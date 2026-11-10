import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import test from "node:test";

import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { normalizeConfig } from "../../herdr-insights/mods/insights/core/config.mjs";
import { readWorkerClaim } from "../../herdr-insights/mods/insights/core/fence.mjs";
import { ensureIndexer } from "../../herdr-insights/mods/insights/core/indexer-control.mjs";
import { emptyStore, loadStore, snapshotRows } from "../../herdr-insights/mods/insights/core/store.mjs";
import {
  isProcessAlive,
  readStoreLockInfo,
  sleep,
} from "../../herdr-insights/mods/insights/core/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "lifecycle-launcher.mjs");
const presenter = path.join(here, "../../herdr-insights/mods/insights/presenter.mjs");

const codexSource = {
  id: "codex",
  label: "Codex",
  adapter: "codex",
  enabled: true,
  roots: ["~/.codex/sessions"],
};

function sourceConfig(roots = codexSource.roots) {
  return { sources: [{ ...codexSource, roots }] };
}

function sharedSession(extra = []) {
  return [
    { type: "session_meta", timestamp: "2026-04-02T10:00:00Z", payload: { id: "shared", cwd: "/repo/gate", model_provider: "openai" } },
    { type: "turn_context", timestamp: "2026-04-02T10:00:01Z", payload: { turn_id: "turn1", model: "gate-model", cwd: "/repo/gate" } },
    {
      type: "token_usage_record",
      timestamp: "2026-04-02T10:00:02Z",
      payload: {
        response_id: "resp1",
        turn_id: "turn1",
        usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 },
      },
    },
    { type: "event_msg", timestamp: "2026-04-02T10:00:03Z", payload: { type: "task_complete", turn_id: "turn1", duration_ms: 2000 } },
    ...extra,
  ];
}

function noiseLines(bytes) {
  const line = `${JSON.stringify({ type: "synthetic_noise", payload: "x".repeat(1024) })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

function codexContent(bytes, extra = []) {
  return `${sharedSession(extra).map((record) => JSON.stringify(record)).join("\n")}\n${noiseLines(bytes)}`;
}

async function zstdFile(directory, name, content) {
  const file = path.join(directory, name);
  await writeFile(file, zlib.zstdCompressSync(Buffer.from(content)));
  return file;
}

async function context(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await mkdir(path.dirname(store), { recursive: true });
  return { root, home, store };
}

async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function stopWorker(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const gone = await waitFor(() => !isProcessAlive(pid), { timeoutMs: 8_000 });
  if (!gone && isProcessAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    await waitFor(() => !isProcessAlive(pid), { timeoutMs: 2_000 });
  }
}

async function cleanup(ctx, pids = []) {
  for (const pid of pids) await stopWorker(pid);
  await rm(ctx.root, { recursive: true, force: true });
}

async function readStore(storePath) {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

test("four separate simultaneous launchers coalesce into one worker and one writer", async (t) => {
  const ctx = await context("insights-lifecycle-coalesce-");
  const workers = new Set();
  t.after(() => cleanup(ctx, [...workers]));
  try {
    const dir = path.join(ctx.home, ".codex", "sessions", "race");
    await mkdir(dir, { recursive: true });
    const seeded = await collectSnapshot("configure", {
      store: ctx.store,
      home: ctx.home,
      config: sourceConfig(),
    });
    assert.equal(seeded.scan.status, "complete");
    await zstdFile(dir, "big.jsonl.zst", codexContent(1_400_000));

    const gate = path.join(ctx.root, "start.gate");
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, [
      launcher, ctx.store, ctx.home, gate, "45",
    ], { stdio: ["ignore", "pipe", "pipe"] }));
    const results = children.map((child) => new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    }));
    await writeFile(gate, "go\n");
    const finished = await Promise.all(results);
    for (const [index, result] of finished.entries()) {
      assert.equal(result.code, 0, `launcher ${index} failed: ${result.stderr}`);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.warnings.length, 0, `launcher ${index} warned`);
      if (payload.workerPid) workers.add(payload.workerPid);
    }
    assert.equal(workers.size, 1, "all four launchers observed the same worker pid");

    const claim = await readWorkerClaim(ctx.store);
    assert.ok(claim?.token, "exactly one worker claim exists");
    assert.equal(Number.isInteger(claim.pid), true);
    workers.add(claim.pid);
    assert.equal(isProcessAlive(claim.pid), true, "the claimed worker stays alive");
    const owner = await waitFor(async () => {
      const info = await readStoreLockInfo(ctx.store);
      return info?.pid === claim.pid ? info : null;
    });
    assert.ok(owner, "the one claimed worker is the store writer");
    assert.equal(owner.role, "worker");

    const again = await ensureIndexer(ctx.store, ctx.home, { generation: (await readStore(ctx.store)).generation });
    assert.equal(again.spawned, false, "a live claim is never respawned");
    assert.equal(again.pid, claim.pid);
    assert.equal((await readWorkerClaim(ctx.store))?.token, claim.token);
  } finally {
    for (const pid of [...workers]) await stopWorker(pid);
  }
});

test("SIGKILL mid-archive preserves durable file checkpoints and restart completes exactly once", async (t) => {
  const ctx = await context("insights-lifecycle-kill-");
  const oracle = await context("insights-lifecycle-kill-oracle-");
  let workerPid = null;
  t.after(async () => {
    if (workerPid) await stopWorker(workerPid);
    await cleanup(ctx);
    await cleanup(oracle);
  });
  try {
    const dir = path.join(ctx.home, ".codex", "sessions", "kill");
    await mkdir(dir, { recursive: true });
    const unique = [
      { type: "session_meta", timestamp: "2026-04-02T10:00:04Z", payload: { id: "open-unique", cwd: "/repo/gate", model_provider: "openai" } },
      { type: "turn_context", timestamp: "2026-04-02T10:00:05Z", payload: { turn_id: "turn-open", model: "open-model", cwd: "/repo/gate" } },
      {
        type: "token_usage_record",
        timestamp: "2026-04-02T10:00:06Z",
        payload: {
          response_id: "resp-open",
          turn_id: "turn-open",
          usage: { input_tokens: 7, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 8 },
        },
      },
    ];
    await zstdFile(dir, "01-shared.jsonl.zst", codexContent(2_400_000));
    await zstdFile(dir, "02-open.jsonl.zst", codexContent(3_200_000, unique));
    for (const name of ["01-shared.jsonl.zst", "02-open.jsonl.zst"]) {
      const target = path.join(oracle.home, ".codex", "sessions", "kill");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, name), await readFile(path.join(dir, name)));
    }
    const oracleSnapshot = await collectSnapshot("configure", {
      store: oracle.store,
      home: oracle.home,
      config: sourceConfig(),
    });
    assert.equal(oracleSnapshot.scan.status, "complete");
    const expected = snapshotRows((await loadStore(oracle.store)).store);
    assert.equal(expected.length, 2, "shared copy deduplicates and the unique session appears once");
    const expectedShared = expected.find((row) => row.model === "gate-model");
    assert.equal(expectedShared.messages, 1);
    assert.equal(expectedShared.tokens.input, 10);
    assert.equal(expectedShared.activeMs, 2000);
    assert.ok(expected.find((row) => row.model === "open-model"));

    const seedStore = emptyStore(normalizeConfig(sourceConfig()));
    seedStore.generation = 1;
    seedStore.scan.generation = 1;
    seedStore.scan.status = "complete";
    await mkdir(path.dirname(ctx.store), { recursive: true });
    await writeFile(ctx.store, `${JSON.stringify(seedStore)}\n`);

    const launched = await collectSnapshot("snapshot", {
      store: ctx.store,
      home: ctx.home,
      budgetMs: 0,
      testStreamDelayMs: 50,
      workerAckMs: 5_000,
    });
    workerPid = launched.scan.workerPid;
    assert.ok(workerPid, "foreground aborted and promoted one worker");
    const checkpointed = await waitFor(async () => {
      const store = await readStore(ctx.store);
      const entries = Object.values(store?.files ?? {});
      return entries.some((entry) => entry.path.endsWith("01-shared.jsonl.zst"))
        && !entries.some((entry) => entry.path.endsWith("02-open.jsonl.zst"))
        ? store
        : null;
    }, { timeoutMs: 10_000 });
    assert.ok(checkpointed, "first completed archive was durably checkpointed");
    assert.equal(isProcessAlive(workerPid), true, "worker is still mid open archive");
    await sleep(250);
    process.kill(workerPid, "SIGKILL");
    await waitFor(() => !isProcessAlive(workerPid), { timeoutMs: 3_000 });

    const killed = await readStore(ctx.store);
    const killedRows = snapshotRows(killed);
    const killedPaths = Object.values(killed.files).map((entry) => entry.path);
    assert.ok(killedPaths.some((value) => value.endsWith("01-shared.jsonl.zst")));
    assert.equal(killedPaths.some((value) => value.endsWith("02-open.jsonl.zst")), false,
      "the open archive contributed no store entry");
    assert.equal(killedRows.some((row) => row.model === "open-model"), false,
      "the open archive contributed zero rows");
    assert.equal(killedRows.find((row) => row.model === "gate-model").messages, 1);

    const restarted = await ensureIndexer(ctx.store, ctx.home, {
      generation: (await readStore(ctx.store)).generation,
    });
    assert.equal(restarted.spawned, true, "the dead worker claim was reclaimed and restarted");
    workerPid = restarted.pid;
    const completed = await waitFor(async () => {
      const store = await readStore(ctx.store);
      return store?.scan?.status === "complete" ? store : null;
    }, { timeoutMs: 15_000 });
    assert.ok(completed, "restart completed the remaining archive");
    await waitFor(async () => (await readWorkerClaim(ctx.store)) === null, { timeoutMs: 5_000 });
    await waitFor(() => !isProcessAlive(restarted.pid), { timeoutMs: 5_000 });
    assert.equal(isProcessAlive(restarted.pid), false, "worker exited after completion");

    const finalRows = snapshotRows(await readStore(ctx.store));
    assert.deepEqual(finalRows, expected, "exact tokens, messages, tasks and copied-session dedup");
    assert.equal(finalRows.length, expected.length, "no duplicate rows after restart");
  } finally {
    if (workerPid) await stopWorker(workerPid);
  }
});

test("configure during a slow worker fences the old generation and commits only new config history", async (t) => {
  const ctx = await context("insights-lifecycle-fence-");
  let workerPid = null;
  t.after(async () => {
    if (workerPid) await stopWorker(workerPid);
    await cleanup(ctx);
  });
  try {
    const oldRoot = path.join(ctx.home, ".codex", "sessions", "old");
    const newRoot = path.join(ctx.home, ".codex", "sessions", "new");
    await mkdir(oldRoot, { recursive: true });
    await mkdir(newRoot, { recursive: true });
    await writeFile(path.join(newRoot, "fresh.jsonl"), [
      { type: "session_meta", timestamp: "2026-04-02T11:00:00Z", payload: { id: "new-session", cwd: "/repo/new", model_provider: "openai" } },
      { type: "turn_context", timestamp: "2026-04-02T11:00:01Z", payload: { turn_id: "turn-new", model: "new-model", cwd: "/repo/new" } },
      {
        type: "token_usage_record",
        timestamp: "2026-04-02T11:00:02Z",
        payload: {
          response_id: "resp-new",
          turn_id: "turn-new",
          usage: { input_tokens: 4, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 5 },
        },
      },
    ].map((record) => `${JSON.stringify(record)}\n`).join(""));
    const seededConfig = sourceConfig(["~/.codex/sessions/old"]);
    await collectSnapshot("configure", { store: ctx.store, home: ctx.home, config: seededConfig });
    await zstdFile(oldRoot, "old-big.jsonl.zst", codexContent(1_500_000));

    const launched = await collectSnapshot("snapshot", {
      store: ctx.store,
      home: ctx.home,
      budgetMs: 0,
      testStreamDelayMs: 40,
      workerAckMs: 5_000,
    });
    workerPid = launched.scan.workerPid;
    assert.ok(workerPid);
    const active = await waitFor(async () => {
      const info = await readStoreLockInfo(ctx.store);
      return info?.pid === workerPid ? info : null;
    });
    assert.ok(active, "old worker owns the store lock");

    const configured = await collectSnapshot("configure", {
      store: ctx.store,
      home: ctx.home,
      config: sourceConfig(["~/.codex/sessions/new"]),
      lockWaitMs: 25_000,
    });
    assert.ok(["complete", "partial"].includes(configured.scan.status));
    assert.deepEqual(configured.config.sources[0].roots, ["~/.codex/sessions/new"]);
    assert.equal(configured.rows.some((row) => row.model === "gate-model"), false,
      "old history was rebuilt away with the source change");
    assert.equal(configured.rows.some((row) => row.model === "new-model"), true);
    const configuredGeneration = configured.scan.generation;
    assert.ok(configuredGeneration >= 2, "configure advanced the generation");

    await waitFor(() => !isProcessAlive(workerPid), { timeoutMs: 8_000 });
    assert.equal(isProcessAlive(workerPid), false, "the fenced worker exited");
    await waitFor(async () => (await readWorkerClaim(ctx.store)) === null, { timeoutMs: 5_000 });
    assert.equal(await readWorkerClaim(ctx.store), null, "the worker claim was cleared");

    await sleep(700);
    const settled = await loadStore(ctx.store);
    assert.equal(settled.store.generation, (await readStore(ctx.store)).generation);
    assert.deepEqual(snapshotRows(settled.store), snapshotRows((await loadStore(ctx.store)).store));
    assert.deepEqual(snapshotRows(settled.store).map((row) => row.model), ["new-model"],
      "no late old-generation checkpoint or final save leaked");
    assert.equal(await readStoreLockInfo(ctx.store), null, "single writer released the lock");
  } finally {
    if (workerPid) await stopWorker(workerPid);
  }
});

test("presenter prepare/status stay fast, running and truthful while a worker holds the lock", { skip: process.platform === "win32" && "requires POSIX worker suspension" }, async (t) => {
  const ctx = await context("insights-lifecycle-presenter-");
  let workerPid = null;
  t.after(async () => {
    if (workerPid) await stopWorker(workerPid);
    await cleanup(ctx);
  });
  try {
    const dir = path.join(ctx.home, ".codex", "sessions", "ui");
    await mkdir(dir, { recursive: true });
    await collectSnapshot("configure", { store: ctx.store, home: ctx.home, config: sourceConfig() });
    await zstdFile(dir, "01-slow.jsonl.zst", codexContent(700_000));
    await zstdFile(dir, "02-big.jsonl.zst", codexContent(1_600_000));

    const launched = await collectSnapshot("snapshot", {
      store: ctx.store,
      home: ctx.home,
      budgetMs: 0,
      testStreamDelayMs: 35,
      workerAckMs: 5_000,
    });
    workerPid = launched.scan.workerPid;
    assert.ok(workerPid);
    const owner = await waitFor(async () => {
      const info = await readStoreLockInfo(ctx.store);
      return info?.pid === workerPid ? info : null;
    });
    assert.ok(owner, "worker owns the writer lock");
    const running = await waitFor(async () => {
      const snapshot = await collectSnapshot("status", { store: ctx.store });
      return snapshot.scan.status === "running" && snapshot.scan.workerPid === workerPid ? snapshot : null;
    }, { timeoutMs: 5_000 });
    assert.ok(running, "the worker published its running state");
    // Preserve the writer lock while measuring readers, rather than racing a finite scan.
    process.kill(workerPid, "SIGSTOP");
    assert.equal((await readStoreLockInfo(ctx.store))?.pid, workerPid);

    const samples = [];
    for (const command of ["prepare", "status", "prepare", "status", "prepare"]) {
      const started = Date.now();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [presenter, command, "--store", ctx.store], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      const elapsed = Date.now() - started;
      samples.push(elapsed);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.command, command);
      assert.ok(payload.snapshot, "presenter returned the committed snapshot");
      assert.equal(payload.snapshot.scan?.status, "running", "scan state is truthful while indexing");
      assert.equal(payload.snapshot.scan?.workerPid, workerPid, "worker identity is exposed");
      assert.ok(payload.snapshot.scan?.generation >= 1);
      assert.ok(payload.dashboard, "dashboard derives from committed cache without waiting");
      assert.ok(elapsed < 1_000, `${command} returned in ${elapsed}ms, under the 1s local limit`);
    }
    const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    assert.ok(median < 1_000, `median ${median}ms stays under the hard local limit`);
  } finally {
    if (workerPid) {
      try { process.kill(workerPid, "SIGCONT"); } catch { /* worker already exited */ }
      await stopWorker(workerPid);
    }
  }
});
