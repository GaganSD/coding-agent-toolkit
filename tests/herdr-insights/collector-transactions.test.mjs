import assert from "node:assert/strict";
import { appendFile, chmod, readFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";

import {
  addCodexTask,
  addTask,
  addUsage,
  beginStoreTransaction,
  commitStoreTransaction,
  dedupKeyFor,
  emptyStore,
  findFileById,
  fileKey,
  loadStore,
  newFileEntry,
  prepareStore,
  removeLatestFallbackTaskForSession,
  resetFileEntry,
  rollbackStoreTransaction,
  snapshotRows,
  taskKeyFor,
} from "../../herdr-insights/mods/insights/core/store.mjs";
import { scanSources } from "../../herdr-insights/mods/insights/core/scan.mjs";
import { CODEX_PARSER_VERSION } from "../../herdr-insights/mods/insights/core/codex-spend.mjs";
import { produceCodexRetry } from "./fixtures/codex-producer-model.mjs";

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

for (const unavailable of ["missing", "corrupt"]) {
  test(`Codex migration preserves shared revisions when a copy is ${unavailable}`, async (t) => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-shared-revision-")));
    t.after(() => rm(home, { recursive: true, force: true }));
    const dir = path.join(home, ".codex", "sessions");
    await mkdir(dir, { recursive: true });
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl.zst");
    const body = [
      { type: "session_meta", payload: { id: "revisions" } },
      { type: "token_usage_record", payload: { response_id: "r", usage: { input_tokens: 10, output_tokens: 0 } } },
    ].map((record) => JSON.stringify({ ...record, timestamp: "2026-11-01T10:00:00Z" })).join("\n") + "\n";
    await writeFile(a, body);
    if (unavailable === "corrupt") await writeFile(b, "not a valid archive");
    const store = archiveStore();
    const key = dedupKeyFor("codex", "response", "r");
    for (const [file, input] of [[a, 10], [b, 15]]) {
      const entry = newFileEntry(store, { sourceId: "codex", adapter: "codex", path: file, size: 1 });
      entry.state.codexParserVersion = 9;
      addUsage(store, entry, meta({ session: "codex:revisions" }), { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, key);
    }
    assert.deepEqual(snapshotRows(store).map((row) => [row.tokens.total, row.messages]), [[15, 1]]);
    const result = await scanSources(store, { home });
    assert.equal(result.complete, true);
    assert.deepEqual(snapshotRows(store).map((row) => [row.tokens.total, row.messages]), [[15, 1]]);
  });
}

test("a budget-aborted Codex upgrade keeps the complete old history even if the file disappears", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-partial-upgrade-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".codex", "sessions");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "history.jsonl");
  const modern = (response_id, input_tokens) => ({ type: "token_usage_record",
    payload: { response_id, usage: { input_tokens, output_tokens: 0 } } });
  const records = [{ type: "session_meta", payload: { id: "history" } },
    modern("a", 10), { type: "padding", payload: " ".repeat(300_000) }, modern("b", 20)];
  await writeFile(file, records.map((record) => JSON.stringify({ ...record, timestamp: "2026-11-01T10:00:00Z" })).join("\n") + "\n");
  const store = archiveStore();
  assert.equal((await scanSources(store, { home })).complete, true);
  Object.values(store.files)[0].state.codexParserVersion = 9;
  const prior = JSON.stringify(store);
  const partial = await scanSources(store, { home, deadline: 0 });
  assert.equal(partial.complete, false);
  assert.equal(partial.stats.bytesRead, 256 * 1024);
  assert.equal(JSON.stringify(store), prior);
  const storePath = path.join(home, "store.json");
  await writeFile(storePath, JSON.stringify(store));
  await rm(file);
  const loaded = (await loadStore(storePath)).store;
  assert.equal((await scanSources(loaded, { home })).complete, true);
  assert.deepEqual(snapshotRows(loaded).map((row) => [row.tokens.total, row.messages]), [[30, 2]]);
  assert.equal(Object.values(loaded.files)[0].state.codexParserVersion, 9);
});

test("old Codex echo cycles preserve the largest carrier regardless of insertion order", () => {
  for (const keys of [["p", "q"], ["q", "p"]]) {
    const store = emptyStore();
    const entry = newFileEntry(store, { sourceId: "codex", adapter: "codex", path: "/old-rollout.jsonl" });
    entry.state.codexParserVersion = 12;
    for (const key of keys) {
      const amount = key === "p" ? 5 : 15;
      addUsage(store, entry, meta(), { input: amount, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, key);
      store.dedup[key][7] = { echo: { key: key === "p" ? "q" : "p" } };
    }
    assert.deepEqual(snapshotRows(prepareStore(JSON.parse(JSON.stringify(store)))).map((r) => [r.tokens.total, r.messages]), [[15, 1]]);
  }
});

test("new Codex tasks do not search earlier task keys", () => {
  const store = emptyStore();
  const file = newFileEntry(store, { sourceId: "codex", adapter: "codex", path: "/rollout.jsonl" });
  addUsage(store, file, meta(), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, "usage");
  Object.defineProperty(file.tasks, "includes", { value: () => assert.fail("new tasks must not scan the task list") });
  for (let i = 0; i < 1000; i += 1) assert.ok(addCodexTask(store, file, "usage", `task-${i}`, 1, "session-a"));
  assert.equal(file.tasks.length, 1000);
});

test("Codex draft migration replaces inflated attribution, preserves unreadable and missing v9 history", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-v9-migration-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const source = await readFile(path.join(here, "fixtures", "codex-first-late-echo.jsonl"), "utf8");
  await Promise.all(["a.jsonl", "b.jsonl"].map((name) => writeFile(path.join(sessions, name), source)));
  const unreadable = path.join(sessions, "c.jsonl.zst");
  await writeFile(unreadable, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]));
  const store = emptyStore();
  const id = JSON.parse(source.split("\n")[0]).payload.id;
  const before = meta({ day: "2026-11-02", session: `codex:${id}`, model: "stale" });
  const usage = { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const name of ["a.jsonl", "b.jsonl", "c.jsonl.zst", "missing.jsonl"]) {
    const entry = newFileEntry(store, {
      sourceId: "codex", adapter: "codex", path: path.join(sessions, name), size: 1, mtimeMs: 0,
    });
    entry.state.codexParserVersion = ["a.jsonl", "b.jsonl"].includes(name) ? 16 : 9;
    if (["a.jsonl", "b.jsonl"].includes(name)) {
      addUsage(store, entry, before, usage, dedupKeyFor("codex", "response", "resp_1"));
      addUsage(store, entry, before, usage, dedupKeyFor("codex", "legacy-v9-duplicate"));
    } else {
      addUsage(store, entry, meta({ session: name }), usage, dedupKeyFor("codex", name));
    }
  }
  const migrated = await scanSources(store, { home });
  assert.equal(migrated.stats.errors, 1);
  assert.match(migrated.warnings.join("\n"), /archive upgrade failed; prior usage retained/);
  const corrected = snapshotRows(store).find((row) => row.session === before.session);
  assert.deepEqual([corrected.day, corrected.model, corrected.tokens.total, corrected.messages], ["2026-11-01", "m", 110, 1]);
  assert.equal(snapshotRows(store).filter((row) => row.session === before.session).length, 1, "no stale bucket remains");
  assert.deepEqual(snapshotRows(store).filter((row) => row.session.endsWith("jsonl") || row.session.endsWith("zst"))
    .map((row) => [row.session, row.tokens.total]), [["c.jsonl.zst", 220], ["missing.jsonl", 220]]);
  assert.deepEqual(Object.values(store.files).map((entry) => entry.state.codexParserVersion), [CODEX_PARSER_VERSION, CODEX_PARSER_VERSION, 9, 9]);
  const stable = await scanSources(store, { home });
  assert.equal(stable.stats.bytesRead, 0);
  assert.match(stable.warnings.join("\n"), /older parser/);
});

test("real main v9 store preserves incomplete history and refuses a replacement of an indexed checkpoint", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-real-v9-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const { initial, store: v9 } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-main-v9.json"), "utf8"));
  v9.files = Object.fromEntries(Object.values(v9.files).map((entry) => {
    entry.path = path.join(sessions, entry.path);
    return [fileKey(entry.sourceId, entry.path), entry];
  }));
  const db = path.join(home, "usage.json");
  await writeFile(db, JSON.stringify(v9));
  const { store } = await loadStore(db);
  const usage = () => Object.fromEntries(snapshotRows(store).map((r) => [r.session, [r.tokens.total, r.messages]]));
  assert.deepEqual(usage(), { "codex:v9-history": [30, 2], "codex:v9-maxima": [50, 3] });

  const history = path.join(sessions, "history.jsonl");
  const maxB = path.join(sessions, "max-b.jsonl");
  // Stable on disk and longer than the original, but the suffix is not an
  // accepted record. It cannot replace the previous complete index.
  const historicalPrefix = initial["history.jsonl"].trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
  await writeFile(history, historicalPrefix + '{"padding":"' + "x".repeat(500));
  await writeFile(path.join(sessions, "max-a.jsonl"), initial["max-b.jsonl"]);
  await writeFile(maxB, initial["max-b.jsonl"] + '{"incomplete":');
  const partial = await scanSources(store, { home });
  assert.equal(partial.complete, true);
  assert.match(partial.warnings.join("\n"), /upgrade could not verify a complete reparse/);
  assert.deepEqual(usage()["codex:v9-history"], [30, 2]);
  assert.ok(usage()["codex:v9-maxima"][0] >= 30);
  assert.equal((await scanSources(store, { home })).stats.bytesRead, 0);

  const append = (id) => JSON.stringify({ type: "token_usage_record", timestamp: "2026-11-01T10:03:00Z",
    payload: { response_id: id, usage: { input_tokens: 10 } } }) + "\n";
  await writeFile(history, initial["history.jsonl"] + append("third"));
  await writeFile(maxB, initial["max-b.jsonl"]);
  const migrated = await scanSources(store, { home });
  assert.equal(migrated.stats.errors, 1, "a historical malformed line is still diagnosed");
  assert.deepEqual(usage(), { "codex:v9-history": [40, 3], "codex:v9-maxima": [50, 3] });
  // max-a's original one-token carrier was replaced. Another existing
  // copy's carrier is not proof that the removed carrier was accepted.
  assert.equal(store.files[fileKey("codex", path.join(sessions, "max-a.jsonl"))].state.codexParserVersion, 9);
  assert.equal(store.files[fileKey("codex", maxB)].state.codexParserVersion, CODEX_PARSER_VERSION);

  await appendFile(history, append("fourth"));
  assert.equal((await scanSources(store, { home })).stats.bytesRead, Buffer.byteLength(append("fourth")));
  assert.deepEqual(usage()["codex:v9-history"], [50, 4]);
});

test("real v9 retry preserves accepted history despite null, blank, or corrupt replacements", async (t) => {
  const { initial, store: v9 } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-main-v9.json"), "utf8"));
  const original = initial["history.jsonl"];
  const prefix = original.trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
  const previous = Object.values(v9.files).find((entry) => entry.path === "history.jsonl");
  const append = JSON.stringify({ type: "token_usage_record", timestamp: "2026-11-01T10:03:00Z",
    payload: { response_id: "new-after-corruption", usage: { input_tokens: 5 } } }) + "\n";
  for (const [label, replacement] of [["blank", " "], ["null", "null"], ["corrupt", "!"]]) {
    await t.test(label, async (sub) => {
      const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-v9-retry-")));
      sub.after(() => rm(home, { recursive: true, force: true }));
      const sessions = path.join(home, ".codex", "sessions");
      const file = path.join(sessions, "history.jsonl");
      const db = path.join(home, "usage.json");
      await mkdir(sessions, { recursive: true });
      const otherIds = new Set(Object.values(v9.files).filter((entry) => entry !== previous).map((entry) => entry.id));
      await writeFile(db, JSON.stringify({ ...v9, files: { [fileKey(previous.sourceId, file)]: { ...previous, path: file } },
        dedup: Object.fromEntries(Object.entries(v9.dedup).filter(([, dedup]) => !otherIds.has(dedup[0]))) }));
      const gather = () => collectSnapshot("snapshot", { home, store: db });
      const amount = (result) => result.rows.map((row) => [row.tokens.total, row.messages]);
      await writeFile(file, prefix + replacement.padEnd(Buffer.byteLength(original), " ") + "\n");
      const refused = await gather();
      assert.deepEqual(amount(refused), [[30, 2]]);
      assert.match(refused.warnings.join("\n"), /prior usage retained/);
      await appendFile(file, append);
      assert.deepEqual(amount(await gather()), [[35, 3]]);
      assert.deepEqual(amount(await gather()), [[35, 3]]);
      await writeFile(file, original);
      assert.deepEqual(amount(await gather()), [[35, 3]], "the independently indexed suffix cannot silently disappear");
      await writeFile(file, original + append);
      assert.deepEqual(amount(await gather()), [[35, 3]]);
      assert.equal(Object.values((await loadStore(db)).store.files)[0].state.codexParserVersion, CODEX_PARSER_VERSION);
    });
  }
});

test("real v9 indexes retain newly appended keys, revision values and task time through retries", async (t) => {
  const { samples } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-retry-v9.json"), "utf8"));
  const damageLast = (body) => body.replace(/[^\n]+\n$/, (line) => "!".repeat(line.length - 1) + "\n");
  const generated = Object.fromEntries(Array.from({ length: 8 }, (_, i) =>
    [`first-history-seed-${i + 1}`, produceCodexRetry(i + 1, samples.downgrade.rollouts.at(-1), 30)]));
  for (const [variant, expected] of Object.entries({ downgrade: [30, 2, 0], revision: [25, 1, 0], task: [10, 1, 3000],
    "missing-index": [30, 2, 0], "missing-cursor": [30, 2, 0], "false-witness": [30, 2, 0],
    "first-history": [35, 3, 0], "first-history-repeat": [35, 3, 0],
    ...Object.fromEntries(Object.entries(generated).map(([key, { input }]) => [key, [input, 3, 0]])) })) {
    await t.test(variant, async (sub) => {
      const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-v9-values-")));
      sub.after(() => rm(home, { recursive: true, force: true }));
      const sessions = path.join(home, ".codex", "sessions");
      const file = path.join(sessions, "rollout.jsonl");
      const db = path.join(home, "usage.json");
      await mkdir(sessions, { recursive: true });
      const { rollouts, stores } = structuredClone(samples[variant] ?? samples.downgrade);
      const gather = () => collectSnapshot("snapshot", { home, store: db });
      const value = (result) => result.rows.map((row) => [row.tokens.total, row.messages, row.activeMs]);
      const install = async (snapshot) => {
        const entry = Object.values(snapshot.files)[0];
        entry.path = file;
        snapshot.files = { [fileKey(entry.sourceId, file)]: entry };
        await writeFile(db, JSON.stringify(snapshot));
        return entry;
      };
      if (variant === "downgrade") {
        await install(stores[0]);
        await writeFile(file, damageLast(rollouts[0]));
        assert.deepEqual(value(await gather()), [[10, 1, 0]]);
        // Install the index made by actual main after re-append; v9 preserves
        // fields it does not understand when appending to its prior index.
        Object.values(stores[1].files)[0].state.codexUpgradeEvidence = Object.keys(stores[0].dedup);
      }
      const snapshot = stores.at(-1);
      if (variant === "missing-index") delete snapshot.dedup[Object.keys(snapshot.dedup).at(-1)];
      if (variant === "missing-cursor") Object.values(snapshot.files)[0].lineNo = 0;
      if (variant === "false-witness") Object.values(snapshot.files)[0].state.codexUpgradeEvidence = [];
      await install(snapshot);
      if (variant === "missing-index") assert.deepEqual(value(await gather()), [expected]);
      const repeat = variant === "first-history-repeat" ? rollouts.at(-1).trimEnd().split("\n").at(-1) + "\n" : "";
      const firstHistory = generated[variant]?.tail ?? (variant.startsWith("first-history") ? repeat + JSON.stringify({
        timestamp: "2026-11-01T10:01:00Z", type: "event_msg", payload: { type: "token_count",
          info: { total_token_usage: { input_tokens: 35 }, last_token_usage: { input_tokens: 5 } } },
      }) + "\n" : "");
      let corrupted = damageLast(rollouts.at(-1)) + firstHistory;
      if (variant === "false-witness") corrupted = rollouts[0] + JSON.stringify({
        timestamp: "2026-11-01T10:01:00Z", type: "event_msg", payload: { type: "token_count", response_id: "b",
          info: { total_token_usage: { input_tokens: 10 }, last_token_usage: { input_tokens: 0 } } }, padding: "x".repeat(500),
      }) + "\n";
      await writeFile(file, corrupted);
      const rejected = await gather();
      assert.deepEqual(value(rejected), [expected]);
      assert.match(rejected.warnings.join("\n"), /prior usage retained/);
      assert.deepEqual(value(await gather()), [expected]);
      assert.equal(Object.values((await loadStore(db)).store.files)[0].state.codexParserVersion, 9);
      if (variant !== "missing-index") {
        await writeFile(file, rollouts.at(-1) + firstHistory);
        assert.deepEqual(value(await gather()), [expected]);
        assert.equal(Object.values((await loadStore(db)).store.files)[0].state.codexParserVersion, CODEX_PARSER_VERSION);
      }
    });
  }
});

test("migration never uses a retired copy's usage observation to replace a larger indexed revision", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-retired-witness-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions");
  const file = path.join(sessions, "rollout.jsonl");
  const db = path.join(home, "usage.json");
  await mkdir(sessions, { recursive: true });
  const { samples } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-retry-v9.json"), "utf8"));
  const { rollouts: [original], stores: [prior] } = samples.revision;
  const entry = Object.values(prior.files)[0];
  entry.path = file;
  const retired = { ...entry, id: 2, path: path.join(sessions, "retired.jsonl"), rows: [], tasks: [] };
  prior.nextFileId = 3;
  prior.files = Object.fromEntries([entry, retired].map((value) => [fileKey(value.sourceId, value.path), value]));
  const { day, session, harness, provider, model, project } = entry.rows[0];
  const meta = { day, session, harness, provider, model, project };
  Object.values(prior.dedup)[0][7] = { meta, copies: [], codexObserved: { 2: { meta, tokens: [25, 0, 0, 0, 0] } } };
  await writeFile(db, JSON.stringify(prior));
  await writeFile(file, original.replace('"input_tokens":25', '"input_tokens":10'));
  const gather = () => collectSnapshot("snapshot", { home, store: db });
  assert.deepEqual((await gather()).rows.map((row) => [row.tokens.total, row.messages]), [[25, 1]]);
  assert.equal(Object.values((await loadStore(db)).store.files)[0].state.codexParserVersion, 9);
  await writeFile(file, original);
  assert.deepEqual((await gather()).rows.map((row) => [row.tokens.total, row.messages]), [[25, 1]]);
  assert.equal(Object.values((await loadStore(db)).store.files)[0].state.codexParserVersion, CODEX_PARSER_VERSION);
});

test("a shorter task in a new copy cannot lower an unavailable v9 task's duration", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-mixed-task-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions");
  const db = path.join(home, "usage.json");
  await mkdir(sessions, { recursive: true });
  const { samples } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-retry-v9.json"), "utf8"));
  const { rollouts: [original], stores: [prior] } = samples.task;
  const entry = Object.values(prior.files)[0];
  entry.path = path.join(sessions, "unavailable.jsonl");
  prior.files = { [fileKey(entry.sourceId, entry.path)]: entry };
  await writeFile(db, JSON.stringify(prior));
  await writeFile(path.join(sessions, "copy.jsonl"), original.replace('"duration_ms":3000', '"duration_ms":1000'));
  for (let i = 0; i < 2; i++) {
    const result = await collectSnapshot("snapshot", { home, store: db });
    assert.deepEqual(result.rows.map((row) => [row.tokens.total, row.messages, row.activeMs]), [[10, 1, 3000]]);
  }
});

test("historical v5–v9 and committed draft v10–v11 indexes upgrade or retain history while appending", async (t) => {
  const { rollouts, suffix, parsers } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-migration-matrix.json"), "utf8"));
  for (const [version, { samples }] of Object.entries(parsers)) {
    for (const [kind, sample] of Object.entries(samples)) {
      for (const damaged of [false, true]) for (const append of [false, true]) {
        await t.test(`v${version} ${kind}, ${damaged ? "damaged" : "healthy"}, ${append ? "append" : "no append"}`, async (sub) => {
          const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-version-matrix-")));
          sub.after(() => rm(home, { recursive: true, force: true }));
          const sessions = path.join(home, ".codex", "sessions");
          const file = path.join(sessions, "matrix.jsonl");
          const db = path.join(home, "usage.json");
          await mkdir(sessions, { recursive: true });
          const old = { config: emptyStore().config, ...structuredClone(sample) };
          const entry = Object.values(old.files)[0];
          assert.equal(entry.state.codexParserVersion, Number(version));
          entry.path = file;
          old.files = { [fileKey(entry.sourceId, file)]: entry };
          await writeFile(db, JSON.stringify(old));
          await loadStore(db, { readOnly: true }); // Do not silently test a fresh rebuild.
          const original = rollouts[kind];
          const damagedPrefix = (kind === "history" ? /[^\n]+\n$/ : /[^\n]+"response_id":"b"[^\n]+\n/);
          const prefix = damaged ? original.replace(damagedPrefix, (line) => "!".repeat(line.length - 1) + "\n") : original;
          assert.equal(prefix !== original, damaged);
          const tail = append ? suffix[kind] : "";
          await writeFile(file, prefix + tail);
          const gather = () => collectSnapshot("snapshot", { home, store: db });
          const total = (result) => result.rows.reduce(([tokens, messages], row) =>
            [tokens + row.tokens.total, messages + row.messages], [0, 0]);
          const expected = append ? [35, 3] : [30, 2];
          const initial = await gather();
          assert.deepEqual(total(initial), expected);
          const parser = async () => Object.values((await loadStore(db)).store.files)[0].state.codexParserVersion;
          assert.equal(await parser(), damaged ? Number(version) : CODEX_PARSER_VERSION);
          assert.equal((await gather()).stats.bytesRead, 0);
          if (damaged) {
            await writeFile(file, original + tail);
            assert.deepEqual(total(await gather()), expected);
            assert.equal(await parser(), CODEX_PARSER_VERSION);
          }
        });
      }
    }
  }
});

// Index snapshots emitted by the recorded historical commits; only paths
// and file-stat identities are normalized for relocation.
test("genuine v5–v9 native copied-fork and no-spend turn upgrades", async (t) => {
  const fixtures = path.join(here, "fixtures");
  const { fork, shell, compact, suffix, archivedParent, forkChild, forkSuffix, replays, parsers } = JSON.parse(
    await readFile(path.join(fixtures, "codex-migration-native.json"), "utf8"));
  const replayFiles = Object.fromEntries(await Promise.all(Object.entries(replays).map(async ([kind, file]) =>
    [kind, { [file]: await readFile(path.join(fixtures, file), "utf8") }])));
  for (const [version, { samples }] of Object.entries(parsers)) {
    for (const [kind, sample] of Object.entries(samples)) {
      const noSpend = kind === "shell" ? shell : kind === "compact" ? compact : null;
      const archived = kind === "archivedParent";
      const cases = kind === "shell" ? ["initial", "append", "damaged append"]
        : noSpend || archived ? ["initial", "append"] : ["initial"];
      if (kind === "shell" && version === "9") cases.push("completion without an attributable row");
      for (const situation of cases) await t.test(`v${version} ${kind}: ${situation}`, async (sub) => {
        const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-native-matrix-")));
        sub.after(() => rm(home, { recursive: true, force: true }));
        const sessions = path.join(home, ".codex", "sessions");
        await mkdir(sessions, { recursive: true });
        const db = path.join(home, "usage.json");
        const old = { config: emptyStore().config, ...structuredClone(sample) };
        const files = Object.values(old.files);
        const name = `${kind}.jsonl`;
        const rollouts = noSpend ? { [name]: noSpend } : archived ? archivedParent : replayFiles[kind] ?? fork;
        const suffixPath = path.join(archived ? path.dirname(sessions) : sessions, archived ? forkChild : name);
        const tail = archived ? forkSuffix : suffix;
        for (const entry of files) {
          assert.equal(entry.state.codexParserVersion, Number(version));
          const name = entry.path;
          entry.path = path.join(archived ? path.dirname(sessions) : sessions, name);
          const original = rollouts[name.replace(/\.zst$/, "")];
          await mkdir(path.dirname(entry.path), { recursive: true });
          await writeFile(entry.path, entry.compressed ? zstdCompressSync(original) : original);
        }
        old.files = Object.fromEntries(files.map((entry) => [fileKey(entry.sourceId, entry.path), entry]));
        await writeFile(db, JSON.stringify(old));
        await loadStore(db, { readOnly: true });
        const gather = (store = db) => collectSnapshot("snapshot", { home, store });
        const stamps = async () => Object.values((await loadStore(db)).store.files).map((f) => f.state.codexParserVersion);
        const totals = (result) => result.rows.reduce(([tokens, messages, ms], row) =>
          [tokens + row.tokens.total, messages + row.messages, ms + row.activeMs], [0, 0, 0]);
        const byModel = (result) => Object.fromEntries(result.rows.map((r) => [r.model, [r.tokens.total, r.messages, r.activeMs]]));
        if (situation === "damaged append") {
          const damaged = shell.replace(/[^\n]+"response_id":"r1"[^\n]+\n/,
            (line) => "!".repeat(line.length - 1) + "\n");
          assert.notEqual(damaged, shell);
          await writeFile(suffixPath, damaged + suffix);
          assert.deepEqual(byModel(await gather()), { initial: [5, 1, 10000], next: [10, 1, 4000] });
          assert.deepEqual(await stamps(), [Number(version)]);
          assert.equal((await gather()).stats.bytesRead, 0);
          // A missing suffix completion must not undo time already accepted.
          await writeFile(suffixPath, shell + suffix.replace(/[^\n]+"duration_ms":4000[^\n]+\n/, ""));
          assert.deepEqual(byModel(await gather()), { initial: [5, 1, 10000], next: [10, 1, 4000] });
          assert.deepEqual(await stamps(), [Number(version)]);
          await writeFile(suffixPath, shell + suffix);
        } else if (situation === "completion without an attributable row") {
          // Same indexed usage and completion, but damage to producer order
          // leaves the first completion with no usage bucket on reparse.
          const lines = shell.trimEnd().split("\n");
          const [completion] = lines.splice(lines.findIndex((line) => line.includes('"duration_ms":3000')), 1);
          assert.ok(completion.includes('"duration_ms":3000'));
          lines.splice(1, 0, completion);
          await writeFile(suffixPath, lines.join("\n") + "\n");
          assert.deepEqual(byModel(await gather()), { initial: [5, 1, 10000] });
          assert.deepEqual(await stamps(), [Number(version)]);
          await writeFile(suffixPath, shell);
        } else if (situation === "append") {
          await appendFile(suffixPath, tail);
        }
        const result = await gather();
        const cold = await gather(path.join(home, "cold.json"));
        assert.deepEqual(result.rows, cold.rows);
        assert.deepEqual(await stamps(), files.map(() => CODEX_PARSER_VERSION));
        assert.equal(result.stats.errors, 0);
        if (noSpend || archived) {
          const first = archived ? { parent: [100, 1, 3000], child: [5, 1, 7000] } : { initial: [5, 1, 10000] };
          const appended = { ...first, next: [10, 1, 4000] };
          const hasAppend = situation === "append" || situation === "damaged append";
          assert.deepEqual(byModel(result), hasAppend ? appended : first);
          assert.deepEqual((await gather()).rows, result.rows, "warm scan preserves exact task duration");
          if (situation === "initial") {
            await appendFile(suffixPath, tail);
            assert.deepEqual(byModel(await gather()), appended);
          }
        } else {
          assert.deepEqual(totals(result), kind in replayFiles ? [250, 2, 0] : [105, 2, 0]);
          if (!(kind in replayFiles)) assert.deepEqual(byModel(result), { initial: [100, 1, 0], child: [5, 1, 0] });
        }
      });
    }
  }
});

test("real v9 boundaries: missing copies, new corruption, and decoded archive verification", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-boundary-v9-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const { initial, store: v9 } = JSON.parse(await readFile(path.join(here, "fixtures", "codex-boundaries-v9.json"), "utf8"));
  v9.files = Object.fromEntries(Object.values(v9.files).map((entry) => {
    entry.path = path.join(sessions, entry.path);
    return [fileKey(entry.sourceId, entry.path), entry];
  }));
  const file = (name) => path.join(sessions, name);
  const db = path.join(home, "usage.json");
  await writeFile(db, JSON.stringify(v9));
  const { store } = await loadStore(db);
  const rows = () => Object.fromEntries(snapshotRows(store).map((r) => [r.session.slice(6), [r.tokens.total, r.messages]]));
  const append = (id) => JSON.stringify({ type: "token_usage_record", timestamp: "2026-11-01T10:10:00Z",
    payload: { response_id: id, usage: { input_tokens: 10 } } }) + "\n";
  for (const key of ["legacy-a.jsonl", "mixed-a.jsonl", "history-a.jsonl"]) await writeFile(file(key), initial[key]);
  assert.ok(v9.scan.warnings.length < 51, "main did not retain all original diagnostics");
  await writeFile(file("capped.jsonl"), initial["capped.jsonl"] + append("capped-third"));
  const prefix = (name) => initial[name].trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
  await writeFile(file("bad-plain.jsonl"), prefix("bad-plain.jsonl") + "!".repeat(400) + "\n");
  await writeFile(file("bad-zstd.jsonl.zst"), zstdCompressSync(prefix("bad-zstd.jsonl.zst") + '{"partial":'));
  await writeFile(file("old-bad-zstd.jsonl.zst"), zstdCompressSync(initial["old-bad-zstd.jsonl.zst"] + append("archive-third")));
  const repacked = zstdCompressSync(initial["repack.jsonl.zst"] + append("repack-last"));
  assert.ok(repacked.length < v9.files[fileKey("codex", file("repack.jsonl.zst"))].size);
  await writeFile(file("repack.jsonl.zst"), repacked);
  const result = await scanSources(store, { home });
  assert.equal(result.warnings.filter((warning) => /verify a complete reparse/.test(warning)).length, 2);
  const expected = { "legacy-copy": [25, 2], "mixed-copy": [30, 3], "history-copy": [30, 2],
    "capped-warnings": [40, 3], "bad-plain": [30, 2], "bad-zstd": [30, 2], "old-bad-zstd": [40, 3], repack: [70, 7] };
  assert.deepEqual(rows(), expected);
  assert.equal((await scanSources(store, { home })).stats.bytesRead, 0);

  for (const key of ["legacy-b.jsonl", "mixed-b.jsonl", "history-b.jsonl", "bad-plain.jsonl"]) {
    await writeFile(file(key), initial[key]);
  }
  await writeFile(file("bad-zstd.jsonl.zst"), zstdCompressSync(initial["bad-zstd.jsonl.zst"]));
  await scanSources(store, { home });
  assert.deepEqual(rows(), expected);
  assert.ok(Object.values(store.files).every((entry) => entry.state.codexParserVersion === CODEX_PARSER_VERSION));
});

for (const [name, archive, migration] of [["archive migration", true, true], ["new archive", true, false], ["plain migration", false, true]]) {
  test(`Codex handles permission failures on ${name} and recovers`, {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), "codex-permissions-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const sessions = path.join(home, ".codex", "sessions");
    await mkdir(sessions, { recursive: true });
    const file = path.join(sessions, archive ? "rollout.jsonl.zst" : "rollout.jsonl");
    const source = await readFile(path.join(here, "fixtures", "codex-concurrent-counters.jsonl"));
    await writeFile(file, archive ? zstdCompressSync(source) : source, { mode: 0o600 });
    const store = archiveStore();
    if (migration) {
      await scanSources(store, { home });
      Object.values(store.files)[0].state.codexParserVersion = 9;
    }
    const rows = snapshotRows(store);
    await chmod(file, 0o000);
    try {
      const unavailable = await scanSources(store, { home });
      assert.equal(unavailable.stats.errors, 1);
      const warning = unavailable.warnings.join("\n");
      const [entry] = Object.values(store.files);
      if (migration) {
        assert.match(warning, archive ? /archive upgrade failed; prior usage retained/ : /upgrade read failed; prior usage retained/);
        assert.doesNotMatch(warning, /accepted prefix retained/);
        assert.equal(entry.state.codexParserVersion, 9);
        if (archive) assert.equal(entry.state.codexUpgradeRejected.reason, "corrupt");
      } else {
        assert.match(warning, /zstd file could not be decompressed/);
        assert.ok(entry.state.zstdError);
      }
      assert.deepEqual(snapshotRows(store), rows);
      if (archive) {
        const repeated = await scanSources(store, { home });
        assert.equal(repeated.stats.errors, 0);
        assert.equal(repeated.stats.unchangedFiles, 1);
      }
    } finally {
      await chmod(file, 0o600);
    }
    const recovered = await scanSources(store, { home });
    assert.equal(recovered.stats.errors, 0);
    assert.equal(recovered.stats.filesRead, 1);
    assert.equal(Object.values(store.files)[0].state.codexParserVersion, CODEX_PARSER_VERSION);
    if (migration) assert.deepEqual(snapshotRows(store), rows);
    else assert.ok(snapshotRows(store).length);
  });
}

test("a cached Codex upgrade rejection does not bypass superseded-entry cleanup", async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "codex-cached-rejection-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const logs = path.join(home, "conversation", ".system_generated", "logs");
  await mkdir(logs, { recursive: true });
  const transcript = path.join(logs, "transcript.jsonl");
  await writeFile(transcript, "not a transcript\n");
  const info = await stat(transcript);
  const store = emptyStore();
  // Antigravity discovery supplies superseded keys. Seed a stale Codex entry
  // under the same configured source key to exercise both paths together.
  store.config.sources = [{ id: "custom", adapter: "antigravity", enabled: true, roots: [home] }];
  const prior = newFileEntry(store, { sourceId: "custom", adapter: "codex", path: transcript });
  newFileEntry(store, { sourceId: "custom", adapter: "antigravity", path: path.join(home, "conversations", "conversation.db") });
  prior.state.codexParserVersion = 9;
  prior.state.codexUpgradeRejected = {
    fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    reason: "corrupt", version: CODEX_PARSER_VERSION,
  };
  addUsage(store, prior, meta(), { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, dedupKeyFor("codex", "prior"));
  const rows = snapshotRows(store);
  const result = await scanSources(store, { home });
  assert.equal(result.dirty, true);
  assert.equal(result.stats.bytesRead, 0);
  assert.deepEqual(Object.values(store.files), [prior]);
  assert.deepEqual(snapshotRows(store), rows);
});

test("the store validates Codex tasks keyed by usage", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-task-validation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "store.json");
  const store = emptyStore();
  const entry = [1, -1, 1000, 1, "session"];
  const base = { meta: meta(), copies: [], usageKey: "response" };
  for (const aux of [undefined, { ...base, usageKey: undefined }, { ...base, usageKey: "" },
    { ...base, usageKey: 1 }, { ...base, copyTargets: [] }, { ...base, copyTargets: { 2: null } }]) {
    store.tasks.task = aux ? [...entry, aux] : entry;
    await writeFile(file, JSON.stringify(store));
    await assert.rejects(loadStore(file, { readOnly: true }), (error) => error.cause?.message === "task entry task is malformed");
  }
  store.tasks.task = [...entry, { ...base, copyTargets: { 2: "snapshot" } }];
  await writeFile(file, JSON.stringify(store));
  assert.deepEqual((await loadStore(file, { readOnly: true })).store.tasks.task, store.tasks.task);
});

test("a failed Codex archive rolls back its response and interval settlement", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-promotion-rollback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".codex", "sessions");
  await mkdir(dir, { recursive: true });
  const source = (await readFile(path.join(here, "fixtures", "codex-first-late-echo.jsonl"), "utf8")).trimEnd().split("\n");
  const prefix = [source[0], source[1], source[3]].join("\n") + "\n";
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl.zst");
  await writeFile(a, prefix);
  const store = emptyStore();
  await scanSources(store, { home });
  const rows = snapshotRows(store);
  assert.deepEqual(rows.map((row) => [row.tokens.total, row.messages]), [[110, 1]]);
  const beforeKeys = JSON.stringify(store.dedup);
  const frames = [zstdCompressSync(source.slice(0, 3).join("\n") + "\n"), zstdCompressSync(source[3] + "\n")];
  await writeFile(b, Buffer.concat([...frames, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0])]));
  assert.equal((await scanSources(store, { home })).stats.errors, 1);
  assert.deepEqual(snapshotRows(store), rows);
  assert.equal(JSON.stringify(store.dedup), beforeKeys);
  assert.equal(Object.values(store.dedup).filter((entry) => entry[7]?.echo).length, 0);

  await writeFile(b, Buffer.concat(frames));
  assert.equal((await scanSources(store, { home })).stats.errors, 0);
  assert.deepEqual(snapshotRows(store), rows);
  assert.equal(Object.values(store.dedup).filter((entry) => entry[7]?.echo).length, 0);
  await appendFile(a, source[3] + "\n");
  assert.equal((await scanSources(store, { home })).stats.errors, 0);
  assert.deepEqual(snapshotRows(store), rows, "snapshot-only copy must not resurrect covered spend");
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
  assert.equal(entry.state.zstdError, `${badStat.dev}:${badStat.ino}:${badStat.size}:${badStat.mtimeMs}:${badStat.ctimeMs}`);

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

test("empty and skippable frames still honor a scan deadline", async () => {
  const emptySkip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
  const empties = Buffer.concat(Array.from({ length: 8 }, () => emptySkip));
  const payload = 256 * 1024;
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50, 0);
  header.writeUInt32LE(payload, 4);
  const hugeSkip = Buffer.concat([header, Buffer.alloc(payload)]);
  const root = await mkdtemp(path.join(tmpdir(), "insights-empty-limit-"));
  const home = path.join(root, "home");
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "empty.jsonl.zst"), Buffer.concat([empties, hugeSkip]));
  const store = archiveStore();
  const stopped = await scanSources(store, {
    home,
    deadline: Date.now(),
    now: Date.now,
  });
  assert.equal(stopped.complete, false);
  assert.equal(stopped.abortedFile?.reason, "budget");
  assert.equal(stopped.stats.errors, 0, "a budget stop is not archive corruption");
  assert.equal(Object.keys(store.files).length, 0, "the unfinished archive is rolled back");

  const cancelledRoot = await mkdtemp(path.join(tmpdir(), "insights-empty-cancel-"));
  const cancelledHome = path.join(cancelledRoot, "home");
  const cancelledSessions = path.join(cancelledHome, ".codex", "sessions");
  await mkdir(cancelledSessions, { recursive: true });
  await writeFile(path.join(cancelledSessions, "empty.jsonl.zst"), Buffer.concat([empties, hugeSkip]));
  const cancelledStore = archiveStore();
  let polls = 0;
  const cancelled = await scanSources(cancelledStore, {
    home: cancelledHome,
    // Let the scan enter the archive, then cancel on the next empty frame.
    shouldStop: () => {
      polls += 1;
      return polls > 1;
    },
  });
  assert.equal(cancelled.complete, false);
  assert.equal(cancelled.abortedFile?.reason, "stop");
  assert.equal(Object.keys(cancelledStore.files).length, 0);
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
  assert.equal(entry.state.zstdError, `${badStat.dev}:${badStat.ino}:${badStat.size}:${badStat.mtimeMs}:${badStat.ctimeMs}`);
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
