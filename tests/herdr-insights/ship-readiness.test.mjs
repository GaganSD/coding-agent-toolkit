import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { progressWriter } from "../../herdr-insights/mods/insights/core/progress.mjs";
import { compactDashboard, deriveDashboard } from "../../herdr-insights/mods/insights/analytics.js";
import { MAX_LINE_BYTES, withStoreLock } from "../../herdr-insights/mods/insights/core/util.mjs";
import { normalizeConfig } from "../../herdr-insights/mods/insights/core/config.mjs";
import { scanSources } from "../../herdr-insights/mods/insights/core/scan.mjs";
import { run as present } from "../../herdr-insights/mods/insights/presenter.mjs";
import { emptyStore, getOrCreateRow, newFileEntry, resetFileEntry, snapshotRows } from "../../herdr-insights/mods/insights/core/store.mjs";

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

// Synthetic fork sequences use the raw counter schema already exercised by
// codex-modern.jsonl; they establish parser behavior, not production ordering.
const forkThread = "019f0000-1000-7000-8000-000000000001";
const copiedTurn = "019f0000-0001-7000-8000-000000000002";
const childTurn = "019f0000-2000-7000-8000-000000000003";
const forkParent = { input_tokens: 2000, cached_input_tokens: 800, cache_write_input_tokens: 100,
  output_tokens: 500, reasoning_output_tokens: 100 };
const forkChild = { input_tokens: 80, cached_input_tokens: 30, cache_write_input_tokens: 10,
  output_tokens: 20, reasoning_output_tokens: 5 };
const forkTotal = Object.fromEntries(Object.keys(forkParent).map((key) => [key, forkParent[key] + forkChild[key]]));
const forkEncode = (records) => records.map((record) => JSON.stringify(record) + "\n").join("");
const forkRecord = (type, payload) => ({ type, timestamp: "2026-03-08T08:00:00Z", payload });
const forkMarker = (turn_id) => forkRecord("turn_context", { turn_id, model: "fork-model" });
const forkCount = (raw, lastOnly = false) => forkRecord("event_msg", { type: "token_count",
  info: { [lastOnly ? "last_token_usage" : "total_token_usage"]: raw } });
const forkModern = (response_id, usage, thread_token_usage, turn_id) => forkRecord("token_usage_record",
  { response_id, usage, thread_token_usage, turn_token_usage: usage, turn_id });
function forkHeader(id = forkThread) {
  return forkRecord("session_meta", { id, forked_from_id: copiedTurn, cwd: "/repo" });
}
const forkExpected = { input: 40, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 5, total: 100 };

for (const carrier of ["modern-mixed", "modern-thread-prefix", "modern-only", "modern-no-thread", "mixed", "legacy-last-only"]) {
  test(`Codex fork ${carrier}: full and persisted incremental scans agree in every token category`, async (t) => {
    const root = await fixture(t);
    const file = path.join(root, "fork.jsonl");
    const parent = carrier === "legacy-last-only" ? forkCount(forkParent, true)
      : forkModern("copied", carrier === "modern-thread-prefix" ? forkChild : forkParent,
        carrier === "modern-no-thread" ? undefined : forkParent, copiedTurn);
    const child = carrier === "legacy-last-only" ? forkCount(forkChild, true)
      : forkModern("own", forkChild, forkTotal, childTurn);
    const copied = carrier === "modern-no-thread" ? [
      forkModern("copied-first", forkChild, undefined, copiedTurn),
      forkModern("copied-first", forkChild, undefined, copiedTurn), // repeated response is not pending twice
      forkModern("copied-rest", Object.fromEntries(Object.keys(forkParent).map((key) =>
        [key, forkParent[key] - forkChild[key]])), undefined, copiedTurn),
    ] : [parent];
    const marker = carrier === "modern-thread-prefix"
      ? forkRecord("event_msg", { type: "task_started", root_turn_id: childTurn }) : forkMarker(childTurn);
    const records = [forkHeader(), forkMarker(copiedTurn), ...copied,
      ...(carrier === "mixed" ? [forkCount(forkParent)] : []), marker, child,
      ...(["modern-mixed", "modern-thread-prefix", "modern-no-thread", "mixed"].includes(carrier) ? [forkCount(forkTotal)] : [])];
    await writeFile(file, forkEncode(records));
    const config = sourceStore(file, "codex").config;
    const oracle = await collectSnapshot("configure", { home: root, store: path.join(root, "oracle.json"), config });
    assert.equal(oracle.rows.length, 1);
    assert.deepEqual(oracle.rows[0].tokens, forkExpected);
    assert.equal(oracle.rows[0].messages, 1);
    assert.deepEqual(oracle.warnings, []);

    await writeFile(file, "");
    const store = path.join(root, "incremental.json");
    await collectSnapshot("configure", { home: root, store, config });
    let incremental;
    for (const record of records) {
      await appendFile(file, forkEncode([record]));
      incremental = await collectSnapshot("snapshot", { home: root, store });
    }
    assert.deepEqual(incremental.rows, oracle.rows);
    assert.deepEqual((await collectSnapshot("snapshot", { home: root, store })).rows, oracle.rows);
    const saved = JSON.parse(await readFile(store, "utf8"));
    const entry = Object.values(saved.files)[0];
    assert.equal(entry.state.codexParserVersion, 9);
    entry.state.codexParserVersion = 8;
    entry.rows[0].input += 2500; // A stale PR parser contribution must be rebuilt, not retained.
    await writeFile(store, JSON.stringify(saved));
    const migrated = await collectSnapshot("snapshot", { home: root, store });
    assert.equal(migrated.stats.filesRead, 1);
    assert.deepEqual(migrated.rows, oracle.rows);
    assert.equal((await collectSnapshot("snapshot", { home: root, store })).stats.filesRead, 0);
  });
}

// Missing/last-only carriers are compatibility inputs, not the required paired
// cumulative fields in current upstream Codex TokenUsageRecord/TokenUsageInfo.
async function checkForkCompatibility(t, records, { ambiguous = false, timestampWarning = false } = {}) {
  const root = await fixture(t);
  const file = path.join(root, "compatibility.jsonl");
  await writeFile(file, forkEncode(records));
  const config = sourceStore(file, "codex").config;
  const store = path.join(root, "full.json");
  const full = await collectSnapshot("configure", { home: root, store, config });
  if (!ambiguous) {
    assert.equal(full.rows.length, 1);
    assert.deepEqual(full.rows[0].tokens, forkExpected);
    assert.equal(full.rows[0].messages, 1);
  }
  assert.equal(full.warnings.filter((message) => /lack a reliable shared identity/.test(message)).length, ambiguous ? 1 : 0);
  assert.equal(full.warnings.length, Number(ambiguous) + Number(timestampWarning));
  await writeFile(file, "");
  const incrementalStore = path.join(root, "incremental.json");
  await collectSnapshot("configure", { home: root, store: incrementalStore, config });
  let incremental;
  for (const record of records) {
    await appendFile(file, forkEncode([record]));
    incremental = await collectSnapshot("snapshot", { home: root, store: incrementalStore });
  }
  assert.deepEqual(incremental.rows, full.rows);
  const unchanged = await collectSnapshot("snapshot", { home: root, store: incrementalStore });
  assert.deepEqual(unchanged.rows, full.rows);
  assert.equal(unchanged.warnings.filter((message) => /lack a reliable shared identity/.test(message)).length, ambiguous ? 1 : 0);
}

for (const shape of ["zero-usage", "missing-usage", "modern-missing-time", "modern-invalid-time", "legacy-missing-time", "legacy-invalid-time"]) {
  test(`Codex replay raw cumulative baseline survives ${shape}`, async (t) => {
    const header = forkHeader();
    const modern = !shape.startsWith("legacy");
    const parent = modern ? forkModern("copied", forkParent, forkParent, copiedTurn) : forkCount(forkParent);
    if (shape === "zero-usage") parent.payload.usage = {};
    if (shape === "missing-usage") delete parent.payload.usage;
    if (shape.endsWith("time")) {
      delete header.timestamp;
      if (shape.includes("invalid")) parent.timestamp = "not-a-timestamp";
      else delete parent.timestamp;
    }
    await checkForkCompatibility(t, [header, forkMarker(copiedTurn), parent, forkMarker(childTurn), forkCount(forkTotal)],
      { timestampWarning: modern && shape.endsWith("time") });
  });
}

for (const shape of ["zero-usage", "missing-usage", "missing-time", "invalid-time"]) {
  test(`Codex own usage validation still skips ${shape} without consuming its baseline`, async (t) => {
    const root = await fixture(t);
    const file = path.join(root, "own.jsonl");
    const header = forkHeader("non-v7-thread");
    delete header.timestamp;
    const record = forkModern("own-invalid", forkParent, forkParent, childTurn);
    if (shape === "zero-usage") record.payload.usage = {};
    if (shape === "missing-usage") delete record.payload.usage;
    if (shape === "missing-time") delete record.timestamp;
    if (shape === "invalid-time") record.timestamp = "invalid";
    await writeFile(file, forkEncode([header, record]));
    const store = sourceStore(file, "codex");
    await scanSources(store, { home: root });
    assert.deepEqual(snapshotRows(store), []);
    assert.equal(Object.values(store.files)[0].state.legacyTotals, undefined);
    await appendFile(file, forkEncode([forkCount(forkParent)]));
    await scanSources(store, { home: root });
    assert.equal(snapshotRows(store)[0].tokens.total, 2500);
  });
}

for (const shape of ["last-to-total", "repeated-exact-last", "repeated-response", "distinct-equal-last", "distinct-equal-response",
  "modern-last", "last-modern", "modern-thread-last", "last-modern-thread", "response-modern-last", "response-last-modern",
  "total-last", "last-total-last", "total-last-modern", "total-modern-last", "equal-child-modern"]) {
  test(`Codex copied compatibility observations reconcile ${shape} in full and append scans`, async (t) => {
    const last = forkCount(forkParent, true);
    const modern = forkModern("copied", forkParent, undefined, copiedTurn);
    const total = forkCount(forkParent);
    total.payload.info.last_token_usage = forkParent;
    let prefix = [last];
    if (shape === "repeated-exact-last") prefix = [last, last, last];
    if (shape === "repeated-response") prefix = [
      { ...last, payload: { ...last.payload, response_id: "copied" } },
      { ...last, timestamp: "2026-03-08T08:00:01Z", payload: { ...last.payload, response_id: "copied" } },
    ];
    if (shape === "distinct-equal-last" || shape === "distinct-equal-response") {
      const half = Object.fromEntries(Object.entries(forkParent).map(([key, value]) => [key, value / 2]));
      prefix = [forkCount(half, true), { ...forkCount(half, true), timestamp: "2026-03-08T08:00:01Z" }];
      if (shape === "distinct-equal-response") {
        prefix[0].payload.response_id = "first";
        prefix[1].payload.response_id = "second";
        prefix[1].timestamp = prefix[0].timestamp;
      }
    }
    if (shape === "modern-last") prefix = [modern, last, last];
    if (shape === "last-modern") prefix = [last, modern, modern];
    if (shape === "modern-thread-last" || shape === "last-modern-thread") {
      modern.payload.thread_token_usage = forkParent;
      prefix = shape === "modern-thread-last" ? [modern, last, last] : [last, modern, modern];
    }
    if (shape === "response-modern-last" || shape === "response-last-modern") {
      last.payload.response_id = "copied";
      last.timestamp = "2026-03-08T08:00:01Z";
      prefix = shape === "response-modern-last" ? [modern, last, last] : [last, modern, modern];
    }
    if (shape === "total-last") prefix = [total, last, last];
    if (shape === "last-total-last") prefix = [last, total, last];
    if (shape === "total-last-modern") prefix = [total, last, modern];
    if (shape === "total-modern-last") prefix = [total, modern, last];
    const suffix = shape === "equal-child-modern"
      ? [forkModern("own", forkChild, undefined, childTurn), forkCount(forkTotal)] : [forkCount(forkTotal)];
    if (shape === "equal-child-modern") {
      // An equal-sized copied twin cannot consume a distinct child response.
      const rest = Object.fromEntries(Object.keys(forkParent).map((key) => [key, forkParent[key] - forkChild[key]]));
      prefix = [forkCount(rest, true), { ...forkCount(forkChild, true), timestamp: "2026-03-08T08:00:01Z" }];
    }
    await checkForkCompatibility(t, [forkHeader(), forkMarker(copiedTurn), ...prefix, forkMarker(childTurn), ...suffix]);
  });
}

for (const shape of ["unidentified-total-last", "weak-modern-last", "weak-last-modern", "inferred-time-modern-last"]) {
  test(`Codex unsupported copied attribution ${shape} preserves a bounded persistent diagnostic`, async (t) => {
    const last = { ...forkCount(forkParent, true), timestamp: "2026-03-08T08:00:01Z" };
    const modern = forkModern("copied", forkParent, undefined, copiedTurn);
    const prefix = shape === "unidentified-total-last" ? [forkCount(forkParent), last, last]
      : shape === "weak-last-modern" ? [last, modern] : [modern, last];
    if (shape === "inferred-time-modern-last") {
      delete modern.timestamp;
      delete last.timestamp;
    }
    await checkForkCompatibility(t, [forkHeader(), forkMarker(copiedTurn), ...prefix,
      forkMarker(childTurn), forkCount(forkTotal)], { ambiguous: true });
  });
}

for (const carrier of ["last-only", "modern-no-thread"]) {
  test(`Codex timestamp-free copied ${carrier} retains an accounting diagnostic`, async (t) => {
    const header = forkHeader();
    delete header.timestamp;
    const copied = carrier === "last-only" ? forkCount(forkParent, true)
      : forkModern("copied", forkParent, undefined, copiedTurn);
    delete copied.timestamp;
    await checkForkCompatibility(t, [header, forkMarker(copiedTurn), copied,
      forkMarker(childTurn), forkCount(forkTotal)],
    { ambiguous: true, timestampWarning: carrier === "modern-no-thread" });
  });
}

test("Codex fork replay state survives a budget slice before and after the boundary", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "fork.jsonl");
  const padding = forkEncode([forkRecord("ignored", { padding: "x".repeat(300_000) })]);
  const prefix = forkEncode([forkHeader(), forkMarker(copiedTurn), forkModern("copied", forkParent, forkParent, copiedTurn)]);
  const boundary = forkEncode([forkMarker(childTurn)]);
  const suffix = forkEncode([forkModern("own", forkChild, forkTotal, childTurn), forkCount(forkTotal)]);
  await writeFile(file, prefix + padding + boundary + padding + suffix);
  const oracle = sourceStore(file, "codex");
  await scanSources(oracle, { home: root });
  const sliced = sourceStore(file, "codex");
  let result = await scanSources(sliced, { home: root, deadline: Date.now() });
  assert.equal(result.complete, false);
  assert.equal(Object.values(sliced.files)[0].state.forkReplay, true);
  assert.deepEqual(result.warnings, [], "unfinished healthy prefix is not an ambiguous boundary");
  assert.deepEqual(snapshotRows(sliced), []);
  let sawBoundary = false;
  for (let i = 0; i < 10 && !result.complete; i += 1) {
    result = await scanSources(sliced, { home: root, deadline: Date.now() });
    assert.deepEqual(result.warnings, []);
    if (Object.values(sliced.files)[0].state.forkReplay === false && !result.complete) sawBoundary = true;
  }
  assert.equal(sawBoundary, true);
  assert.equal(result.complete, true);
  assert.deepEqual(snapshotRows(sliced), snapshotRows(oracle));
});

for (const marker of [undefined, "12345678-1234-4000-8000-000000000001", childTurn.slice(0, 15) + "garbage",
  "019f0000-1000-7001-8000-000000000004"]) {
  test(`Codex ambiguous fork boundary ${marker ?? "missing"} stays excluded and diagnosed`, async (t) => {
    const root = await fixture(t);
    const file = path.join(root, "fork.jsonl");
    await writeFile(file, forkEncode([forkHeader(), forkMarker(marker), forkCount(forkParent), forkCount(forkTotal)]));
    const store = sourceStore(file, "codex");
    for (let i = 0; i < 2; i += 1) {
      const result = await scanSources(store, { home: root });
      assert.deepEqual(snapshotRows(store), []);
      assert.equal(result.warnings.length, 1, "bounded diagnostic survives unchanged scans");
      assert.match(result.warnings[0], /may exclude child usage/);
    }
    // A newer marker cannot retroactively establish whether the excluded
    // equal-ms/non-v7 activity was copied or the child's own activity.
    await appendFile(file, forkEncode([forkMarker(childTurn), forkCount({ ...forkTotal, input_tokens: 2090 })]));
    const resolved = await scanSources(store, { home: root });
    assert.equal(snapshotRows(store)[0].tokens.input, 10);
    assert.equal(resolved.warnings.length, 1);
  });
}

for (const initial of ["12345678-1234-4000-8000-000000000001", "019f0000-1000-7not-a-uuid",
  "019f0000-1000-7000-0000-000000000001"]) {
  test(`Codex non-v7/malformed initial ID keeps the old accounting path: ${initial}`, async (t) => {
    const root = await fixture(t);
    const file = path.join(root, "fork.jsonl");
    await writeFile(file, forkEncode([forkHeader(initial), forkMarker(copiedTurn), forkCount(forkParent)]));
    const store = sourceStore(file, "codex");
    const result = await scanSources(store, { home: root });
    assert.equal(snapshotRows(store)[0].tokens.total, 2500);
    assert.deepEqual(result.warnings, []);
  });
}

test("Codex fork notes count bounded overflow without inflating errors", async (t) => {
  const root = await fixture(t);
  const records = forkEncode([forkHeader(), forkMarker(undefined), forkCount(forkParent)]);
  await Promise.all(Array.from({ length: 53 }, (_, index) => writeFile(path.join(root, `${index}.jsonl`), records)));
  const store = sourceStore(root, "codex");
  for (let i = 0; i < 2; i += 1) {
    const result = await scanSources(store, { home: root });
    assert.equal(result.stats.errors, 0);
    assert.equal(result.sourceStats.codex.errors, 0);
    assert.equal(result.warnings.length, 51);
    assert.equal(result.warnings[50], "3 additional scan warnings were not shown.");
  }
});

test("Codex replay reaching EOF without a boundary remains diagnosed", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "fork.jsonl");
  await writeFile(file, forkEncode([forkHeader(), forkMarker(copiedTurn), forkCount(forkParent)]));
  const store = sourceStore(file, "codex");
  for (let i = 0; i < 2; i += 1) {
    const result = await scanSources(store, { home: root });
    assert.equal(result.complete, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /may exclude child usage/);
  }
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

test("lock acquisition publishes one populated directory and release leaves no artifacts", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  const lock = `${store}.lock`;
  await withStoreLock(store, async () => {
    assert.deepEqual(await readdir(root), [path.basename(lock)], "no staging directory survives");
    const owners = await readdir(lock);
    assert.equal(owners.length, 1, "the published lock directory is never empty");
    const owner = JSON.parse(await readFile(path.join(lock, owners[0]), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.token, "string");
  });
  assert.deepEqual(await readdir(root), [], "release quarantines the whole directory");
  await assert.rejects(stat(lock), { code: "ENOENT" });
});

test("concurrent writers serialize through the atomically published lock", async (t) => {
  const root = await fixture(t);
  const store = path.join(root, "store.json");
  let active = 0;
  let peak = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: 4 }, () => withStoreLock(store, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    completed += 1;
  })));
  assert.equal(peak, 1, "exactly one writer holds the lock");
  assert.equal(completed, 4);
  assert.deepEqual(await readdir(root), [], "no lock, staging or quarantine remains");
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
