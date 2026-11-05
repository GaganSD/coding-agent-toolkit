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
  const missing = await scanAntigravityDb(store, store.config.sources[0], `${file}.removed`, sink, stats);
  assert.equal(missing.accepted, undefined);
  assert.equal(JSON.stringify(store), before);
  assert.equal(warnings.length, 0);
  if (process.platform === "win32") return;
  await symlink(`${file}-wal`, `${file}-wal`); // stat reports ELOOP, not a missing WAL
  const unreadable = await scanAntigravityDb(store, store.config.sources[0], file, sink, stats);
  assert.equal(unreadable.accepted, undefined);
  assert.equal(JSON.stringify(store), before);
  assert.match(warnings.join(" "), /cannot stat database WAL/);
});

test("Antigravity SQLite abort rolls back all file contributions and resumes on next scan", async (t) => {
  const context = await env(t);
  const second = generation({ id: "two", step: 3 });
  const { db } = database(context, "conv", [{ idx: 0, ...generation() }, { idx: 1, ...second, step: 3 }]); db.close();
  const store = emptyStore({ sources: context.sources.map((s) => ({ ...s, enabled: true })) });
  let checks = 0;
  const stopped = await scanSources(store, { home: context.home, shouldStop: () => ++checks >= 3 });
  assert.equal(stopped.complete, false); assert.equal(Object.keys(store.files).length, 0); assert.equal(Object.keys(store.dedup).length, 0);
  const complete = await scanSources(store, { home: context.home });
  assert.equal(complete.complete, true);
  assert.equal(Object.keys(store.dedup).length, 2);
});
