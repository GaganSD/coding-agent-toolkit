import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { normalizeConfig } from "../../herdr-insights/mods/insights/core/config.mjs";
import { readWorkerClaim, workerClaimPath } from "../../herdr-insights/mods/insights/core/fence.mjs";
import {
  ensureIndexer,
  indexerPath,
  waitForIndexerAck,
} from "../../herdr-insights/mods/insights/core/indexer-control.mjs";
import {
  emptyStore,
  loadStore,
  newFileEntry,
  saveStore,
} from "../../herdr-insights/mods/insights/core/store.mjs";
import {
  atomicWriteJson,
  isLockBusyError,
  isProcessAlive,
  readStoreLockInfo,
  sleep,
  withStoreLock,
} from "../../herdr-insights/mods/insights/core/util.mjs";

const piSource = [{
  id: "pi",
  label: "Pi",
  adapter: "pi",
  enabled: true,
  roots: ["~/.pi/agent/sessions"],
}];

function piSession(sessionId, input, timestamp = "2026-04-01T10:00:00Z") {
  return [
    JSON.stringify({ type: "session", id: sessionId, timestamp, cwd: "/repo/lifecycle" }),
    JSON.stringify({
      type: "message",
      id: `user-${sessionId}`,
      timestamp,
      message: { role: "user", content: "prompt" },
    }),
    JSON.stringify({
      type: "message",
      id: `assistant-${sessionId}`,
      timestamp,
      message: {
        role: "assistant",
        model: "lifecycle-model",
        provider: "lifecycle-provider",
        usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        stopReason: "stop",
        content: [],
      },
    }),
  ].map((line) => `${line}\n`).join("");
}

async function context(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
  await mkdir(path.dirname(store), { recursive: true });
  return { root, home, store };
}

async function seedStore(storePath, mutate) {
  const store = emptyStore(normalizeConfig({ sources: piSource }));
  store.generation = 3;
  store.scan.generation = 3;
  store.scan.status = "complete";
  store.lastCompletedScanAt = "2026-04-01T11:00:00.000Z";
  mutate?.(store);
  await saveStore(storePath, store, { completed: true, now: "2026-04-01T11:00:00.000Z" });
  return store;
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function commitQueuedGeneration(storePath, marker) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      return await withStoreLock(storePath, async () => {
        const loaded = await loadStore(storePath);
        const store = loaded.store;
        store.generation = Number(store.generation ?? 0) + 1;
        newFileEntry(store, {
          sourceId: "pi",
          path: `/tmp/${marker}.jsonl`,
          adapter: "pi",
          size: 10,
          mtimeMs: 1,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          messages: 1,
        });
        await saveStore(storePath, store, { status: store.scan?.status ?? "partial" });
        return store;
      }, { timeoutMs: 0, meta: { role: "test-client" } });
    } catch (error) {
      if (!isLockBusyError(error) || Date.now() >= deadline) throw error;
      await sleep(25);
    }
  }
}

test("worker failure is recorded under the lock and never clobbers a queued generation", async () => {
  const ctx = await context("insights-worker-failure-");
  const slow = [
    piSession("worker-failure", 9),
    ...Array.from({ length: 2_600 }, () => JSON.stringify({ type: "event", payload: "x".repeat(1024) })).map((line) => `${line}\n`),
  ].join("");
  await writeFile(path.join(ctx.home, ".pi", "agent", "sessions", "one.jsonl"), slow);
  await seedStore(ctx.store, (store) => {
    newFileEntry(store, {
      sourceId: "pi",
      path: "/tmp/kept.jsonl",
      adapter: "pi",
      size: 10,
      mtimeMs: 1,
      tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      messages: 2,
    });
  });

  const token = `test-${process.pid}-${Date.now()}`;
  const { hostname } = await import("node:os");
  const claimSeed = {
    version: 1,
    token,
    pid: null,
    host: hostname(),
    generation: 3,
    startedAt: Date.now(),
    at: Date.now(),
  };
  await atomicWriteJson(workerClaimPath(ctx.store), claimSeed);

  const child = spawn(process.execPath, [
    indexerPath(),
    "--store", ctx.store,
    "--home", ctx.home,
    "--generation", "3",
    "--claim-token", token,
    "--test-stream-delay-ms", "120",
    "--test-fail-after-checkpoint", "1200",
  ], { stdio: "ignore", detached: false });

  try {
    // Publish the spawned pid exactly like the launcher does.
    await atomicWriteJson(workerClaimPath(ctx.store), { ...claimSeed, pid: child.pid, at: Date.now() });
    const owner = await waitFor(async () => {
      const info = await readStoreLockInfo(ctx.store);
      return info?.pid === child.pid ? info : null;
    });
    assert.ok(owner, "worker became the store lock owner");

    const queued = commitQueuedGeneration(ctx.store, "queued.jsonl");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 1, "injected worker failure exits non-zero");
    await queued;

    const final = JSON.parse(await readFile(ctx.store, "utf8"));
    assert.equal(final.generation, 4, "the queued client's newer generation survives");
    const byPath = (suffix) => Object.values(final.files).find((entry) => entry.path.includes(suffix));
    assert.ok(byPath("queued.jsonl"), "queued client marker survives");
    assert.ok(byPath("kept.jsonl"), "previous committed rows survive");
    assert.equal(byPath("kept.jsonl").tokens.input, 7);
    assert.equal(final.scan.status, "failed", "failure was recorded under writer authority");
    assert.equal(final.scan.workerPid, null);
    assert.match(final.scan.error, /injected indexer failure/);
  } finally {
    if (isProcessAlive(child.pid)) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("promotion spawns one worker that waits out the launcher lock handoff", async () => {
  const ctx = await context("insights-worker-promotion-");
  const big = path.join(ctx.home, ".pi", "agent", "sessions", "big.jsonl");
  const filler = JSON.stringify({ type: "event", payload: "x".repeat(1024) });
  const lines = [piSession("promoted", 11)];
  for (let index = 0; index < 8_200; index += 1) lines.push(`${filler}\n`);
  await writeFile(big, lines.join(""));
  await seedStore(ctx.store, (store) => {
    store.scan.status = "partial";
    store.scan.pendingFile = { path: big, requestedAt: "2026-04-01T11:00:00.000Z" };
  });

  let worker = null;
  // The launcher holds the lock across spawn and a deliberately slow save.
  const launch = await withStoreLock(ctx.store, async () => {
    const promoted = await ensureIndexer(ctx.store, ctx.home, {
      generation: 3,
      testStreamDelayMs: 120,
    });
    await sleep(300);
    return promoted;
  }, { timeoutMs: 5_000, meta: { role: "test-launcher" } });
  worker = launch;
  assert.ok(worker.spawned && worker.pid > 0, "one detached worker was spawned");

  try {
    const ack = await waitForIndexerAck(ctx.store, worker.claim, { timeoutMs: 8_000 });
    assert.equal(ack.ok, true, "worker acquired the lock after the bounded handoff");
    const owner = await readStoreLockInfo(ctx.store);
    assert.equal(owner.pid, worker.pid);
    assert.equal(isProcessAlive(worker.pid), true, "worker survives promotion");

    const again = await ensureIndexer(ctx.store, ctx.home, { generation: 3 });
    assert.equal(again.spawned, false, "no respawn while the worker is live");
    assert.equal(again.pid, worker.pid);
    assert.equal((await readWorkerClaim(ctx.store))?.token, worker.claim.token);

    const started = Date.now();
    const status = await collectSnapshot("status", { store: ctx.store });
    assert.ok(Date.now() - started < 1_000, "status stays non-blocking during the worker lock");
    assert.equal(status.scan.workerPid, worker.pid);
  } finally {
    if (worker?.pid && isProcessAlive(worker.pid)) {
      try { process.kill(worker.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    await waitFor(async () => !(worker?.pid && isProcessAlive(worker.pid)), { timeoutMs: 5_000 });
    await waitFor(async () => (await readWorkerClaim(ctx.store)) === null, { timeoutMs: 5_000 });
    await rm(ctx.root, { recursive: true, force: true });
  }
});
