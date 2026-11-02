import { unlink } from "node:fs/promises";
import os from "node:os";
import {
  atomicWriteJson,
  isPlainObject,
  isProcessAlive,
  readJsonFile,
} from "./util.mjs";

// A generation fence is written BEFORE a configure/rebuild waits for the store
// lock. Any worker spawned for an older generation must stop and must not
// commit. The fence is advisory metadata next to the store (no transcript text)
// and is always written atomically with 0600 permissions.
const FENCE_VERSION = 1;
// A configure/rebuild holds its in-process work for seconds, never minutes.
// Only a provably dead local writer (or a long-abandoned fence) is ignored.
const FENCE_ABANDONED_MS = 10 * 60 * 1000;
// A claim may exist for a few milliseconds before the spawned pid is recorded.
export const WORKER_CLAIM_STARTUP_MS = 5_000;

export function fencePath(storePath) {
  return `${storePath}.generation.json`;
}

export function workerClaimPath(storePath) {
  return `${storePath}.worker.json`;
}

export function storeGeneration(store) {
  const value = Number(store?.generation);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function nextGeneration(...values) {
  let highest = 0;
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > highest) highest = number;
  }
  return highest + 1;
}

export async function readFence(storePath) {
  try {
    const value = await readJsonFile(fencePath(storePath));
    if (!isPlainObject(value)) return null;
    if (value.version !== FENCE_VERSION) return null;
    if (!Number.isInteger(value.generation) || value.generation < 1) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * A fence from a crashed configure must not block indexing forever. Ignore it
 * only when its local owner is provably dead or it is far older than any real
 * configure. Never kill the pid here; the lock remains the sole writer gate.
 */
export async function readEffectiveFence(storePath, { now = Date.now() } = {}) {
  const fence = await readFence(storePath);
  if (!fence) return null;
  const age = now - Number(fence.at ?? 0);
  const sameHost = fence.host === os.hostname();
  const dead = sameHost && Number.isInteger(fence.pid) && !isProcessAlive(fence.pid);
  const abandoned = Number.isFinite(age) && age > FENCE_ABANDONED_MS;
  return { ...fence, stale: dead || abandoned };
}

export async function writeFence(storePath, generation) {
  const value = {
    version: FENCE_VERSION,
    generation,
    pid: process.pid,
    host: os.hostname(),
    at: Date.now(),
  };
  await atomicWriteJson(fencePath(storePath), value);
  return value;
}

/** Raise the fence above both the committed generation and any prior fence. */
export async function bumpFence(storePath, committedGeneration = 0) {
  const current = await readFence(storePath);
  const generation = nextGeneration(committedGeneration, current?.generation ?? 0);
  return writeFence(storePath, generation);
}

/** Best-effort undo for a configure that failed before it committed. */
export async function restoreFence(storePath, generation) {
  const current = await readFence(storePath);
  if (!current || current.pid !== process.pid) return false;
  if (current.generation <= generation) return false;
  await writeFence(storePath, generation);
  return true;
}

export async function readWorkerClaim(storePath) {
  try {
    const value = await readJsonFile(workerClaimPath(storePath));
    if (!isPlainObject(value)) return null;
    if (typeof value.token !== "string" || value.token.length === 0) return null;
    if (!Number.isInteger(value.generation) || value.generation < 0) return null;
    return value;
  } catch {
    return null;
  }
}

export async function writeWorkerClaim(storePath, claim) {
  await atomicWriteJson(workerClaimPath(storePath), claim);
  return claim;
}

export async function clearWorkerClaim(storePath, token) {
  const current = await readWorkerClaim(storePath);
  if (!current || current.token !== token) return false;
  try {
    await unlink(workerClaimPath(storePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * A claim is live while its recorded pid is alive. A claim without a pid is
 * only a spawn in progress; it expires quickly so a crashed launcher cannot
 * pin the store. A claim from another host fails closed (never spawn a second
 * long-lived writer against a possibly shared directory).
 */
export function workerClaimActive(claim, { now = Date.now() } = {}) {
  if (!claim) return false;
  if (claim.host !== os.hostname()) return true;
  if (Number.isInteger(claim.pid) && claim.pid > 0) return isProcessAlive(claim.pid);
  const age = now - Number(claim.at ?? claim.startedAt ?? 0);
  return Number.isFinite(age) && age < WORKER_CLAIM_STARTUP_MS;
}
