#!/usr/bin/env node
// Opt-in reproducible performance/RSS benchmark for Insights.
//
// Everything is synthetic and lives in a private temp directory. Fixtures are
// generated in this parent process BEFORE any measured child; the measured
// children are fresh presenter CLI processes. On macOS/Linux their peak RSS is
// read from /usr/bin/time. The 500MiB input is removed in finally.
//
// Usage:
//   node scripts/herdr-insights/benchmark.mjs [--keep] [--json=<path>]
//
// This is a development benchmark, not native Herdr proof and never reads the
// operator's real home directories.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as zlib from "node:zlib";

import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { clearWorkerClaim, readWorkerClaim } from "../../herdr-insights/mods/insights/core/fence.mjs";
import { isProcessAlive, sleep } from "../../herdr-insights/mods/insights/core/util.mjs";

const MiB = 1024 * 1024;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PRESENTER = path.join(REPO_ROOT, "herdr-insights/mods/insights/presenter.mjs");
const PROBE = path.join(REPO_ROOT, "scripts/herdr-insights/clone-probe.mjs");
const FIXTURE = path.join(REPO_ROOT, "tests/herdr-insights/fixtures/codex-modern.jsonl.zst");
const DEFAULT_JSON = path.join(REPO_ROOT, "research/issue-109/round2-perf-benchmark.json");
const COLD_CODEX_COUNTS = [1_000, 10_008];
const SAMPLES = 3;
const STATUS_SAMPLES = 5;
const USAGE_EVENTS = 250_000;
const GIANT_SIZES = [50 * MiB, 500 * MiB];

// One checked-in codex-modern fixture contributes these committed values
// (token_count twins are deduped against their token_usage_record).
const CODEX_FILE_ORACLE = {
  tokens: { input: 55, output: 30, cacheRead: 90, cacheWrite: 5, reasoning: 7, total: 180 },
  messages: 2,
  tasks: 2,
  activeMs: 7_000,
  longestTaskMs: 4_000,
  sessions: 1,
};

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const jsonArg = args.find((arg) => arg.startsWith("--json="));
const outputPath = jsonArg ? path.resolve(REPO_ROOT, jsonArg.slice("--json=".length)) : DEFAULT_JSON;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function timeArgs() {
  if (process.platform === "darwin") return ["-l"];
  if (process.platform === "linux") return ["-v"];
  return null;
}

function parsePeakRss(stderr, platform) {
  const text = stderr.toString("utf8");
  const match = platform === "darwin"
    ? /^\s*(\d+)\s+maximum resident set size$/im.exec(text)
    : /Maximum resident set size \(kbytes\):\s*(\d+)/i.exec(text);
  if (!match) return null;
  return Number(match[1]) * (platform === "darwin" ? 1 : 1024);
}

async function readCloneCounts(logPath) {
  try {
    const lines = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    const counts = lines.map((line) => JSON.parse(line));
    return {
      processes: counts.length,
      calls: sum(counts.map((entry) => Number(entry.total) || 0)),
      wholeStore: sum(counts.map((entry) => Number(entry.wholeStore) || 0)),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { processes: 0, calls: 0, wholeStore: 0, missing: true };
    throw error;
  }
}

async function resetLog(file) {
  await unlink(file).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function runPresenter(commandArgs, cloneLog) {
  const time = timeArgs();
  const executable = time ? "/usr/bin/time" : process.execPath;
  const spawnArgs = time
    ? [...time, process.execPath, PRESENTER, ...commandArgs]
    : [PRESENTER, ...commandArgs];
  const existingOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : "";
  const child = spawn(executable, spawnArgs, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TZ: "UTC",
      INSIGHTS_CLONE_LOG: cloneLog,
      NODE_OPTIONS: `${existingOptions}--import ${pathToFileURL(PROBE).href}`.trim(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = performance.now();
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      resolve({
        code,
        signal,
        wallMs: performance.now() - started,
        stdout: out,
        stderr: err,
        payloadBytes: out.length,
        peakRssBytes: parsePeakRss(err, process.platform),
        peakRssMethod: time ? `/usr/bin/time ${time.join(" ")}` : "unavailable",
      });
    });
  });
}

function parsePresentation(result, label) {
  assert.equal(result.code, 0, `${label}: presenter exited ${result.code}${result.stderr.length ? `: ${result.stderr.toString("utf8")}` : ""}`);
  const text = result.stdout.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid presenter JSON: ${error.message}`, { cause: error });
  }
  assert.equal(parsed.kind, "insights-presentation", `${label}: unexpected payload kind`);
  return parsed;
}

async function snapshotStore(storePath) {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function storeMetrics(storePath) {
  const store = await snapshotStore(storePath);
  if (!store) return null;
  const rows = Object.values(store.files ?? {}).reduce(
    (total, file) => total + (Array.isArray(file.rows) ? file.rows.length : 0),
    0,
  );
  const text = await readFile(storePath, "utf8");
  return {
    files: Object.keys(store.files ?? {}).length,
    rows,
    dedup: Object.keys(store.dedup ?? {}).length,
    tasks: Object.keys(store.tasks ?? {}).length,
    bytes: Buffer.byteLength(text),
    payloadMarkerLeaked: text.includes("BENCH_PAYLOAD_MARKER"),
    scanStatus: store.scan?.status ?? null,
  };
}

async function cleanupWorker(storePath) {
  const claim = await readWorkerClaim(storePath).catch(() => null);
  if (!claim) return;
  if (claim.host === os.hostname() && Number.isInteger(claim.pid) && claim.pid > 0) {
    try {
      process.kill(claim.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let index = 0; index < 50 && isProcessAlive(claim.pid); index += 1) {
      await sleep(100);
    }
    if (isProcessAlive(claim.pid)) {
      try {
        process.kill(claim.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await clearWorkerClaim(storePath, claim.token).catch(() => {});
}

async function coldSample({ home, store, label }) {
  await mkdir(path.dirname(store), { recursive: true });
  await rm(store, { force: true });
  const cloneLog = `${store}.clones`;
  await resetLog(cloneLog);
  const started = performance.now();
  const peaks = [];
  const payloads = [];
  const invocations = [];
  let final = null;
  let finalResult = null;
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await runPresenter(
        ["snapshot", "--store", store, "--home", home],
        cloneLog,
      );
      invocations.push(Math.round(result.wallMs));
      if (result.peakRssBytes) peaks.push(result.peakRssBytes);
      payloads.push(result.payloadBytes);
      finalResult = result;
      final = parsePresentation(result, `${label} run ${attempt + 1}`);
      if (final.snapshot?.scan?.status === "complete") break;
      await sleep(150);
    }
    if (final?.snapshot?.scan?.status !== "complete") {
      throw new Error(`${label}: scan did not complete (${final?.snapshot?.scan?.status ?? "no snapshot"})`);
    }
    await sleep(250);
    return {
      wallMs: performance.now() - started,
      invocations,
      peakRssBytes: peaks.length > 0 ? Math.max(...peaks) : null,
      payloadBytes: finalResult?.payloadBytes ?? null,
      maxPayloadBytes: payloads.length > 0 ? Math.max(...payloads) : null,
      clones: await readCloneCounts(cloneLog),
      snapshot: final.snapshot,
      dashboard: final.dashboard,
      store: await storeMetrics(store),
    };
  } finally {
    const scanStatus = final?.snapshot?.scan?.status;
    if (scanStatus !== "complete") await cleanupWorker(store);
  }
}

function assertScanOracle(sample, expected, label) {
  const { snapshot, dashboard } = sample;
  assert.equal(snapshot.scan.status, "complete", `${label}: scan status`);
  assert.equal(snapshot.scan.processed, snapshot.scan.total, `${label}: scan processed total`);
  assert.ok(snapshot.scan.total >= expected.files, `${label}: discovered ${snapshot.scan.total} < ${expected.files}`);
  assert.equal(snapshot.stats.files, expected.files, `${label}: stats.files`);
  assert.equal(snapshot.stats.filesRead, expected.files, `${label}: cold stats.filesRead`);
  assert.equal(snapshot.stats.errors, 0, `${label}: cold scan errors`);
  assert.equal(dashboard?.totals?.input, expected.tokens.input, `${label}: input tokens`);
  assert.equal(dashboard?.totals?.output, expected.tokens.output, `${label}: output tokens`);
  assert.equal(dashboard?.totals?.cacheRead, expected.tokens.cacheRead, `${label}: cacheRead tokens`);
  assert.equal(dashboard?.totals?.cacheWrite, expected.tokens.cacheWrite, `${label}: cacheWrite tokens`);
  assert.equal(dashboard?.totals?.reasoning, expected.tokens.reasoning, `${label}: reasoning tokens`);
  assert.equal(dashboard?.totals?.total, expected.tokens.total, `${label}: total tokens`);
  assert.equal(dashboard?.totals?.messages, expected.messages, `${label}: messages`);
  assert.equal(dashboard?.totals?.activeMs, expected.activeMs, `${label}: activeMs`);
  assert.equal(dashboard?.totals?.longestTaskMs, expected.longestTaskMs, `${label}: longestTaskMs`);
  assert.equal(dashboard?.totals?.sessions, expected.sessions, `${label}: sessions`);
  assert.equal(sample.store?.tasks, expected.tasks, `${label}: tasks`);
  assert.equal(sample.store?.files, expected.files, `${label}: store files`);
  assert.equal(sample.clones.wholeStore, 0, `${label}: whole-store clone count`);
  assert.equal(sample.clones.missing, undefined, `${label}: clone probe did not report`);
}

function codexExpected(count) {
  return {
    files: count,
    tokens: {
      input: CODEX_FILE_ORACLE.tokens.input * count,
      output: CODEX_FILE_ORACLE.tokens.output * count,
      cacheRead: CODEX_FILE_ORACLE.tokens.cacheRead * count,
      cacheWrite: CODEX_FILE_ORACLE.tokens.cacheWrite * count,
      reasoning: CODEX_FILE_ORACLE.tokens.reasoning * count,
      total: CODEX_FILE_ORACLE.tokens.total * count,
    },
    messages: CODEX_FILE_ORACLE.messages * count,
    tasks: CODEX_FILE_ORACLE.tasks * count,
    activeMs: CODEX_FILE_ORACLE.activeMs * count,
    longestTaskMs: CODEX_FILE_ORACLE.longestTaskMs,
    sessions: CODEX_FILE_ORACLE.sessions * count,
  };
}

async function generateCodexHome(home, count) {
  const directory = path.join(home, ".codex/sessions/bench");
  await mkdir(directory, { recursive: true });
  const base = zlib.zstdDecompressSync(await readFile(FIXTURE)).toString("utf8");
  const lines = base.trimEnd().split("\n");
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const session = `bench-session-${index}`;
    const turn1 = `bench-${index}-turn1`;
    const turn2 = `bench-${index}-turn2`;
    const resp1 = `bench-${index}-resp1`;
    const resp2 = `bench-${index}-resp2`;
    const content = `${lines.map((line) => line
      .replaceAll("codex-fixture", session)
      .replaceAll("turn1", turn1)
      .replaceAll("turn2", turn2)
      .replaceAll("resp1", resp1)
      .replaceAll("resp2", resp2)).join("\n")}\n`;
    const compressed = zlib.zstdCompressSync(Buffer.from(content));
    const file = path.join(directory, `bench-${String(index).padStart(5, "0")}.jsonl.zst`);
    await writeFile(file, compressed);
    bytes += compressed.length;
  }
  return { files: count, sourceBytes: bytes };
}

async function writeStreamLine(stream, line) {
  if (!stream.write(line)) {
    await new Promise((resolve) => stream.once("drain", resolve));
  }
}

async function generatePiUsageHome(home, events) {
  const directory = path.join(home, ".pi/agent/sessions/bench");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "usage-250k.jsonl");
  const stream = createWriteStream(file, { encoding: "utf8" });
  const header = { type: "session", version: 3, id: "bench-usage", timestamp: "2026-03-01T00:00:00Z", cwd: "/bench/usage" };
  await writeStreamLine(stream, `${JSON.stringify(header)}\n`);
  for (let index = 0; index < events; index += 1) {
    const record = {
      type: "message",
      id: `usage-${index}`,
      timestamp: "2026-03-01T00:00:00Z",
      message: {
        role: "assistant",
        model: "bench-model",
        provider: "bench-provider",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2 },
        stopReason: "toolUse",
        content: [],
      },
    };
    await writeStreamLine(stream, `${JSON.stringify(record)}\n`);
  }
  stream.end();
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return { files: 1, sourceBytes: (await stat(file)).size };
}

async function generateGiantSource(work, size) {
  const directory = path.join(work, "giant-src");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `giant-${size}.jsonl`);
  const stream = createWriteStream(file, { encoding: "utf8" });
  const header = { type: "session_meta", timestamp: "2026-03-02T00:00:00Z", payload: { id: "bench-giant", cwd: "/bench/giant", model_provider: "bench-provider" } };
  await writeStreamLine(stream, `${JSON.stringify(header)}\n`);
  const context = { type: "turn_context", timestamp: "2026-03-02T00:00:00Z", payload: { turn_id: "giant-turn", model: "bench-model", cwd: "/bench/giant" } };
  await writeStreamLine(stream, `${JSON.stringify(context)}\n`);
  for (let index = 0; index < 1_000; index += 1) {
    const record = {
      type: "token_usage_record",
      timestamp: "2026-03-02T00:00:00Z",
      payload: {
        response_id: `giant-${index}`,
        turn_id: "giant-turn",
        usage: { input_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 5 },
      },
    };
    await writeStreamLine(stream, `${JSON.stringify(record)}\n`);
  }
  const block = Buffer.alloc(192 * 1024);
  let state = 0x9e3779b9;
  for (let index = 0; index < block.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    block[index] = state & 0xff;
  }
  const filler = `${JSON.stringify({ type: "bench_payload", marker: "BENCH_PAYLOAD_MARKER", payload: block.toString("base64") })}\n`;
  const lineBytes = Buffer.byteLength(filler);
  const count = Math.ceil(size / lineBytes);
  for (let index = 0; index < count; index += 1) {
    await writeStreamLine(stream, filler);
  }
  stream.end();
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return { file, bytes: (await stat(file)).size };
}

async function giantVariant(work, source, size, format) {
  const home = path.join(work, `giant-${size}-${format}`, "home");
  const directory = path.join(home, ".codex/sessions/bench");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, format === "zstd" ? "giant.jsonl.zst" : "giant.jsonl");
  if (format === "zstd") {
    await pipeline(
      createReadStream(source),
      zlib.createZstdCompress(),
      createWriteStream(file),
    );
  } else {
    try {
      await link(source, file);
    } catch {
      await copyFile(source, file);
    }
  }
  return { home, file, sourceBytes: (await stat(file)).size };
}

async function measureStatusWhileIndexing(work) {
  const home = path.join(work, "status", "home");
  const store = path.join(work, "status", "data", "insights.json");
  const directory = path.join(home, ".codex/sessions/bench");
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(store), { recursive: true });
  const base = zlib.zstdDecompressSync(await readFile(FIXTURE)).toString("utf8");
  const filler = `${JSON.stringify({ type: "synthetic_noise", payload: "s".repeat(1024) })}\n`;
  const content = `${base}${filler.repeat(Math.ceil((8 * MiB) / filler.length))}`;
  await writeFile(path.join(directory, "slow.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(content)));
  try {
    const launched = await collectSnapshot("snapshot", {
      store,
      home,
      budgetMs: 1,
      workerAckMs: 5_000,
      testStreamDelayMs: 100,
    });
    const workerPid = launched.scan?.workerPid ?? null;
    if (launched.scan?.status !== "running" && launched.scan?.status !== "complete") {
      throw new Error(`status bench: expected a promoted worker, got ${launched.scan?.status}`);
    }
    for (let index = 0; index < 20; index += 1) {
      const storeState = await snapshotStore(store);
      if (storeState?.scan?.status === "running" || storeState?.scan?.status === "partial") break;
      await sleep(100);
    }
    const cloneLog = path.join(work, "status", "clones.log");
    const times = [];
    const statuses = [];
    const payloads = [];
    for (let index = 0; index < STATUS_SAMPLES; index += 1) {
      const result = await runPresenter(["status", "--store", store], cloneLog);
      const parsed = parsePresentation(result, `status ${index + 1}`);
      times.push(result.wallMs);
      payloads.push(result.payloadBytes);
      statuses.push(parsed.snapshot?.scan?.status ?? null);
    }
    for (let index = 0; index < 300; index += 1) {
      const storeState = await snapshotStore(store);
      if (storeState?.scan?.status === "complete") break;
      await sleep(100);
    }
    const finalStore = await snapshotStore(store);
    return {
      label: "ARTIFICIAL stream throttling; cached status while one detached indexer runs",
      workerPid,
      timesMs: times,
      medianMs: median(times),
      payloadBytes: Math.max(...payloads),
      statuses,
      finalScanStatus: finalStore?.scan?.status ?? null,
      complete: finalStore?.scan?.status === "complete",
      clones: await readCloneCounts(cloneLog),
    };
  } finally {
    await cleanupWorker(store);
  }
}

function buildGates(results) {
  const gates = [];
  const gate = (id, target, actual, pass, note) => gates.push({ id, target, actual, pass, ...(note ? { note } : {}) });
  const cold10k = results.cold.find((entry) => entry.files === 10_008);
  gate("cold10kMedianMs", "<=8000 (target <=5000)", cold10k.medianMs, cold10k.medianMs <= 8_000,
    cold10k.medianMs <= 5_000 ? "target met" : "hard limit met, target missed");
  gate("warm10kMedianMs", "<=1500 (target <=1000)", results.warm.medianMs, results.warm.medianMs <= 1_500,
    results.warm.medianMs <= 1_000 ? "target met" : "hard limit met, target missed");
  gate("warm10kFilesRead", "0", results.warm.samples[0].snapshot.stats.filesRead,
    results.warm.samples.every((sample) => sample.snapshot.stats.filesRead === 0));
  gate("warm10kBytesRead", "0", results.warm.samples[0].snapshot.stats.bytesRead,
    results.warm.samples.every((sample) => sample.snapshot.stats.bytesRead === 0));
  gate("warm10kStoreRewrite", "none (mtimeNs + sha256 unchanged)", results.warm.storeUnchanged,
    results.warm.storeUnchanged);
  gate("coldGrowth1kTo10k", "<=15x", results.growth, results.growth <= 15);
  gate("usage250kMedianMs", "<=5000", results.usage.medianMs, results.usage.medianMs <= 5_000);
  gate("usage250kExactTotals", "exact", results.usage.exact, results.usage.exact);
  gate("giantPlainRssDeltaMiB", "<=64", results.giant.plain.deltaMiB, results.giant.plain.deltaMiB <= 64);
  gate("giantZstdRssDeltaMiB", "<=64", results.giant.zstd.deltaMiB, results.giant.zstd.deltaMiB <= 64);
  gate("presentationPayloadMaxKiB", "<512", results.payloadMaxBytes / 1024, results.payloadMaxBytes < 512 * 1024);
  gate("wholeStoreClones", "0", results.wholeStoreClones, results.wholeStoreClones === 0);
  gate("cachedStatusMedianMs", "<=300 (hard <=1000)", results.status.medianMs, results.status.medianMs <= 300);
  gate("cachedStatusCompletes", "complete", results.status.finalScanStatus, results.status.complete);
  gate("node22FullSuite", "CI-owned cross-version check", "not evaluated by this benchmark", null,
    "This benchmark runs on the invoking Node runtime only and does not compare Node versions. Full-suite and lint results for the supported Node 22 and 24 runtimes are recorded by CI, not certified here.");
  return gates;
}

async function main() {
  const work = await mkdtemp(path.join(os.tmpdir(), "insights-bench-"));
  const machine = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    node: process.version,
    loadAvg: os.loadavg(),
  };
  const startedAt = new Date().toISOString();
  const results = {
    schemaVersion: 1,
    label: "Synthetic, opt-in Insights performance/RSS benchmark. Not native Herdr proof.",
    startedAt,
    machine,
    work,
    commands: {
      benchmark: "node scripts/herdr-insights/benchmark.mjs",
      coldAndWarm: "node herdr-insights/mods/insights/presenter.mjs snapshot --store <store> --home <synthetic-home>",
      status: "node herdr-insights/mods/insights/presenter.mjs status --store <store>",
      peakRss: process.platform === "darwin" ? "/usr/bin/time -l <node> <presenter> ..." : "/usr/bin/time -v <node> <presenter> ...",
      cloneProbe: "NODE_OPTIONS=--import scripts/herdr-insights/clone-probe.mjs (benchmark sets INSIGHTS_CLONE_LOG)",
    },
    generation: {},
    cold: [],
    warm: {},
    usage: {},
    giant: {},
    status: {},
    payloadMaxBytes: 0,
    wholeStoreClones: 0,
  };
  try {
    console.log(`work=${work}`);
    console.log(`node=${process.version} platform=${process.platform} cpu=${machine.cpu}`);

    const codexHomes = {};
    for (const count of COLD_CODEX_COUNTS) {
      const home = path.join(work, `codex-${count}`, "home");
      const generationStarted = performance.now();
      const generated = await generateCodexHome(home, count);
      results.generation[`codex${count}`] = {
        ...generated,
        ms: performance.now() - generationStarted,
      };
      codexHomes[count] = home;
      console.log(`generated ${count} unique codex archives in ${Math.round(results.generation[`codex${count}`].ms)}ms`);
    }

    for (const count of COLD_CODEX_COUNTS) {
      const home = codexHomes[count];
      const samples = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const store = path.join(work, `cold-${count}`, `sample-${index}`, "insights.json");
        const sample = await coldSample({ home, store, label: `cold-${count}-${index + 1}` });
        assertScanOracle(sample, codexExpected(count), `cold-${count}-${index + 1}`);
        sample.wallMs = Math.round(sample.wallMs);
        samples.push(sample);
        results.payloadMaxBytes = Math.max(results.payloadMaxBytes, sample.maxPayloadBytes ?? 0);
        results.wholeStoreClones += sample.clones.wholeStore;
        console.log(`cold ${count} #${index + 1}: ${sample.wallMs}ms peak=${sample.peakRssBytes} filesRead=${sample.snapshot.stats.filesRead} payload=${sample.payloadBytes}B`);
      }
      results.cold.push({
        files: count,
        sourceBytes: results.generation[`codex${count}`].sourceBytes,
        samples,
        medianMs: median(samples.map((sample) => sample.wallMs)),
        peakRssBytes: median(samples.map((sample) => sample.peakRssBytes)),
        storeBytes: samples[0].store.bytes,
        payloadBytes: samples[0].payloadBytes,
        filesRead: samples[0].snapshot.stats.filesRead,
        bytesRead: samples[0].snapshot.stats.bytesRead,
        clones: samples.reduce((total, sample) => total + sample.clones.calls, 0),
        wholeStoreClones: samples.reduce((total, sample) => total + sample.clones.wholeStore, 0),
      });
    }

    const warmHome = codexHomes[10_008];
    const warmStore = path.join(work, "cold-10008", "sample-0", "insights.json");
    await mkdir(path.dirname(warmStore), { recursive: true });
    const beforeStat = await stat(warmStore, { bigint: true });
    assert.ok(beforeStat, "warm baseline store must exist after a completed cold scan");
    const beforeHash = await fileSha256(warmStore);
    let afterMtimeNs = beforeStat.mtimeNs;
    let afterHash = beforeHash;
    const warmSamples = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const cloneLog = path.join(path.dirname(warmStore), `warm-clones-${index}.log`);
      const result = await runPresenter(["snapshot", "--store", warmStore, "--home", warmHome], cloneLog);
      const parsed = parsePresentation(result, `warm-${index + 1}`);
      const sample = {
        wallMs: result.wallMs,
        peakRssBytes: result.peakRssBytes,
        payloadBytes: result.payloadBytes,
        snapshot: parsed.snapshot,
        dashboard: parsed.dashboard,
        clones: await readCloneCounts(cloneLog),
      };
      warmSamples.push(sample);
      results.payloadMaxBytes = Math.max(results.payloadMaxBytes, result.payloadBytes);
      results.wholeStoreClones += sample.clones.wholeStore;
      assert.equal(sample.snapshot.scan.status, "complete", `warm-${index + 1}: scan status`);
      assert.equal(sample.snapshot.stats.filesRead, 0, `warm-${index + 1}: filesRead`);
      assert.equal(sample.snapshot.stats.bytesRead, 0, `warm-${index + 1}: bytesRead`);
      assert.equal(sample.clones.wholeStore, 0, `warm-${index + 1}: whole-store clone`);
      const afterStat = await stat(warmStore, { bigint: true });
      afterMtimeNs = afterStat.mtimeNs;
      afterHash = await fileSha256(warmStore);
      assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs, `warm-${index + 1}: store mtime changed`);
      assert.equal(afterHash, beforeHash, `warm-${index + 1}: store content changed`);
      console.log(`warm 10008 #${index + 1}: ${Math.round(result.wallMs)}ms peak=${result.peakRssBytes} payload=${result.payloadBytes}B`);
    }
    results.warm = {
      files: 10_008,
      samples: warmSamples,
      medianMs: median(warmSamples.map((sample) => sample.wallMs)),
      peakRssBytes: median(warmSamples.map((sample) => sample.peakRssBytes)),
      storeUnchanged: true,
      storeMtimeNsBefore: beforeStat.mtimeNs.toString(),
      storeMtimeNsAfter: afterMtimeNs.toString(),
      storeSha256: beforeHash,
      storeSha256After: afterHash,
      storeBytes: (await stat(warmStore)).size,
      filesRead: 0,
      bytesRead: 0,
      clones: warmSamples.reduce((total, sample) => total + sample.clones.calls, 0),
      wholeStoreClones: warmSamples.reduce((total, sample) => total + sample.clones.wholeStore, 0),
    };
    const growth = results.cold.find((entry) => entry.files === 10_008).medianMs
      / results.cold.find((entry) => entry.files === 1_000).medianMs;
    results.growth = growth;
    console.log(`growth 1k->10k: ${growth.toFixed(2)}x`);

    const usageHome = path.join(work, "usage-250k", "home");
    const usageGenerated = performance.now();
    const usageFixture = await generatePiUsageHome(usageHome, USAGE_EVENTS);
    results.generation.usage250k = {
      ...usageFixture,
      ms: performance.now() - usageGenerated,
    };
    const usageSamples = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const store = path.join(work, "usage-250k", `sample-${index}`, "insights.json");
      const sample = await coldSample({ home: usageHome, store, label: `usage-250k-${index + 1}` });
      const expected = {
        files: 1,
        tokens: { input: 250_000, output: 250_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 500_000 },
        messages: 250_000,
        tasks: 0,
        activeMs: 0,
        longestTaskMs: 0,
        sessions: 1,
      };
      assertScanOracle(sample, expected, `usage-250k-${index + 1}`);
      sample.wallMs = Math.round(sample.wallMs);
      usageSamples.push(sample);
      results.payloadMaxBytes = Math.max(results.payloadMaxBytes, sample.maxPayloadBytes ?? 0);
      results.wholeStoreClones += sample.clones.wholeStore;
      console.log(`usage 250k #${index + 1}: ${sample.wallMs}ms peak=${sample.peakRssBytes} filesRead=${sample.snapshot.stats.filesRead} bytesRead=${sample.snapshot.stats.bytesRead}`);
    }
    const usageCloneLog = path.join(work, "usage-warm", "clones.log");
    await mkdir(path.dirname(usageCloneLog), { recursive: true });
    const usageWarm = await runPresenter(
      ["snapshot", "--store", path.join(work, "usage-250k", "sample-0", "insights.json"), "--home", usageHome],
      usageCloneLog,
    );
    const usageWarmParsed = parsePresentation(usageWarm, "usage-warm");
    assert.equal(usageWarmParsed.snapshot.stats.filesRead, 0, "usage warm: filesRead");
    assert.equal(usageWarmParsed.snapshot.stats.bytesRead, 0, "usage warm: bytesRead");
    results.usage = {
      events: USAGE_EVENTS,
      sourceBytes: usageFixture.sourceBytes,
      samples: usageSamples,
      medianMs: median(usageSamples.map((sample) => sample.wallMs)),
      peakRssBytes: median(usageSamples.map((sample) => sample.peakRssBytes)),
      storeBytes: usageSamples[0].store.bytes,
      payloadBytes: usageSamples[0].payloadBytes,
      filesRead: usageSamples[0].snapshot.stats.filesRead,
      bytesRead: usageSamples[0].snapshot.stats.bytesRead,
      exact: true,
      warmFilesRead: usageWarmParsed.snapshot.stats.filesRead,
      warmBytesRead: usageWarmParsed.snapshot.stats.bytesRead,
    };

    results.giant = { formats: {} };
    for (const size of GIANT_SIZES) {
      const giantStarted = performance.now();
      results.generation[`giantSource${size}`] = {
        ...(await generateGiantSource(work, size)),
        ms: performance.now() - giantStarted,
      };
    }
    for (const format of ["plain", "zstd"]) {
      const bySize = [];
      for (const size of GIANT_SIZES) {
        const variant = await giantVariant(work, results.generation[`giantSource${size}`].file, size, format);
        const samples = [];
        for (let index = 0; index < SAMPLES; index += 1) {
          const store = path.join(work, `giant-${size}-${format}`, `sample-${index}`, "insights.json");
          const sample = await coldSample({ home: variant.home, store, label: `giant-${size}-${format}-${index + 1}` });
          const expected = {
            files: 1,
            tokens: { input: 2_000, output: 2_000, cacheRead: 1_000, cacheWrite: 0, reasoning: 0, total: 5_000 },
            messages: 1_000,
            tasks: 0,
            activeMs: 0,
            longestTaskMs: 0,
            sessions: 1,
          };
          assertScanOracle(sample, expected, `giant-${size}-${format}-${index + 1}`);
          assert.equal(sample.store.payloadMarkerLeaked, false, `giant-${size}-${format}: raw payload leaked into store`);
          sample.wallMs = Math.round(sample.wallMs);
          samples.push(sample);
          results.payloadMaxBytes = Math.max(results.payloadMaxBytes, sample.maxPayloadBytes ?? 0);
          results.wholeStoreClones += sample.clones.wholeStore;
          console.log(`giant ${format} ${Math.round(size / MiB)}MiB #${index + 1}: ${sample.wallMs}ms peak=${sample.peakRssBytes} bytesRead=${sample.snapshot.stats.bytesRead}`);
        }
        bySize.push({
          sizeMiB: size / MiB,
          sourceBytes: variant.sourceBytes,
          rawSourceBytes: results.generation[`giantSource${size}`].bytes,
          samples,
          medianMs: median(samples.map((sample) => sample.wallMs)),
          peakRssBytes: median(samples.map((sample) => sample.peakRssBytes)),
          storeBytes: samples[0].store.bytes,
          payloadBytes: samples[0].payloadBytes,
          filesRead: samples[0].snapshot.stats.filesRead,
          bytesRead: samples[0].snapshot.stats.bytesRead,
          decompressedBytes: samples[0].snapshot.stats.decompressedBytes,
          clones: samples.reduce((total, sample) => total + sample.clones.calls, 0),
          wholeStoreClones: samples.reduce((total, sample) => total + sample.clones.wholeStore, 0),
        });
      }
      results.giant.formats[format] = {
        sizes: bySize,
        deltaMiB: (bySize[1].peakRssBytes - bySize[0].peakRssBytes) / MiB,
      };
    }
    results.giant.plain = results.giant.formats.plain;
    results.giant.zstd = results.giant.formats.zstd;

    results.status = await measureStatusWhileIndexing(work);
    results.payloadMaxBytes = Math.max(results.payloadMaxBytes, results.status.payloadBytes);
    results.wholeStoreClones += results.status.clones.wholeStore;
    console.log(`status while indexing median: ${results.status.medianMs.toFixed(1)}ms (${results.status.statuses.join(",")})`);

    results.gates = buildGates(results);
    results.finishedAt = new Date().toISOString();
    results.workKept = keep;
    const failed = results.gates.filter((gate) => gate.pass === false);
    const pending = results.gates.filter((gate) => gate.pass === null);
    results.ok = failed.length === 0;
    results.pending = pending.map((gate) => gate.id);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nJSON artifact: ${outputPath}`);
    for (const gate of results.gates) {
      const state = gate.pass === null ? "PENDING" : gate.pass ? "PASS" : "FAIL";
      console.log(`${state}  ${gate.id}: ${gate.actual} (${gate.target})${gate.note ? ` — ${gate.note}` : ""}`);
    }
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    if (!keep) {
      await rm(work, { recursive: true, force: true, maxRetries: 3 });
    } else {
      console.log(`kept work directory: ${work}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
