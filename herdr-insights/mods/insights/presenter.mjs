#!/usr/bin/env node
// Node presentation helper for Insights.
//
// QuickJS receives only a compact dashboard payload. The full snapshot rows and
// the pure analytics derivation stay in Node, where a filter change can also be
// prepared from the existing store without scanning transcripts again.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESENTATION_VERSION,
  compactDashboard,
  deriveDashboard,
} from "./analytics.js";
import { run as runCollector } from "./collector.mjs";
import { loadStore, snapshotRows } from "./core/store.mjs";

function usage() {
  return [
    "Usage:",
    "  presenter.mjs snapshot --store <file> --home <dir> [--options <json>]",
    "  presenter.mjs configure --store <file> --home <dir> --config <json> [--options <json>]",
    "  presenter.mjs prepare --store <file> [--options <json>]",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const match = /^--(store|home|config|options)(?:=(.*))?$/.exec(arg);
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

function parseOptions(raw) {
  if (raw === undefined) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const invalid = new Error(`invalid --options: ${error.message}`);
    invalid.exitCode = 2;
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const invalid = new Error("invalid --options: expected one JSON object");
    invalid.exitCode = 2;
    throw invalid;
  }
  return parsed;
}

function compactSnapshot(snapshot, rowCount = 0) {
  const {
    version = 1,
    generatedAt = null,
    lastScanAt = null,
    config = {},
    stats,
    sourceStats,
    warnings = [],
  } = snapshot ?? {};
  return {
    version,
    generatedAt,
    lastScanAt,
    config,
    rowCount: Array.isArray(snapshot?.rows)
      ? snapshot.rows.length
      : Number.isFinite(Number(rowCount))
        ? Number(rowCount)
        : 0,
    stats,
    sourceStats,
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

function presentation(command, snapshot, options, dashboard, error) {
  return {
    version: PRESENTATION_VERSION,
    kind: "insights-presentation",
    command,
    options,
    snapshot: compactSnapshot(snapshot),
    dashboard: dashboard ? compactDashboard(dashboard) : null,
    error: error ? String(error.message ?? error) : null,
  };
}

function storeSnapshot(store, loaded) {
  const rows = snapshotRows(store);
  return {
    version: 1,
    generatedAt: store.lastScanAt,
    lastScanAt: store.lastScanAt,
    config: store.config,
    rows,
    stats: loaded?.errors ? { errors: loaded.errors } : undefined,
    warnings: loaded?.warnings ?? [],
  };
}

function derive(snapshot, options) {
  try {
    return { dashboard: deriveDashboard(snapshot, options), error: null };
  } catch (error) {
    return { dashboard: null, error };
  }
}

function collectorSnapshot(result) {
  if (!result || result.exitCode !== 0) {
    const error = new Error(
      String(result?.stderr ?? "").trim() || `collector exited with code ${result?.exitCode ?? "?"}`,
    );
    error.exitCode = result?.exitCode ?? 1;
    error.stderr = result?.stderr ?? "";
    throw error;
  }
  const text = String(result.stdout ?? "").trim();
  if (!text) throw new Error("the collector returned no snapshot");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the collector returned invalid JSON");
  }
}

export async function run(argv, environment = {}) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    return { exitCode: 0, stdout: "", stderr: `${usage()}\n` };
  }
  if (!["snapshot", "configure", "prepare"].includes(command)) {
    return { exitCode: 2, stdout: "", stderr: `unknown command ${command}\n${usage()}\n` };
  }
  if (!options.store) {
    return { exitCode: 2, stdout: "", stderr: "--store is required\n" };
  }
  if (command === "configure" && options.config === undefined) {
    return { exitCode: 2, stdout: "", stderr: "--config is required\n" };
  }

  const storePath = path.resolve(options.store);
  const home = path.resolve(options.home ?? environment.home ?? os.homedir());
  const dashboardOptions = parseOptions(options.options);

  if (command === "prepare") {
    const loaded = await loadStore(storePath);
    const snapshot = storeSnapshot(loaded.store, loaded);
    const derived = derive(snapshot, dashboardOptions);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(presentation("prepare", snapshot, dashboardOptions, derived.dashboard, derived.error))}\n`,
      stderr: "",
    };
  }

  const collectorArgs = command === "snapshot"
    ? ["snapshot", "--store", storePath, "--home", home]
    : ["configure", "--store", storePath, "--home", home, "--config", options.config];
  const result = await runCollector(collectorArgs);
  const snapshot = collectorSnapshot(result);
  const derived = derive(snapshot, dashboardOptions);
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(presentation(command, snapshot, dashboardOptions, derived.dashboard, derived.error))}\n`,
    stderr: "",
  };
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error.stderr) process.stderr.write(String(error.stderr));
    else process.stderr.write(`insights presenter: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isEntryPoint()) await main();
