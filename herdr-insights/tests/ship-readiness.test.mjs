import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { progressWriter } from "../mods/insights/collector.mjs";
import { compactDashboard, deriveDashboard } from "../mods/insights/analytics.js";
import { MAX_LINE_BYTES, withStoreLock } from "../mods/insights/core/util.mjs";
import { normalizeConfig } from "../mods/insights/core/config.mjs";
import { scanSources } from "../mods/insights/core/scan.mjs";
import { run as present } from "../mods/insights/presenter.mjs";
import { emptyStore, getOrCreateRow, newFileEntry, resetFileEntry, snapshotRows } from "../mods/insights/core/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "insights-ship-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sourceStore(file, adapter = "pi") {
  return emptyStore(normalizeConfig({ sources: [{ id: adapter, label: adapter, adapter, roots: [file] }] }));
}

function piSession(session, input = 1) {
  return [
    { type: "session", id: session, cwd: "/repo" },
    { type: "message", id: `a-${session}`, timestamp: "2026-10-30T12:00:00Z", message: {
      role: "assistant", model: "m", provider: "p", usage: { input, output: 1 }, stopReason: "stop",
    } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function codexCount(input, second) {
  return JSON.stringify({ type: "event_msg", timestamp: `2026-10-30T12:00:${String(second).padStart(2, "0")}Z`,
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } } }) + "\n";
}

const codexHeader = JSON.stringify({ type: "session_meta", payload: { id: "test", cwd: "/repo" } }) + "\n";

test("Pi tool-result usage counts once across fork copies without changing task timing", async (t) => {
  const root = await fixture(t);
  const records = [
    { type: "session", id: "original", cwd: "/repo" },
    { type: "message", id: "u", timestamp: "2026-10-30T12:00:00Z", message: { role: "user" } },
    { type: "message", id: "tool", timestamp: "2026-10-30T12:00:05Z", message: {
      role: "toolResult", toolCallId: "call", usage: { input: 7, output: 2 },
    } },
    { type: "message", id: "a", timestamp: "2026-10-30T12:00:10Z", message: {
      role: "assistant", model: "m", provider: "p", usage: { input: 10, output: 1 }, stopReason: "stop",
    } },
  ];
  const encode = () => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(path.join(root, "a.jsonl"), encode());
  const store = sourceStore(root);
  await scanSources(store, { home: root });
  const first = snapshotRows(store);
  assert.equal(first.reduce((sum, row) => sum + row.tokens.total, 0), 20);
  assert.equal(first.reduce((sum, row) => sum + row.activeMs, 0), 10_000);
  records[0].id = "fork";
  await writeFile(path.join(root, "b.jsonl"), encode());
  await scanSources(store, { home: root });
  assert.deepEqual(snapshotRows(store), first);
});

test("Codex counter resets reset the entire vector when fields move in different directions", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "session.jsonl");
  const count = (input, output, second) => codexCount(input, second).replace('"output_tokens":0', `"output_tokens":${output}`);
  await writeFile(file, codexHeader + count(100, 10, 1) + count(50, 20, 2));
  const store = sourceStore(file, "codex");
  await scanSources(store, { home: root });
  assert.equal(snapshotRows(store)[0].tokens.input, 150);
  assert.equal(snapshotRows(store)[0].tokens.output, 30);
});

test("Claude fork copies deduplicate task duration even with rewritten session IDs", async (t) => {
  const root = await fixture(t);
  const original = await readFile(new URL("./fixtures/claude-session.jsonl", import.meta.url), "utf8");
  await writeFile(path.join(root, "a.jsonl"), original);
  const store = sourceStore(root, "claude");
  await scanSources(store, { home: root });
  const first = snapshotRows(store);
  await writeFile(path.join(root, "b.jsonl"), original.replaceAll("claude-fixture", "claude-fork-fixture"));
  await scanSources(store, { home: root });
  assert.deepEqual(snapshotRows(store), first);
});

test("OpenCode read-only open failure never retries with write/create access", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "opencode.db");
  await writeFile(file, "original source");
  const fakeSqlite = `import { writeFileSync } from "node:fs";
    export class DatabaseSync {
      constructor(file, options) {
        globalThis.__insightsSqliteOpens.push(options);
        if (!options?.readOnly) writeFileSync(file, "unsafe writable fallback");
        throw new Error("synthetic read-only open failure");
      }
    }`;
  globalThis.__insightsSqliteOpens = [];
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === "node:sqlite"
      ? { url: `data:text/javascript,${encodeURIComponent(fakeSqlite)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  } });
  try {
    const store = sourceStore(file, "opencode");
    const result = await scanSources(store, { home: root });
    assert.equal(result.stats.errors, 1);
    assert.deepEqual(globalThis.__insightsSqliteOpens, [{ readOnly: true }]);
    assert.equal(await readFile(file, "utf8"), "original source");
  } finally {
    hook.deregister();
    delete globalThis.__insightsSqliteOpens;
  }
});

test("new transcript files never enumerate the global dedup collection to reset empty history", async (t) => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 50 }, (_, index) =>
    writeFile(path.join(root, `${index}.jsonl`), piSession(`s${index}`, 1))));
  const store = sourceStore(root);
  let enumerations = 0;
  store.dedup = new Proxy(store.dedup, { ownKeys(target) {
    enumerations += 1;
    return Reflect.ownKeys(target);
  } });
  const result = await scanSources(store, { home: root });
  assert.equal(result.stats.filesRead, 50);
  assert.equal(enumerations, 0);
  assert.equal(snapshotRows(store).length, 50);
});

test("shrinking a file with an unfinished tail resets its complete prefix", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "session.jsonl");
  await writeFile(file, piSession("old", 100) + '{"partial":"' + "x".repeat(50_000));
  const store = sourceStore(file);
  await scanSources(store, { home: root });
  const cursor = Object.values(store.files)[0].offset;
  const replacement = piSession("new-" + "x".repeat(1000), 7);
  assert.ok(Buffer.byteLength(replacement) > cursor);
  await writeFile(file, replacement);
  await scanSources(store, { home: root });
  assert.equal(snapshotRows(store).reduce((sum, row) => sum + row.tokens.input, 0), 7);
  assert.equal(snapshotRows(store).some((row) => row.session === "pi:old"), false);
});

test("a mid-read failure checkpoints its accepted prefix and retries without replaying counters", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "session.jsonl");
  await writeFile(file, codexHeader + codexCount(100, 1));
  const store = sourceStore(file, "codex");
  await scanSources(store, { home: root });
  await appendFile(file, codexCount(200, 2) + codexCount(250, 3) + " ".repeat(300_000));
  const handle = await open(file, "r");
  const prototype = Object.getPrototypeOf(handle);
  const read = prototype.read;
  await handle.close();
  let calls = 0;
  const mocked = t.mock.method(prototype, "read", function (...args) {
    if (++calls === 2) throw new Error("synthetic read failure");
    return read.apply(this, args);
  });
  const failed = await scanSources(store, { home: root });
  mocked.mock.restore();
  assert.equal(failed.stats.errors, 1);
  assert.equal(Object.values(store.files)[0].state.readFailed, true);
  assert.equal(snapshotRows(store)[0].tokens.input, 250);
  const recovered = await scanSources(store, { home: root });
  assert.equal(recovered.stats.errors, 0);
  assert.equal(recovered.stats.filesRead, 1);
  assert.equal(snapshotRows(store)[0].tokens.input, 250);
  assert.equal(Object.values(store.files)[0].state.readFailed, undefined);
});

test("oversized unfinished lines warn once and resume from discarded bytes", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "session.jsonl");
  await writeFile(file, Buffer.alloc(MAX_LINE_BYTES + 100, 120));
  const store = sourceStore(file);
  const first = await scanSources(store, { home: root });
  assert.equal(first.stats.errors, 1);
  assert.equal(Object.values(store.files)[0].offset, MAX_LINE_BYTES + 100);
  const suffix = "\n" + piSession("after-large", 7);
  await appendFile(file, suffix);
  const second = await scanSources(store, { home: root });
  assert.equal(second.stats.errors, 0);
  assert.equal(second.stats.bytesRead, Buffer.byteLength(suffix));
  assert.equal(snapshotRows(store)[0].tokens.input, 7);
});

test("a corrupt zstd stream rolls back already parsed usage and recovers on replacement", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "session.jsonl.zst");
  await writeFile(file, zstdCompressSync(codexHeader + codexCount(100, 1)));
  const store = sourceStore(file, "codex");
  await scanSources(store, { home: root });
  await writeFile(file, Buffer.concat([
    zstdCompressSync(codexHeader + codexCount(999, 2)), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]),
  ]));
  const failed = await scanSources(store, { home: root });
  assert.equal(failed.stats.errors, 1);
  assert.equal(snapshotRows(store)[0].tokens.input, 100);
  await writeFile(file, zstdCompressSync(codexHeader + codexCount(200, 3)));
  const recovered = await scanSources(store, { home: root });
  assert.equal(recovered.stats.errors, 0);
  assert.equal(snapshotRows(store)[0].tokens.input, 200);
});

test("Model Usage shows only the top 10 and keeps totals across every model", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    day: "2026-10-30", session: `s${index}`, harness: "pi", provider: "p",
    model: `model-${index}`, project: "/repo", tokens: { input: index + 1 }, messages: 1,
  }));
  const dashboard = compactDashboard(deriveDashboard({ version: 1, config: {}, rows }, {
    today: "2026-10-30", period: "all",
  }));
  assert.equal(dashboard.leaders.entries.length, 10);
  assert.equal(dashboard.leaders.limit, 10);
  assert.equal(dashboard.leaders.totalGroups, 12);
  assert.equal(dashboard.leaders.totalTokens, 78);
  assert.deepEqual(dashboard.leaders.entries.map((entry) => entry.name),
    Array.from({ length: 10 }, (_, index) => `model-${11 - index}`));
});

test("compact presentation bounds high-cardinality facets and retains selected values", () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    day: "2026-10-30", session: `s${index}`, harness: "pi", provider: `p${index}`,
    model: `m${index}`, project: `/repo/${index}`, tokens: { input: index + 1, output: 1 }, messages: 1,
  }));
  const derived = deriveDashboard({ version: 1, config: {}, rows }, {
    today: "2026-10-30", period: "all", filters: { project: "/repo/0" },
  });
  const compact = compactDashboard(derived);
  assert.equal(compact.facets.project.stats.length, 250);
  assert.equal(compact.facets.project.totalCount, 10_000);
  assert.equal(compact.facets.project.truncated, true);
  assert.ok(compact.facets.project.stats.some((stat) => stat.value === "/repo/0"));
  assert.equal(compact.facets.project.total, derived.facets.project.total);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 512 * 1024);
});

test("row lookup is indexed, survives reload, and resets with file history", () => {
  const store = emptyStore();
  const file = newFileEntry(store, { sourceId: "pi", path: "/fixture.jsonl" });
  const meta = { day: "2026-10-30", session: "s", harness: "pi", provider: "p", model: "m", project: "/repo" };
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(getOrCreateRow(file, { ...meta, session: `s${index}` }), index);
  }
  const rowIndex = file._rowIndex;
  assert.equal(getOrCreateRow(file, { ...meta, session: "s9999" }), 9999);
  assert.equal(file._rowIndex, rowIndex, "reuse one index rather than rebuild per event");
  const saved = JSON.stringify(file);
  assert.equal(saved.includes("_rowIndex"), false, "index is transient metadata");
  const loaded = JSON.parse(saved);
  assert.equal(getOrCreateRow(loaded, { ...meta, session: "s9999" }), 9999);
  resetFileEntry(store, file);
  assert.equal(getOrCreateRow(file, { ...meta, session: "new" }), 0);
  assert.equal(getOrCreateRow(file, { ...meta, session: "s9999" }), 1);
});

test("a live same-host lock cannot be stolen just because it is old", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  await withStoreLock(store, async () => {
    const old = new Date(Date.now() - 60_000);
    await utimes(`${store}.lock`, old, old);
    let entered = false;
    await assert.rejects(withStoreLock(store, async () => { entered = true; }, {
      staleMs: 1, timeoutMs: 0,
    }), /store is busy/);
    assert.equal(entered, false);
    const owners = await readdir(`${store}.lock`);
    assert.equal(owners.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(`${store}.lock`, owners[0]), "utf8")).pid, process.pid);
  });
  await assert.rejects(stat(`${store}.lock`), { code: "ENOENT" });
});

test("concurrent dead-owner reclaimers cannot remove a newly acquired lock", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  const lock = `${store}.lock`;
  await mkdir(lock);
  await writeFile(path.join(lock, "owner-dead.json"), JSON.stringify({
    pid: 999_999_999, host: hostname(), token: "dead",
  }));
  let active = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: 8 }, () => withStoreLock(store, async () => {
    active += 1;
    assert.equal(active, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    completed += 1;
  })));
  assert.equal(completed, 8);
  await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("ownerless and foreign locks fail closed instead of age-evicting an unknown writer", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  const lock = `${store}.lock`;
  await mkdir(lock);
  await assert.rejects(withStoreLock(store, async () => assert.fail("entered ownerless lock"), {
    staleMs: 0, timeoutMs: 0,
  }), /store is busy/);
  await rm(lock, { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: 123, host: "another-host", token: "foreign" }));
  const old = new Date(0);
  await utimes(lock, old, old);
  await assert.rejects(withStoreLock(store, async () => assert.fail("entered foreign lock"), {
    staleMs: 0, timeoutMs: 0,
  }), /store is busy/);
});

test("read-only prepare never copies or repairs a corrupt store", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  await writeFile(store, "{corrupt");
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(present(["prepare", "--store", store]), /store is corrupt; refresh/);
  }
  assert.deepEqual(await readdir(root), ["store.json"]);
  assert.equal(await readFile(store, "utf8"), "{corrupt");
});

test("read-only prepare of a missing store does not create parent directories", async (t) => {
  const root = await fixture(t);
  const parent = path.join(root, "missing");
  const result = await present(["prepare", "--store", path.join(parent, "store.json")]);
  assert.equal(result.exitCode, 0);
  await assert.rejects(stat(parent), { code: "ENOENT" });
});

test("progress is private, atomic, and never follows a pre-existing sidecar link", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  const target = path.join(root, "unrelated.txt");
  await writeFile(target, "keep");
  await symlink(target, `${store}.progress.json`);
  const progress = progressWriter(store);
  progress.update({ processed: 1, total: 1, file: "/private/session.jsonl" });
  assert.equal(await readFile(target, "utf8"), "keep");
  const sidecar = `${store}.progress.json`;
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(sidecar, "utf8")).processed, 1);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
  progress.clear();
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
});
