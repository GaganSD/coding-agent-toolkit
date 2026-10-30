import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as zlib from "node:zlib";
import { parseAdapterRecord } from "./adapters.mjs";
import {
  MAX_LINE_BYTES,
  expandHome,
  isPlainObject,
} from "./util.mjs";
import {
  addTask,
  addUsage,
  fileKey,
  newFileEntry,
  removeLatestFallbackTaskForSession,
  resetFileEntry,
} from "./store.mjs";

const CHUNK_BYTES = 256 * 1024;
const MAX_WARNINGS = 50;
const MAX_TRAVERSAL_ENTRIES = 250_000;

function warningSink(warnings, stats, sourceState) {
  let hidden = 0;
  let reportedHidden = false;
  return {
    warn(message, sourceId) {
      stats.errors += 1;
      if (sourceId && sourceState?.[sourceId]) sourceState[sourceId].errors += 1;
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
      else hidden += 1;
    },
    note(message) {
      if (warnings.length < MAX_WARNINGS) warnings.push(message);
    },
    finish() {
      if (hidden > 0 && !reportedHidden) {
        reportedHidden = true;
        warnings.push(`${hidden} additional scan warnings were not shown.`);
      }
    },
  };
}

function isEligible(adapter, filePath) {
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
      } else if (entry.isFile() && isEligible(adapter, entry.name)) {
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
  return discovered;
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
          } else if (remainder.length > 0) {
            pending.push(Buffer.from(remainder));
            pendingLength += remainder.length;
          }
        }
        return;
      }
      const absoluteEnd = chunkStart + newline + 1;
      if (discarding) {
        lineNo += 1;
        offset = absoluteEnd;
        discarding = false;
        skippedLargeLine = true;
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
        } else {
          processLine(whole, absoluteEnd, true);
        }
      } else if (piece.length > MAX_LINE_BYTES) {
        lineNo += 1;
        offset = absoluteEnd;
        skippedLargeLine = true;
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
    set offset(value) {
      offset = value;
    },
    set lineNo(value) {
      lineNo = value;
    },
  };
}

async function streamRange(filePath, start, end, onChunk) {
  const handle = await open(filePath, "r");
  let position = start;
  let bytes = 0;
  try {
    while (position < end) {
      const toRead = Math.min(CHUNK_BYTES, end - position);
      const buffer = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      bytes += bytesRead;
      await onChunk(buffer.subarray(0, bytesRead), position - bytesRead);
    }
  } finally {
    await handle.close();
  }
  return bytes;
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

async function parseBuffers(
  store,
  entry,
  source,
  chunks,
  startOffset,
  endOffset,
  sink,
) {
  const context = lineContext(store, entry, source, sink);
  const consumer = createLineConsumer((record, info) => {
    if (info.parseError) {
      sink.warn(
        `${source.adapter} ${entry.path}: line ${info.lineNo} is not valid JSON; skipped.`,
      );
      return;
    }
    if (!isPlainObject(record)) return;
    context.lineHash = info.hash;
    try {
      parseAdapterRecord(source.adapter, record, context);
    } catch (error) {
      sink.warn(
        `${source.adapter} ${entry.path}: line ${info.lineNo} could not be parsed: ${error.message}`,
      );
    }
  });
  consumer.offset = startOffset;
  consumer.lineNo = entry.lineNo ?? 0;
  let chunkStart = startOffset;
  for (const chunk of chunks) {
    consumer.feedAt(chunk, chunkStart);
    chunkStart += chunk.length;
  }
  consumer.finish(endOffset);
  if (consumer.skippedLargeLine) {
    sink.warn(
      `${source.adapter} ${entry.path}: a line larger than ${MAX_LINE_BYTES} bytes was skipped.`,
    );
  }
  return { offset: consumer.offset, lineNo: consumer.lineNo };
}

async function processStringChunks(
  store,
  entry,
  source,
  chunks,
  startOffset,
  endOffset,
  sink,
) {
  return parseBuffers(store, entry, source, chunks, startOffset, endOffset, sink);
}

async function scanPlainFile(
  store,
  entry,
  source,
  filePath,
  fileStat,
  sink,
  stats,
) {
  const adapter = source.adapter;
  let dirty = false;
  const start = entry.offset;

  if (fileStat.size > start) {
    const context = lineContext(store, entry, source, sink);
    const consumer = createLineConsumer((record, info) => {
      if (info.parseError) {
        sink.warn(
          `${adapter} ${entry.path}: line ${info.lineNo} is not valid JSON; skipped.`,
        );
        return;
      }
      if (!isPlainObject(record)) return;
      context.lineHash = info.hash;
      try {
        parseAdapterRecord(adapter, record, context);
      } catch (error) {
        sink.warn(
          `${adapter} ${entry.path}: line ${info.lineNo} could not be parsed: ${error.message}`,
        );
      }
    });
    consumer.offset = start;
    consumer.lineNo = entry.lineNo ?? 0;
    const bytes = await streamRange(
      filePath,
      start,
      fileStat.size,
      async (chunk, chunkStart) => {
        consumer.feedAt(chunk, chunkStart);
      },
    );
    stats.bytesRead += bytes;
    if (bytes > 0) stats.filesRead += 1;
    consumer.finish(fileStat.size);
    if (consumer.skippedLargeLine) {
      sink.warn(
        `${adapter} ${entry.path}: a line larger than ${MAX_LINE_BYTES} bytes was skipped.`,
      );
    }
    entry.offset = consumer.offset;
    entry.lineNo = consumer.lineNo;
    dirty = true;
    return dirty;
  }

  // Size grew but the read returned no bytes; keep the cursor stable.
  if (fileStat.size > start) {
    stats.filesRead += 1;
  }
  return dirty;
}

async function scanCompressedFile(
  store,
  entry,
  source,
  filePath,
  fileStat,
  sink,
  stats,
) {
  if (!hasZstdSupport()) {
    entry.size = fileStat.size;
    entry.mtimeMs = fileStat.mtimeMs;
    entry.offset = fileStat.size;
    entry.state.unsupported = "zstd";
    sink.warn(
      `${source.adapter} ${entry.path}: .jsonl.zst needs Node's zstd API (Node 22.15+); skipped.`,
    );
    return { ok: true, dirty: true };
  }
  const chunks = [];
  try {
    const stream = createReadStream(filePath).pipe(zlib.createZstdDecompress());
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  } catch (error) {
    sink.warn(
      `${source.adapter} ${entry.path}: zstd file could not be decompressed: ${error.message}`,
    );
    return { ok: false, dirty: false };
  }
  stats.bytesRead += fileStat.size;
  if (fileStat.size > 0) stats.filesRead += 1;
  resetFileEntry(store, entry);
  const result = await processStringChunks(
    store,
    entry,
    source,
    chunks,
    0,
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    sink,
  );
  entry.offset = fileStat.size;
  entry.lineNo = result.lineNo;
  return { ok: true, dirty: true };
}

async function scanOneFile(store, source, filePath, sink, stats) {
  const sourceSink = {
    warn(message) {
      sink.warn(`[${source.id}] ${message}`, source.id);
    },
    note(message) {
      sink.note(`[${source.id}] ${message}`);
    },
  };
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      sourceSink.warn(`${source.adapter} ${filePath}: cannot stat file: ${error.message}`);
    }
    return false;
  }
  if (!fileStat.isFile()) return false;

  const key = fileKey(source.id, filePath);
  let entry = store.files[key];
  let dirty = false;
  if (!entry) {
    entry = newFileEntry(store, {
      sourceId: source.id,
      adapter: source.adapter,
      path: filePath,
      dev: String(fileStat.dev),
      ino: String(fileStat.ino),
      size: 0,
      mtimeMs: 0,
      compressed: filePath.endsWith(".jsonl.zst"),
    });
    dirty = true;
  }

  const dev = String(fileStat.dev);
  const ino = String(fileStat.ino);
  let forceRead = false;
  if (entry.adapter === "pi" && entry.state.piParserVersion !== 2) {
    // Older collectors ignored Pi usage carriers and keyed tasks by the fork
    // session. Rescan Pi files once with carrier and stable task accounting.
    resetFileEntry(store, entry);
    forceRead = true;
    dirty = true;
  }
  if (entry.adapter === "codex" && entry.state.codexParserVersion !== 4) {
    // Older collectors accumulated only globally-new Codex deltas into the
    // local pending counter, so copied files could double count their legacy
    // suffix. Rescan Codex files once with local request accounting.
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
    entry.size === fileStat.size &&
    entry.mtimeMs === fileStat.mtimeMs
  ) {
    stats.unchangedFiles += 1;
    return dirty;
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
    );
    if (!compressed.ok) return dirty;
    dirty = compressed.dirty || dirty;
  } else {
    dirty =
      (await scanPlainFile(
        store,
        entry,
        source,
        filePath,
        fileStat,
        sourceSink,
        stats,
      )) || dirty;
  }

  entry.size = fileStat.size;
  entry.mtimeMs = fileStat.mtimeMs;
  entry.path = filePath;
  if (entry.adapter === "pi") entry.state.piParserVersion = 2;
  if (entry.adapter === "codex") entry.state.codexParserVersion = 4;
  return dirty;
}

export async function scanSources(store, { home, onProgress } = {}) {
  const warnings = [];
  const stats = {
    files: 0,
    filesRead: 0,
    bytesRead: 0,
    unchangedFiles: 0,
    errors: 0,
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
  const seenInodes = new Set();
  const seenPaths = new Set();
  let dirty = false;
  let processed = 0;

  for (const found of discovered) {
    onProgress?.({ processed, total: discovered.length, file: found.file });
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
    const changed = await scanOneFile(
      store,
      found.source,
      found.file,
      sink,
      stats,
    ).catch((error) => {
      sink.warn(
        `[${found.source.id}] ${found.source.adapter} ${found.file}: scan failed: ${error.message}`,
        found.source.id,
      );
      return false;
    });
    sourceState[found.source.id].filesRead +=
      stats.filesRead - beforeRead;
    sourceState[found.source.id].bytesRead +=
      stats.bytesRead - beforeBytes;
    dirty = changed || dirty;
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

  sink.finish();
  return { stats, warnings, dirty, sourceStats };
}

export async function rebuildScan(store, { home }) {
  return scanSources(store, { home });
}

export { createLineConsumer, processStringChunks, scanOneFile, walkRoot };
