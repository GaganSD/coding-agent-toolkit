#!/usr/bin/env node
// Managed detached indexer for legitimate giant, non-seekable compressed
// archives that cannot finish inside a foreground exec slice. It keeps one
// streaming decoder alive to completion, owns the store writer lock, and
// commits completed files incrementally. No transcript text is stored.
//
// A decoder restart (after this process dies) re-reads only the open archive;
// Node exposes no zstd decoder-state snapshot, so continuing mid-frame is not
// promised. Polls never spawn or restart the decoder.
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearWorkerClaim,
  readEffectiveFence,
  readWorkerClaim,
  storeGeneration,
} from "./core/fence.mjs";
import { progressWriter } from "./core/progress.mjs";
import { scanSources } from "./core/scan.mjs";
import {
  emptyScanState,
  ensureStoreMeta,
  loadStore,
  saveStore,
} from "./core/store.mjs";
import { isLockBusyError, withStoreLock } from "./core/util.mjs";

const SAVE_INTERVAL_MS = 1_500;
const FENCE_POLL_MS = 250;
const CLAIM_WAIT_MS = 5_000;

function parseArgs(argv) {
  const options = { testStreamDelayMs: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^--(store|home|generation|claim-token|test-stream-delay-ms)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw new Error(`--${match[1]} needs a value`);
    }
    options[match[1]] = value;
  }
  for (const required of ["store", "home", "generation", "claim-token"]) {
    if (options[required] === undefined) throw new Error(`--${required} is required`);
  }
  const generation = Number(options.generation);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error("--generation must be a non-negative integer");
  }
  const delay = Number(options["test-stream-delay-ms"]);
  return {
    storePath: path.resolve(options.store),
    home: path.resolve(options.home),
    generation,
    claimToken: options["claim-token"],
    testStreamDelayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
  };
}

async function waitForClaim(storePath, token) {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    const claim = await readWorkerClaim(storePath);
    if (!claim || claim.token !== token) return { ok: false, reason: "claim-replaced" };
    if (claim.pid === process.pid) return { ok: true, claim };
    if (Number.isInteger(claim.pid) && claim.pid > 0) return { ok: false, reason: "claim-other-pid" };
    if (Date.now() >= deadline) return { ok: false, reason: "claim-timeout" };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function scanViewUpdate(store, state, { status = "running" } = {}) {
  const scan = store.scan;
  scan.status = status;
  scan.generation = storeGeneration(store);
  scan.updatedAt = new Date().toISOString();
  scan.processed = Number.isInteger(state?.processed) ? state.processed : scan.processed;
  scan.total = Number.isInteger(state?.total) ? state.total : scan.total;
  if (state?.stats) scan.stats = state.stats;
  if (state?.sourceStats) scan.sourceStats = state.sourceStats;
  if (Array.isArray(state?.warnings)) scan.warnings = state.warnings;
  scan.currentFile = state?.file ?? null;
  return scan;
}

export async function runIndexer(argv) {
  const options = parseArgs(argv);
  const { storePath, home, generation, claimToken, testStreamDelayMs } = options;
  const claim = await waitForClaim(storePath, claimToken);
  if (!claim.ok) return { exitCode: 3, reason: claim.reason };

  let stopping = false;
  let fenceAborted = false;
  let fenceCheck = null;
  const onSignal = () => { stopping = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const progress = progressWriter(storePath);
  let lastSave = Date.now();
  try {
    const result = await withStoreLock(storePath, async () => {
      const loaded = await loadStore(storePath);
      const store = loaded.store;
      ensureStoreMeta(store);
      if (storeGeneration(store) !== generation) {
        return { exitCode: 0, reason: "stale-generation" };
      }
      const startFence = await readEffectiveFence(storePath);
      if (startFence && !startFence.stale && startFence.generation > generation) {
        return { exitCode: 0, reason: "fenced" };
      }

      store.scan.status = "running";
      store.scan.workerPid = process.pid;
      store.scan.generation = generation;
      store.scan.startedAt = store.scan.startedAt ?? new Date().toISOString();
      store.scan.currentFile = null;
      store.scan.error = null;
      if (store.scan.pendingFile?.path) {
        const pendingStat = await stat(store.scan.pendingFile.path).catch(() => null);
        if (!pendingStat?.isFile()) store.scan.pendingFile = null;
      }
      const startedIso = new Date().toISOString();
      await saveStore(storePath, store, { status: "running", now: startedIso });

      fenceCheck = async () => {
        if (fenceAborted) return;
        const fence = await readEffectiveFence(storePath);
        if (fence && !fence.stale && fence.generation > generation) fenceAborted = true;
      };
      const fenceTimer = setInterval(() => {
        if (fenceAborted || stopping) return;
        fenceCheck().catch(() => { /* best-effort fence poll */ });
      }, FENCE_POLL_MS);
      fenceTimer.unref();

      let scanned;
      try {
        scanned = await scanSources(store, {
          home,
          deadline: null,
          mode: "worker",
          streamDelayMs: testStreamDelayMs,
          shouldStop: () => stopping || fenceAborted,
          onProgress: (state) => {
            progress.update({
              ...state,
              mode: "worker",
              workerPid: process.pid,
              generation,
            });
          },
          onStreamProgress: (state) => {
            progress.update({
              ...state,
              mode: "worker",
              workerPid: process.pid,
              generation,
            });
          },
          onCheckpoint: async (state) => {
            scanViewUpdate(store, state);
            store.scan.workerPid = process.pid;
            const finished = new Date().toISOString();
            progress.update({
              processed: state.processed,
              total: state.total,
              file: state.file,
              filesRead: state.stats?.filesRead ?? 0,
              bytesRead: state.stats?.bytesRead ?? 0,
              mode: "worker",
              workerPid: process.pid,
              generation,
              phase: "scan",
            });
            if (Date.now() - lastSave >= SAVE_INTERVAL_MS) {
              // Never persist a checkpoint after this generation has been
              // fenced by configure/rebuild; fail closed if the fence cannot
              // be read so an old generation cannot leak a late commit.
              try {
                await fenceCheck();
              } catch {
                return;
              }
              if (fenceAborted) return;
              await saveStore(storePath, store, { status: "running", now: finished });
              lastSave = Date.now();
            }
          },
        });
      } finally {
        clearInterval(fenceTimer);
      }

      await fenceCheck();
      const finishedIso = new Date().toISOString();
      scanViewUpdate(store, scanned, {
        status: scanned.complete ? "complete" : "partial",
      });
      store.scan.currentFile = null;
      store.scan.workerPid = null;
      if (scanned.abortedFile) {
        store.scan.pendingFile = { ...scanned.abortedFile, requestedAt: finishedIso };
        store.scan.status = "partial";
      } else if (scanned.complete) {
        store.scan.pendingFile = null;
        store.scan.completedAt = finishedIso;
      }
      if (fenceAborted) {
        // A configure/rebuild owns the next generation. Leave the last
        // committed files intact and write nothing from this open generation.
        return { exitCode: 0, reason: "fenced" };
      }
      if (scanned.complete) {
        await saveStore(storePath, store, { completed: true, now: finishedIso });
      } else {
        await saveStore(storePath, store, { status: "partial", now: finishedIso });
      }
      return {
        exitCode: 0,
        reason: scanned.complete ? "complete" : (stopping ? "stopped" : "partial"),
      };
    }, {
      timeoutMs: 0,
      meta: { role: "worker", generation },
    });
    return result ?? { exitCode: 0 };
  } catch (error) {
    if (isLockBusyError(error)) return { exitCode: 0, reason: "lock-busy" };
    try {
      const loaded = await loadStore(storePath);
      const store = loaded.store;
      ensureStoreMeta(store);
      if (storeGeneration(store) === generation) {
        if (!store.scan) store.scan = emptyScanState();
        store.scan.status = "failed";
        store.scan.workerPid = null;
        store.scan.error = error.message;
        store.scan.updatedAt = new Date().toISOString();
        await saveStore(storePath, store, { status: "failed" });
      }
    } catch { /* failure reporting is best-effort */ }
    return { exitCode: 1, reason: "error", error };
  } finally {
    progress.clear();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await clearWorkerClaim(storePath, claimToken).catch(() => {});
  }
}

async function main() {
  try {
    const result = await runIndexer(process.argv.slice(2));
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    process.stderr.write(`insights indexer: ${error.message}\n`);
    process.exitCode = 1;
  }
}

function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) await main();
