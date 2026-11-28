import { readFile } from "node:fs/promises";
import { storeRevisionFingerprint, writePresentationCache } from "./cache.mjs";
import { defaultConfig, migrateLoadedConfig, normalizeConfig } from "./config.mjs";
import { settleCodexInterval } from "./codex-spend.mjs";
import { codexCheckpointEvidence, codexCycleRoots, codexReferencedInput, readCodexInterval } from "./codex-draft-compat.mjs";
import {
  STORE_VERSION,
  atomicWriteJson,
  backupCorruptStore,
  ensureParent,
  hashKey,
  isPlainObject,
  sessionHash,
  toNonNegInt,
  tokenTotal,
} from "./util.mjs";

export function fileKey(sourceId, filePath) {
  return `${sourceId}\u0000${filePath}`;
}

const SCAN_STATUSES = new Set([
  "idle",
  "running",
  "partial",
  "complete",
  "failed",
  "reconfiguring",
]);

function zeroScanStats() {
  return { files: 0, filesRead: 0, bytesRead: 0, unchangedFiles: 0, errors: 0 };
}

export function emptyScanState() {
  return {
    status: "idle",
    generation: 0,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    processed: 0,
    total: 0,
    stats: zeroScanStats(),
    sourceStats: {},
    warnings: [],
    currentFile: null,
    pendingFile: null,
    workerPid: null,
    error: null,
  };
}

/** Additive, backward-compatible store metadata for truthful scan state. */
export function ensureStoreMeta(store) {
  if (!Number.isInteger(store.generation) || store.generation < 0) store.generation = 0;
  if (store.lastCompletedScanAt === undefined) store.lastCompletedScanAt = null;
  if (!isPlainObject(store.scan)) store.scan = emptyScanState();
  const scan = store.scan;
  if (!SCAN_STATUSES.has(scan.status)) scan.status = "idle";
  if (!Number.isInteger(scan.generation) || scan.generation < 0) scan.generation = 0;
  for (const field of ["startedAt", "updatedAt", "completedAt", "currentFile", "error"]) {
    if (scan[field] === undefined) scan[field] = null;
  }
  if (!isPlainObject(scan.stats)) scan.stats = zeroScanStats();
  if (!isPlainObject(scan.sourceStats)) scan.sourceStats = {};
  if (!Array.isArray(scan.warnings)) scan.warnings = [];
  if (!Number.isInteger(scan.processed) || scan.processed < 0) scan.processed = 0;
  if (!Number.isInteger(scan.total) || scan.total < 0) scan.total = 0;
  if (scan.pendingFile !== null && !isPlainObject(scan.pendingFile)) scan.pendingFile = null;
  if (!Number.isInteger(scan.workerPid) || scan.workerPid <= 0) scan.workerPid = null;
  return store;
}

export function storeGeneration(store) {
  const value = Number(store?.generation);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function emptyStore(config = defaultConfig()) {
  const store = {
    version: STORE_VERSION,
    config,
    generation: 0,
    nextFileId: 1,
    files: {},
    dedup: {},
    tasks: {},
    lastScanAt: null,
    lastCompletedScanAt: null,
    scan: emptyScanState(),
  };
  prepareStore(store);
  return store;
}

export function prepareStore(store) {
  const byId = new Map();
  for (const entry of Object.values(store.files ?? {})) {
    if (entry && Number.isInteger(entry.id)) {
      byId.set(entry.id, entry);
      attachStore(entry, store);
    }
  }
  Object.defineProperty(store, "_byId", {
    value: byId,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(store, "_codexEchoes", {
    value: new Set(codexEchoKeys(store)),
    configurable: true,
  });
  return store;
}

function attachStore(entry, store) {
  if (entry._store === store) return;
  Object.defineProperty(entry, "_store", {
    value: store, enumerable: false, writable: true, configurable: true,
  });
}

export function findFileById(store, id) {
  if (!store._byId) prepareStore(store);
  return store._byId.get(id) ?? null;
}

export function addFileEntry(store, entry) {
  if (!store._byId) prepareStore(store);
  const key = fileKey(entry.sourceId, entry.path);
  const tx = store._tx;
  if (tx) {
    const existing = store.files[key];
    if (existing && existing !== entry) tx.trackFile(existing);
    if (!existing) tx.createdFileKeys.add(key);
    if (!existing || existing.id !== entry.id) tx.createdFileIds.add(entry.id);
  }
  store.files[key] = entry;
  store._byId.set(entry.id, entry);
  attachStore(entry, store);
  return entry;
}

const TX_MISSING = Symbol("insights-tx-missing");

function cloneAux(value, index) {
  const aux = value[index];
  if (!isPlainObject(aux)) return value;
  const copy = { ...aux };
  if (Array.isArray(aux.copies)) copy.copies = [...aux.copies];
  if (isPlainObject(aux.copyTargets)) copy.copyTargets = { ...aux.copyTargets };
  if (isPlainObject(aux.codexObserved)) copy.codexObserved = { ...aux.codexObserved };
  if (isPlainObject(aux.meta)) copy.meta = { ...aux.meta };
  value[index] = copy;
  return value;
}

function cloneRecord(value, auxIndex) {
  if (!Array.isArray(value)) return value;
  return cloneAux([...value], auxIndex);
}

function snapshotFileEntry(entry) {
  const fields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "rows" || key === "tasks" || key === "state" || key === "_rowIndex") continue;
    fields[key] = value;
  }
  return {
    entry,
    fields,
    rowsRef: Array.isArray(entry.rows) ? entry.rows : null,
    rowsLength: Array.isArray(entry.rows) ? entry.rows.length : 0,
    rows: new Map(),
    tasksRef: Array.isArray(entry.tasks) ? entry.tasks : null,
    tasks: Array.isArray(entry.tasks) ? [...entry.tasks] : [],
    state: structuredClone(entry.state ?? {}),
  };
}

/**
 * Precise per-file transaction. Existing mutation helpers keep their single
 * accounting implementation; they only announce which dedup/task/row records
 * they are about to touch. Unchanged history is never cloned, so cost follows
 * the records a file actually changes rather than the whole accumulated store.
 */
export function beginStoreTransaction(store, { fileId } = {}) {
  if (store._tx) throw new Error("a store transaction is already active");
  const tx = {
    store,
    savedFiles: new Map(),
    savedDedup: new Map(),
    savedTasks: new Map(),
    createdFileKeys: new Set(),
    createdFileIds: new Set(),
    deletedFiles: new Map(),
    nextFileId: store.nextFileId,
    active: true,
    trackFile(entry) {
      if (!entry || !Number.isInteger(entry.id)) return null;
      if (tx.createdFileIds.has(entry.id)) return null;
      if (!tx.savedFiles.has(entry.id)) tx.savedFiles.set(entry.id, snapshotFileEntry(entry));
      return tx.savedFiles.get(entry.id);
    },
    trackFileById(id) {
      const entry = findFileById(store, id);
      return tx.trackFile(entry);
    },
    trackRow(entry, index) {
      if (!entry || !Number.isInteger(index) || index < 0) return;
      const record = tx.trackFile(entry);
      if (!record) return;
      // When a reset replaced the rows array, rollback restores the original
      // array wholesale; per-index snapshots of the new array would overwrite it.
      if (record.rowsRef && entry.rows !== record.rowsRef) return;
      // Rows created during the transaction are removed by truncating to the
      // original length; do not re-add them from a later snapshot.
      if (index >= record.rowsLength) return;
      if (!record.rows.has(index)) {
        const row = entry.rows?.[index];
        record.rows.set(index, isPlainObject(row) ? { ...row } : row);
      }
    },
    touchDedup(key) {
      if (tx.savedDedup.has(key)) return;
      const value = Object.hasOwn(store.dedup, key) ? store.dedup[key] : TX_MISSING;
      tx.savedDedup.set(key, value === TX_MISSING ? TX_MISSING : cloneRecord(value, DEDUP_AUX_INDEX));
    },
    touchTask(key) {
      if (tx.savedTasks.has(key)) return;
      const value = Object.hasOwn(store.tasks, key) ? store.tasks[key] : TX_MISSING;
      tx.savedTasks.set(key, value === TX_MISSING ? TX_MISSING : cloneRecord(value, TASK_AUX_INDEX));
    },
    deleteFileEntry(key, entry) {
      tx.trackFile(entry);
      tx.deletedFiles.set(key, entry);
      tx.createdFileKeys.delete(key);
    },
  };
  Object.defineProperty(store, "_tx", {
    value: tx, enumerable: false, writable: true, configurable: true,
  });
  if (Number.isInteger(fileId)) tx.trackFileById(fileId);
  return tx;
}

export function commitStoreTransaction(tx) {
  if (!tx?.active) return false;
  tx.active = false;
  if (tx.store._tx === tx) delete tx.store._tx;
  return true;
}

export function rollbackStoreTransaction(tx) {
  if (!tx?.active) return false;
  tx.active = false;
  const store = tx.store;
  for (const saved of tx.savedFiles.values()) {
    const entry = saved.entry;
    for (const key of Object.keys(entry)) {
      if (key === "rows" || key === "tasks" || key === "state" || key === "_rowIndex") continue;
      if (!Object.hasOwn(saved.fields, key)) delete entry[key];
    }
    Object.assign(entry, saved.fields);
    if (saved.rowsRef) {
      saved.rowsRef.length = saved.rowsLength;
      for (const [index, row] of saved.rows) saved.rowsRef[index] = row;
      entry.rows = saved.rowsRef;
    } else {
      entry.rows = [];
    }
    taskIndexes.delete(entry);
    if (saved.tasksRef) {
      saved.tasksRef.length = 0;
      saved.tasksRef.push(...saved.tasks);
      entry.tasks = saved.tasksRef;
    } else {
      entry.tasks = [];
    }
    entry.state = saved.state;
    // A row mutation can invalidate the transient row index. Rebuilding it
    // lazily after rollback is cheap relative to a rare corrupt archive.
    delete entry._rowIndex;
  }
  for (const [key, value] of tx.savedDedup) {
    if (value === TX_MISSING) delete store.dedup[key];
    else store.dedup[key] = value;
  }
  for (const [key, value] of tx.savedTasks) {
    if (value === TX_MISSING) delete store.tasks[key];
    else store.tasks[key] = value;
  }
  for (const key of tx.createdFileKeys) {
    const entry = store.files[key];
    if (entry && tx.createdFileIds.has(entry.id)) {
      delete store.files[key];
      store._byId?.delete(entry.id);
    }
  }
  for (const [key, entry] of tx.deletedFiles) {
    store.files[key] = entry;
    store._byId?.set(entry.id, entry);
  }
  store.nextFileId = tx.nextFileId;
  if (store._tx === tx) delete store._tx;
  // Rebuild the transient id index from the restored file map. Rollback is a
  // rare recovery path, so an O(files) rebuild is preferable to a stale index.
  prepareStore(store);
  return true;
}

export function newFileEntry(store, values) {
  const entry = {
    id: store.nextFileId++,
    ...values,
    offset: 0,
    lineNo: 0,
    rows: [],
    tasks: [],
    state: {},
  };
  addFileEntry(store, entry);
  return entry;
}

export function deleteFileEntry(store, key) {
  const entry = store.files[key];
  if (!entry) return null;
  store._tx?.deleteFileEntry(key, entry);
  removeOwnedMetadata(store, entry.id);
  delete store.files[key];
  if (store._byId) store._byId.delete(entry.id);
  return entry;
}

export function removeOwnedMetadata(store, fileId) {
  const tx = store._tx;
  for (const [key, value] of Object.entries(store.dedup)) {
    if (!Array.isArray(value)) continue;
    const aux = value[DEDUP_AUX_INDEX];
    const hasCopy = isPlainObject(aux) && Array.isArray(aux.copies) && aux.copies.includes(fileId);
    if (hasCopy) tx?.touchDedup(key);
    if (hasCopy) {
      dropCopyCandidate(value, DEDUP_AUX_INDEX, fileId);
      if (aux.codexObserved) delete aux.codexObserved[fileId];
    }
    if (value[0] !== fileId) continue;
    tx?.touchDedup(key);
    if (transferDedupOwnership(store, value)) continue;
    store._codexEchoes.delete(key);
    delete store.dedup[key];
  }
  for (const [key, value] of Object.entries(store.tasks)) {
    if (!Array.isArray(value)) continue;
    const aux = value[TASK_AUX_INDEX];
    const hasCopy = isPlainObject(aux) && Array.isArray(aux.copies) && aux.copies.includes(fileId);
    if (hasCopy) {
      tx?.touchTask(key);
      dropCopyCandidate(value, TASK_AUX_INDEX, fileId);
      if (aux.copyTargets) delete aux.copyTargets[fileId];
    }
    if (value[0] !== fileId) continue;
    tx?.touchTask(key);
    if (transferTaskOwnership(store, value)) continue;
    delete store.tasks[key];
  }
}

export function resetFileEntry(store, entry) {
  store._tx?.trackFile(entry);
  removeOwnedMetadata(store, entry.id);
  entry.offset = 0;
  entry.lineNo = 0;
  entry.rows = [];
  delete entry._rowIndex;
  entry.tasks = [];
  entry.state = {};
  return entry;
}

export function clearCollectedData(store) {
  if (store._tx) throw new Error("cannot clear collected data inside a transaction");
  store.files = {};
  store.dedup = {};
  store.tasks = {};
  delete store.codexAliases;
  store.nextFileId = 1;
  prepareStore(store);
}

export function getOrCreateRow(file, meta) {
  storeTrackFileForRow(file);
  // OpenCode puts the entire history in one file. A linear search here makes
  // a cold scan quadratic in the number of session/model buckets.
  if (!file._rowIndex || file._rowIndex.length !== file.rows.length) {
    const map = new Map();
    file.rows.forEach((row, index) => {
      const key = rowKey(row);
      if (!map.has(key)) map.set(key, index);
    });
    Object.defineProperty(file, "_rowIndex", {
      value: { map, length: file.rows.length }, configurable: true,
    });
  }
  const key = rowKey(meta);
  const existing = file._rowIndex.map.get(key);
  if (existing !== undefined) return existing;
  file.rows.push({
    day: meta.day,
    session: meta.session,
    harness: meta.harness,
    provider: meta.provider,
    model: meta.model,
    project: meta.project,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    messages: 0,
  });
  const index = file.rows.length - 1;
  file._rowIndex.map.set(key, index);
  file._rowIndex.length = file.rows.length;
  return index;
}

function storeTrackFileForRow(file) {
  const store = file?._store;
  if (!store?._tx) return;
  store._tx.trackFile(file);
}

function addRowTokens(row, tokens) {
  row.input = toNonNegInt(row.input + tokens.input);
  row.output = toNonNegInt(row.output + tokens.output);
  row.cacheRead = toNonNegInt(row.cacheRead + tokens.cacheRead);
  row.cacheWrite = toNonNegInt(row.cacheWrite + tokens.cacheWrite);
  row.reasoning = toNonNegInt(row.reasoning + tokens.reasoning);
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const DEDUP_AUX_INDEX = 7;
const TASK_AUX_INDEX = 5;

function rowMeta(row) {
  return {
    day: row.day,
    session: row.session,
    harness: row.harness,
    provider: row.provider,
    model: row.model,
    project: row.project,
  };
}

function validAuxMeta(meta) {
  return (
    isPlainObject(meta) &&
    ["day", "session", "harness", "provider", "model", "project"].every(
      (field) => typeof meta[field] === "string",
    )
  );
}

function auxFor(entry, index, row) {
  let aux = entry[index];
  if (!isPlainObject(aux)) aux = {};
  if (!Array.isArray(aux.copies)) aux.copies = [];
  if (!validAuxMeta(aux.meta)) aux.meta = rowMeta(row);
  entry[index] = aux;
  return aux;
}

function recordCopyCandidate(entry, index, row, fileId) {
  const aux = auxFor(entry, index, row);
  if (!aux.copies.includes(fileId)) aux.copies.push(fileId);
}

function refreshConcreteProvider(owner, row, entry, meta) {
  if (
    row.provider !== "unknown" ||
    typeof meta.provider !== "string" ||
    meta.provider.length === 0 ||
    meta.provider === "unknown"
  ) {
    return false;
  }
  row.provider = meta.provider;
  // The row's bucket key changed. Rebuild the transient index lazily rather
  // than trying to merge another row that may already occupy the new bucket.
  delete owner._rowIndex;
  const aux = entry[DEDUP_AUX_INDEX];
  if (isPlainObject(aux) && validAuxMeta(aux.meta)) aux.meta.provider = meta.provider;
  return true;
}

function dropCopyCandidate(entry, index, fileId) {
  const aux = entry[index];
  if (!isPlainObject(aux) || !Array.isArray(aux.copies)) return;
  aux.copies = aux.copies.filter((id) => id !== fileId);
}

function takeCandidate(store, aux) {
  while (aux.copies.length > 0) {
    const candidateId = aux.copies.shift();
    const candidate = findFileById(store, candidateId);
    if (candidate) return candidate;
  }
  return null;
}

// Only live copy membership plus the writer's parser stamp can turn an
// auxiliary observation into a migration witness. Downgrades may leave
// unknown observation fields behind after retiring or rewriting a copy.
function liveCodexObservation(store, aux, id) {
  const observation = aux.codexObserved?.[id];
  const parser = findFileById(store, id)?.state.codexParserVersion;
  return observation && parser >= 17 && parser === (observation.parserVersion ?? 17) ? observation : null;
}

function transferDedupOwnership(store, entry) {
  const aux = entry[DEDUP_AUX_INDEX];
  if (!isPlainObject(aux) || !Array.isArray(aux.copies) || !validAuxMeta(aux.meta)) {
    return false;
  }
  if (aux.codexObserved) {
    // Old maxima may contain a real revision from any unreparsed copy.
    const unread = aux.copies.find((id) => findFileById(store, id) && !liveCodexObservation(store, aux, id));
    if (unread !== undefined) {
      aux.copies = [unread, ...aux.copies.filter((id) => id !== unread)];
    } else {
      let verified = [0, 0, 0, 0, 0];
      for (const id of aux.copies) {
        const observation = liveCodexObservation(store, aux, id);
        if (observation) verified = codexRevisionVector(verified, observation.tokens);
      }
      entry.splice(2, TOKEN_FIELDS.length, ...verified);
      aux.meta = liveCodexObservation(store, aux, aux.copies.find((id) => findFileById(store, id)))?.meta ?? aux.meta;
      delete aux.codexObserved;
    }
  }
  const candidate = takeCandidate(store, aux);
  if (!candidate) return false;
  store._tx?.trackFile(candidate);
  const rowIdx = getOrCreateRow(candidate, aux.meta);
  store._tx?.trackRow(candidate, rowIdx);
  const row = candidate.rows[rowIdx];
  addRowTokens(row, {
    input: entry[2],
    output: entry[3],
    cacheRead: entry[4],
    cacheWrite: entry[5],
    reasoning: entry[6],
  });
  row.messages = toNonNegInt(row.messages + 1);
  entry[0] = candidate.id;
  entry[1] = rowIdx;
  return true;
}

function transferTaskOwnership(store, entry) {
  const aux = entry[TASK_AUX_INDEX];
  if (!isPlainObject(aux) || !Array.isArray(aux.copies) || !validAuxMeta(aux.meta)) {
    return false;
  }
  const candidate = takeCandidate(store, aux);
  if (!candidate) return false;
  store._tx?.trackFile(candidate);
  if (aux.usageKey) {
    const previous = aux.usageKey;
    aux.usageKey = aux.copyTargets?.[candidate.id] ?? previous;
    if (aux.copyTargets) {
      delete aux.copyTargets[candidate.id];
      for (const id of aux.copies) aux.copyTargets[id] ??= previous;
    }
    entry[1] = -1;
  } else {
    entry[1] = getOrCreateRow(candidate, aux.meta);
  }
  entry[0] = candidate.id;
  return true;
}

// Usage dedup is a max-upsert: Claude streams the same message.id repeatedly
// and revises its numbers upward. One message, maximum numeric value per field.
export function addUsage(store, file, meta, tokens, dedupKey, codexRevision = false) {
  const tx = store._tx;
  const entry = store.dedup[dedupKey];
  if (Array.isArray(entry)) {
    const owner = findFileById(store, entry[0]);
    const row = owner?.rows?.[entry[1]];
    if (owner && row) {
      tx?.trackFile(owner);
      tx?.trackRow(owner, entry[1]);
      tx?.touchDedup(dedupKey);
      let changed = refreshConcreteProvider(owner, row, entry, meta);
      const added = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      };
      const revision = codexRevision && codexRevisionVector(entry.slice(2, 7), TOKEN_FIELDS.map((field) => toNonNegInt(tokens[field])));
      for (let index = 0; index < TOKEN_FIELDS.length; index += 1) {
        const field = TOKEN_FIELDS[index];
        const previous = toNonNegInt(entry[index + 2]);
        const next = revision ? revision[index] : tokens[field] > previous ? tokens[field] : previous;
        if (next !== previous) {
          added[field] = Math.max(0, next - previous);
          row[field] = toNonNegInt(row[field] + next - previous);
          entry[index + 2] = next;
          changed = true;
        }
      }
      if (owner.id !== file.id) {
        recordCopyCandidate(entry, DEDUP_AUX_INDEX, row, file.id);
      }
      return {
        fileId: owner.id,
        rowIdx: entry[1],
        row,
        isNew: false,
        changed,
        added,
      };
    }
    // Save the stale entry before removing it so a rollback restores the
    // exact committed dedup map, including an owner that no longer exists.
    tx?.touchDedup(dedupKey);
    store._codexEchoes.delete(dedupKey);
    delete store.dedup[dedupKey];
  }

  tx?.trackFile(file);
  tx?.touchDedup(dedupKey);
  const rowIdx = getOrCreateRow(file, meta);
  tx?.trackRow(file, rowIdx);
  const row = file.rows[rowIdx];
  addRowTokens(row, tokens);
  row.messages = toNonNegInt(row.messages + 1);
  store.dedup[dedupKey] = [
    file.id,
    rowIdx,
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.reasoning,
  ];
  return {
    fileId: file.id,
    rowIdx,
    row,
    isNew: true,
    changed: true,
    added: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      reasoning: tokens.reasoning,
    },
  };
}

export function addTask(
  store,
  fileId,
  rowIdx,
  taskKey,
  durationMs,
  session,
  exact,
  candidateFileId = fileId,
) {
  const ms = toNonNegInt(durationMs);
  const tx = store._tx;
  const owner = findFileById(store, fileId);
  const row = owner?.rows?.[rowIdx];
  if (!owner || !row) return false;
  tx?.trackFile(owner);
  const existing = store.tasks[taskKey];
  if (Array.isArray(existing)) {
    tx?.touchTask(taskKey);
    if (existing[0] !== candidateFileId) {
      const existingOwner = findFileById(store, existing[0]);
      const existingRow = existingOwner?.rows?.[existing[1]];
      if (existingOwner && existingRow) {
        recordCopyCandidate(existing, TASK_AUX_INDEX, existingRow, candidateFileId);
      }
    }
    if (existing[0] === fileId && exact && existing[3] === 0) {
      existing[2] = ms;
      existing[3] = 1;
      return true;
    }
    if (existing[0] === fileId && !exact && existing[3] === 0 && ms > existing[2]) {
      existing[2] = ms;
      return true;
    }
    return false;
  }
  const sHash = sessionHash(session);
  tx?.touchTask(taskKey);
  store.tasks[taskKey] = [fileId, rowIdx, ms, exact ? 1 : 0, sHash];
  if (!Array.isArray(owner.tasks)) owner.tasks = [];
  appendTaskKey(owner, taskKey);
  return true;
}

function codexEchoKeys(store) {
  return Object.keys(store.dedup ?? {}).filter((key) => store.dedup[key]?.[DEDUP_AUX_INDEX]?.echo);
}

function codexUsageRow(store, entry) {
  return Array.isArray(entry) ? findFileById(store, entry[0])?.rows?.[entry[1]] : null;
}

// Keep the snapshot's contribution and its real copy owners. It is only
// suppressed while the authoritative response still exists in the store.
export function linkCodexSnapshot(store, snapshotKey, responseKey) {
  const entry = store.dedup[snapshotKey];
  if (!codexUsageRow(store, entry) || snapshotKey === responseKey || store.dedup[responseKey]?.[DEDUP_AUX_INDEX]?.echo) return;
  const existing = entry[DEDUP_AUX_INDEX]?.echo;
  if (existing) return;
  store._tx?.touchDedup(snapshotKey);
  // Current parsers write links only for legacy snapshots with a response ID.
  (entry[DEDUP_AUX_INDEX] ??= {}).echo = { key: responseKey, revision: true };
  store._codexEchoes.add(snapshotKey);
}

function codexTaskRow(store, key) {
  const usage = store.dedup[key];
  const echo = usage?.[DEDUP_AUX_INDEX]?.echo;
  const response = echo && !echo.total && !echo.covered && codexUsageRow(store, store.dedup[echo.key]);
  return response || codexUsageRow(store, usage);
}

// Cache classifications partition raw input; they are not additional spend.
const codexRawInput = ([input, , read, write]) => input + read + write;

function codexRevisionVector(previous, current) {
  const raw = Math.max(codexRawInput(previous), codexRawInput(current));
  const read = Math.min(raw, Math.max(previous[2], current[2]));
  const write = Math.min(raw - read, Math.max(previous[3], current[3]));
  return [raw - read - write, Math.max(previous[1], current[1]), read, write, Math.max(previous[4], current[4])];
}

function codexRevisionOverlap(source, target) {
  const overlap = source.map((amount, i) => Math.min(amount, target[i]));
  let reclassified = Math.min(codexRawInput(source), codexRawInput(target)) - codexRawInput(overlap);
  for (const i of [0, 2, 3]) {
    const amount = Math.min(reclassified, source[i] - overlap[i]);
    overlap[i] += amount;
    reclassified -= amount;
  }
  return overlap;
}

// Only migrated/rebound tasks need a membership index. Normal appends already
// know that the global task key is new. File task-key order has no semantics.
const taskIndexes = new WeakMap();

function indexFileTasks(file) {
  let index = taskIndexes.get(file);
  if (!index || index.list !== file.tasks) {
    index = { list: file.tasks, positions: new Map(file.tasks.map((key, i) => [key, i])) };
    taskIndexes.set(file, index);
  }
  return index.positions;
}

function appendTaskKey(file, key) {
  const index = taskIndexes.get(file);
  if (index && index.list === file.tasks) index.positions.set(key, file.tasks.length);
  file.tasks.push(key);
}

function removeTaskKey(file, key) {
  const positions = indexFileTasks(file);
  const at = positions.get(key);
  if (at === undefined) return;
  const last = file.tasks.pop();
  positions.delete(key);
  if (at !== file.tasks.length) {
    file.tasks[at] = last;
    positions.set(last, at);
  }
}

export function addCodexTask(store, file, usageKey, taskKey, durationMs, session) {
  const reference = file.state.codexReferencedInterval;
  const row = codexTaskRow(store, usageKey) ?? (reference?.key === usageKey ? reference.input?.target : null);
  if (!row) return false;
  const tx = store._tx;
  const task = store.tasks[taskKey];
  const previous = task?.[TASK_AUX_INDEX];
  tx?.touchTask(taskKey);
  if (previous?.usageKey && task[1] === -1) {
    const previousDuration = task[2];
    task[2] = Math.max(previousDuration, toNonNegInt(durationMs));
    if (task[0] !== file.id) {
      recordCopyCandidate(task, TASK_AUX_INDEX, row, file.id);
      if (previous.usageKey !== usageKey) (previous.copyTargets ??= {})[file.id] = usageKey;
    }
    return task[2] !== previousDuration;
  }
  // An older entry's row pointer is not reliable after reconciliation. Keep
  // legitimate task copies, but tie the new task to the recording file.
  const oldOwner = task && findFileById(store, task[0]);
  if (oldOwner && oldOwner !== file) {
    tx?.trackFile(oldOwner);
    removeTaskKey(oldOwner, taskKey);
  }
  const copies = task ? [...new Set([task[0], ...(previous?.copies ?? [])])].filter((id) => id !== file.id) : [];
  tx?.trackFile(file);
  if (!task || !indexFileTasks(file).has(taskKey)) appendTaskKey(file, taskKey);
  const duration = Math.max(toNonNegInt(task?.[2]), toNonNegInt(durationMs));
  store.tasks[taskKey] = [file.id, -1, duration, 1, sessionHash(session), { meta: rowMeta(row), copies, usageKey }];
  return true;
}

// Reconstruct evidence from the index being replaced, never from a cached
// list that can outlive a downgrade and a subsequent v9 append.
export function codexIndexedEvidence(store, file) {
  const usage = new Map();
  const tasks = new Map();
  const foreignTaskRows = new Map();
  const rows = (file.rows ?? []).map(() => [0, 0, 0, 0, 0, 0]);
  let consistent = true;
  for (const [key, entry] of Object.entries(store.dedup)) {
    if (!Array.isArray(entry)) continue;
    const owned = entry[0] === file.id;
    const copies = entry[DEDUP_AUX_INDEX]?.copies;
    if (!owned && !copies?.includes(file.id)) continue;
    const max = entry.slice(2, 7);
    // Shared values remain protected by an old owner until the last old
    // copy verifies them, either directly or using already-verified copies.
    const unread = owned && copies?.some((id) => findFileById(store, id)?.state.codexParserVersion <= 9);
    const required = (vector) => [codexRawInput(vector), vector[1], vector[4], vector[2], vector[3]];
    let value = owned && !unread ? required(max) : null;
    if (value) {
      for (const id of copies ?? []) {
        const copy = liveCodexObservation(store, entry[DEDUP_AUX_INDEX], id);
        if (!copy) continue;
        const known = required(copy.tokens);
        value = value.map((n, i) => known[i] >= n ? 0 : n);
      }
    }
    usage.set(key, value);
    if (!owned) continue;
    const row = rows[entry[1]];
    if (!row) { consistent = false; continue; }
    max.forEach((n, i) => { row[i] += n; });
    row[5] += 1;
  }
  for (const [key, task] of Object.entries(store.tasks)) {
    if (!Array.isArray(task)) continue;
    if (task[0] === file.id || task[TASK_AUX_INDEX]?.copies?.includes(file.id)) tasks.set(key, task[2]);
    // Old exact tasks could be owned by the file holding the shared usage
    // row rather than by the session that emitted the completion.
    const row = task[0] === file.id && file.state.codexParserVersion <= 9 && task[3] === 1 && file.rows[task[1]];
    if (row && row.session !== `codex:${file.state.session}` && task[4] === sessionHash(row.session)) {
      foreignTaskRows.set(key, rowMeta(row));
    }
  }
  for (const key of file.tasks ?? []) if (!Array.isArray(store.tasks[key])) consistent = false;
  return { usage, tasks, foreignTaskRows, consistent: consistent && rows.every((sum, i) => {
    const row = file.rows[i];
    return TOKEN_FIELDS.every((field, j) => row[field] === sum[j]) && row.messages === sum[5];
  }) };
}

export function addCodexUsage(store, file, meta, tokens, key, parserVersion) {
  const prior = store.dedup[key];
  const owner = Array.isArray(prior) && findFileById(store, prior[0]);
  const stale = owner && owner !== file && owner.state.codexParserVersion !== parserVersion;
  const result = addUsage(store, file, meta, tokens, key, true);
  const entry = store.dedup[key];
  // A byte-preserving clip may lack the turn context. Enrich an unknown
  // bucket when a full copy supplies it, without moving timed usage to a
  // different day or changing the first known model of a revised response.
  if (!stale && owner && result.row.model === "unknown" && meta.model !== "unknown" &&
    result.row.day === meta.day && result.row.session === meta.session) {
    const previous = result.row;
    const better = { ...rowMeta(previous), model: meta.model,
      project: previous.project === "unknown" ? meta.project : previous.project };
    const index = getOrCreateRow(owner, better);
    store._tx?.trackRow(owner, index);
    const row = owner.rows[index];
    for (const [i, field] of TOKEN_FIELDS.entries()) {
      previous[field] -= entry[i + 2];
      row[field] += entry[i + 2];
    }
    previous.messages -= 1;
    row.messages += 1;
    entry[1] = index;
    if (entry[DEDUP_AUX_INDEX]?.meta) entry[DEDUP_AUX_INDEX].meta = rowMeta(row);
    Object.assign(result, { rowIdx: index, row, changed: true });
  }
  if (stale) {
    const aux = entry[DEDUP_AUX_INDEX];
    const observations = aux.codexObserved ??= {};
    const earlier = observations[file.id];
    observations[file.id] = {
      parserVersion,
      meta: earlier?.meta ?? rowMeta(meta),
      tokens: codexRevisionVector(earlier?.tokens ?? [0, 0, 0, 0, 0], TOKEN_FIELDS.map((field) => tokens[field])),
    };
  }
  return result;
}

export function removeLatestFallbackTaskForSession(store, session) {
  const sHash = sessionHash(session);
  const keys = Object.keys(store.tasks);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    const entry = store.tasks[key];
    if (Array.isArray(entry) && entry[3] === 0 && entry[4] === sHash) {
      store._tx?.touchTask(key);
      delete store.tasks[key];
      const owner = findFileById(store, entry[0]);
      store._tx?.trackFile(owner);
      if (Array.isArray(owner?.tasks)) {
        owner.tasks = owner.tasks.filter((taskKey) => taskKey !== key);
      }
      return {
        key,
        fileId: entry[0],
        rowIdx: entry[1],
        milliseconds: entry[2],
      };
    }
  }
  return null;
}

function emptyAggregate(meta) {
  return {
    day: meta.day,
    session: meta.session,
    harness: meta.harness,
    provider: meta.provider,
    model: meta.model,
    project: meta.project,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
    messages: 0,
    activeMs: 0,
    longestTaskMs: 0,
  };
}

function codexReferenceIndex(store) {
  const files = Object.values(store.files).filter((file) => file.adapter === "codex");
  const index = new Map();
  if (!files.some((file) => file.state.codexReferencedInterval)) return index;
  for (const file of files) {
    const id = file.state.codexPhysicalId ?? file.state.session;
    if (!id) continue;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(file);
  }
  return index;
}

function codexReferencedBaseline(index, base, visited = new Set()) {
  if (!base) return null;
  const [id, ordinal, offset] = base;
  if (visited.has(id)) return null;
  const next = new Set([...visited, id]);
  let result = null;
  for (const file of index.get(id) ?? []) {
    const endOrdinal = (file.lineNo || file.state.codexOrdinal || 0) + (file.state.codexHistoryBase?.[1] ?? 0);
    if (endOrdinal < ordinal ||
      ((file.state.codexDecodedBytes ?? file.offset) > 0 && (file.state.codexDecodedBytes ?? file.offset) < offset)) continue;
    const points = file.state.codexHistoryPoints ?? [];
    const point = points.findLast(([line, end]) => line <= ordinal && (!end || end <= offset));
    if (point && point[1] && ((point[0] === ordinal) !== (point[1] === offset))) continue;
    const history = point?.[2] ?? (file.state.codexHistoryBase && !file.state.codexFilteredHistory ?
      codexReferencedBaseline(index, file.state.codexHistoryBase, next) : [0, 0, 0, 0, 0]);
    if (!history) continue;
    if (result && String(result) !== String(history)) return null; // Conflicting parent copies.
    result = history;
  }
  return result;
}

export function unresolvedCodexReferences(store) {
  const index = codexReferenceIndex(store);
  return Object.values(store.files).filter((file) => file.state.codexReferencedInterval &&
    file.state.codexReferencedInterval.input?.inheritance !== "filtered" &&
    !codexReferencedBaseline(index, file.state.codexHistoryBase));
}

// Compatibility for unavailable draft stores. Current links have only
// {key, revision}; historical checkpoint links may need draft evidence.
function resolveCodexLinks(store, charges, redirects) {
  const echoes = store._codexEchoes ?? codexEchoKeys(store);
  const preserved = codexCycleRoots(store, echoes, DEDUP_AUX_INDEX);
  const checkpoints = codexCheckpointEvidence(store, echoes, DEDUP_AUX_INDEX, (id) => dedupKeyFor("codex", "response", id));
  for (const key of echoes) {
    const snapshot = store.dedup[key];
    const echo = snapshot?.[DEDUP_AUX_INDEX]?.echo;
    const target = echo && store.dedup[echo.key];
    if (preserved.has(key) || !codexUsageRow(store, target)) continue;
    const coverage = echo.total ? checkpoints.get(echo.key + "/" + echo.total)
      : echo.revision ? codexRevisionOverlap(snapshot.slice(2, 7), target.slice(2, 7)) : echo.covered;
    if (echo.total && !coverage) continue;
    const vector = snapshot.slice(2, 7).map((n, i) => Math.max(0, n - (coverage?.[i] ?? n)));
    charges.set(key, [vector, Number(!echo.revision && vector.some(Boolean))]);
    redirects.set(key, echo.key);
  }
}

// Resolve each carrier's accounting contribution before any dashboard rows
// are accumulated. A prefix's revision evidence can also settle an interval
// in a complementary fragment when both preserve the same record carrier.
function resolveCodexCharges(store) {
  const charges = new Map();
  const redirects = new Map();
  resolveCodexLinks(store, charges, redirects);
  const intervals = new Map();
  const aliases = new Map();
  const revisions = new Map();
  const parentIndex = codexReferenceIndex(store);
  const files = Object.values(store.files).filter((file) => file.adapter === "codex");
  for (const file of files) {
    for (const scope of Object.values(file.state.codexSpend ?? {})) {
      for (const [key, delta] of Object.entries(scope.revisionCarriers ?? {})) {
        // A retained pre-upgrade scope may still contain a duplicate's zero.
        if (!delta.some(Boolean)) continue;
        const old = revisions.get(key);
        if (!old || delta[0] + delta[3] < old[0] + old[3]) revisions.set(key, delta);
      }
    }
  }
  const spend = (v) => v ? codexRawInput(v) + v[1] : 0;
  for (const file of files) {
    const reference = file.state.codexReferencedInterval;
    const base = reference && reference.input?.inheritance !== "filtered" &&
      codexReferencedBaseline(parentIndex, file.state.codexHistoryBase);
    for (const scope of Object.values(file.state.codexSpend ?? {})) {
      // A copied history total precedes the first owned interval, but is not
      // included in its carrier depth. At equal depth prefer that baseline
      // to a clipped copy starting at the same child record. Later intervals
      // have their own history baseline; referenced forks resolve separately.
      let startsWithCopiedHistory = scope?.copiedHistory && !file.state.codexHistoryBase;
      for (const [key, observation] of Object.entries(scope?.intervals ?? {})) {
        const copiedBaseline = Boolean(startsWithCopiedHistory);
        startsWithCopiedHistory = false;
        const isReferenced = key === reference?.key;
        const evidence = scope.intervalInputs?.[key];
        if (!store.dedup[key] && !isReferenced && !evidence) continue;
        const interval = readCodexInterval(observation, TOKEN_FIELDS.length);
        if (!interval) continue;
        let [depth, residual] = interval;
        let input = evidence?.[0];
        if (isReferenced && (reference.input || base)) input = codexReferencedInput(reference, base || undefined);
        if (input && evidence && Object.values(evidence[1]).some((carrier) => revisions.has(carrier))) {
          const records = { ...input.records };
          const pending = [...(input.pending ?? [0, 0, 0, 0, 0])];
          for (const [id, carrier] of Object.entries(evidence[1])) {
            const delta = revisions.get(carrier);
            if (!delta || !records[id]) continue;
            for (let i = 0; i < pending.length; i++) pending[i] += delta[i] - records[id][i];
            records[id] = delta;
          }
          input = { ...input, pending, records };
        } else if (!isReferenced) input = null;
        if (input) {
          const raw = settleCodexInterval(input).charge;
          if (raw?.some(Boolean)) {
            const [input, read, write, output, reasoning] = raw;
            const cacheRead = Math.min(read, input);
            const cacheWrite = Math.min(write, input - cacheRead);
            residual = [input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, reasoning];
          } else residual = 0;
        }
        const previous = intervals.get(key);
        const tieBetter = depth === -1 ? spend(residual) < spend(previous?.[1]) : spend(residual) > spend(previous?.[1]);
        const target = scope.intervalRows?.[key] ??
          (isReferenced || !store.dedup[key] || input?.target?.model !== "unknown" ? input?.target : undefined);
        const betterTarget = target && (!previous?.[3] || (previous[3].model === "unknown" && target.model !== "unknown"));
        const preferAtEqualDepth = previous && copiedBaseline !== previous[4] ? copiedBaseline
          : tieBetter || (previous && spend(residual) === spend(previous[1]) && betterTarget);
        if (!previous || depth > previous[0] || (depth === previous[0] && preferAtEqualDepth)) {
          intervals.set(key, [depth, residual, scope.intervalTargets?.[key], target, copiedBaseline]);
        }
      }
    }
    for (const [key, alias] of Object.entries(file.state.codexLegacyAliases ?? {})) {
      for (const candidate of [].concat(alias)) {
        const old = store.dedup[candidate];
        const owner = old && findFileById(store, old[0]);
        if (owner?.adapter === "codex" && owner.state.codexParserVersion <= 9) {
          aliases.set(key, candidate);
          break;
        }
      }
    }
  }
  const matchedAliases = new Set();
  for (const key of new Set([...intervals.keys(), ...aliases.keys()])) {
    const entry = store.dedup[key];
    const observation = intervals.get(key);
    if ((!entry && !observation?.[3]) || charges.has(key) || entry?.[DEDUP_AUX_INDEX]?.echo) continue;
    let residual = observation ? observation[1] : entry.slice(2, 7);
    let messages = Number(Boolean(residual));
    const alias = aliases.get(key);
    if (residual && alias && !matchedAliases.has(alias)) {
      const overlap = codexRevisionOverlap(residual, store.dedup[alias].slice(2, 7));
      residual = residual.map((n, i) => n - overlap[i]);
      matchedAliases.add(alias);
      messages = 0;
      redirects.set(key, alias);
    } else if (!residual && observation?.[2]) redirects.set(key, observation[2]);
    charges.set(key, [residual, messages, observation?.[3]]);
  }
  return { charges, redirects };
}

function resolveTaskRows(store, charges, redirects) {
  const resolved = [];
  const taskUsage = (key) => {
    const visited = new Set();
    while (redirects.has(key) && !visited.has(key)) {
      visited.add(key);
      key = redirects.get(key);
    }
    return charges.get(key)?.[2] ?? codexTaskRow(store, key);
  };
  for (const entry of Object.values(store.tasks)) {
    if (!Array.isArray(entry)) continue;
    const aux = entry[TASK_AUX_INDEX];
    let row = aux?.usageKey ? taskUsage(aux.usageKey) : codexUsageRow(store, entry);
    for (const key of Object.values(aux?.copyTargets ?? {})) {
      const candidate = taskUsage(key);
      if (candidate && (!row || (row.model === "unknown" && candidate.model !== "unknown"))) row = candidate;
    }
    if (!row) continue;
    resolved.push([row, toNonNegInt(entry[2])]);
  }
  return resolved;
}

export function snapshotRows(store) {
  const { charges, redirects } = resolveCodexCharges(store);
  const taskRows = resolveTaskRows(store, charges, redirects);
  const rows = new Map();
  const aggregateFor = (row) => {
    const key = rowKey(row);
    if (!rows.has(key)) rows.set(key, emptyAggregate(row));
    return rows.get(key);
  };
  for (const file of Object.values(store.files)) {
    // v9 rows are the authoritative totals even when their auxiliary dedup
    // index has missing entries. Current Codex rows are settled below.
    if (file.adapter === "codex" && !(file.state.codexParserVersion <= 9)) continue;
    for (const row of file.rows ?? []) {
      const aggregate = aggregateFor(row);
      for (const field of TOKEN_FIELDS) aggregate.tokens[field] += toNonNegInt(row[field]);
      aggregate.messages += toNonNegInt(row.messages);
    }
  }
  for (const [key, entry] of Object.entries(store.dedup)) {
    const owner = findFileById(store, entry?.[0]);
    if (owner?.adapter !== "codex" || owner.state.codexParserVersion <= 9) continue;
    const row = codexUsageRow(store, entry);
    if (!row) continue;
    const [vector, messages, target] = charges.get(key) ?? [entry.slice(2, 7), 1];
    if (!messages && !vector?.some?.(Boolean)) continue;
    const aggregate = aggregateFor(target ?? row);
    for (let i = 0; i < TOKEN_FIELDS.length; i++) aggregate.tokens[TOKEN_FIELDS[i]] += vector?.[i] ?? 0;
    aggregate.messages += messages;
  }
  for (const [key, [vector, messages, target]] of charges) {
    if (store.dedup[key] || !target || !messages) continue;
    const aggregate = aggregateFor(target);
    for (let i = 0; i < TOKEN_FIELDS.length; i++) aggregate.tokens[TOKEN_FIELDS[i]] += vector[i];
    aggregate.messages += messages;
  }
  for (const [row, ms] of taskRows) {
    const aggregate = row.harness === "codex" ? aggregateFor(row) : rows.get(rowKey(row));
    if (!aggregate) continue;
    aggregate.activeMs += ms;
    if (ms > aggregate.longestTaskMs) aggregate.longestTaskMs = ms;
  }

  const out = [...rows.values()].filter((row) =>
    row.harness !== "codex" || row.messages || row.activeMs || row.tokens.reasoning || tokenTotal(row.tokens));
  for (const row of out) {
    row.tokens.total = tokenTotal(row.tokens);
  }
  out.sort((a, b) => {
    return (
      a.day.localeCompare(b.day) ||
      a.session.localeCompare(b.session) ||
      a.harness.localeCompare(b.harness) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      a.project.localeCompare(b.project)
    );
  });
  return out;
}

function rowKey(row) {
  return JSON.stringify([
    row.day,
    row.session,
    row.harness,
    row.provider,
    row.model,
    row.project,
  ]);
}

function validRow(row) {
  return (
    isPlainObject(row) &&
    typeof row.day === "string" &&
    typeof row.session === "string" &&
    typeof row.harness === "string" &&
    typeof row.provider === "string" &&
    typeof row.model === "string" &&
    typeof row.project === "string" &&
    Number.isFinite(row.input) &&
    Number.isFinite(row.output) &&
    Number.isFinite(row.cacheRead) &&
    Number.isFinite(row.cacheWrite) &&
    Number.isFinite(row.reasoning) &&
    Number.isFinite(row.messages) &&
    row.input >= 0 &&
    row.output >= 0 &&
    row.cacheRead >= 0 &&
    row.cacheWrite >= 0 &&
    row.reasoning >= 0 &&
    row.messages >= 0
  );
}

function validateLoadedStore(store) {
  if (!isPlainObject(store) || store.version !== STORE_VERSION) {
    throw new Error("unsupported store version");
  }
  const configMigration = migrateLoadedConfig(normalizeConfig(store.config));
  store.config = configMigration.config;
  if (!isPlainObject(store.files) || !isPlainObject(store.dedup) || !isPlainObject(store.tasks)) {
    throw new Error("store collections are malformed");
  }
  if (!Number.isInteger(store.nextFileId) || store.nextFileId < 1) {
    throw new Error("store nextFileId is malformed");
  }
  const ids = new Set();
  let maxId = 0;
  for (const [key, entry] of Object.entries(store.files)) {
    if (!isPlainObject(entry)) throw new Error(`file entry ${key} is malformed`);
    if (!Number.isInteger(entry.id) || entry.id < 1) {
      throw new Error(`file entry ${key} has a bad id`);
    }
    if (ids.has(entry.id)) throw new Error(`duplicate file id ${entry.id}`);
    ids.add(entry.id);
    maxId = Math.max(maxId, entry.id);
    if (
      typeof entry.sourceId !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.adapter !== "string" ||
      !Number.isFinite(entry.size) ||
      entry.size < 0 ||
      !Number.isFinite(entry.mtimeMs) ||
      !Number.isFinite(entry.offset) ||
      entry.offset < 0 ||
      !Number.isFinite(entry.lineNo) ||
      entry.lineNo < 0
    ) {
      throw new Error(`file entry ${key} is malformed`);
    }
    if (!Array.isArray(entry.rows) || !entry.rows.every(validRow)) {
      throw new Error(`file entry ${key} has malformed rows`);
    }
    if (!Array.isArray(entry.tasks) || !entry.tasks.every((task) => typeof task === "string")) {
      throw new Error(`file entry ${key} has malformed tasks`);
    }
    if (!isPlainObject(entry.state)) {
      throw new Error(`file entry ${key} has malformed state`);
    }
  }
  if (store.nextFileId <= maxId) {
    throw new Error("store nextFileId is behind existing files");
  }
  for (const [key, value] of Object.entries(store.dedup)) {
    const aux = value?.[DEDUP_AUX_INDEX];
    const echo = aux?.echo;
    const validAux =
      Array.isArray(value) &&
      (value.length === 7 ||
        (value.length === 8 && isPlainObject(aux) &&
          ((echo !== undefined && aux.copies === undefined && aux.meta === undefined) ||
            (Array.isArray(aux.copies) && aux.copies.every((id) => Number.isInteger(id)) && validAuxMeta(aux.meta)))));
    if (
      !Array.isArray(value) ||
      !validAux ||
      !Number.isInteger(value[0]) ||
      !Number.isInteger(value[1]) ||
      !value.slice(2, 7).every((number) => Number.isFinite(number) && number >= 0) ||
      (aux?.codexObserved !== undefined && (!isPlainObject(aux.codexObserved) ||
        !Object.values(aux.codexObserved).every((observation) => validAuxMeta(observation?.meta) &&
          Array.isArray(observation.tokens) && observation.tokens.length === TOKEN_FIELDS.length &&
          observation.tokens.every((n) => Number.isFinite(n) && n >= 0)))) ||
      (echo !== undefined && (!isPlainObject(echo) || typeof echo.key !== "string" || echo.key === key ||
        (echo.revision !== undefined && typeof echo.revision !== "boolean") ||
        (echo.total !== undefined && (!Array.isArray(echo.total) || echo.total.length !== TOKEN_FIELDS.length ||
          !echo.total.every((number) => Number.isFinite(number) && number >= 0))) ||
        (echo.covered !== undefined && (!Array.isArray(echo.covered) || echo.covered.length !== TOKEN_FIELDS.length ||
          !echo.covered.every((number) => Number.isFinite(number) && number >= 0)))))
    ) {
      throw new Error(`dedup entry ${key} is malformed`);
    }
  }
  // The draft v10 stored aliases on their modern target. Its readable files
  // are reindexed; don't treat old, unavailable history as a corrupt store.
  delete store.codexAliases;
  for (const [key, value] of Object.entries(store.tasks)) {
    const validAux =
      Array.isArray(value) &&
      (value.length === 5 ||
        (value.length === 6 &&
          isPlainObject(value[5]) &&
          Array.isArray(value[5].copies) &&
          value[5].copies.every((id) => Number.isInteger(id)) &&
          validAuxMeta(value[5].meta)));
    const aux = value?.[TASK_AUX_INDEX];
    const validUsageTarget = value?.[1] !== -1 || (
      typeof aux?.usageKey === "string" && aux.usageKey.length > 0 &&
      (aux.copyTargets === undefined || (isPlainObject(aux.copyTargets) &&
        Object.values(aux.copyTargets).every((target) => typeof target === "string")))
    );
    if (
      !Array.isArray(value) ||
      !validAux ||
      !validUsageTarget ||
      !Number.isInteger(value[0]) ||
      !Number.isInteger(value[1]) ||
      !Number.isFinite(value[2]) ||
      value[2] < 0 ||
      (value[3] !== 0 && value[3] !== 1) ||
      typeof value[4] !== "string"
    ) {
      throw new Error(`task entry ${key} is malformed`);
    }
  }
  return configMigration.migrated;
}

export async function loadStore(storePath, { readOnly = false } = {}) {
  const warnings = [];
  let errors = 0;
  if (!readOnly) await ensureParent(storePath);
  let text;
  try {
    text = await readFile(storePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { store: emptyStore(), warnings, errors, exists: false, dirty: true };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
    const migrated = validateLoadedStore(parsed);
    ensureStoreMeta(parsed);
    prepareStore(parsed);
    return { store: parsed, warnings, errors, exists: true, dirty: migrated };
  } catch (error) {
    // Filter changes are reads, not recovery operations. Leave preservation
    // and repair to the next lock-protected snapshot/configure operation.
    if (readOnly) {
      throw new Error("Insights store is corrupt; refresh to preserve and rebuild it.", { cause: error });
    }
    let backup;
    try {
      backup = await backupCorruptStore(storePath);
    } catch (backupError) {
      throw new Error(
        `insights store is corrupt and could not be preserved: ${error.message}; ${backupError.message}`,
        { cause: backupError },
      );
    }
    warnings.push(
      `Store was corrupt and has been preserved at ${backup}; a fresh store was started (${error.message}).`,
    );
    errors += 1;
    return {
      store: emptyStore(),
      warnings,
      errors,
      exists: true,
      corruptBackup: backup,
      dirty: true,
    };
  }
}

export async function saveStore(
  storePath,
  store,
  { completed = false, status, now = new Date() } = {},
) {
  const savedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  ensureStoreMeta(store);
  store.lastScanAt = savedAt;
  const scan = store.scan;
  scan.updatedAt = savedAt;
  scan.generation = storeGeneration(store);
  if (status) scan.status = status;
  if (completed) {
    scan.status = "complete";
    scan.completedAt = savedAt;
    scan.currentFile = null;
    scan.pendingFile = null;
    scan.workerPid = null;
    scan.error = null;
    store.lastCompletedScanAt = savedAt;
  }
  await atomicWriteJson(storePath, store);
  // The presentation cache is derived from this exact committed store. Capture
  // the post-rename identity while the caller still holds writer authority so
  // an old cache can never be accepted for a newer atomic store revision. A
  // failure here must not fail the commit; prepare falls back to the store.
  try {
    const fingerprint = await storeRevisionFingerprint(storePath);
    await writePresentationCache(storePath, {
      savedAt, store, rows: snapshotRows(store), fingerprint,
    });
  } catch { /* the cache is an optional read accelerator */ }
  return savedAt;
}

export function dedupKeyFor(harness, ...parts) {
  return hashKey("usage", harness, ...parts);
}

export function taskKeyFor(harness, ...parts) {
  return hashKey("task", harness, ...parts);
}
