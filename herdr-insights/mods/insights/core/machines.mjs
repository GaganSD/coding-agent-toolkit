// Mac-side storage for remote machines: builds the worker bundle that
// remote.mjs installs, and turns the files main.js saved after each fetch
// into merge.mjs records. Saved files are untrusted; a bad one is skipped.
import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { REMOTE_RECORD_VERSION } from "../merge.mjs";
import { machineFileStem } from "../remote.mjs";
import { isPlainObject, toNonNegInt, withStoreLock } from "./util.mjs";

const BUNDLE_ROOT_FILES = ["collector.mjs", "indexer.mjs", "remote-entry.mjs", "remote.mjs"];

async function bundleFiles(modDir) {
  // This module stays behind: it is Mac-only and imports ../merge.mjs.
  const core = (await readdir(path.join(modDir, "core")))
    .filter((name) => name.endsWith(".mjs") && name !== "machines.mjs")
    .map((name) => `core/${name}`);
  const files = {};
  for (const relative of [...BUNDLE_ROOT_FILES, ...core].sort()) {
    files[relative] = await readFile(path.join(modDir, relative), "utf8");
  }
  return files;
}

// Must match the digest in remote.mjs INSTALL_SCRIPT.
function bundleHash(files) {
  const keys = Object.keys(files).sort();
  return createHash("sha256").update(JSON.stringify(keys.map((key) => [key, files[key]]))).digest("hex").slice(0, 16);
}

export async function buildRemoteBundle(modDir) {
  const files = await bundleFiles(modDir);
  return { hash: bundleHash(files), payload: gzipSync(JSON.stringify({ files })).toString("base64") };
}

export function applyMachineSettings(saved, { writer, changes }) {
  const disabled = new Set(Array.isArray(saved?.disabled) ? saved.disabled.filter((name) => typeof name === "string") : []);
  const orders = new Map(saved?.writer === writer && Array.isArray(saved.orders) ? saved.orders : []);
  for (const { name, enabled, order } of changes) {
    if ((orders.get(name) ?? 0) >= order) continue;
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    orders.set(name, order);
  }
  return { disabled: [...disabled].sort(), writer, orders: [...orders] };
}

export async function publishRemoteFile(staged, destination, kind) {
  if (kind !== "settings") {
    await rename(staged, destination);
    return null;
  }
  // The pane may have read Settings before another dashboard copy changed it.
  // Merge only the requested toggles while holding the writer lock.
  return withStoreLock(destination, async () => {
    const pending = JSON.parse(await readFile(staged, "utf8"));
    let saved;
    try {
      saved = JSON.parse(await readFile(destination, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const settings = applyMachineSettings(saved, pending);
    await writeFile(staged, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(staged, destination);
    return settings.disabled;
  });
}

const KINDS = {
  rows: "insights-remote-machine-rows",
  state: "insights-remote-machine-state",
};

// The worker caps encoded rows at MAX_ROWS_CHARS, about 5 MB of gzip. Typical
// usage rows gzip about 5-7x, so this is about twice what such a history inflates
// to at that limit.
const MAX_ROWS_BYTES = 64 * 1024 * 1024;

function parseFile(text, kind) {
  const value = JSON.parse(text);
  if (!isPlainObject(value) || value.version !== 1 || value.kind !== KINDS[kind] || typeof value.machine !== "string" || !value.machine) {
    throw new Error("unexpected contents");
  }
  if (kind === "rows") {
    const envelope = value.envelope;
    if (!isPlainObject(envelope) || typeof envelope.rows !== "string") throw new Error("missing usage rows");
    const rows = JSON.parse(gunzipSync(Buffer.from(envelope.rows, "base64"), { maxOutputLength: MAX_ROWS_BYTES }).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error("usage rows are not a list");
    return {
      machine: value.machine,
      fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : null,
      snapshot: {
        rows,
        lastCompletedScanAt: typeof envelope.lastCompletedScanAt === "string" ? envelope.lastCompletedScanAt : null,
        scan: isPlainObject(envelope.scan) ? envelope.scan : null,
        warningCount: toNonNegInt(envelope.warningCount),
      },
    };
  }
  return {
    machine: value.machine,
    attemptedAt: typeof value.attemptedAt === "string" ? value.attemptedAt : null,
    error: typeof value.error === "string" && value.error ? value.error : null,
  };
}

export async function loadMachineRecords(dir, { disabled = [] } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], warnings: [] };
    throw error;
  }
  const skip = new Set(disabled);
  const skipStems = new Set(disabled.map(machineFileStem));
  const byMachine = new Map();
  const warnings = [];
  for (const name of names.sort()) {
    const kind = name.endsWith(".rows.json") ? "rows" : name.endsWith(".state.json") ? "state" : null;
    if (!kind || skipStems.has(name.slice(0, -`.${kind}.json`.length))) continue;
    let parsed;
    try {
      parsed = parseFile(await readFile(path.join(dir, name), "utf8"), kind);
    } catch (error) {
      warnings.push(`${name}: ${error?.message ?? error}; skipped.`);
      continue;
    }
    if (skip.has(parsed.machine)) continue;
    const entry = byMachine.get(parsed.machine) ?? { machine: parsed.machine };
    Object.assign(entry, parsed);
    byMachine.set(parsed.machine, entry);
  }
  const records = [...byMachine.values()].map((entry) => ({
    version: REMOTE_RECORD_VERSION,
    machine: entry.machine,
    fetchedAt: entry.fetchedAt ?? null,
    attemptedAt: entry.attemptedAt ?? null,
    // Readers can see newly published rows before the corresponding state file.
    error: Date.parse(entry.fetchedAt) > Date.parse(entry.attemptedAt) ? null : entry.error ?? null,
    snapshot: entry.snapshot ?? null,
  }));
  return { records, warnings };
}
