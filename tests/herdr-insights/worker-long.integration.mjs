#!/usr/bin/env node
// Opt-in integration proof that a real background worker can exceed 30s of
// wall-clock lifetime while finishing one giant compressed archive, with no
// repeated prefix decompression. NOT part of the routine suite.
//
// The stream is synthetic and the delay is an ARTIFICIAL test hook
// (testStreamDelayMs per decompressed chunk). This is not a real-user speed
// claim and not native Herdr proof.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { readWorkerClaim } from "../../herdr-insights/mods/insights/core/fence.mjs";
import { snapshotRows } from "../../herdr-insights/mods/insights/core/store.mjs";
import { isProcessAlive, sleep } from "../../herdr-insights/mods/insights/core/util.mjs";

const STREAM_DELAY_MS = 200;
const RAW_BYTES = 10_000_000;
const HOST_FOREGROUND_LIMIT_MS = 30_000;
const sourceConfig = {
  sources: [{
    id: "codex",
    label: "Codex",
    adapter: "codex",
    enabled: true,
    roots: ["~/.codex/sessions"],
  }],
};

function codexContent() {
  const shared = [
    { type: "session_meta", timestamp: "2026-04-03T10:00:00Z", payload: { id: "long-worker", cwd: "/repo/long", model_provider: "openai" } },
    { type: "turn_context", timestamp: "2026-04-03T10:00:01Z", payload: { turn_id: "turn1", model: "long-model", cwd: "/repo/long" } },
    {
      type: "token_usage_record",
      timestamp: "2026-04-03T10:00:02Z",
      payload: {
        response_id: "resp1",
        turn_id: "turn1",
        usage: { input_tokens: 11, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 14 },
      },
    },
    { type: "event_msg", timestamp: "2026-04-03T10:00:03Z", payload: { type: "task_complete", turn_id: "turn1", duration_ms: 4000 } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const noise = `${JSON.stringify({ type: "synthetic_noise", payload: "x".repeat(1024) })}\n`;
  const filler = noise.repeat(Math.ceil(RAW_BYTES / noise.length));
  return `${shared}\n${filler}`;
}

async function env(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(path.join(home, ".codex", "sessions", "long"), { recursive: true });
  await mkdir(path.dirname(store), { recursive: true });
  return { root, home, store };
}

async function readStore(storePath) {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const ctx = await env("insights-long-worker-");
  const oracle = await env("insights-long-worker-oracle-");
  let workerPid = null;
  const result = {
    label: "ARTIFICIAL synthetic stream throttling; not real-user performance or native Herdr proof",
    artificialStreamDelayMs: STREAM_DELAY_MS,
    rawDecompressedBytes: 0,
  };
  try {
    const content = codexContent();
    result.rawDecompressedBytes = Buffer.byteLength(content);
    const compressed = zlib.zstdCompressSync(Buffer.from(content));
    const fileName = "long.jsonl.zst";
    await collectSnapshot("configure", { store: ctx.store, home: ctx.home, config: sourceConfig });
    await writeFile(path.join(ctx.home, ".codex", "sessions", "long", fileName), compressed);
    await writeFile(path.join(oracle.home, ".codex", "sessions", "long", fileName), compressed);
    const oracleSnapshot = await collectSnapshot("configure", {
      store: oracle.store,
      home: oracle.home,
      config: sourceConfig,
    });
    if (oracleSnapshot.scan.status !== "complete") throw new Error("oracle scan did not complete");
    const expectedRows = snapshotRows(JSON.parse(await readFile(oracle.store, "utf8")));

    const foregroundStarted = Date.now();
    const launched = await collectSnapshot("snapshot", {
      store: ctx.store,
      home: ctx.home,
      budgetMs: 0,
      testStreamDelayMs: STREAM_DELAY_MS,
      workerAckMs: 10_000,
    });
    const foregroundMs = Date.now() - foregroundStarted;
    workerPid = launched.scan.workerPid;
    result.foregroundMs = foregroundMs;
    result.foregroundUnderHostLimit = foregroundMs < HOST_FOREGROUND_LIMIT_MS;
    result.foregroundAbortedBytes = launched.scan.decompressedBytes ?? 0;
    result.workerPid = workerPid;
    result.foregroundStatus = launched.scan.status;
    if (!workerPid) throw new Error("foreground did not promote a worker");
    if (foregroundMs >= HOST_FOREGROUND_LIMIT_MS) {
      throw new Error(`foreground took ${foregroundMs}ms, over the host limit`);
    }
    if (result.foregroundAbortedBytes !== 0) {
      throw new Error("aborted foreground prefix contributed decompressed bytes");
    }

    const workerStarted = Date.now();
    const seenPids = new Set();
    const progress = [];
    let finalStore = null;
    for (;;) {
      const store = await readStore(ctx.store);
      if (store?.scan?.workerPid) seenPids.add(store.scan.workerPid);
      progress.push({
        atMs: Date.now() - workerStarted,
        status: store?.scan?.status ?? null,
        workerPid: store?.scan?.workerPid ?? null,
        processed: store?.scan?.processed ?? 0,
        total: store?.scan?.total ?? 0,
      });
      if (store?.scan?.status === "complete") {
        finalStore = store;
        break;
      }
      if (Date.now() - workerStarted > 120_000) throw new Error("worker did not finish within 120s");
      await sleep(2_000);
    }
    result.workerLifetimeMs = Date.now() - workerStarted;
    result.workerExceeded30s = result.workerLifetimeMs > 30_000;
    result.distinctWorkerPids = [...seenPids];
    result.singleWorkerPid = seenPids.size === 1 && seenPids.has(workerPid);
    result.workerPolls = progress.length;
    result.finalStatus = finalStore.scan.status;
    result.finalDecompressedBytes = finalStore.scan.stats?.decompressedBytes ?? 0;
    result.singleDecoderPass = result.finalDecompressedBytes === result.rawDecompressedBytes;
    result.filesRead = finalStore.scan.stats?.filesRead ?? 0;
    result.rows = snapshotRows(finalStore);
    result.rowsMatchOracle = JSON.stringify(result.rows) === JSON.stringify(expectedRows);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await readWorkerClaim(ctx.store)) === null && !isProcessAlive(workerPid)) break;
      await sleep(100);
    }
    result.claimCleared = (await readWorkerClaim(ctx.store)) === null;
    result.workerExited = !isProcessAlive(workerPid);

    const failures = [];
    if (!result.workerExceeded30s) failures.push(`worker lifetime ${result.workerLifetimeMs}ms <= 30s`);
    if (!result.singleWorkerPid) failures.push("worker pid changed across polls");
    if (!result.singleDecoderPass) failures.push("decompressed bytes do not equal one full pass");
    if (result.filesRead !== 1) failures.push(`filesRead ${result.filesRead} !== 1`);
    if (!result.rowsMatchOracle) failures.push("final rows differ from one-shot oracle");
    if (!result.claimCleared) failures.push("worker claim was not cleared");
    if (!result.workerExited) failures.push("worker process did not exit");
    result.ok = failures.length === 0;
    if (failures.length) result.failures = failures;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    if (workerPid && isProcessAlive(workerPid)) {
      try { process.kill(workerPid, "SIGTERM"); } catch { /* already gone */ }
      await sleep(500);
      if (isProcessAlive(workerPid)) {
        try { process.kill(workerPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    await rm(ctx.root, { recursive: true, force: true });
    await rm(oracle.root, { recursive: true, force: true });
  }
}

await main();
