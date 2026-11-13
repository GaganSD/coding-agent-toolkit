#!/usr/bin/env node
// Runs on a remote Herdr machine. Collects usage with the ordinary collector
// into a store kept on that machine, then prints only aggregated rows.
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { collectSnapshot } from "./collector.mjs";

const MAX_ROWS_CHARS = 7_000_000;

function errorEnvelope(message) {
  return { kind: "insights-remote-rows", version: 1, error: String(message).slice(0, 300) };
}

function parseArgs(argv) {
  if (argv[0] !== "rows") throw new Error("usage: remote-entry.mjs rows [--store <file>] [--home <dir>]");
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const match = /^--(store|home)$/.exec(argv[index]);
    if (!match || argv[index + 1] === undefined) throw new Error(`unknown argument ${argv[index]}`);
    options[match[1]] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function rows(argv) {
  const options = parseArgs(argv);
  const home = path.resolve(options.home ?? os.homedir());
  const store = path.resolve(options.store ?? path.join(os.homedir(), ".cache", "herdr-insights", "store", "insights.json"));
  await mkdir(path.dirname(store), { recursive: true });
  const snapshot = await collectSnapshot("snapshot", { store, home });
  const encoded = gzipSync(JSON.stringify(snapshot.rows ?? [])).toString("base64");
  if (encoded.length > MAX_ROWS_CHARS) return errorEnvelope("usage rows exceed the transfer limit");
  const scan = snapshot.scan ?? {};
  return {
    kind: "insights-remote-rows",
    version: 1,
    generatedAt: snapshot.generatedAt ?? null,
    lastScanAt: snapshot.lastScanAt ?? null,
    lastCompletedScanAt: snapshot.lastCompletedScanAt ?? null,
    rowCount: Array.isArray(snapshot.rows) ? snapshot.rows.length : 0,
    rows: encoded,
    scan: {
      status: typeof scan.status === "string" ? scan.status : "idle",
      processed: Number.isInteger(scan.processed) ? scan.processed : 0,
      total: Number.isInteger(scan.total) ? scan.total : 0,
      live: scan.live ?? null,
    },
    warnings: (Array.isArray(snapshot.warnings) ? snapshot.warnings : []).slice(0, 20).map(String),
  };
}

let result;
try {
  result = await rows(process.argv.slice(2));
} catch (error) {
  result = errorEnvelope(error?.message ?? error);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
