import { readFile, stat, unlink } from "node:fs/promises";
import { defaultConfig, normalizeConfig } from "./config.mjs";
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

export function emptyStore(config = defaultConfig()) {
  const store = {
    version: STORE_VERSION,
    config,
    nextFileId: 1,
    files: {},
    dedup: {},
    tasks: {},
    lastScanAt: null,
  };
  prepareStore(store);
  return store;
}

export function prepareStore(store) {
  const byId = new Map();
  for (const entry of Object.values(store.files ?? {})) {
    if (entry && Number.isInteger(entry.id)) byId.set(entry.id, entry);
  }
  Object.defineProperty(store, "_byId", {
    value: byId,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return store;
}

export function findFileById(store, id) {
  if (!store._byId) prepareStore(store);
  return store._byId.get(id) ?? null;
}

export function addFileEntry(store, entry) {
  if (!store._byId) prepareStore(store);
  store.files[fileKey(entry.sourceId, entry.path)] = entry;
  store._byId.set(entry.id, entry);
  return entry;
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
  removeOwnedMetadata(store, entry.id);
  delete store.files[key];
  if (store._byId) store._byId.delete(entry.id);
  return entry;
}

export function removeOwnedMetadata(store, fileId) {
  for (const [key, value] of Object.entries(store.dedup)) {
    if (Array.isArray(value) && value[0] === fileId) delete store.dedup[key];
  }
  for (const [key, value] of Object.entries(store.tasks)) {
    if (Array.isArray(value) && value[0] === fileId) delete store.tasks[key];
  }
}

export function resetFileEntry(store, entry) {
  removeOwnedMetadata(store, entry.id);
  entry.offset = 0;
  entry.lineNo = 0;
  entry.rows = [];
  entry.tasks = [];
  entry.state = {};
  return entry;
}

export function clearCollectedData(store) {
  store.files = {};
  store.dedup = {};
  store.tasks = {};
  store.nextFileId = 1;
  prepareStore(store);
}

function rowMatches(row, meta) {
  return (
    row.day === meta.day &&
    row.session === meta.session &&
    row.harness === meta.harness &&
    row.provider === meta.provider &&
    row.model === meta.model &&
    row.project === meta.project
  );
}

export function getOrCreateRow(file, meta) {
  for (let index = 0; index < file.rows.length; index += 1) {
    if (rowMatches(file.rows[index], meta)) return index;
  }
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
  return file.rows.length - 1;
}

function addRowTokens(row, tokens) {
  row.input = toNonNegInt(row.input + tokens.input);
  row.output = toNonNegInt(row.output + tokens.output);
  row.cacheRead = toNonNegInt(row.cacheRead + tokens.cacheRead);
  row.cacheWrite = toNonNegInt(row.cacheWrite + tokens.cacheWrite);
  row.reasoning = toNonNegInt(row.reasoning + tokens.reasoning);
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

// Usage dedup is a max-upsert: Claude streams the same message.id repeatedly
// and revises its numbers upward. One message, maximum numeric value per field.
export function addUsage(store, file, meta, tokens, dedupKey) {
  const entry = store.dedup[dedupKey];
  if (Array.isArray(entry)) {
    const owner = findFileById(store, entry[0]);
    const row = owner?.rows?.[entry[1]];
    if (owner && row) {
      let changed = false;
      for (let index = 0; index < TOKEN_FIELDS.length; index += 1) {
        const field = TOKEN_FIELDS[index];
        const previous = toNonNegInt(entry[index + 2]);
        if (tokens[field] > previous) {
          row[field] = toNonNegInt(row[field] + (tokens[field] - previous));
          entry[index + 2] = tokens[field];
          changed = true;
        }
      }
      return {
        fileId: owner.id,
        rowIdx: entry[1],
        row,
        isNew: false,
        changed,
      };
    }
    delete store.dedup[dedupKey];
  }

  const rowIdx = getOrCreateRow(file, meta);
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
  return { fileId: file.id, rowIdx, row, isNew: true, changed: true };
}

export function addTask(
  store,
  fileId,
  rowIdx,
  taskKey,
  durationMs,
  session,
  exact,
) {
  const ms = toNonNegInt(durationMs);
  const owner = findFileById(store, fileId);
  const row = owner?.rows?.[rowIdx];
  if (!owner || !row) return false;
  const existing = store.tasks[taskKey];
  if (Array.isArray(existing)) {
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
  store.tasks[taskKey] = [fileId, rowIdx, ms, exact ? 1 : 0, sHash];
  if (!Array.isArray(owner.tasks)) owner.tasks = [];
  owner.tasks.push(taskKey);
  return true;
}

export function removeLatestFallbackTaskForSession(store, session) {
  const sHash = sessionHash(session);
  const keys = Object.keys(store.tasks);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    const entry = store.tasks[key];
    if (Array.isArray(entry) && entry[3] === 0 && entry[4] === sHash) {
      delete store.tasks[key];
      const owner = findFileById(store, entry[0]);
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

export function removeFallbackTasksForSession(store, file, session) {
  if (!Array.isArray(file.tasks) || file.tasks.length === 0) return;
  const sHash = sessionHash(session);
  const keep = [];
  for (const key of file.tasks) {
    const entry = store.tasks[key];
    if (
      Array.isArray(entry) &&
      entry[0] === file.id &&
      entry[3] === 0 &&
      entry[4] === sHash
    ) {
      delete store.tasks[key];
    } else {
      keep.push(key);
    }
  }
  file.tasks = keep;
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

export function snapshotRows(store) {
  const rows = new Map();
  for (const file of Object.values(store.files)) {
    for (const row of file.rows ?? []) {
      const key = rowKey(row);
      let aggregate = rows.get(key);
      if (!aggregate) {
        aggregate = emptyAggregate(row);
        rows.set(key, aggregate);
      }
      aggregate.tokens.input += toNonNegInt(row.input);
      aggregate.tokens.output += toNonNegInt(row.output);
      aggregate.tokens.cacheRead += toNonNegInt(row.cacheRead);
      aggregate.tokens.cacheWrite += toNonNegInt(row.cacheWrite);
      aggregate.tokens.reasoning += toNonNegInt(row.reasoning);
      aggregate.messages += toNonNegInt(row.messages);
    }
  }

  for (const entry of Object.values(store.tasks)) {
    if (!Array.isArray(entry)) continue;
    const file = findFileById(store, entry[0]);
    const row = file?.rows?.[entry[1]];
    if (!row) continue;
    const aggregate = rows.get(rowKey(row));
    if (!aggregate) continue;
    const ms = toNonNegInt(entry[2]);
    aggregate.activeMs += ms;
    if (ms > aggregate.longestTaskMs) aggregate.longestTaskMs = ms;
  }

  const out = [...rows.values()];
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
  store.config = normalizeConfig(store.config);
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
    if (
      !Array.isArray(value) ||
      value.length !== 7 ||
      !Number.isInteger(value[0]) ||
      !Number.isInteger(value[1]) ||
      !value.slice(2).every((number) => Number.isFinite(number) && number >= 0)
    ) {
      throw new Error(`dedup entry ${key} is malformed`);
    }
  }
  for (const [key, value] of Object.entries(store.tasks)) {
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
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
  return true;
}

export async function loadStore(storePath) {
  const warnings = [];
  let errors = 0;
  await ensureParent(storePath);
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
    validateLoadedStore(parsed);
    prepareStore(parsed);
    return { store: parsed, warnings, errors, exists: true, dirty: false };
  } catch (error) {
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

export async function saveStore(storePath, store) {
  store.lastScanAt = new Date().toISOString();
  await atomicWriteJson(storePath, store);
}

export async function fileStatOrNull(file) {
  try {
    return await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function removeStoreFile(storePath) {
  await unlink(storePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export function dedupKeyFor(harness, ...parts) {
  return hashKey("usage", harness, ...parts);
}

export function taskKeyFor(harness, ...parts) {
  return hashKey("task", harness, ...parts);
}
