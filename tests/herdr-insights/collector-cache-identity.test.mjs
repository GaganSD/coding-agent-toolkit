import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readCommittedSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import {
  presentationCachePath,
  readPresentationCache,
  storeRevisionFingerprint,
} from "../../herdr-insights/mods/insights/core/cache.mjs";
import { normalizeConfig } from "../../herdr-insights/mods/insights/core/config.mjs";
import { emptyStore, saveStore } from "../../herdr-insights/mods/insights/core/store.mjs";
import { atomicWriteJson } from "../../herdr-insights/mods/insights/core/util.mjs";

function storeWith(name, generation = 0) {
  const store = emptyStore(normalizeConfig({
    profile: { name },
    sources: [],
  }));
  store.generation = generation;
  store.scan.generation = generation;
  return store;
}

async function context(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  return { root, store: path.join(root, "data", "insights.json") };
}

test("an old cache is rejected after a new atomic store commit, even with the same mtime", async () => {
  const ctx = await context("insights-cache-identity-");
  const oldStore = storeWith("OLD");
  await saveStore(ctx.store, oldStore);

  const oldStat = await stat(ctx.store);
  const staleCache = JSON.parse(await readFile(presentationCachePath(ctx.store), "utf8"));
  assert.equal(staleCache.config.profile.name, "OLD");

  // Simulate a crash after the new store rename but before the cache rename.
  const newStore = JSON.parse(JSON.stringify(oldStore));
  newStore.config.profile.name = "NEW";
  newStore.generation = 1;
  newStore.scan.generation = 1;
  await atomicWriteJson(ctx.store, newStore);
  // Deliberately keep the old store mtime inside the former 2ms tolerance.
  await utimes(ctx.store, oldStat.atime, oldStat.mtime);

  const newStat = await stat(ctx.store);
  const cacheStat = await stat(presentationCachePath(ctx.store));
  assert.ok(
    cacheStat.mtimeMs + 2 >= newStat.mtimeMs,
    "the stale cache would satisfy the old 2ms mtime tolerance",
  );
  const newFingerprint = await storeRevisionFingerprint(ctx.store);
  assert.notDeepEqual(staleCache.storeFingerprint, newFingerprint);

  assert.equal(await readPresentationCache(ctx.store), null);
  const snapshot = await readCommittedSnapshot(ctx.store);
  assert.equal(snapshot.config.profile.name, "NEW", "prepare reads the committed NEW store");
  assert.equal(snapshot.scan.generation, 1);
});

test("a valid cache is a fast-path hit and legacy or failed caches fall back", async () => {
  const ctx = await context("insights-cache-fallback-");
  await saveStore(ctx.store, storeWith("CURRENT"));
  const cached = await readPresentationCache(ctx.store);
  assert.equal(cached?.config.profile.name, "CURRENT");
  assert.deepEqual(cached.storeFingerprint, await storeRevisionFingerprint(ctx.store));

  // Legacy cache without a store fingerprint must not be trusted.
  const legacy = { ...cached };
  delete legacy.storeFingerprint;
  legacy.version = 1;
  await atomicWriteJson(presentationCachePath(ctx.store), legacy);
  assert.equal(await readPresentationCache(ctx.store), null);
  const fallback = await readCommittedSnapshot(ctx.store);
  assert.equal(fallback.config.profile.name, "CURRENT");

  // A cache write failure must not fail the store commit; prepare uses it.
  await rm(presentationCachePath(ctx.store));
  await mkdir(presentationCachePath(ctx.store));
  await saveStore(ctx.store, storeWith("AFTER-FAILURE", 1));
  assert.equal(await readPresentationCache(ctx.store), null);
  const committed = await readCommittedSnapshot(ctx.store);
  assert.equal(committed.config.profile.name, "AFTER-FAILURE");
});

test("cache identity works through a symlinked store directory", async () => {
  const ctx = await context("insights-cache-symlink-");
  const real = path.join(ctx.root, "real");
  const linked = path.join(ctx.root, "linked");
  await mkdir(real, { recursive: true });
  await symlink(real, linked);
  const storePath = path.join(linked, "insights.json");
  await saveStore(storePath, storeWith("LINKED"));
  const cached = await readPresentationCache(storePath);
  assert.equal(cached?.config.profile.name, "LINKED");
  const snapshot = await readCommittedSnapshot(storePath);
  assert.equal(snapshot.config.profile.name, "LINKED");
});
