#!/usr/bin/env node
// Node presentation helper for Insights.
//
// QuickJS receives only a compact dashboard payload. The full snapshot rows and
// the pure analytics derivation stay in Node, where a filter change can also be
// prepared from the existing store without scanning transcripts again.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESENTATION_VERSION,
  compactDashboard,
  deriveDashboard,
} from "./analytics.js";
import { collectSnapshot, readCommittedSnapshot } from "./collector.mjs";
import { buildRemoteBundle, loadMachineRecords, publishRemoteFile } from "./core/machines.mjs";
import { mergeSnapshots } from "./merge.mjs";
import { timeZoneStoreKey } from "./remote.mjs";

function usage() {
  return [
    "Usage:",
    "  presenter.mjs snapshot --store <file> --home <dir> [--options <json>]",
    "  presenter.mjs configure --store <file> --home <dir> --config <json> [--options <json>]",
    "  presenter.mjs prepare --store <file> [--options <json>]",
    "  presenter.mjs status --store <file> [--options <json>]",
    "  presenter.mjs bundle",
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
    lastCompletedScanAt = null,
    savedAt = null,
    config = {},
    stats,
    sourceStats,
    scan,
    warnings = [],
    machines = [],
    remoteDisabled = [],
    remoteTimeZone = null,
    remoteWarnings = [],
  } = snapshot ?? {};
  return {
    version,
    generatedAt,
    lastScanAt,
    lastCompletedScanAt,
    savedAt,
    config,
    rowCount: Array.isArray(snapshot?.rows)
      ? snapshot.rows.length
      : Number.isFinite(Number(rowCount))
        ? Number(rowCount)
        : 0,
    stats,
    sourceStats,
    scan: scan && typeof scan === "object" ? scan : null,
    warnings: Array.isArray(warnings) ? warnings : [],
    machines: Array.isArray(machines) ? machines : [],
    remoteDisabled: Array.isArray(remoteDisabled) ? remoteDisabled : [],
    remoteTimeZone,
    remoteWarnings,
  };
}

// Remote files live beside the store: machines/<timezone>/<stem>.{rows,state}.json
// written by main.js, and remote.json {disabled: [names]} from Settings.
async function disabledMachines(dataDir, warnings) {
  let text;
  try {
    text = await readFile(path.join(dataDir, "remote.json"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") warnings.push(`remote.json: ${error.message}; ignored.`);
    return [];
  }
  try {
    const disabled = JSON.parse(text)?.disabled;
    return Array.isArray(disabled) ? disabled.filter((name) => typeof name === "string") : [];
  } catch {
    warnings.push("remote.json is not valid JSON; ignored.");
    return [];
  }
}

async function withMachines(snapshot, storePath) {
  const dataDir = path.dirname(storePath);
  const warnings = [];
  let records = [];
  let disabled = [];
  // This local process derives the dashboard and gives QuickJS the same zone
  // for remote collection, even on builds without Intl in QuickJS.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    disabled = await disabledMachines(dataDir, warnings);
    const loaded = await loadMachineRecords(path.join(dataDir, "machines", timeZoneStoreKey(timeZone)), { disabled });
    records = loaded.records;
    warnings.push(...loaded.warnings);
  } catch (error) {
    warnings.push(`remote machines: ${error.message}; ignored.`);
  }
  const merged = mergeSnapshots(snapshot, records);
  merged.remoteWarnings = [...merged.warnings.slice(snapshot?.warnings?.length ?? 0), ...warnings];
  merged.warnings.push(...warnings);
  merged.remoteDisabled = disabled;
  merged.remoteTimeZone = timeZone;
  return merged;
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

function derive(snapshot, options) {
  try {
    return { dashboard: deriveDashboard(snapshot, options), error: null };
  } catch (error) {
    return { dashboard: null, error };
  }
}

export async function run(argv, environment = {}) {
  if (argv[0] === "publish-remote") {
    const [, staged, destination, kind] = argv;
    if (!staged || !destination || !["settings", "data"].includes(kind)) throw new Error("Missing remote publish arguments.");
    const disabled = await publishRemoteFile(staged, destination, kind);
    return { exitCode: 0, stdout: `${JSON.stringify(disabled)}\n`, stderr: "" };
  }
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    return { exitCode: 0, stdout: "", stderr: `${usage()}\n` };
  }
  if (command === "bundle") {
    const bundle = await buildRemoteBundle(path.dirname(fileURLToPath(import.meta.url)));
    return { exitCode: 0, stdout: `${JSON.stringify(bundle)}\n`, stderr: "" };
  }
  if (!["snapshot", "configure", "prepare", "status"].includes(command)) {
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

  if (command === "prepare" || command === "status") {
    // Never takes the writer lock: a long indexer must not block the cached UI.
    const snapshot = await withMachines(await readCommittedSnapshot(storePath), storePath);
    const derived = derive(snapshot, dashboardOptions);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(presentation(command, snapshot, dashboardOptions, derived.dashboard, derived.error))}\n`,
      stderr: "",
    };
  }

  const snapshot = await withMachines(await collectSnapshot(command, {
    store: storePath, home, config: options.config,
  }), storePath);
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
