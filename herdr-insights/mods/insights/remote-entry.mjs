#!/usr/bin/env node
// Runs on a remote Herdr machine. Collects usage with the ordinary collector
// into a store kept on that machine, then prints only aggregated rows.
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { collectSnapshot } from "./collector.mjs";
import { timeZoneStoreKey } from "./remote.mjs";

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
  const activeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone = process.env.TZ ?? activeTimeZone;
  const key = timeZoneStoreKey(timeZone);
  if (Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone !== activeTimeZone) {
    throw new Error("The remote runtime could not use the dashboard timezone.");
  }
  const store = path.resolve(options.store ?? path.join(os.homedir(), ".cache", "herdr-insights", "store", key, "insights.json"));
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
      failed: scan.status === "failed" || Boolean(scan.error),
      processed: Number.isInteger(scan.processed) ? scan.processed : 0,
      total: Number.isInteger(scan.total) ? scan.total : 0,
      live: scan.live ? {
        phase: scan.live.phase ?? null,
        processed: scan.live.processed ?? 0,
        total: scan.live.total ?? 0,
        decodedBytes: scan.live.decodedBytes ?? 0,
      } : null,
    },
    // Warning text names remote files; only the count leaves the machine.
    warnings: [],
    warningCount: Array.isArray(snapshot.warnings) ? snapshot.warnings.length : 0,
  };
}

let result;
try {
  result = await rows(process.argv.slice(2));
} catch (error) {
  result = errorEnvelope(error?.message ?? error);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
