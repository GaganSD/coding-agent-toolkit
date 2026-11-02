import { readFile, stat } from "node:fs/promises";
import { atomicWriteJson, isPlainObject } from "./util.mjs";

// The dashboard and status paths must stay fast while a long indexer holds the
// writer lock. This sidecar is a compact, metadata-only copy of the committed
// aggregate rows plus the truthful scan state. It is always derived from the
// committed store and is never read as a source for mutation.
const CACHE_VERSION = 1;
const STALE_MTIME_MS = 2;

export function presentationCachePath(storePath) {
  return `${storePath}.cache.json`;
}

export async function writePresentationCache(storePath, { savedAt, store, rows }) {
  const scan = isPlainObject(store?.scan) ? store.scan : {};
  const value = {
    version: CACHE_VERSION,
    savedAt: savedAt ?? store?.lastScanAt ?? null,
    lastScanAt: store?.lastScanAt ?? null,
    lastCompletedScanAt: store?.lastCompletedScanAt ?? null,
    generation: Number.isInteger(store?.generation) ? store.generation : 0,
    config: store?.config ?? {},
    rows: Array.isArray(rows) ? rows : [],
    scan,
  };
  await atomicWriteJson(presentationCachePath(storePath), value);
  return value;
}

function validCache(value) {
  return Boolean(
    isPlainObject(value)
      && value.version === CACHE_VERSION
      && isPlainObject(value.config)
      && Array.isArray(value.rows)
      && isPlainObject(value.scan)
      && (value.lastScanAt === null || typeof value.lastScanAt === "string")
      && (value.lastCompletedScanAt === null || typeof value.lastCompletedScanAt === "string")
      && Number.isInteger(value.generation)
      && value.generation >= 0,
  );
}

/**
 * Returns the cached presentation data only when it is at least as new as the
 * committed store file. A missing, corrupt, or older cache falls back to the
 * full store so prepare never invents data.
 */
export async function readPresentationCache(storePath) {
  try {
    const [storeStat, cacheStat] = await Promise.all([
      stat(storePath),
      stat(presentationCachePath(storePath)),
    ]);
    if (!storeStat.isFile() || !cacheStat.isFile()) return null;
    if (cacheStat.mtimeMs + STALE_MTIME_MS < storeStat.mtimeMs) return null;
    const value = JSON.parse(await readFile(presentationCachePath(storePath), "utf8"));
    if (!validCache(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export async function removePresentationCache(storePath) {
  const { unlink } = await import("node:fs/promises");
  await unlink(presentationCachePath(storePath)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
