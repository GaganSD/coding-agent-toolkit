// Mac-side storage for remote machines: builds the worker bundle that
// remote.mjs installs, and turns the files main.js saved after each fetch
// into merge.mjs records. Saved files are untrusted; a bad one is skipped.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { REMOTE_RECORD_VERSION } from "../merge.mjs";
import { isPlainObject } from "./util.mjs";

const BUNDLE_ROOT_FILES = ["collector.mjs", "indexer.mjs", "remote-entry.mjs"];

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

const KINDS = {
  rows: "insights-remote-machine-rows",
  state: "insights-remote-machine-state",
};

function parseFile(text, kind) {
  const value = JSON.parse(text);
  if (!isPlainObject(value) || value.version !== 1 || value.kind !== KINDS[kind] || typeof value.machine !== "string" || !value.machine) {
    throw new Error("unexpected contents");
  }
  if (kind === "rows") {
    const envelope = value.envelope;
    if (!isPlainObject(envelope) || typeof envelope.rows !== "string") throw new Error("missing usage rows");
    const rows = JSON.parse(gunzipSync(Buffer.from(envelope.rows, "base64")).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error("usage rows are not a list");
    return {
      machine: value.machine,
      fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : null,
      snapshot: {
        rows,
        lastCompletedScanAt: typeof envelope.lastCompletedScanAt === "string" ? envelope.lastCompletedScanAt : null,
        scan: isPlainObject(envelope.scan) ? envelope.scan : null,
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
  const byMachine = new Map();
  const warnings = [];
  for (const name of names.sort()) {
    const kind = name.endsWith(".rows.json") ? "rows" : name.endsWith(".state.json") ? "state" : null;
    if (!kind) continue;
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
    error: entry.error ?? null,
    snapshot: entry.snapshot ?? null,
  }));
  return { records, warnings };
}
