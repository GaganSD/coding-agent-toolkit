#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeConfig, sourcesSignature } from "./core/config.mjs";
import { scanSources } from "./core/scan.mjs";
import {
  clearCollectedData,
  loadStore,
  saveStore,
  snapshotRows,
} from "./core/store.mjs";
import { withStoreLock } from "./core/util.mjs";

function usage() {
  return [
    "Usage:",
    "  collector.mjs snapshot --store <file> [--home <dir>] [--rebuild]",
    "  collector.mjs configure --store <file> [--home <dir>] --config <json> [--rebuild]",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { rebuild: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rebuild") {
      options.rebuild = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const match = /^--(store|home|config)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    options[key] = value;
  }
  return { command, options };
}

async function buildSnapshot(store, scan, nowIso, loadWarnings = [], loadErrors = 0) {
  const warnings = [...loadWarnings, ...scan.warnings];
  const stats = {
    ...scan.stats,
    errors: scan.stats.errors + loadErrors,
  };
  return {
    version: 1,
    generatedAt: nowIso,
    lastScanAt: nowIso,
    config: store.config,
    rows: snapshotRows(store),
    stats,
    sourceStats: scan.sourceStats ?? undefined,
    warnings,
  };
}

async function snapshotWithStore(storePath, home, { rebuild = false } = {}) {
  return withStoreLock(storePath, async () => {
    const loaded = await loadStore(storePath);
    const store = loaded.store;
    let dirty = loaded.dirty;
    if (rebuild) {
      clearCollectedData(store);
      dirty = true;
    }
    const scan = await scanSources(store, { home });
    if (dirty || scan.dirty) await saveStore(storePath, store);
    const now = new Date().toISOString();
    return buildSnapshot(store, scan, now, loaded.warnings, loaded.errors);
  });
}

async function configureStore(storePath, home, rawConfig, { rebuild = false } = {}) {
  let config;
  try {
    const parsed = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
    config = normalizeConfig(parsed);
  } catch (error) {
    const invalid = new Error(`invalid --config: ${error.message}`);
    invalid.exitCode = 2;
    throw invalid;
  }

  return withStoreLock(storePath, async () => {
    const loaded = await loadStore(storePath);
    const store = loaded.store;
    let dirty = loaded.dirty;
    const configChanged = JSON.stringify(store.config) !== JSON.stringify(config);
    const mappingsChanged =
      sourcesSignature(store.config) !== sourcesSignature(config);
    if (configChanged) {
      store.config = config;
      dirty = true;
    }
    if (mappingsChanged || rebuild) {
      clearCollectedData(store);
      dirty = true;
    }

    // Persist the accepted config before scanning. If the scan fails, the UI
    // still has the newly configured sources and can show the scan error.
    if (dirty) {
      await saveStore(storePath, store);
      dirty = false;
    }

    const scan = await scanSources(store, { home });
    if (dirty || scan.dirty) await saveStore(storePath, store);
    const now = new Date().toISOString();
    return buildSnapshot(store, scan, now, loaded.warnings, loaded.errors);
  });
}

export async function run(argv) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    return { exitCode: 0, stdout: "", stderr: `${usage()}\n` };
  }
  if (command !== "snapshot" && command !== "configure") {
    return { exitCode: 2, stdout: "", stderr: `unknown command ${command}\n${usage()}\n` };
  }
  if (!options.store) {
    return { exitCode: 2, stdout: "", stderr: "--store is required\n" };
  }
  if (command === "configure" && options.config === undefined) {
    return { exitCode: 2, stdout: "", stderr: "--config is required\n" };
  }
  const storePath = path.resolve(options.store);
  const home = path.resolve(options.home ?? os.homedir());

  let snapshot;
  if (command === "snapshot") {
    snapshot = await snapshotWithStore(storePath, home, {
      rebuild: options.rebuild,
    });
  } else {
    snapshot = await configureStore(storePath, home, options.config, {
      rebuild: options.rebuild,
    });
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(snapshot)}\n`,
    stderr: "",
  };
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`insights collector: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
