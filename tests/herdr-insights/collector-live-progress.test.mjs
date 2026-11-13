import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectSnapshot,
  readCommittedSnapshot,
} from "../../herdr-insights/mods/insights/collector.mjs";
import { normalizeConfig } from "../../herdr-insights/mods/insights/core/config.mjs";
import {
  atomicWriteJson,
  withStoreLock,
} from "../../herdr-insights/mods/insights/core/util.mjs";
import {
  workerClaimPath,
} from "../../herdr-insights/mods/insights/core/fence.mjs";
import {
  emptyStore,
  newFileEntry,
  saveStore,
} from "../../herdr-insights/mods/insights/core/store.mjs";
import { run as runPresenter } from "../../herdr-insights/mods/insights/presenter.mjs";

const WORKER_TOKEN = "live-progress-job-token";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-live-progress-"));
  const storePath = path.join(root, "data", "insights.json");
  await mkdir(path.dirname(storePath), { recursive: true });
  const store = emptyStore(normalizeConfig({ sources: [] }));
  store.generation = 4;
  store.lastScanAt = "2026-04-01T12:00:00.000Z";
  store.lastCompletedScanAt = "2026-04-01T11:00:00.000Z";
  store.scan = {
    status: "running",
    generation: 4,
    startedAt: "2026-04-01T12:00:00.000Z",
    updatedAt: "2026-04-01T12:00:00.000Z",
    completedAt: null,
    processed: 2,
    total: 10,
    stats: {
      files: 2,
      filesRead: 2,
      bytesRead: 800,
      unchangedFiles: 0,
      errors: 0,
      decompressedBytes: 500,
    },
    currentFile: null,
    pendingFile: null,
    workerPid: null,
    error: null,
  };
  const entry = newFileEntry(store, {
    sourceId: "pi",
    path: "/tmp/committed.jsonl",
    adapter: "pi",
    size: 10,
    mtimeMs: 1,
  });
  entry.rows.push({
    day: "2026-04-01",
    session: "committed-session",
    harness: "pi",
    provider: "provider",
    model: "model",
    project: "project",
    input: 12,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    messages: 1,
  });
  await saveStore(storePath, store, { status: "running", now: "2026-04-01T12:00:00.000Z" });
  await atomicWriteJson(workerClaimPath(storePath), {
    version: 1,
    token: WORKER_TOKEN,
    pid: process.pid,
    host: hostname(),
    generation: 4,
    startedAt: Date.now(),
    at: Date.now(),
  });
  return { root, storePath };
}

function progress(storePath, overrides = {}) {
  return {
    workerPid: process.pid,
    pid: process.pid,
    generation: 4,
    token: WORKER_TOKEN,
    store: path.resolve(storePath),
    file: "/tmp/open-giant.jsonl.zst",
    processed: 3,
    total: 10,
    filesRead: 2,
    bytesRead: 900,
    decodedBytes: 123_456,
    phase: "decompress",
    rows: [{ injected: true }],
    config: { injected: true },
    stats: { input: 999_999 },
    accounting: { input: 999_999 },
    ...overrides,
  };
}

async function writeProgress(storePath, overrides) {
  await writeFile(`${storePath}.progress.json`, `${JSON.stringify(progress(storePath, overrides))}\n`, { mode: 0o600 });
}

test("prepare/status/read overlay only allowlisted live worker metadata", async () => {
  const ctx = await fixture();
  try {
    const before = await readCommittedSnapshot(ctx.storePath);
    await withStoreLock(ctx.storePath, async () => {
      await writeProgress(ctx.storePath);
      const snapshot = await readCommittedSnapshot(ctx.storePath);
      assert.equal(snapshot.scan.status, "running");
      assert.equal(snapshot.scan.workerPid, process.pid);
      assert.deepEqual(snapshot.scan.live, {
        file: "/tmp/open-giant.jsonl.zst",
        phase: "decompress",
        processed: 3,
        total: 10,
        filesRead: 2,
        bytesRead: 900,
        decodedBytes: 123_456,
        updatedAt: null,
      });
      assert.deepEqual(snapshot.rows, before.rows, "committed rows are unchanged");
      assert.deepEqual(snapshot.config, before.config, "committed config is unchanged");
      assert.deepEqual(snapshot.stats, before.stats, "committed accepted stats are unchanged");
      assert.equal(snapshot.stats.decompressedBytes, 500);
      assert.equal(snapshot.lastCompletedScanAt, before.lastCompletedScanAt);
      assert.equal(snapshot.scan.live.rows, undefined);
      assert.equal(snapshot.scan.live.config, undefined);
      assert.equal(snapshot.scan.live.stats, undefined);

      const status = await collectSnapshot("status", { store: ctx.storePath });
      assert.equal(status.scan.live.decodedBytes, 123_456);
      assert.deepEqual(status.rows, before.rows);

      const prepared = await runPresenter(["prepare", "--store", ctx.storePath]);
      assert.equal(prepared.exitCode, 0);
      const payload = JSON.parse(prepared.stdout);
      assert.equal(payload.snapshot.scan.live.file, "/tmp/open-giant.jsonl.zst");
      assert.equal(payload.snapshot.scan.live.decodedBytes, 123_456);
      assert.equal(payload.snapshot.rowCount, before.rows.length);
    }, { timeoutMs: 2_000, meta: { role: "worker", generation: 4 } });
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("stale job pid, generation, token, store, or non-worker lock reject live progress", async () => {
  const ctx = await fixture();
  try {
    await withStoreLock(ctx.storePath, async () => {
      const cases = [
        ["dead pid", { workerPid: 999_999_999, pid: 999_999_999 }],
        ["old generation", { generation: 3 }],
        ["replaced token", { token: "replaced-job-token" }],
        ["foreign store", { store: "/tmp/other-insights.json" }],
      ];
      for (const [label, overrides] of cases) {
        await writeProgress(ctx.storePath, overrides);
        const snapshot = await readCommittedSnapshot(ctx.storePath);
        assert.equal(snapshot.scan.live, undefined, label);
        assert.equal(snapshot.scan.workerPid, null, label);
      }
    }, { timeoutMs: 2_000, meta: { role: "worker", generation: 4 } });

    await withStoreLock(ctx.storePath, async () => {
      await writeProgress(ctx.storePath);
      const snapshot = await readCommittedSnapshot(ctx.storePath);
      assert.equal(snapshot.scan.live, undefined, "a non-worker lock owner rejects progress");
    }, { timeoutMs: 2_000, meta: { role: "collector", generation: 4 } });
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("completed snapshots never expose residual worker progress", async () => {
  const ctx = await fixture();
  try {
    await withStoreLock(ctx.storePath, async () => {
      await saveStore(ctx.storePath, emptyStore(normalizeConfig({ sources: [] })), { completed: true });
      await writeProgress(ctx.storePath);
      const snapshot = await readCommittedSnapshot(ctx.storePath);
      assert.equal(snapshot.scan.status, "complete");
      assert.equal(snapshot.scan.live, undefined);
    }, { timeoutMs: 2_000, meta: { role: "worker", generation: 4 } });
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});
