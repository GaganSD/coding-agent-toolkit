import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";

import {
  addTask,
  addUsage,
  beginStoreTransaction,
  commitStoreTransaction,
  dedupKeyFor,
  emptyStore,
  findFileById,
  newFileEntry,
  removeLatestFallbackTaskForSession,
  resetFileEntry,
  rollbackStoreTransaction,
  snapshotRows,
  taskKeyFor,
} from "../../herdr-insights/mods/insights/core/store.mjs";
import { scanSources } from "../../herdr-insights/mods/insights/core/scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function meta(overrides = {}) {
  return {
    day: "2026-04-01",
    session: "session-a",
    harness: "codex",
    provider: "openai",
    model: "model-a",
    project: "/repo/a",
    ...overrides,
  };
}

function seedStore() {
  const store = emptyStore();
  const first = newFileEntry(store, {
    sourceId: "codex", adapter: "codex", path: "/a.jsonl", size: 10, mtimeMs: 1,
  });
  const second = newFileEntry(store, {
    sourceId: "codex", adapter: "codex", path: "/b.jsonl", size: 10, mtimeMs: 1,
  });
  first.state.sessions = { "codex:a": { turnStart: 1, turnFirst: 1, lastRow: null } };
  const usageKey = dedupKeyFor("codex", "response-a");
  addUsage(store, first, meta(), { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, usageKey);
  addUsage(store, second, meta(), { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, usageKey);
  addTask(store, first.id, 0, taskKeyFor("codex", "turn-1"), 1000, "codex:a", false, first.id);
  addTask(store, first.id, 0, taskKeyFor("codex", "turn-2"), 500, "codex:a", false, first.id);
  return { store, first, second, usageKey };
}

test("per-file transaction rollback restores rows, dedup, tasks, ownership and nextFileId", () => {
  const { store, first, second } = seedStore();
  const before = JSON.stringify(store);
  const beforeRows = JSON.stringify(snapshotRows(store));
  const beforeDedup = JSON.stringify(store.dedup);
  const beforeTasks = JSON.stringify(store.tasks);
  const beforeNext = store.nextFileId;

  const tx = beginStoreTransaction(store, { fileId: first.id });
  // Mutate the open file, a shared dedup owner, a sibling copy, and task state.
  resetFileEntry(store, first);
  const bumped = dedupKeyFor("codex", "response-a");
  addUsage(store, first, meta({ provider: "concrete" }), {
    input: 999, output: 99, cacheRead: 9, cacheWrite: 9, reasoning: 9,
  }, bumped);
  addUsage(store, second, meta(), {
    input: 11, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  }, bumped);
  addTask(store, second.id, 0, taskKeyFor("codex", "turn-1"), 5000, "codex:a", true, second.id);
  removeLatestFallbackTaskForSession(store, "codex:a");
  const created = newFileEntry(store, {
    sourceId: "codex", adapter: "codex", path: "/c.jsonl", size: 0, mtimeMs: 0,
  });
  created.state.scratch = true;
  assert.notEqual(store.nextFileId, beforeNext);
  assert.ok(findFileById(store, created.id));

  assert.equal(rollbackStoreTransaction(tx), true);
  assert.equal(JSON.stringify(store), before, "every touched store record is restored");
  assert.equal(JSON.stringify(snapshotRows(store)), beforeRows);
  assert.equal(JSON.stringify(store.dedup), beforeDedup);
  assert.equal(JSON.stringify(store.tasks), beforeTasks);
  assert.equal(store.nextFileId, beforeNext);
  assert.equal(findFileById(store, created.id), null);
  assert.ok(findFileById(store, first.id));
  assert.ok(findFileById(store, second.id));
  assert.equal(first.rows[0].input, 10);
  assert.equal(first.state.sessions["codex:a"].turnStart, 1);
});

test("rollback restores a stale dedup entry that a new owner replaced", () => {
  const { store, first } = seedStore();
  const staleKey = dedupKeyFor("codex", "stale-response");
  // A committed entry whose owner no longer exists is discarded on reuse.
  store.dedup[staleKey] = [9999, 0, 5, 1, 0, 0, 0];
  const before = JSON.stringify(store.dedup);

  const tx = beginStoreTransaction(store, { fileId: first.id });
  addUsage(store, first, meta(), {
    input: 7, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  }, staleKey);
  assert.equal(store.dedup[staleKey][0], first.id, "the stale owner was replaced");

  assert.equal(rollbackStoreTransaction(tx), true);
  assert.equal(JSON.stringify(store.dedup), before, "the stale entry comes back unchanged");
});

test("per-file transaction commit keeps mutations and releases the transaction", () => {
  const { store, first } = seedStore();
  const tx = beginStoreTransaction(store, { fileId: first.id });
  addUsage(store, first, meta(), {
    input: 50, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  }, dedupKeyFor("codex", "response-new"));
  assert.equal(commitStoreTransaction(tx), true);
  assert.equal(store._tx, undefined);
  assert.equal(snapshotRows(store)[0].tokens.input, 60);
  assert.equal(rollbackStoreTransaction(tx), false, "a committed transaction cannot roll back");
});

test("a corrupt archive after shared revisions preserves sibling rows, dedup and tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "insights-transaction-"));
  const home = path.join(root, "home");
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const plain = await readFile(path.join(here, "fixtures", "codex-modern.jsonl"), "utf8");
  const good = zstdCompressSync(plain);
  const first = path.join(sessions, "a.jsonl.zst");
  const second = path.join(sessions, "b.jsonl.zst");
  await writeFile(first, good);
  await writeFile(second, good);

  const store = emptyStore();
  store.config = {
    ...store.config,
    sources: [{ id: "codex", label: "Codex", adapter: "codex", enabled: true, roots: ["~/.codex/sessions"] }],
  };
  const initial = await scanSources(store, { home });
  assert.equal(initial.complete, true);
  assert.equal(initial.stats.errors, 0);
  const beforeRows = JSON.stringify(snapshotRows(store));
  const beforeDedup = JSON.stringify(store.dedup);
  const beforeTasks = JSON.stringify(store.tasks);
  const entryFor = (file) => Object.values(store.files).find(
    (item) => item.path === file || item.path.endsWith(path.basename(file)),
  );
  const beforeSecond = JSON.stringify(entryFor(second));

  // Compress a revision that would raise the shared usage before failing.
  const revised = plain.replaceAll('"input_tokens":100', '"input_tokens":999');
  assert.notEqual(revised, plain);
  await writeFile(second, Buffer.concat([
    zstdCompressSync(revised),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]),
  ]));
  const corrupted = await scanSources(store, { home });
  assert.equal(corrupted.stats.errors, 1);
  assert.equal(JSON.stringify(snapshotRows(store)), beforeRows);
  assert.equal(JSON.stringify(store.dedup), beforeDedup);
  assert.equal(JSON.stringify(store.tasks), beforeTasks);
  const entry = entryFor(second);
  assert.ok(entry);
  assert.deepEqual(entry.rows, JSON.parse(beforeSecond).rows);
  assert.deepEqual(entry.tasks, JSON.parse(beforeSecond).tasks);
  assert.equal(entry.state.zstdError !== undefined, true, "corrupt fingerprint is recorded");

  // The same broken fingerprint is not repeatedly re-read or re-warned.
  const repeated = await scanSources(store, { home });
  assert.equal(repeated.stats.errors, 0);
  assert.equal(repeated.stats.filesRead, 0);
  assert.equal(JSON.stringify(snapshotRows(store)), beforeRows);
});

test("a first-seen corrupt archive persists a rowless fingerprint and recovers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "insights-first-corrupt-"));
  const home = path.join(root, "home");
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const file = path.join(sessions, "bad.jsonl.zst");
  await writeFile(file, Buffer.from("not a zstd frame"));
  const store = emptyStore();
  store.config = {
    ...store.config,
    sources: [{ id: "codex", label: "Codex", adapter: "codex", enabled: true, roots: ["~/.codex/sessions"] }],
  };

  const first = await scanSources(store, { home });
  assert.equal(first.stats.errors, 1);
  const keys = Object.keys(store.files);
  assert.equal(keys.length, 1, "the corrupt file itself is fingerprinted");
  const entry = store.files[keys[0]];
  assert.equal(entry.path.endsWith(path.basename(file)), true);
  assert.deepEqual(entry.rows, []);
  assert.deepEqual(entry.tasks, []);
  const badStat = await stat(file);
  assert.equal(entry.size, badStat.size);
  assert.equal(entry.offset, badStat.size);
  assert.equal(entry.state.zstdError, `${badStat.mtimeMs}:${badStat.size}`);

  const repeated = await scanSources(store, { home });
  assert.equal(repeated.stats.errors, 0, "the stored fingerprint suppresses re-warning");
  assert.equal(repeated.stats.filesRead, 0);
  assert.equal(repeated.stats.bytesRead, 0);
  assert.equal(store.files[keys[0]], entry, "the same rowless stub stays in the store");
  assert.deepEqual(entry.rows, []);

  const plain = await readFile(path.join(here, "fixtures", "codex-modern.jsonl"), "utf8");
  await writeFile(file, zstdCompressSync(plain));
  const recovered = await scanSources(store, { home });
  assert.equal(recovered.stats.errors, 0);
  assert.equal(recovered.stats.filesRead, 1);
  assert.equal(entry.state.zstdError, undefined);
  assert.ok(entry.rows.length > 0, "a valid replacement is indexed");
});

function archiveStore() {
  const store = emptyStore();
  store.config = {
    ...store.config,
    sources: [{ id: "codex", label: "Codex", adapter: "codex", enabled: true, roots: ["~/.codex/sessions"] }],
  };
  return store;
}

async function codexFrames() {
  const plain = await readFile(path.join(here, "fixtures", "codex-modern.jsonl"), "utf8");
  const lines = plain.split("\n").filter(Boolean);
  const mid = Math.floor(lines.length / 2);
  return [
    zstdCompressSync(`${lines.slice(0, mid).join("\n")}\n`),
    zstdCompressSync(`${lines.slice(mid).join("\n")}\n`),
  ];
}

async function scanArchive(frames) {
  const root = await mkdtemp(path.join(tmpdir(), "insights-multiframe-"));
  const home = path.join(root, "home");
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const file = path.join(sessions, "archive.jsonl.zst");
  await writeFile(file, Buffer.concat(frames));
  const store = archiveStore();
  const first = await scanSources(store, { home });
  return { file, store, first };
}

test("two concatenated zstd frames both contribute rows", async () => {
  const [firstFrame, secondFrame] = await codexFrames();
  const { store, first } = await scanArchive([firstFrame, secondFrame]);
  assert.equal(first.stats.errors, 0);
  assert.equal(first.stats.filesRead, 1);
  const [entry] = Object.values(store.files);
  assert.equal(entry.state.zstdError, undefined);
  assert.equal(entry.rows.length, 2, "both frames were decoded");
  const rows = snapshotRows(store);
  assert.deepEqual(
    rows.map((row) => row.model).sort(),
    ["gpt-6.1", "gpt-6.2"],
  );
  assert.equal(rows.reduce((sum, row) => sum + row.messages, 0), 2);
});

test("a skippable zstd frame between data frames is ignored, not decoded", async () => {
  const [firstFrame, secondFrame] = await codexFrames();
  const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 0xaa, 0xbb, 0xcc]);
  const { store, first } = await scanArchive([firstFrame, skippable, secondFrame]);
  assert.equal(first.stats.errors, 0);
  const rows = snapshotRows(store);
  assert.deepEqual(
    rows.map((row) => row.model).sort(),
    ["gpt-6.1", "gpt-6.2"],
  );
  assert.equal(rows.reduce((sum, row) => sum + row.messages, 0), 2);
});

test("empty trailing data and skippable frames preserve preceding archive rows", async () => {
  const [firstFrame, secondFrame] = await codexFrames();
  const emptySkip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
  const { store, first } = await scanArchive([
    firstFrame, secondFrame, zstdCompressSync(Buffer.alloc(0)), emptySkip,
  ]);
  assert.equal(first.stats.errors, 0);
  assert.equal(snapshotRows(store).reduce((sum, row) => sum + row.messages, 0), 2);
  const empty = await scanArchive([zstdCompressSync(Buffer.alloc(0))]);
  assert.equal(empty.first.stats.errors, 0);
  assert.deepEqual(snapshotRows(empty.store), []);
});

test("a truncated second zstd frame rolls back and stays fingerprinted", async () => {
  const [firstFrame, secondFrame] = await codexFrames();
  const { file, store, first } = await scanArchive([
    firstFrame,
    secondFrame.subarray(0, secondFrame.length - 20),
  ]);
  assert.equal(first.stats.errors, 1, "the truncated frame is corrupt");
  assert.equal(snapshotRows(store).length, 0, "no frame rows are committed");
  const [entry] = Object.values(store.files);
  assert.equal(entry.rows.length, 0);
  const badStat = await stat(file);
  assert.equal(entry.state.zstdError, `${badStat.mtimeMs}:${badStat.size}`);
  assert.equal(entry.offset, badStat.size);

  const repeated = await scanSources(store, { home: path.dirname(path.dirname(path.dirname(file))) });
  assert.equal(repeated.stats.errors, 0);
  assert.equal(repeated.stats.filesRead, 0, "the corrupt fingerprint suppresses rereads");
  assert.equal(repeated.stats.bytesRead, 0);
  assert.equal(snapshotRows(store).length, 0);
});

test("replacing an archive binds the parser to fresh session state", async (t) => {
  const plain = await readFile(path.join(here, "fixtures", "codex-modern.jsonl"), "utf8");
  const { file, store, first } = await scanArchive([
    zstdCompressSync(plain.replaceAll("codex-fixture", "before-replacement")),
  ]);
  const home = path.dirname(path.dirname(path.dirname(file)));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(path.dirname(home), { recursive: true, force: true });
  });
  assert.equal(first.stats.errors, 0);
  assert.deepEqual([...new Set(snapshotRows(store).map((row) => row.session))], ["codex:before-replacement"]);
  // Grow the same inode so truncation handling cannot hide a stale parser context.
  const skip = Buffer.alloc(1024);
  skip.writeUInt32LE(0x184d2a50, 0);
  skip.writeUInt32LE(skip.length - 8, 4);
  await writeFile(file, Buffer.concat([
    zstdCompressSync(plain.replaceAll("codex-fixture", "after-replacement")),
    skip,
  ]));
  const updated = await scanSources(store, { home });
  assert.equal(updated.stats.errors, 0);
  const rows = snapshotRows(store);
  assert.deepEqual([...new Set(rows.map((row) => row.session))], ["codex:after-replacement"]);
  assert.equal(rows.reduce((sum, row) => sum + row.messages, 0), 2);
});

test("production scanning does not clone the accumulated store", async () => {
  const scanSource = await readFile(
    path.join(here, "../../herdr-insights/mods/insights/core/scan.mjs"),
    "utf8",
  );
  const collectorSource = await readFile(
    path.join(here, "../../herdr-insights/mods/insights/collector.mjs"),
    "utf8",
  );
  assert.doesNotMatch(scanSource, /structuredClone\(\s*store\s*\)/);
  assert.doesNotMatch(collectorSource, /structuredClone\(\s*store\s*\)/);
  assert.doesNotMatch(scanSource, /Object\.assign\(store,\s*checkpoint\)/);
});
