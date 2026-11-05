/**
 * Antigravity CLI usage from conversations/<id>.db (read-only SQLite).
 * Canonical brain/<id>/.system_generated/logs/transcript.jsonl exports are a
 * fallback in adapters.mjs. Discovery selects one file per conversation: SQLite
 * first, then configured root order. Cached alternatives are removed only after
 * a replacement is accepted. Unreadable databases retain accepted history.
 *
 * Reverse-engineered protobuf mapping (not an official stable API):
 *   gen_metadata.data #1.#19: response model; #1.#4: usage.
 *   Usage #1 + #2: system + uncached input; #5: cache read; #3: total output;
 *   #9: text output; #10: thinking (a subset of output); #11: response ID.
 *   Envelope #2: packed step indexes. steps.metadata #1: creation timestamp,
 *   used only when #9.#11 matches the generation's response ID. Otherwise use
 *   trajectory_metadata_blob creation time, then database mtime, with a note.
 *   Trajectory metadata also supplies the workspace URI.
 * Reject inconsistent output totals; skip prefilled system-only records without
 * measured usage. Response IDs deduplicate copies; missing IDs use conversation
 * and generation index. Provider denotes model publisher, not billing gateway.
 *
 * DB/WAL fingerprints invalidate cached usage. Blobs are read one row at a time,
 * capped at 16 MiB; malformed/oversized records warn. Only usage metadata is
 * persisted, never prompt/output/thinking text. No RPC, credentials or uploads.
 * Retired Gemini CLI history and Antigravity IDE .pb stores are not decoded.
 * See also: https://github.com/junhoyeo/tokscale/pull/713
 *           https://github.com/robinebers/openusage/pull/1139
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  addUsage,
  beginStoreTransaction,
  commitStoreTransaction,
  rollbackStoreTransaction,
  deleteFileEntry,
  fileKey,
  newFileEntry,
  resetFileEntry,
  dedupKeyFor as makeDedupKey,
} from "./store.mjs";
import { localDay } from "./util.mjs";

const VERSION = 2;
const MAX_BLOB = 16 * 1024 * 1024;
const MAX_FIELDS = 100_000;

export function antigravityConversation(file) {
  return file.endsWith(".db")
    ? path.basename(file, ".db")
    : path.basename(path.dirname(path.dirname(path.dirname(file))));
}

// Read only selected protobuf fields. Unknown fields (including prompt payloads)
// are bounded byte slices, never decoded to text or persisted. uint64 uses BigInt
// so unrelated signed/sentinel fields cannot silently overflow JS numbers.
function varint(bytes, cursor) {
  let value = 0n;
  for (let shift = 0; shift < 70; shift += 7) {
    if (cursor.pos >= bytes.length) throw new Error("truncated protobuf varint");
    const byte = bytes[cursor.pos++];
    if (shift === 63 && byte > 1) throw new Error("protobuf uint64 overflow");
    value |= BigInt(byte & 127) << BigInt(shift);
    if (byte < 128) return value;
  }
}

export function protobufFields(bytes) {
  const cursor = { pos: 0 };
  const out = [];
  while (cursor.pos < bytes.length) {
    if (out.length >= MAX_FIELDS) throw new Error("too many protobuf fields");
    const tag = varint(bytes, cursor);
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1 || number > 536870911) throw new Error("invalid protobuf tag");
    let value;
    if (wire === 0) value = varint(bytes, cursor);
    else if (wire === 1 || wire === 2 || wire === 5) {
      const size = wire === 2 ? Number(varint(bytes, cursor)) : wire === 1 ? 8 : 4;
      if (size > bytes.length - cursor.pos) {
        throw new Error("invalid protobuf length");
      }
      value = bytes.subarray(cursor.pos, cursor.pos + size);
      cursor.pos += size;
    } else throw new Error("unsupported protobuf wire type");
    out.push({ number, wire, value });
  }
  return out;
}

function blob(fields, number) {
  return fields.find((f) => f.number === number && f.wire === 2)?.value;
}
function integer(fields, number) {
  const value = fields.find((f) => f.number === number && f.wire === 0)?.value ?? 0n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unsafe usage integer");
  return Number(value);
}
function text(bytes, max = 256) {
  if (!bytes || bytes.length === 0 || bytes.length > max) return "";
  const value = Buffer.from(bytes).toString("utf8");
  return /[\x00-\x1f\x7f\ufffd]/.test(value) ? "" : value;
}
function timestamp(bytes) {
  if (!bytes) return null;
  const fields = protobufFields(bytes);
  const seconds = integer(fields, 1), nanos = integer(fields, 2);
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  return seconds > 0 && nanos < 1e9 && Number.isSafeInteger(ms) &&
    Number.isFinite(new Date(ms).getTime()) ? ms : null;
}
function responseId(usage) { return text(blob(usage, 11)); }
function provider(model) {
  // Model publisher, not the account/billing gateway used by Antigravity.
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("claude-")) return "anthropic";
  return "unknown";
}

export function decodeAntigravityGeneration(bytes) {
  const outer = protobufFields(bytes);
  const packedSteps = blob(outer, 2);
  let step = null;
  if (packedSteps?.length) {
    const value = varint(packedSteps, { pos: 0 });
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) step = Number(value);
  }
  const generations = [];
  let recognizedUsage = false;
  for (const field of outer) {
    if (field.number !== 1 || field.wire !== 2) continue;
    const inner = protobufFields(field.value);
    const usageBytes = blob(inner, 4);
    if (!usageBytes) continue;
    const usage = protobufFields(usageBytes);
    recognizedUsage = true;
    const system = integer(usage, 1), input = integer(usage, 2);
    const output = integer(usage, 3), cacheRead = integer(usage, 5);
    const reasoning = integer(usage, 10), outputText = integer(usage, 9);
    if (!Number.isSafeInteger(system + input + output + cacheRead)) throw new Error("unsafe token total");
    if (outputText + reasoning !== output) throw new Error("inconsistent output accounting");
    // A fixed system-prompt count is prefilled even on abandoned/failed
    // requests with no measured usage. It is not a completed generation.
    if (input + output + cacheRead === 0) continue;
    generations.push({
      step, model: text(blob(inner, 19)) || "unknown", responseId: responseId(usage),
      // Output includes thinking; reasoning is a subset, never added to total.
      tokens: { input: system + input, output, cacheRead, cacheWrite: 0, reasoning },
    });
  }
  if (!recognizedUsage) throw new Error("unrecognized generation metadata");
  return generations;
}

function sessionMetadata(bytes) {
  const fields = protobufFields(bytes);
  let project = "unknown";
  const workspace = blob(fields, 1);
  if (workspace) {
    const uri = text(blob(protobufFields(workspace), 1), 8192);
    try { if (uri.startsWith("file://")) project = fileURLToPath(uri); } catch { /* unknown */ }
  }
  return { timestamp: timestamp(blob(fields, 2)), project };
}

function stepTimestamp(bytes, id) {
  if (!bytes || !id) return null;
  const fields = protobufFields(bytes);
  const usage = blob(fields, 9);
  // Packed step references were validated against response IDs on real stores.
  // Do not attribute a timestamp if a future schema points at a different step.
  if (!usage || responseId(protobufFields(usage)) !== id) return null;
  return timestamp(blob(fields, 1));
}

export async function scanAntigravityDb(store, source, file, sink, stats, options = {}) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code !== "ENOENT") sink.warn(`Antigravity: cannot stat database ${path.basename(file)}; previous accepted data retained.`);
    return { dirty: false, aborted: false };
  }
  if (!info.isFile()) return { dirty: false, aborted: false };
  let wal = null;
  try {
    wal = await stat(`${file}-wal`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      sink.warn(`Antigravity: cannot stat database WAL ${path.basename(file)}; previous accepted data retained.`);
      return { dirty: false, aborted: false };
    }
  }
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
  let entry = store.files[fileKey(source.id, file)];
  const supersededKeys = options.supersededKeys ?? [];
  if (supersededKeys.length === 0 && entry?.state.agyDbVersion === VERSION && entry.state.agyDbFingerprint === fingerprint) {
    for (const warning of entry.state.agyWarnings ?? []) sink.warn(warning);
    for (const note of entry.state.agyNotes ?? []) sink.note(note);
    stats.unchangedFiles += 1;
    return { dirty: false, aborted: false };
  }
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch {
    sink.warn("Antigravity SQLite requires a Node runtime with node:sqlite; skipped.");
    return { dirty: false, aborted: false };
  }
  const tx = beginStoreTransaction(store, { fileId: entry?.id });
  let db;
  const counts = { oversized: 0, malformed: 0, approximateTime: 0, missingId: 0 };
  let rows = 0;
  let decodedRows = 0;
  try {
    for (const key of supersededKeys) deleteFileEntry(store, key);
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    db.exec("BEGIN");
    // SQLite limits the returned blob before it crosses into JS memory.
    const limited = `CASE WHEN length(data) <= ${MAX_BLOB} THEN data ELSE NULL END`;
    let session = {};
    const meta = db.prepare(`SELECT ${limited} AS data FROM trajectory_metadata_blob WHERE id = 'main'`).get();
    if (meta?.data) {
      try { session = sessionMetadata(meta.data); } catch { counts.malformed += 1; }
    } else if (meta) counts.oversized += 1;
    const stepQuery = db.prepare(`SELECT CASE WHEN length(metadata) <= ${MAX_BLOB} THEN metadata ELSE NULL END AS data FROM steps WHERE idx = ?`);
    const records = db.prepare(`SELECT idx, ${limited} AS data FROM gen_metadata ORDER BY idx`).iterate();
    if (!entry) entry = newFileEntry(store, {
      sourceId: source.id, adapter: source.adapter, path: file,
      dev: String(info.dev), ino: String(info.ino), size: 0, mtimeMs: 0, compressed: false,
    });
    else resetFileEntry(store, entry);
    const conversation = antigravityConversation(file);
    for (const record of records) {
      const stopped = options.shouldStop?.();
      const expired = rows > 0 && Number.isFinite(options.deadline) &&
        (options.now ?? Date.now)() >= options.deadline;
      if (stopped || expired) {
        rollbackStoreTransaction(tx);
        return { dirty: false, aborted: true, reason: stopped ? "stop" : "budget" };
      }
      rows += 1;
      if (!record.data) { counts.oversized += 1; continue; }
      let generations;
      try { generations = decodeAntigravityGeneration(record.data); } catch { counts.malformed += 1; continue; }
      decodedRows += 1;
      for (let index = 0; index < generations.length; index += 1) {
        const generation = generations[index];
        let created = null;
        if (generation.step !== null) {
          const step = stepQuery.get(generation.step);
          try { created = stepTimestamp(step?.data, generation.responseId); } catch { /* use documented fallback */ }
        }
        if (created === null) {
          counts.approximateTime += 1;
          created = session.timestamp ?? info.mtimeMs;
        }
        if (!generation.responseId) counts.missingId += 1;
        addUsage(store, entry, {
          day: localDay(created), session: `antigravity:${conversation}`, harness: "antigravity",
          model: generation.model, provider: provider(generation.model), project: session.project ?? "unknown",
        }, generation.tokens, generation.responseId
          ? makeDedupKey("antigravity", "response", generation.responseId)
          : makeDedupKey("antigravity", "generation", conversation, record.idx, index));
      }
    }
    if (rows > 0 && decodedRows === 0) {
      rollbackStoreTransaction(tx);
      sink.warn(`Antigravity ${path.basename(file)}: no decodable generation records; previous accepted data retained.`);
      return { dirty: false, aborted: false };
    }
    db.exec("COMMIT");
    const warnings = [];
    const notes = [];
    const prefix = `Antigravity ${path.basename(file)}:`;
    if (counts.oversized) warnings.push(`${prefix} ${counts.oversized} blobs exceed the 16 MiB limit; skipped.`);
    if (counts.malformed) warnings.push(`${prefix} ${counts.malformed} malformed metadata records were skipped.`);
    if (counts.approximateTime) notes.push(`${prefix} ${counts.approximateTime} generations use session time or database mtime (no verified step timestamp).`);
    if (counts.missingId) notes.push(`${prefix} ${counts.missingId} generations have no response ID; deduplicated by conversation and generation index.`);
    entry.dev = String(info.dev); entry.ino = String(info.ino);
    entry.size = info.size; entry.mtimeMs = info.mtimeMs;
    entry.state.agyDbVersion = VERSION;
    entry.state.agyDbFingerprint = fingerprint;
    entry.state.agyWarnings = warnings;
    entry.state.agyNotes = notes;
    commitStoreTransaction(tx);
    for (const warning of warnings) sink.warn(warning);
    for (const note of notes) sink.note(note);
    stats.filesRead += 1;
    stats.bytesRead += info.size + (wal?.size ?? 0);
    return { dirty: true, aborted: false };
  } catch {
    rollbackStoreTransaction(tx);
    // Do not leak strings from SQLite or protobuf source payloads in diagnostics.
    sink.warn(`Antigravity: cannot read generation database ${path.basename(file)}; previous accepted data retained.`);
    return { dirty: false, aborted: false };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}
