import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { decodeAntigravityGeneration, protobufFields, scanAntigravityDb } from "../../herdr-insights/mods/insights/core/antigravity.mjs";
import { emptyStore, snapshotRows } from "../../herdr-insights/mods/insights/core/store.mjs";
import { scanSources } from "../../herdr-insights/mods/insights/core/scan.mjs";
import { readWorkerClaim, writeFence } from "../../herdr-insights/mods/insights/core/fence.mjs";
import { ensureIndexer } from "../../herdr-insights/mods/insights/core/indexer-control.mjs";
import { readLiveProgress } from "../../herdr-insights/mods/insights/core/progress.mjs";
import { isProcessAlive, sleep } from "../../herdr-insights/mods/insights/core/util.mjs";

const collector = new URL("../../herdr-insights/mods/insights/collector.mjs", import.meta.url);
function vi(value) {
  let n = BigInt(value); const out = [];
  do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
function num(n, value) { return Buffer.concat([vi(n * 8), vi(value)]); }
function msg(n, value) { const b = typeof value === "string" ? Buffer.from(value) : value; return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]); }
const join = (...values) => Buffer.concat(values);
const ts = (seconds) => join(num(1, seconds), num(2, 123000000));
function generation({ id = "response-one", model = "gemini-test", step = 1, input = 10, system = 3, output = 7, thinking = 2, cache = 20 } = {}) {
  const usage = join(num(1, system), num(2, input), num(3, output), num(5, cache), num(9, output - thinking), num(10, thinking), msg(11, id));
  return { usage, data: join(msg(2, vi(step)), msg(1, join(msg(4, usage), msg(19, model))), msg(8, "PRIVATE_PROMPT_AND_THINKING")) };
}
async function env(t) {
  const root = await mkdtemp(path.join(tmpdir(), "insights-agy-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(path.join(home, "conversations"), { recursive: true });
  await mkdir(path.join(home, "brain"), { recursive: true });
  return { root, home, store: path.join(root, "data/insights.json"), sources: [{ id: "agy", label: "Antigravity", adapter: "antigravity", roots: ["~/conversations", "~/brain"] }] };
}
function database(context, name = "conv", records = [{ idx: 0, ...generation() }]) {
  const file = path.join(context.home, "conversations", `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY, data BLOB)");
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(join(msg(1, msg(1, "file:///workspace/test")), msg(2, ts(1790400000))));
  for (const r of records) {
    db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(r.idx, r.data);
    if (r.usage) db.prepare("INSERT OR IGNORE INTO steps VALUES (?, ?)").run(r.step ?? 1, join(msg(1, ts(r.seconds ?? 1790486400)), msg(9, r.usage)));
  }
  return { db, file };
}
async function transcript(context, name = "conv") {
  const file = path.join(context.home, "brain", name, ".system_generated/logs/transcript.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ source: "MODEL", step_index: 1, created_at: "2026-09-27T00:00:00Z", input_tokens: 999, output_tokens: 2, cache_read_tokens: 3, content: "PRIVATE_TRANSCRIPT" }) + "\n");
  return file;
}
async function run(context, configure = false) {
  const args = [collector.pathname, configure ? "configure" : "snapshot", "--store", context.store, "--home", context.home];
  if (configure) args.push("--config", JSON.stringify({ sources: context.sources }));
  const { stdout } = await promisify(execFile)(process.execPath, args, { env: { ...process.env, TZ: "UTC" } });
  return JSON.parse(stdout);
}
const total = (snapshot) => snapshot.rows.reduce((n, r) => n + r.tokens.total, 0);

test("Antigravity protobuf decoder validates accounting, bounds and uint64", () => {
  const [g] = decodeAntigravityGeneration(generation().data);
  assert.equal(g.model, "gemini-test"); assert.equal(g.responseId, "response-one");
  assert.deepEqual(decodeAntigravityGeneration(generation({ input: 0, output: 0, thinking: 0, cache: 0 }).data), [], "prefilled system-only metadata is not billable usage");
  assert.deepEqual(g.tokens, { input: 13, output: 7, cacheRead: 20, cacheWrite: 0, reasoning: 2 });
  assert.throws(() => protobufFields(Buffer.from([0])), /tag/);
  assert.throws(() => protobufFields(Buffer.from([10, 255])), /varint/);
  assert.throws(() => protobufFields(Buffer.from([10, 5, 0])), /length/);
  assert.throws(() => protobufFields(Buffer.from([15])), /wire/);
  assert.throws(() => protobufFields(Buffer.from([8, ...Array(10).fill(255)])), /overflow/);
  assert.equal(protobufFields(join(num(7, 18446744073709551615n)))[0].value, 18446744073709551615n);
  assert.throws(() => decodeAntigravityGeneration(msg(1, msg(4, join(num(3, 10), num(9, 11))))), /output accounting/);
  assert.throws(() => decodeAntigravityGeneration(msg(1, msg(4, num(1, 9007199254740992n)))), /unsafe/);
});

test("Antigravity SQLite: actual model, system input, reasoning subset, verified step day, read-only and privacy", async (t) => {
  const context = await env(t); const { db, file } = database(context); db.close();
  const digest = async () => createHash("sha256").update(await readFile(file)).digest("hex");
  const before = await digest();
  const first = await run(context, true);
  assert.equal(first.rows.length, 1);
  const row = first.rows[0];
  assert.equal(row.model, "gemini-test"); assert.equal(row.provider, "google");
  assert.equal(row.project, "/workspace/test"); assert.equal(row.day, "2026-09-27");
  assert.deepEqual(row.tokens, { input: 13, output: 7, cacheRead: 20, cacheWrite: 0, reasoning: 2, total: 40 });
  assert.equal(row.messages, 1); assert.equal(row.session, "antigravity:conv");
  assert.equal(first.warnings.length, 0); assert.equal(await digest(), before);
  assert.equal((await readFile(context.store, "utf8")).includes("PRIVATE_"), false);
  const warm = await run(context);
  assert.equal(warm.stats.filesRead, 0); assert.equal(warm.stats.unchangedFiles, 1); assert.equal(total(warm), 40);
});

test("Antigravity SQLite supersedes cached transcript without duplicate totals, with or without source reconfiguration", async (t) => {
  const context = await env(t); await transcript(context);
  assert.equal(total(await run(context, true)), 1004);
  const { db } = database(context); db.close();
  const next = await run(context);
  assert.equal(total(next), 40); assert.equal(next.rows.length, 1);
  const persisted = JSON.parse(await readFile(context.store, "utf8"));
  assert.equal(Object.values(persisted.files).filter((f) => f.adapter === "antigravity").length, 1);
  assert.equal(Object.values(persisted.files)[0].path.endsWith(".db"), true);
  assert.equal(total(await run(context)), 40);
});

test("Antigravity database handoff replaces token maxima and attribution, but rolls back an unusable replacement", async (t) => {
  const context = await env(t);
  context.sources[0].roots.push("~/second/conversations");
  const original = database(context);
  original.db.close();
  await mkdir(path.join(context.home, "second/conversations"), { recursive: true });
  const replacement = database({ home: path.join(context.home, "second") }, "conv", [
    { idx: 0, data: Buffer.from([10, 255]) },
  ]);
  replacement.db.close();
  const first = await run(context, true);
  assert.equal(total(first), 40);
  const before = JSON.parse(await readFile(context.store, "utf8"));
  await rm(original.file);

  const failed = await run(context);
  assert.equal(total(failed), 40);
  const retained = JSON.parse(await readFile(context.store, "utf8"));
  assert.deepEqual(retained.files, before.files);
  assert.deepEqual(retained.dedup, before.dedup);
  assert.equal(retained.nextFileId, before.nextFileId);

  const g = generation({ model: "claude-new", system: 0, input: 10, output: 0, thinking: 0, cache: 0 });
  const db = new DatabaseSync(replacement.file);
  db.prepare("UPDATE gen_metadata SET data = ?").run(g.data);
  db.prepare("INSERT INTO steps VALUES (1, ?)").run(join(msg(1, ts(1790572800)), msg(9, g.usage)));
  db.close();
  const next = await run(context);
  assert.equal(next.rows.length, 1);
  assert.equal(total(next), 10);
  assert.equal(next.rows[0].model, "claude-new");
  assert.equal(next.rows[0].provider, "anthropic");
  assert.equal(next.rows[0].day, "2026-09-28");
  const warm = await run(context);
  assert.deepEqual(warm.rows, next.rows);
  assert.equal(warm.stats.filesRead, 0);
  const saved = JSON.parse(await readFile(context.store, "utf8"));
  assert.deepEqual(Object.values(saved.files).map((entry) => entry.path), [await realpath(replacement.file)]);
});

test("Antigravity transcript handoff replaces revisions from the superseded copy", async (t) => {
  const context = await env(t);
  const original = await transcript(context);
  context.sources[0].roots.push("~/second/brain");
  const replacement = await transcript({ home: path.join(context.home, "second") });
  await writeFile(replacement, JSON.stringify({
    source: "MODEL", step_index: 1, created_at: "2026-09-28T00:00:00Z",
    input_tokens: 10, model: "claude-new", provider: "anthropic",
  }) + "\n");
  assert.equal(total(await run(context, true)), 1004);
  await rm(original);
  const next = await run(context);
  assert.equal(total(next), 10);
  assert.equal(next.rows[0].model, "claude-new");
  assert.equal(next.rows[0].day, "2026-09-28");
  assert.deepEqual((await run(context)).rows, next.rows);
});

for (const invalid of ["malformed", "oversized", "unrecognized"]) {
  test(`Antigravity retains accepted database history when all generation records are ${invalid}`, async (t) => {
    const context = await env(t);
    const { db, file } = database(context);
    db.close();
    const first = await run(context, true);
    const before = JSON.parse(await readFile(context.store, "utf8"));
    const bad = invalid === "malformed" ? Buffer.from([10, 255])
      : invalid === "oversized" ? Buffer.alloc(16 * 1024 * 1024 + 1)
      : num(7, 1);
    const changed = new DatabaseSync(file);
    changed.prepare("UPDATE gen_metadata SET data = ?").run(bad);
    changed.close();
    const failed = await run(context);
    assert.deepEqual(failed.rows, first.rows);
    assert.match(failed.warnings.join(" "), /previous accepted data retained/);
    const retained = JSON.parse(await readFile(context.store, "utf8"));
    assert.deepEqual(retained.files, before.files);
    assert.deepEqual(retained.dedup, before.dedup);
    const repaired = new DatabaseSync(file);
    repaired.prepare("UPDATE gen_metadata SET data = ?").run(generation().data);
    repaired.close();
    assert.deepEqual((await run(context)).rows, first.rows);
  });
}

test("Antigravity keeps a transcript until the preferred database has decodable metadata", async (t) => {
  const context = await env(t);
  await transcript(context);
  const first = await run(context, true);
  const { db } = database(context, "conv", [{ idx: 0, data: Buffer.from([10, 255]) }]);
  db.close();
  const failed = await run(context);
  assert.deepEqual(failed.rows, first.rows);
  assert.match(failed.warnings.join(" "), /previous accepted data retained/);
  const saved = JSON.parse(await readFile(context.store, "utf8"));
  assert.equal(Object.values(saved.files)[0].path.endsWith("transcript.jsonl"), true);
});

test("Antigravity accepts genuinely empty and system-only databases", async (t) => {
  const context = await env(t);
  await transcript(context);
  assert.equal(total(await run(context, true)), 1004);
  const { db } = database(context, "conv", []);
  db.close();
  assert.equal(total(await run(context)), 0);
  const systemOnly = database(context, "system-only", [
    { idx: 0, ...generation({ input: 0, output: 0, thinking: 0, cache: 0 }) },
  ]);
  systemOnly.db.close();
  const next = await run(context);
  assert.equal(next.rows.length, 0);
  assert.equal(next.stats.errors, 0);
});

test("Antigravity SQLite handles WAL append and response-ID dedup across sessions and copied roots", async (t) => {
  const context = await env(t); const { db, file } = database(context);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  assert.equal(total(await run(context, true)), 40);
  const g = generation({ id: "two", model: "claude-test", step: 3 });
  db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(g.data);
  db.prepare("INSERT INTO steps VALUES (3, ?)").run(join(msg(1, ts(1790486401)), msg(9, g.usage)));
  const next = await run(context);
  assert.equal(total(next), 80); assert.equal(next.rows.find((r) => r.model === "claude-test").provider, "anthropic");
  db.close();
  const other = database(context, "copy"); other.db.close(); // same response ID
  const copiedRoot = path.join(context.home, "second/conversations");
  await mkdir(copiedRoot, { recursive: true });
  await writeFile(path.join(copiedRoot, "conv.db"), await readFile(file));
  context.sources[0].roots.push("~/second/conversations");
  const copy = await run(context, true);
  assert.equal(total(copy), 80);
});

test("Antigravity warns for malformed/oversized blobs and missing IDs/times, replays cached warnings", async (t) => {
  const context = await env(t);
  const unknown = generation({ id: "", model: "", step: 5 });
  const { db } = database(context, "conv", [
    { idx: 0, ...unknown },
    { idx: 1, data: Buffer.from([10,255]) },
    { idx: 2, data: Buffer.alloc(16 * 1024 * 1024 + 1) },
  ]); db.close();
  const first = await run(context, true);
  assert.equal(total(first), 40); assert.equal(first.rows[0].model, "unknown");
  assert.equal(first.rows[0].day, "2026-09-26"); // session-created, not mismatched step
  assert.match(first.warnings.join(" "), /malformed/);
  assert.match(first.warnings.join(" "), /16 MiB/);
  assert.match(first.warnings.join(" "), /session time/);
  assert.match(first.warnings.join(" "), /no response ID/);
  const warm = await run(context); assert.equal(warm.stats.filesRead, 0); assert.deepEqual(warm.warnings, first.warnings);
});

test("Antigravity preserves accepted history on corrupt DB, excludes duplicate transcript, restores fallback after DB removal", async (t) => {
  const context = await env(t); await transcript(context);
  const { db, file } = database(context); db.close();
  assert.equal(total(await run(context, true)), 40);
  await writeFile(file, "not sqlite PRIVATE_DATABASE_CONTENT");
  const failed = await run(context); assert.equal(total(failed), 40);
  assert.match(failed.warnings.join(" "), /previous accepted data retained/);
  assert.equal(JSON.stringify(failed).includes("PRIVATE_DATABASE_CONTENT"), false);
  await rm(file);
  const fallback = await run(context);
  assert.equal(total(fallback), 1004); assert.equal(fallback.rows[0].model, "unknown");
});

test("Antigravity retains accepted SQLite history until its transcript fallback is readable", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("requires POSIX file permissions enforced for a non-root user");
    return;
  }
  const context = await env(t);
  const fallback = await transcript(context);
  const { db, file } = database(context);
  db.close();
  assert.equal(total(await run(context, true)), 40);
  await rm(file);
  await chmod(fallback, 0o000);
  try {
    const failed = await run(context);
    assert.equal(total(failed), 40);
    assert.match(failed.warnings.join(" "), /scan failed/);
  } finally {
    await chmod(fallback, 0o600);
  }
  assert.equal(total(await run(context)), 1004);
});

for (const interruption of ["deadline", "read error"]) {
  test(`Antigravity rolls back transcript replacement on ${interruption} and retains SQLite history`, async (t) => {
    const context = await env(t);
    const fallback = await realpath(await transcript(context));
    const step = JSON.parse(await readFile(fallback, "utf8"));
    await writeFile(fallback, Array.from({ length: 4000 }, (_, index) =>
      JSON.stringify({ ...step, step_index: index })
    ).join("\n") + "\n");
    const { db, file } = database(context);
    db.close();
    const store = emptyStore({ sources: context.sources.map((source) => ({ ...source, enabled: true })) });
    await scanSources(store, { home: context.home });
    const before = JSON.stringify(store);
    await rm(file);

    const options = { home: context.home };
    let mocked;
    if (interruption === "deadline") {
      options.deadline = 1;
      options.now = () => 2;
    } else {
      const handle = await open(fallback, "r");
      const prototype = Object.getPrototypeOf(handle);
      const read = prototype.read;
      await handle.close();
      let calls = 0;
      mocked = t.mock.method(prototype, "read", function (...args) {
        if (++calls === 2) throw new Error("synthetic read failure");
        return read.apply(this, args);
      });
    }
    try {
      const interrupted = await scanSources(store, options);
      assert.equal(total({ rows: snapshotRows(store) }), 40, "an unfinished fallback must not add a second copy of usage");
      assert.equal(JSON.stringify(store), before, "rows, dedup ownership and file state must roll back together");
      if (interruption === "deadline") {
        assert.equal(interrupted.complete, false);
        assert.equal(interrupted.abortedFile.path, fallback, "use the existing indexer handoff");
      } else {
        assert.equal(interrupted.stats.errors, 1);
        assert.match(interrupted.warnings.join(" "), /synthetic read failure/);
        assert.doesNotMatch(interrupted.warnings.join(" "), /accepted prefix retained/);
      }
    } finally {
      mocked?.mock.restore();
    }

    const completed = await scanSources(store, { home: context.home, mode: "worker" });
    assert.equal(completed.complete, true);
    assert.equal(total({ rows: snapshotRows(store) }), 4000 * 1004);
    assert.deepEqual(Object.values(store.files).map((entry) => entry.path), [fallback]);
    assert.equal(Object.keys(store.dedup).length, 4000);
  });
}

test("Antigravity handles databases disappearing during discovery and unreadable WAL metadata", async (t) => {
  const context = await env(t);
  const { db, file } = database(context);
  db.close();
  const store = emptyStore({ sources: context.sources.map((source) => ({ ...source, enabled: true })) });
  await scanSources(store, { home: context.home });
  const before = JSON.stringify(store);
  const warnings = [];
  const sink = { warn: (message) => warnings.push(message), note: (message) => warnings.push(message) };
  const stats = { filesRead: 0, bytesRead: 0, unchangedFiles: 0 };
  await scanAntigravityDb(store, store.config.sources[0], `${file}.removed`, sink, stats);
  assert.equal(JSON.stringify(store), before);
  assert.equal(warnings.length, 0);
  if (process.platform === "win32") return;
  await symlink(`${file}-wal`, `${file}-wal`); // stat reports ELOOP, not a missing WAL
  await scanAntigravityDb(store, store.config.sources[0], file, sink, stats);
  assert.equal(JSON.stringify(store), before);
  assert.match(warnings.join(" "), /cannot stat database WAL/);
});

for (const interruption of ["SIGTERM", "generation fence"]) {
  test(`Antigravity worker rolls back a database scan on ${interruption} and resumes`, async (t) => {
    const context = await env(t);
    const original = database(context);
    original.db.close();
    const first = await run(context, true);
    const before = JSON.parse(await readFile(context.store, "utf8"));
    const db = new DatabaseSync(original.file);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
      INSERT INTO gen_metadata SELECT i, ? FROM n`).run(generation({ id: "appended", input: 11, step: 2 }).data);
    db.close();

    async function waitFor(predicate) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await sleep(10);
      }
      throw new Error("Antigravity worker did not settle");
    }

    let worker;
    try {
      worker = await ensureIndexer(context.store, context.home, { generation: before.generation });
      assert.equal(worker.spawned, true);
      const progress = await waitFor(async () => {
        const live = await readLiveProgress(context.store);
        if (live?.pid === worker.pid && live.decodedBytes > 0) return live;
        return (await readWorkerClaim(context.store)) === null ? { finished: true } : null;
      });
      assert.ok(progress.decodedBytes > 0, "interruption must occur inside the database scan");
      if (interruption === "SIGTERM") process.kill(worker.pid, "SIGTERM");
      else await writeFence(context.store, before.generation + 1);
      await waitFor(async () => (await readWorkerClaim(context.store)) === null);
      const stopped = JSON.parse(await readFile(context.store, "utf8"));
      assert.deepEqual(snapshotRows(stopped), first.rows);
      assert.deepEqual(stopped.files, before.files);
      assert.deepEqual(stopped.dedup, before.dedup);
      assert.notEqual(stopped.scan.status, "complete");
      if (interruption === "SIGTERM") {
        assert.equal(stopped.scan.status, "partial");
        assert.equal(stopped.scan.pendingFile.path, await realpath(original.file));
      } else {
        await writeFence(context.store, before.generation);
      }

      worker = await ensureIndexer(context.store, context.home, { generation: before.generation });
      assert.equal(worker.spawned, true);
      await waitFor(async () => (await readWorkerClaim(context.store)) === null);
      const completed = JSON.parse(await readFile(context.store, "utf8"));
      assert.equal(completed.scan.status, "complete");
      assert.equal(total({ rows: snapshotRows(completed) }), 81);
      assert.equal(snapshotRows(completed).reduce((n, row) => n + row.messages, 0), 2);
    } finally {
      if (worker?.pid && isProcessAlive(worker.pid)) {
        process.kill(worker.pid, "SIGTERM");
        await waitFor(() => !isProcessAlive(worker.pid));
      }
    }
  });
}
