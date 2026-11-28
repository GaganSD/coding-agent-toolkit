import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { parseAdapterRecord } from "./adapters.mjs";
import { antigravityConversation, scanAntigravityDb } from "./antigravity.mjs";
import { codexTailContext } from "./codex-migration.mjs";
import { CODEX_PARSER_VERSION } from "./codex-spend.mjs";
import {
  MAX_LINE_BYTES,
  expandHome,
  isPlainObject,
  localDay,
  sessionHash,
} from "./util.mjs";
import {
  addCodexUsage,
  codexIndexedEvidence,
  unresolvedCodexReferences,
  addCodexTask,
  addTask,
  addUsage,
  beginStoreTransaction,
  commitStoreTransaction,
  dedupKeyFor,
  deleteFileEntry,
  fileKey,
  getOrCreateRow,
  linkCodexSnapshot,
  newFileEntry,
  removeLatestFallbackTaskForSession,
  resetFileEntry,
  rollbackStoreTransaction,
  taskKeyFor,
} from "./store.mjs";

const CHUNK_BYTES = 256 * 1024;
const MAX_WARNINGS = 50;
const MAX_TRAVERSAL_ENTRIES = 250_000;
const PARSER_VERSIONS = { pi: 3, codex: CODEX_PARSER_VERSION, claude: 2, antigravity: 2 };
const PROGRESS_CHUNK_INTERVAL = 64;
const TRANSIENT_ARCHIVE_READ_CODES = new Set(["EAGAIN", "EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE", "ENOENT", "ESTALE"]);

export class ScanStopError extends Error {
  constructor(reason) {
    super(`scan stopped (${reason})`);
    this.name = "ScanStopError";
    this.reason = reason;
  }
}

function nowFn(options) {
  return typeof options?.now === "function" ? options.now : Date.now;
}

function deadlineReached(options, now = nowFn(options)()) {
  const deadline = options?.deadline;
  return Number.isFinite(deadline) && now >= deadline;
}

function stopRequested(options) {
  if (typeof options?.shouldStop !== "function") return false;
  return Boolean(options.shouldStop());
}

function pausableDelay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return () => new Promise((resolve) => setTimeout(resolve, ms));
}

function warningSink(warnings, stats, sourceState) {
  let hidden = 0;
  return {
    warn(message, sourceId) {
      stats.errors += 1;
      if (sourceId && sourceState?.[sourceId]) sourceState[sourceId].errors += 1;
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
      else hidden += 1;
    },
    note(message) {
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
      else hidden += 1;
    },
    finish() {
      const count = warnings.length + hidden;
      if (hidden > 0) warnings.push(`${hidden} additional scan warnings were not shown.`);
      return count;
    },
  };
}

function isEligible(adapter, filePath) {
  // Exclude full logs and artifacts; only the canonical compact export is a fallback.
  if (adapter === "antigravity") {
    if (filePath.endsWith(".db")) return path.basename(path.dirname(filePath)) === "conversations";
    return path.basename(filePath) === "transcript.jsonl" &&
      path.basename(path.dirname(filePath)) === "logs" &&
      path.basename(path.dirname(path.dirname(filePath))) === ".system_generated";
  }
  if (adapter === "opencode") return path.basename(filePath) === "opencode.db";
  if (adapter === "codex") {
    return filePath.endsWith(".jsonl") || filePath.endsWith(".jsonl.zst");
  }
  return filePath.endsWith(".jsonl");
}

async function walkRoot(root, adapter) {
  const files = [];
  let unavailable = false;
  let fatal = null;
  let traversed = 0;
  let canonical;
  try {
    canonical = await realpath(root);
    const rootStat = await stat(canonical);
    if (rootStat.isFile()) {
      return { files: isEligible(adapter, canonical) ? [canonical] : [], sortBase: root };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { files: [], sortBase: root, unavailable: true };
    return { files: [], sortBase: root, fatal: error };
  }

  const stack = [canonical];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fatal = fatal ?? error;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      traversed += 1;
      if (traversed > MAX_TRAVERSAL_ENTRIES) {
        fatal = new Error(`root ${root} exceeds ${MAX_TRAVERSAL_ENTRIES} entries`);
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isEligible(adapter, full)) {
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        // Do not follow directory symlinks (loops); a symlinked file is harmless.
        try {
          const linkStat = await stat(full);
          if (linkStat.isFile() && isEligible(adapter, full)) files.push(full);
        } catch {
          // Broken links are simply not transcript files.
        }
      }
    }
    if (traversed > MAX_TRAVERSAL_ENTRIES) break;
  }
  return { files, sortBase: canonical, unavailable, fatal };
}

export async function discoverFiles(config, home, sink, sourceState) {
  const discovered = [];
  for (let sourceIndex = 0; sourceIndex < config.sources.length; sourceIndex += 1) {
    const source = config.sources[sourceIndex];
    const state = sourceState[source.id];
    if (!source.enabled) continue;
    for (let rootIndex = 0; rootIndex < source.roots.length; rootIndex += 1) {
      const root = expandHome(source.roots[rootIndex], home);
      if (!root) continue;
      const result = await walkRoot(root, source.adapter);
      if (result.unavailable) {
        sink.note(
          `[${source.id}] source ${source.id}: root ${source.roots[rootIndex]} is not available.`,
        );
      } else if (result.fatal) {
        sink.warn(
          `[${source.id}] source ${source.id}: cannot read root ${source.roots[rootIndex]}: ${result.fatal.message}`,
          source.id,
        );
      } else {
        state.rootsAvailable += 1;
      }
      for (const file of result.files) {
        discovered.push({
          source,
          sourceIndex,
          rootIndex,
          file,
          sortBase: result.sortBase,
        });
      }
    }
  }
  discovered.sort(
    (a, b) =>
      a.sourceIndex - b.sourceIndex ||
      a.rootIndex - b.rootIndex ||
      a.file.localeCompare(b.file),
  );
  // SQLite wins over exports; configured root order breaks ties between copies.
  const preferred = new Map();
  for (const found of discovered) {
    if (found.source.adapter !== "antigravity") continue;
    const id = antigravityConversation(found.file);
    const previous = preferred.get(id);
    if (!previous || (!previous.file.endsWith(".db") && found.file.endsWith(".db"))) preferred.set(id, found);
  }
  return discovered.filter((found) => found.source.adapter !== "antigravity" ||
    preferred.get(antigravityConversation(found.file)) === found);
}

function hashBytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 24);
}

function createLineConsumer(onLine) {
  let pending = [];
  let pendingLength = 0;
  let discarding = false;
  let lineNo = 0;
  let offset = 0;
  let skippedLargeLine = false;

  function processLine(buffer, absoluteEnd, complete) {
    let end = buffer.length;
    if (end > 0 && buffer[end - 1] === 13) end -= 1;
    lineNo += 1;
    offset = absoluteEnd;
    if (end === 0) return;
    const line = buffer.subarray(0, end);
    let value;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      if (complete) onLine(null, { lineNo, hash: hashBytes(line), parseError: true });
      return;
    }
    onLine(value, {
      lineNo,
      lineEnd: absoluteEnd,
      hash: hashBytes(line),
      parseError: false,
    });
  }

  function feedAt(buffer, chunkStart) {
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      if (newline === -1) {
        const remainder = buffer.subarray(start);
        if (!discarding) {
          if (pendingLength + remainder.length > MAX_LINE_BYTES) {
            pending = [];
            pendingLength = 0;
            discarding = true;
            skippedLargeLine = true;
          } else if (remainder.length > 0) {
            pending.push(Buffer.from(remainder));
            pendingLength += remainder.length;
          }
        }
        if (discarding) offset = chunkStart + buffer.length;
        return;
      }
      const absoluteEnd = chunkStart + newline + 1;
      if (discarding) {
        lineNo += 1;
        offset = absoluteEnd;
        discarding = false;
        onLine(null, { lineNo, oversized: true });
        start = newline + 1;
        continue;
      }
      const piece = buffer.subarray(start, newline);
      if (pendingLength > 0) {
        const whole = Buffer.concat([...pending, piece], pendingLength + piece.length);
        pending = [];
        pendingLength = 0;
        if (whole.length > MAX_LINE_BYTES) {
          lineNo += 1;
          offset = absoluteEnd;
          skippedLargeLine = true;
          onLine(null, { lineNo, oversized: true });
        } else {
          processLine(whole, absoluteEnd, true);
        }
      } else if (piece.length > MAX_LINE_BYTES) {
        lineNo += 1;
        offset = absoluteEnd;
        skippedLargeLine = true;
        onLine(null, { lineNo, oversized: true });
      } else {
        processLine(piece, absoluteEnd, true);
      }
      start = newline + 1;
    }
  }

  function finish(fileSize) {
    if (discarding) {
      pending = [];
      pendingLength = 0;
      return;
    }
    if (pendingLength === 0) return;
    const whole = Buffer.concat(pending, pendingLength);
    pending = [];
    pendingLength = 0;
    if (whole.length > MAX_LINE_BYTES) return;
    try {
      JSON.parse(whole.toString("utf8"));
      processLine(whole, fileSize, true);
    } catch {
      // A trailing partial line is deliberately not persisted. offset stays at
      // the last complete newline and the next scan rereads the tail from disk.
    }
  }

  return {
    feedAt,
    finish,
    get offset() {
      return offset;
    },
    get lineNo() {
      return lineNo;
    },
    get skippedLargeLine() {
      return skippedLargeLine;
    },
    get discarding() {
      return discarding;
    },
    set discarding(value) {
      discarding = Boolean(value);
    },
    set offset(value) {
      offset = value;
    },
    set lineNo(value) {
      lineNo = value;
    },
  };
}

async function streamRange(filePath, start, end, onChunk, { shouldStop } = {}) {
  const handle = await open(filePath, "r");
  let position = start;
  let bytes = 0;
  let stopped = false;
  let first = true;
  try {
    while (position < end) {
      if (!first && shouldStop?.()) {
        stopped = true;
        break;
      }
      const toRead = Math.min(CHUNK_BYTES, end - position);
      const buffer = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      bytes += bytesRead;
      await onChunk(buffer.subarray(0, bytesRead), position - bytesRead);
      first = false;
    }
  } finally {
    await handle.close();
  }
  return { bytes, stopped, position };
}

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;
const ZSTD_DICT_ID_BYTES = [0, 1, 2, 4];
const ZSTD_FCS_BYTES = [0, 2, 4, 8];

/**
 * Structural zstd stream splitter. Some Node 22 runtimes stop a decoder at
 * the first frame of a concatenated stream, so each data frame is decoded by
 * its own fresh decoder. This parser walks frame, header, block and checksum
 * lengths to delimit frames; skippable frames are discarded without decoding.
 */
function createZstdFrameSplitter({
  onFrameStart,
  onFrameData,
  onFrameEnd,
  onFrameBoundary,
  onSkippedBytes,
}) {
  let head = Buffer.alloc(0);
  let state = "magic";
  let remaining = 0;
  let lastBlock = false;
  let checksum = false;
  let frames = 0;
  let dataFrame = false;

  const fail = (message) => {
    throw new Error(`invalid zstd stream: ${message}`);
  };

  const need = () => {
    if (state === "magic" || state === "skippableSize") return 4;
    if (state === "blockHeader") return 3;
    if (state === "checksum") return 4;
    if (state === "frameHeader") {
      if (head.length < 1) return 1;
      const descriptor = head[0];
      if (descriptor & 0x18) fail("reserved frame header bits");
      const fcsFlag = descriptor >> 6;
      const singleSegment = (descriptor >> 5) & 1;
      const dictBytes = ZSTD_DICT_ID_BYTES[descriptor & 0x03];
      const fcsBytes = fcsFlag === 0 && singleSegment ? 1 : ZSTD_FCS_BYTES[fcsFlag];
      return 1 + (singleSegment ? 0 : 1) + dictBytes + fcsBytes;
    }
    return 0;
  };

  const endFrame = async () => {
    dataFrame = false;
    await onFrameEnd();
    state = "magic";
  };

  return {
    async push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (state === "skip" || state === "blockData") {
          const take = Math.min(remaining, chunk.length - offset);
          if (take > 0 && state === "blockData") {
            await onFrameData(chunk.subarray(offset, offset + take));
          } else if (take > 0 && state === "skip") {
            await onSkippedBytes?.(take);
          }
          offset += take;
          remaining -= take;
          if (remaining === 0) {
            if (state === "skip") {
              state = "magic";
            } else if (lastBlock) {
              if (checksum) state = "checksum";
              else await endFrame();
            } else {
              state = "blockHeader";
            }
          }
          continue;
        }
        const size = need();
        const take = Math.min(size - head.length, chunk.length - offset);
        if (take > 0) {
          const piece = chunk.subarray(offset, offset + take);
          head = Buffer.concat([head, piece]);
          offset += take;
          if (dataFrame) await onFrameData(piece);
        }
        if (head.length < size) return;
        if (state === "magic") {
          const magicBytes = head;
          const magic = magicBytes.readUInt32LE(0);
          head = Buffer.alloc(0);
          if (magic === ZSTD_FRAME_MAGIC) {
            await onFrameBoundary?.();
            frames += 1;
            dataFrame = true;
            state = "frameHeader";
            await onFrameStart();
            await onFrameData(magicBytes);
          } else if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
            await onFrameBoundary?.();
            frames += 1;
            dataFrame = false;
            state = "skippableSize";
          } else {
            fail("unknown frame magic");
          }
        } else if (state === "skippableSize") {
          remaining = head.readUInt32LE(0);
          head = Buffer.alloc(0);
          state = remaining === 0 ? "magic" : "skip";
        } else if (state === "frameHeader") {
          // The descriptor may arrive before the rest of the header; wait for
          // the full window/dictionary/content-size fields.
          if (head.length < need()) continue;
          checksum = Boolean((head[0] >> 2) & 1);
          head = Buffer.alloc(0);
          state = "blockHeader";
        } else if (state === "blockHeader") {
          const header = head.readUIntLE(0, 3);
          head = Buffer.alloc(0);
          lastBlock = Boolean(header & 1);
          const type = (header >> 1) & 0x03;
          if (type === 3) fail("reserved block type");
          remaining = type === 1 ? 1 : header >> 3;
          state = "blockData";
          if (remaining === 0) {
            if (!lastBlock) state = "blockHeader";
            else if (checksum) state = "checksum";
            else await endFrame();
          }
        } else if (state === "checksum") {
          head = Buffer.alloc(0);
          await endFrame();
        }
      }
    },
    get complete() {
      return frames > 0 && state === "magic" && head.length === 0;
    },
  };
}

function hasZstdSupport() {
  return typeof zlib.createZstdDecompress === "function";
}

function lineContext(store, entry, source, sink) {
  return {
    file: entry,
    state: entry.state,
    source,
    lineHash: "",
    warn(message) {
      sink.warn(`${source.adapter} ${entry.path}: ${message}`);
    },
    addUsage(meta, tokens, key) {
      return addUsage(store, entry, meta, tokens, key);
    },
    addCodexUsage(meta, tokens, key) {
      return addCodexUsage(store, entry, meta, tokens, key, CODEX_PARSER_VERSION);
    },
    addCodexTask(usageKey, taskKey, durationMs, session) {
      return addCodexTask(store, entry, usageKey, taskKey, durationMs, session);
    },
    linkCodexSnapshot(snapshotKey, responseKey) {
      linkCodexSnapshot(store, snapshotKey, responseKey);
    },
    addTask(fileId, rowIdx, key, durationMs, session, exact) {
      return addTask(
        store,
        fileId,
        rowIdx,
        key,
        durationMs,
        session,
        exact,
        entry.id,
      );
    },
    removeLatestFallback(session) {
      return removeLatestFallbackTaskForSession(store, session);
    },
  };
}

function createRecordConsumer(store, entry, source, sink, verification) {
  const context = lineContext(store, entry, source, sink);
  let tailContext;
  if (verification) {
    let named;
    const witness = (keys, key, value, requireValue = false) => {
      if (!keys.has(key)) return;
      const expected = keys.get(key);
      if (expected && requireValue && !value) return;
      const remaining = expected && value && expected.map((n, i) => value[i] >= n ? 0 : n);
      if (remaining?.some(Boolean)) keys.set(key, remaining);
      else keys.delete(key);
    };
    context.observeCodexLegacyKey = (key, value, standalone = false) => {
      const inPrefix = context.lineNo <= verification.prefix;
      if (inPrefix) witness(verification.missing, key, value);
      witness(verification.missingTail, key, value, true);
      if (standalone && !inPrefix) named = key;
    };
    context.observeCodexTask = (key, duration, copied, materializedKey = key) => {
      const inPrefix = context.lineNo <= verification.prefix;
      if (copied) {
        if (!inPrefix || !verification.legacy) return;
        // Inherited completions don't charge the child. If the old index
        // put an exact parent task in this file, keep its verified duration
        // and attribution under the original key. The parent's own reparse
        // can then adopt the same key instead of charging it again.
        const { parentKey, parent } = copied;
        const row = verification.foreignTaskRows.get(parentKey);
        const expected = verification.tasks.get(parentKey);
        if (parent && duration >= expected) {
          if (!store.tasks[parentKey] && row?.session === parent) {
            addTask(store, entry.id, getOrCreateRow(entry, row), parentKey, expected, parent, true);
          }
          const retained = store.tasks[parentKey];
          if (retained?.[4] === sessionHash(parent) && retained[2] >= expected) verification.tasks.delete(parentKey);
        }
        if (!verification.foreignTaskRows.has(key) && duration >= verification.tasks.get(key)) verification.tasks.delete(key);
        return;
      }
      // A completion alone cannot justify removing previously indexed time.
      const retained = Math.min(duration, store.tasks[materializedKey]?.[2] ?? 0);
      if (inPrefix && retained >= verification.tasks.get(key)) verification.tasks.delete(key);
      if (retained >= verification.missingTailTasks.get(key)) verification.missingTailTasks.delete(key);
    };
    const addTimedTask = context.addCodexTask;
    context.addCodexTask = (...task) => {
      if (context.lineNo > verification.prefix && (entry.compressed || context.lineEnd > verification.priorOffset)) {
        verification.tailTasks.push(task);
      }
      return addTimedTask(...task);
    };
    const add = context.addCodexUsage;
    context.addCodexUsage = (meta, tokens, key) => {
      if (verification.missingTail.has(key)) witness(verification.missingTail, key,
        [tokens.input + tokens.cacheRead + tokens.cacheWrite, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]);
      if (named === key) verification.tail.push([meta, tokens, key]);
      named = null;
      return add(meta, tokens, key);
    };
  }
  return createLineConsumer((record, info) => {
    if (info.oversized) {
      return;
    }
    if (info.parseError) {
      sink.warn(
        `${source.adapter} ${entry.path}: line ${info.lineNo} is not valid JSON; skipped.`,
      );
      return;
    }
    if (!isPlainObject(record)) return;
    context.lineHash = info.hash;
    context.lineNo = info.lineNo;
    context.lineEnd = info.lineEnd;
    try {
      parseAdapterRecord(source.adapter, record, context);
      if (verification && info.lineNo > verification.prefix &&
        (entry.compressed || info.lineEnd > verification.priorOffset) && record.type !== "session_meta") {
        if (tailContext === undefined) tailContext = codexTailContext(verification.priorFile,
          (...usage) => verification.tail.push(usage), (...task) => verification.tailTasks.push(task));
        if (tailContext) {
          tailContext.lineNo = info.lineNo;
          tailContext.lineEnd = info.lineEnd;
          tailContext.lineHash = info.hash;
          tailContext.history = record.type === "event_msg" && record.payload?.type === "token_count" &&
            isPlainObject(record.payload.info?.total_token_usage);
          parseAdapterRecord("codex", record, tailContext);
        }
      }
    } catch (error) {
      sink.warn(
        `${source.adapter} ${entry.path}: line ${info.lineNo} could not be parsed: ${error.message}`,
      );
    }
  });
}

async function scanPlainFile(
  store,
  entry,
  source,
  filePath,
  fileStat,
  sink,
  stats,
  options = {},
) {
  const adapter = source.adapter;
  const start = entry.offset;

  if (fileStat.size <= start) {
    if (entry.state.scanPending) {
      delete entry.state.scanPending;
      return { dirty: true, pending: false };
    }
    return { dirty: false, pending: false };
  }

  const consumer = createRecordConsumer(store, entry, source, sink, options.verification);
  consumer.offset = start;
  consumer.lineNo = entry.lineNo ?? 0;
  consumer.discarding = entry.state.discardingLargeLine;
  const now = nowFn(options);
  let bytes = 0;
  let stopped = false;
  try {
    const result = await streamRange(filePath, start, fileStat.size, async (chunk, chunkStart) => {
      bytes += chunk.length;
      consumer.feedAt(chunk, chunkStart);
    }, {
      // Honor cancellation immediately. A deadline stop must still reach a
      // newline or the large-line cap: one 256 KiB chunk with no newline
      // leaves the safe offset unchanged, and every later slice repeats it.
      shouldStop: () => {
        if (stopRequested(options)) return true;
        if (!deadlineReached(options, now())) return false;
        return consumer.offset > start || consumer.discarding;
      },
    });
    bytes = result.bytes;
    stopped = result.stopped;
    if (options.codexMigration && !stopped && result.position < fileStat.size) {
      throw new Error("the file ended before its recorded size");
    }
    // Finish a partial tail only at true EOF. A budget stop can land after a
    // prefix that happens to parse as JSON but is still part of a longer line;
    // committing it would invent rows and advance the offset into the line.
    if (!stopped) consumer.finish(start + bytes);
    if (!stopped) delete entry.state.readFailed;
  } catch (error) {
    if (adapter === "antigravity") throw error;
    // Keep the accepted complete prefix and its parser state together. The
    // unfinished suffix is retried even if the file metadata is unchanged.
    entry.state.readFailed = true;
    const reason = options.codexMigration ? "upgrade read failed; prior usage retained" : "read failed; accepted prefix retained";
    sink.warn(`${adapter} ${entry.path}: ${reason}: ${error.message}`);
  }
  stats.bytesRead += bytes;
  if (bytes > 0) stats.filesRead += 1;
  if (consumer.skippedLargeLine) {
    sink.warn(
      `${adapter} ${entry.path}: a line larger than ${MAX_LINE_BYTES} bytes was skipped.`,
    );
  }
  entry.offset = consumer.offset;
  entry.lineNo = consumer.lineNo;
  if (consumer.discarding) entry.state.discardingLargeLine = true;
  else delete entry.state.discardingLargeLine;
  if (stopped) entry.state.scanPending = true;
  else delete entry.state.scanPending;
  return { dirty: true, pending: stopped };
}

async function scanCompressedFile(
  store,
  entry,
  source,
  filePath,
  fileStat,
  sink,
  stats,
  options = {},
) {
  if (!hasZstdSupport()) {
    entry.size = fileStat.size;
    entry.mtimeMs = fileStat.mtimeMs;
    entry.offset = fileStat.size;
    entry.state.unsupported = "zstd";
    sink.warn(
      `${source.adapter} ${entry.path}: .jsonl.zst needs Node's zstd API (Node 22.15+); skipped.`,
    );
    return { status: "unsupported", dirty: true };
  }
  // The caller owns a per-file transaction. Any decompression failure or
  // deadline stop discards this open archive without exposing its rows. Raw
  // transcript bytes are never retained: each frame streams through its own
  // decoder into one shared line consumer, so a line may span frames.
  // Capture the deliberate stop here because some Node 22 pipeline
  // implementations re-wrap a destination error as a generic AbortError.
  // Only this exact captured ScanStopError is a budget stop; every structural
  // or CRC failure on a complete frame remains a corruption failure.
  let deliberateStop = null;
  let decompressedBytes = 0;
  let chunkStart = 0;
  let chunksSeen = 0;
  let decoderInput = null;
  let decoderDone = null;
  let consumer;
  let readError;
  const now = nowFn(options);
  const delay = pausableDelay(options.streamDelayMs);
  let frameBoundaries = 0;
  let skippedBytes = 0;
  const enforceCompressedLimit = () => {
    if (stopRequested(options)) throw new ScanStopError("stop");
    if (deadlineReached(options, now())) throw new ScanStopError("budget");
  };
  const splitter = createZstdFrameSplitter({
    async onFrameBoundary() {
      frameBoundaries += 1;
      // The first frame may start after the foreground budget is already
      // gone. Every later frame, including empty and skippable frames that
      // produce no decoder output, has to observe the same stop.
      if (frameBoundaries > 1) enforceCompressedLimit();
    },
    async onSkippedBytes(count) {
      skippedBytes += count;
      if (skippedBytes >= CHUNK_BYTES) enforceCompressedLimit();
    },
    async onFrameStart() {
      decoderInput = new PassThrough();
      const input = decoderInput;
      decoderDone = pipeline(input, zlib.createZstdDecompress(), async (chunks) => {
        try {
          for await (const chunk of chunks) {
            if (chunksSeen > 0) {
              if (stopRequested(options)) throw new ScanStopError("stop");
              if (deadlineReached(options, now())) throw new ScanStopError("budget");
            }
            if (delay) await delay();
            consumer.feedAt(chunk, chunkStart);
            chunkStart += chunk.length;
            decompressedBytes += chunk.length;
            chunksSeen += 1;
            if (chunksSeen % PROGRESS_CHUNK_INTERVAL === 0) {
              options.onStreamProgress?.({
                file: entry.path,
                bytes: decompressedBytes,
                phase: "decompress",
              });
            }
          }
        } catch (error) {
          if (error instanceof ScanStopError) deliberateStop = error;
          throw error;
        }
      });
      // The parser awaits the pipeline; this guard only prevents a transient
      // unhandled rejection between a destination failure and the next write.
      decoderDone.catch(() => {});
    },
    async onFrameData(data) {
      if (deliberateStop) throw deliberateStop;
      const input = decoderInput;
      if (!input.write(data)) {
        await Promise.race([once(input, "drain"), decoderDone]);
        if (deliberateStop) throw deliberateStop;
      }
    },
    async onFrameEnd() {
      const input = decoderInput;
      const done = decoderDone;
      decoderInput = null;
      decoderDone = null;
      input.end();
      await done;
    },
  });
  try {
    if (entry.offset || entry.rows.length || Object.keys(entry.state).length) resetFileEntry(store, entry);
    // Bind parser context only after resetting the archive's previous state.
    consumer = createRecordConsumer(store, entry, source, sink, options.verification);
    consumer.offset = 0;
    consumer.lineNo = entry.lineNo ?? 0;
    let sawCompressedChunk = false;
    const input = createReadStream(filePath);
    input.on("error", (error) => { readError = error; });
    for await (const chunk of input) {
      if (sawCompressedChunk) enforceCompressedLimit();
      if (deliberateStop) break;
      await splitter.push(chunk);
      sawCompressedChunk = true;
    }
    if (deliberateStop) throw deliberateStop;
    if (!splitter.complete) {
      throw new Error("invalid zstd stream: truncated or trailing data");
    }
    // Finish the shared consumer only at the true end of the stream. Budget
    // stops must not commit a partial tail that may still continue.
    consumer.finish(chunkStart);
    if (consumer.skippedLargeLine) {
      sink.warn(
        `${source.adapter} ${entry.path}: a line larger than ${MAX_LINE_BYTES} bytes was skipped.`,
      );
    }
  } catch (error) {
    decoderInput?.destroy();
    const stop = deliberateStop ?? (error instanceof ScanStopError ? error : null);
    if (stop) {
      return { status: "stopped", reason: stop.reason, dirty: false };
    }
    const retry = (error === readError || error?.syscall) && TRANSIENT_ARCHIVE_READ_CODES.has(error.code);
    return { status: retry ? "read-failed" : "corrupt", error, dirty: false };
  }
  stats.bytesRead += fileStat.size;
  if (fileStat.size > 0) stats.filesRead += 1;
  stats.decompressedBytes = (stats.decompressedBytes ?? 0) + decompressedBytes;
  entry.offset = fileStat.size;
  entry.lineNo = consumer.lineNo;
  if (entry.adapter === "codex") entry.state.codexDecodedBytes = consumer.offset;
  delete entry.state.zstdError;
  return { status: "ok", dirty: true, completeJsonl: consumer.offset === chunkStart && !consumer.discarding };
}

function openCodeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function openCodeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * OpenCode stores sessions in one SQLite database. Messages are immutable
 * once completed and each assistant row carries canonical tokens, so a full
 * re-read through the max-upsert dedup is exact. The WAL file changes on
 * every write while the main database may not, so the checkpoint fingerprint
 * covers both files.
 */
async function scanOpenCodeDb(store, source, filePath, sink, stats, options = {}) {
  let dbStat;
  try {
    dbStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      sink.warn(`opencode ${filePath}: cannot stat file: ${error.message}`);
    }
    return { dirty: false, aborted: false };
  }
  if (!dbStat.isFile()) return { dirty: false, aborted: false };
  let walStat = null;
  try {
    walStat = await stat(`${filePath}-wal`);
  } catch { /* no WAL right now */ }
  const fingerprint = `${dbStat.mtimeMs}:${dbStat.size}:${walStat?.mtimeMs ?? 0}:${walStat?.size ?? 0}`;

  const key = fileKey(source.id, filePath);
  let entry = store.files[key];
  if (entry?.state.opencodeParserVersion === 2 && entry.state.opencodeFingerprint === fingerprint) {
    if (entry.state.opencodeMalformedRows) sink.warn(`opencode ${filePath}: ${entry.state.opencodeMalformedRows} malformed message rows were skipped.`);
    stats.unchangedFiles += 1;
    return { dirty: false, aborted: false };
  }

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    const tx = beginStoreTransaction(store, { fileId: entry?.id });
    let dirty = false;
    if (!entry) {
      entry = newFileEntry(store, {
        sourceId: source.id,
        adapter: source.adapter,
        path: filePath,
        dev: String(dbStat.dev),
        ino: String(dbStat.ino),
        size: 0,
        mtimeMs: 0,
        compressed: false,
      });
      dirty = true;
    }
    if (entry.state.unsupported !== "sqlite") {
      sink.warn(`opencode ${filePath}: node:sqlite is unavailable in this Node runtime; skipped.`);
      entry.state.unsupported = "sqlite";
      dirty = true;
    }
    commitStoreTransaction(tx);
    stats.unchangedFiles += 1;
    return { dirty, aborted: false };
  }

  let db;
  let malformedRows = 0;
  const tx = beginStoreTransaction(store, { fileId: entry?.id });
  if (!entry) {
    entry = newFileEntry(store, {
      sourceId: source.id,
      adapter: source.adapter,
      path: filePath,
      dev: String(dbStat.dev),
      ino: String(dbStat.ino),
      size: 0,
      mtimeMs: 0,
      compressed: false,
    });
  }
  const now = nowFn(options);
  let rowsSeen = 0;
  try {
    // Never open an external source writable, including on recovery errors.
    db = new sqlite.DatabaseSync(filePath, { readOnly: true });
    const records = db.prepare("SELECT session_id, id, time_created, data FROM message").iterate();
    resetFileEntry(store, entry);
    delete entry.state.unsupported;
    for (const record of records) {
      if (stopRequested(options) || (rowsSeen > 0 && deadlineReached(options, now()))) {
        throw new ScanStopError("budget");
      }
      rowsSeen += 1;
      let data;
      try {
        data = JSON.parse(record.data);
      } catch {
        malformedRows += 1;
        continue;
      }
      if (!isPlainObject(data)) { malformedRows += 1; continue; }
      if (data.role !== "assistant") continue;
      if (!isPlainObject(data.tokens)) { malformedRows += 1; continue; }
      const reported = [data.tokens.input, data.tokens.output, data.tokens.reasoning, data.tokens.cache?.read, data.tokens.cache?.write];
      if (reported.some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
        malformedRows += 1;
        continue;
      }
      const tokens = {
        input: openCodeInt(data.tokens.input),
        output: openCodeInt(data.tokens.output),
        cacheRead: openCodeInt(data.tokens.cache?.read),
        cacheWrite: openCodeInt(data.tokens.cache?.write),
        reasoning: openCodeInt(data.tokens.reasoning),
      };
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) continue;
      const created = openCodeInt(data.time?.created) || openCodeInt(record.time_created);
      if (created <= 0 || !Number.isFinite(new Date(created).getTime())) { malformedRows += 1; continue; }
      const session = String(record.session_id ?? "unknown");
      const result = addUsage(store, entry, {
        day: localDay(created),
        session,
        harness: source.id,
        provider: openCodeString(data.providerID),
        model: openCodeString(data.modelID),
        project: typeof data.path?.cwd === "string" ? data.path.cwd : "",
      }, tokens, dedupKeyFor("opencode", "message", String(record.id)));
      const completed = openCodeInt(data.time?.completed);
      if (completed > created) {
        addTask(
          store,
          result.fileId,
          result.rowIdx,
          taskKeyFor("opencode", "message", String(record.id)),
          completed - created,
          session,
          true,
        );
      }
    }
    commitStoreTransaction(tx);
  } catch (error) {
    rollbackStoreTransaction(tx);
    if (error instanceof ScanStopError) {
      return { dirty: false, aborted: true, reason: error.reason };
    }
    sink.warn(`opencode ${filePath}: scan failed: ${error.message}`);
    return { dirty: false, aborted: false };
  } finally {
    try { db?.close(); } catch { /* close is best-effort */ }
  }

  entry.dev = String(dbStat.dev);
  entry.ino = String(dbStat.ino);
  entry.size = dbStat.size;
  entry.mtimeMs = dbStat.mtimeMs;
  entry.state.opencodeFingerprint = fingerprint;
  entry.state.opencodeParserVersion = 2;
  entry.state.opencodeMalformedRows = malformedRows;
  if (malformedRows) sink.warn(`opencode ${filePath}: ${malformedRows} malformed message rows were skipped.`);
  stats.filesRead += 1;
  stats.bytesRead += dbStat.size + (walStat?.size ?? 0);
  return { dirty: true, aborted: false };
}

function noteCodexForkReplay(entry, sink, { pending = false } = {}) {
  if (entry?.adapter !== "codex") return;
  if (entry.state.forkBoundaryAmbiguous || (entry.state.forkReplay && !pending)) {
    sink.note(`codex ${entry.path}: fork replay usage excluded until a strictly newer UUIDv7 turn; missing, non-v7 or equal-millisecond boundaries may exclude child usage.`);
  }
  if (entry.state.forkUsageAmbiguous) {
    sink.note(`codex ${entry.path}: copied usage carriers lack a reliable shared identity; fork accounting may be inaccurate.`);
  }
  if (entry.state.codexAmbiguousEcho) {
    sink.note(`codex ${entry.path}: ambiguous usage was retained; some responses may be counted twice.`);
  }
  if (entry.state.codexCarrierOrderAmbiguous) {
    sink.note(`codex ${entry.path}: usage carrier timestamps disagree with rollout order; interval accounting may be inaccurate.`);
  }
  if (entry.state.codexPossibleSnapshotFirst && !entry.state.codexCarrierOrderAmbiguous) {
    sink.note(`codex ${entry.path}: ambiguous carrier order at the legacy-to-record boundary (possible snapshot-first import); interval accounting may be inaccurate.`);
  }
  if (entry.state.codexUpgradeRejected) {
    sink.note(`codex ${entry.path}: prior usage preserved because the rollout could not be reparsed; counts may still reflect an older parser.`);
  }
}

async function scanOneFile(store, source, filePath, sink, stats, options = {}) {
  const sourceSink = {
    warn(message) {
      sink.warn(`[${source.id}] ${message}`, source.id);
    },
    note(message) {
      sink.note(`[${source.id}] ${message}`);
    },
  };
  if (source.adapter === "opencode") {
    return scanOpenCodeDb(store, source, filePath, sourceSink, stats, options);
  }
  if (source.adapter === "antigravity" && filePath.endsWith(".db")) {
    return scanAntigravityDb(store, source, filePath, sourceSink, stats, options);
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      sourceSink.warn(`${source.adapter} ${filePath}: cannot stat file: ${error.message}`);
    }
    return { dirty: false, aborted: false };
  }
  if (!fileStat.isFile()) return { dirty: false, aborted: false };

  const dev = String(fileStat.dev);
  const ino = String(fileStat.ino);
  const key = fileKey(source.id, filePath);
  const existing = store.files[key];
  const supersededKeys = options.supersededKeys ?? [];
  const isNew = !existing;
  const parserVersion = PARSER_VERSIONS[existing?.adapter ?? source.adapter];
  const parserKey = `${existing?.adapter ?? source.adapter}ParserVersion`;
  const parserCurrent = (!parserVersion || existing?.state[parserKey] === parserVersion)
    && !(existing?.state.unsupported === "zstd" && hasZstdSupport());
  const codexMigration = existing?.adapter === "codex" && !parserCurrent;
  const rejected = existing?.state.codexUpgradeRejected;
  // ctime also changes on permission fixes that leave size and mtime intact.
  const archiveFingerprint = `${dev}:${ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
  const cachedRejection = codexMigration && rejected?.fingerprint === archiveFingerprint
    && rejected.version === parserVersion && (rejected.reason !== "unsupported" || !hasZstdSupport());
  const changedRejection = existing?.state.zstdError && existing.state.zstdError !== archiveFingerprint;
  if (supersededKeys.length === 0 && (cachedRejection || (
    existing
    && parserCurrent
    && !changedRejection
    && !existing.state.readFailed
    && !existing.state.scanPending
    && existing.dev === dev
    && existing.ino === ino
    && existing.size === fileStat.size
    && existing.mtimeMs === fileStat.mtimeMs
  ))) {
    stats.unchangedFiles += 1;
    noteCodexForkReplay(existing, sourceSink);
    return { dirty: false, aborted: false };
  }

  // Every changed file gets a precise transaction. The previous committed
  // contributions stay visible until the whole file is accepted, and a failure
  // restores rows, dedup/task ownership, parser state, and nextFileId.
  const tx = beginStoreTransaction(store, { fileId: existing?.id });
  const priorOffset = existing?.offset ?? 0;
  const priorLine = existing?.lineNo ?? 0;
  const priorSession = existing?.state.session;
  const priorParser = existing?.state.codexParserVersion;
  const evidence = codexMigration ? codexIndexedEvidence(store, existing) : null;
  const previousTail = priorLine > 0 && existing?.state.codexUpgradeTailBoundary === priorLine
    ? (existing.state.codexUpgradeTailKeys ?? []).filter((key) => evidence?.usage.has(key)) : [];
  const previousTailTasks = priorLine > 0 && existing?.state.codexUpgradeTailBoundary === priorLine
    ? (existing.state.codexUpgradeTailTasks ?? []).filter((key) => evidence?.tasks.has(key)) : [];
  // If the old v9 cursor itself is missing, look for its indexed values
  // across the whole file. There is no verified boundary for accepting a tail.
  const mustVerify = priorLine > 0 || priorParser <= 9;
  const verification = codexMigration ? { prefix: priorLine || Infinity, missing: new Map(mustVerify ? evidence.usage : []),
    priorOffset, priorFile: { path: existing.path, state: existing.state }, missingTail: new Map(),
    tasks: mustVerify ? evidence.tasks : new Map(), legacy: priorParser <= 9, foreignTaskRows: evidence.foreignTaskRows,
    missingTailTasks: new Map(), tail: [], tailTasks: [] } : null;
  for (const key of previousTail) {
    verification.missingTail.set(key, verification.missing.get(key));
    verification.missing.delete(key);
  }
  for (const key of previousTailTasks) {
    verification.missingTailTasks.set(key, verification.tasks.get(key));
    verification.tasks.delete(key);
  }
  const prefixTasks = new Set(verification?.tasks.keys());
  if (verification) options = { ...options, verification };
  async function rejectIncompleteMigration(completeJsonl) {
    if (!codexMigration) return false;
    const after = await stat(filePath).catch(() => null);
    const stable = after?.isFile() && after.dev === fileStat.dev && after.ino === fileStat.ino && after.size === fileStat.size &&
      after.mtimeMs === fileStat.mtimeMs && after.ctimeMs === fileStat.ctimeMs;
    const sameSession = !priorSession || entry.state.session === priorSession;
    if (stable && sameSession && completeJsonl && entry.lineNo >= priorLine &&
      (!(priorParser <= 9) || evidence.consistent) &&
      !verification.missing.size && !verification.missingTail.size && !verification.tasks.size &&
      !verification.missingTailTasks.size &&
      (entry.compressed || fileStat.size >= priorOffset)) return false;
    rollbackStoreTransaction(tx);
    delete existing.state.codexUpgradeEvidence;
    // Named suffix records are independently authoritative. A history
    // suffix also qualifies when settled from the retained index's baseline,
    // never from the damaged prefix. Keep the old verification boundary.
    if (stable && sameSession && priorSession && evidence.consistent && verification.tail.length) {
      const accepted = new Set(previousTail);
      for (const [meta, tokens, key] of verification.tail) {
        addCodexUsage(store, existing, meta, tokens, key, parserVersion);
        accepted.add(key);
      }
      // Task evidence alone proves the duration, not its attribution. Commit
      // suffix time only where this transaction accepted the target usage.
      const acceptedTasks = new Set(previousTailTasks);
      for (const [target, key, duration, session] of verification.tailTasks) {
        if (!accepted.has(target) || prefixTasks.has(key)) continue;
        addCodexTask(store, existing, target, key, duration, session);
        if (store.tasks[key]) acceptedTasks.add(key);
      }
      existing.state.codexUpgradeTailKeys = [...accepted];
      if (acceptedTasks.size) existing.state.codexUpgradeTailTasks = [...acceptedTasks];
      existing.state.codexUpgradeTailBoundary = priorLine;
    }
    existing.state.codexUpgradeRejected = { fingerprint: archiveFingerprint, reason: "incomplete", version: parserVersion };
    sourceSink.warn(`codex ${filePath}: upgrade could not verify a complete reparse; prior usage retained`);
    return true;
  }
  let entry = existing;
  let dirty = false;
  try {
    for (const superseded of supersededKeys) deleteFileEntry(store, superseded);
    if (cachedRejection) {
      commitStoreTransaction(tx);
      stats.unchangedFiles += 1;
      noteCodexForkReplay(existing, sourceSink);
      return { dirty: true, aborted: false };
    }
    if (!entry) {
      entry = newFileEntry(store, {
        sourceId: source.id,
        adapter: source.adapter,
        path: filePath,
        dev,
        ino,
        size: 0,
        mtimeMs: 0,
        compressed: filePath.endsWith(".jsonl.zst"),
      });
      dirty = true;
    }

    let forceRead = supersededKeys.length > 0;
    if (forceRead) {
      resetFileEntry(store, entry);
      dirty = true;
    }
    if (!isNew && parserVersion && entry.state[parserKey] !== parserVersion) {
      if (codexMigration && filePath.endsWith(".jsonl.zst") && !hasZstdSupport()) {
        entry.state.codexUpgradeRejected = { fingerprint: archiveFingerprint, reason: "unsupported", version: parserVersion };
        commitStoreTransaction(tx);
        noteCodexForkReplay(entry, sourceSink);
        return { dirty: true, aborted: false };
      }
      // Migrate existing history once for accounting fixes. New files own no
      // metadata and must never trigger a global ownership cleanup scan.
      resetFileEntry(store, entry);
      forceRead = true;
      dirty = true;
    }
    if (
      entry.state.unsupported === "zstd" &&
      hasZstdSupport() &&
      filePath.endsWith(".jsonl.zst")
    ) {
      resetFileEntry(store, entry);
      forceRead = true;
      dirty = true;
    }
    if (
      entry.dev !== dev ||
      entry.ino !== ino ||
      fileStat.size < entry.size ||
      fileStat.size < entry.offset
    ) {
      resetFileEntry(store, entry);
      entry.dev = dev;
      entry.ino = ino;
      forceRead = true;
      dirty = true;
    }

    if (
      !forceRead &&
      !changedRejection &&
      !entry.state.readFailed &&
      !entry.state.scanPending &&
      entry.size === fileStat.size &&
      entry.mtimeMs === fileStat.mtimeMs
    ) {
      stats.unchangedFiles += 1;
      commitStoreTransaction(tx);
      noteCodexForkReplay(entry, sourceSink);
      return { dirty, aborted: false };
    }

    if (filePath.endsWith(".jsonl.zst")) {
      const compressed = await scanCompressedFile(
        store,
        entry,
        source,
        filePath,
        fileStat,
        sourceSink,
        stats,
        options,
      );
      if (compressed.status === "stopped") {
        rollbackStoreTransaction(tx);
        return {
          dirty: false,
          aborted: true,
          abortedFile: {
            sourceId: source.id,
            adapter: source.adapter,
            path: filePath,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
            dev,
            ino,
            reason: compressed.reason ?? "budget",
          },
        };
      }
      if (compressed.status === "read-failed") {
        rollbackStoreTransaction(tx);
        sourceSink.warn(`${source.adapter} ${filePath}: archive read failed; prior usage retained: ${compressed.error.message}`);
        return { dirty: false, aborted: false };
      }
      if (compressed.status === "corrupt") {
        rollbackStoreTransaction(tx);
        if (codexMigration) {
          existing.state.codexUpgradeRejected = { fingerprint: archiveFingerprint, reason: "corrupt", version: parserVersion };
          sourceSink.warn(`codex ${existing.path}: archive upgrade failed; prior usage retained: ${compressed.error.message}`);
          return { dirty: true, aborted: false };
        }
        // A first-seen archive was detached by rollback. Persist a rowless
        // fingerprint stub so an unchanged corrupt file is not re-read and
        // re-warned on every refresh. A previously indexed archive keeps its
        // last good rows and metadata.
        const key = fileKey(source.id, filePath);
        if (!store.files[key]) {
          entry = newFileEntry(store, {
            sourceId: source.id,
            adapter: source.adapter,
            path: filePath,
            dev,
            ino,
            size: 0,
            mtimeMs: 0,
            compressed: true,
          });
        }
        entry.size = fileStat.size;
        entry.mtimeMs = fileStat.mtimeMs;
        entry.offset = fileStat.size;
        entry.state.zstdError = archiveFingerprint;
        // Mark the fingerprint as current so a first-seen stub is not treated
        // as a parser migration and re-read on the next refresh.
        if (parserVersion) entry.state[parserKey] = parserVersion;
        sourceSink.warn(
          `${source.adapter} ${entry.path}: zstd file could not be decompressed: ${compressed.error.message}`,
        );
        return { dirty: true, aborted: false };
      }
      if (await rejectIncompleteMigration(compressed.completeJsonl)) return { dirty: true, aborted: false };
      dirty = compressed.dirty || dirty;
      commitStoreTransaction(tx);
      entry.size = fileStat.size;
      entry.mtimeMs = fileStat.mtimeMs;
      entry.path = filePath;
      if (parserVersion) entry.state[parserKey] = parserVersion;
      delete entry.state.zstdError;
      delete entry.state.scanPending;
      noteCodexForkReplay(entry, sourceSink);
      return { dirty, aborted: false };
    }

    const plain = await scanPlainFile(
      store,
      entry,
      source,
      filePath,
      fileStat,
      sourceSink,
      stats,
      { ...options, codexMigration },
    );
    if (codexMigration && entry.state.readFailed) {
      rollbackStoreTransaction(tx);
      return { dirty: false, aborted: false };
    }
    // Never replace a complete contribution with a partial migration/reparse.
    if ((codexMigration || source.adapter === "antigravity") && plain.pending) {
      rollbackStoreTransaction(tx);
      return { dirty: false, aborted: true, reason: stopRequested(options) ? "stop" : "budget" };
    }
    if (await rejectIncompleteMigration(entry.offset === fileStat.size && !entry.state.discardingLargeLine)) return { dirty: true, aborted: false };
    dirty = plain.dirty || dirty;
    commitStoreTransaction(tx);
    entry.path = filePath;
    if (parserVersion) entry.state[parserKey] = parserVersion;
    if (!plain.pending) {
      entry.size = fileStat.size;
      entry.mtimeMs = fileStat.mtimeMs;
      delete entry.state.scanPending;
    }
    noteCodexForkReplay(entry, sourceSink, { pending: plain.pending });
    return { dirty, aborted: false, pending: plain.pending };
  } catch (error) {
    rollbackStoreTransaction(tx);
    sourceSink.warn(`${source.adapter} ${filePath}: scan failed: ${error.message}`);
    return { dirty: false, aborted: false };
  }
}

export async function scanSources(store, {
  home,
  onProgress,
  onCheckpoint,
  onStreamProgress,
  deadline,
  shouldStop,
  now,
  streamDelayMs,
  mode = "foreground",
} = {}) {
  const warnings = [];
  const stats = {
    files: 0,
    filesRead: 0,
    bytesRead: 0,
    unchangedFiles: 0,
    errors: 0,
    decompressedBytes: 0,
  };
  const sourceState = {};
  for (const source of store.config.sources) {
    sourceState[source.id] = {
      enabled: source.enabled,
      rootCount: source.roots.length,
      rootsAvailable: 0,
      files: 0,
      filesRead: 0,
      bytesRead: 0,
      errors: 0,
    };
  }
  const sink = warningSink(warnings, stats, sourceState);
  const discovered = await discoverFiles(store.config, home, sink, sourceState);
  const antigravityFiles = new Map();
  for (const [key, entry] of Object.entries(store.files)) {
    if (entry.adapter !== "antigravity") continue;
    const conversation = antigravityConversation(entry.path);
    if (!antigravityFiles.has(conversation)) antigravityFiles.set(conversation, []);
    antigravityFiles.get(conversation).push(key);
  }
  const seenInodes = new Set();
  const seenPaths = new Set();
  const options = {
    deadline,
    shouldStop,
    now: now ?? Date.now,
    streamDelayMs,
    onStreamProgress: (progress) => {
      onStreamProgress?.(progress);
    },
  };
  let dirty = false;
  let processed = 0;
  let stopReason = null;
  let abortedFile = null;

  for (const found of discovered) {
    if (stopRequested(options)) {
      stopReason = "stop";
      break;
    }
    if (processed > 0 && deadlineReached(options, options.now())
      && (stats.filesRead > 0 || dirty)) {
      // A tiny budget still guarantees one changed file per slice. Otherwise a
      // slice could repeatedly stop on the same unchanged prefix and never
      // converge; unchanged files remain cheap discovery/stat work.
      stopReason = "budget";
      break;
    }
    onProgress?.({
      processed,
      total: discovered.length,
      file: found.file,
      mode,
      filesRead: stats.filesRead,
      bytesRead: stats.bytesRead,
      phase: "scan",
    });
    processed += 1;
    if (seenPaths.has(found.file)) continue;
    let fileStat;
    try {
      fileStat = await stat(found.file);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        sink.warn(
          `[${found.source.id}] ${found.source.adapter} ${found.file}: cannot stat file: ${error.message}`,
          found.source.id,
        );
      }
      continue;
    }
    if (!fileStat.isFile()) continue;
    const inode = `${fileStat.dev}:${fileStat.ino}`;
    if (seenInodes.has(inode)) continue;
    seenPaths.add(found.file);
    seenInodes.add(inode);
    stats.files += 1;
    sourceState[found.source.id].files += 1;
    const beforeRead = stats.filesRead;
    const beforeBytes = stats.bytesRead;
    // Remove old owners inside the file transaction, before max-upsert can inherit their values.
    const supersededKeys = found.source.adapter === "antigravity"
      ? (antigravityFiles.get(antigravityConversation(found.file)) ?? [])
        .filter((key) => key !== fileKey(found.source.id, found.file))
      : [];
    const result = await scanOneFile(
      store,
      found.source,
      found.file,
      sink,
      stats,
      { ...options, supersededKeys },
    ).catch((error) => {
      sink.warn(
        `[${found.source.id}] ${found.source.adapter} ${found.file}: scan failed: ${error.message}`,
        found.source.id,
      );
      return { dirty: false, aborted: false };
    });
    sourceState[found.source.id].filesRead +=
      stats.filesRead - beforeRead;
    sourceState[found.source.id].bytesRead +=
      stats.bytesRead - beforeBytes;
    dirty = Boolean(result?.dirty) || dirty;
    if (result?.aborted) {
      stopReason = result.reason ?? "budget";
      abortedFile = result.abortedFile ?? {
        sourceId: found.source.id,
        adapter: found.source.adapter,
        path: found.file,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        dev: String(fileStat.dev),
        ino: String(fileStat.ino),
        reason: result.reason ?? "budget",
      };
      break;
    }
    if (result?.pending) {
      // Plain JSONL reached a slice boundary inside a file. The accepted
      // complete prefix is committed and its offset resumes next time.
      stopReason = "budget";
      break;
    }
    await onCheckpoint?.({
      processed,
      total: discovered.length,
      file: found.file,
      stats,
      dirty,
    });
  }

  const sourceStats = {};
  for (const source of store.config.sources) {
    const state = sourceState[source.id];
    let status;
    if (!state.enabled) status = "disabled";
    else if (state.errors > 0) status = "error";
    else if (state.rootCount > 0 && state.rootsAvailable === 0) status = "missing";
    else if (state.files === 0) status = "empty";
    else status = "ok";
    sourceStats[source.id] = {
      status,
      files: state.files,
      filesRead: state.filesRead,
      bytesRead: state.bytesRead,
      errors: state.errors,
    };
  }

  for (const file of unresolvedCodexReferences(store)) {
    sink.note(`[${file.sourceId}] codex ${file.path}: referenced history baseline is unavailable or conflicting; possible inherited spend retained.`);
  }
  const warningCount = sink.finish();
  return {
    stats,
    warnings,
    warningCount,
    dirty,
    sourceStats,
    complete: stopReason === null,
    stopped: stopReason !== null,
    stopReason,
    abortedFile,
    processed,
    total: discovered.length,
  };
}
