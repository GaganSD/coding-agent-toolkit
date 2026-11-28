import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { settleCodexInterval } from "../../herdr-insights/mods/insights/core/codex-spend.mjs";

process.env.TZ = "UTC";

const usage = (input) => ({ input_tokens: input, output_tokens: 0 });
const turn = (turn_id = "t", model = "m") => ({ type: "turn_context", payload: { turn_id, model } });
const modern = (response_id, amount, total, extra) => ({ type: "token_usage_record", payload: {
  response_id, usage: usage(amount), thread_token_usage: total == null ? undefined : usage(total), ...extra,
} });
const snapshot = (last, total, extra) => ({ type: "event_msg", payload: {
  type: "token_count", ...extra, info: {
    last_token_usage: last == null ? undefined : usage(last), total_token_usage: total == null ? undefined : usage(total),
  },
} });
const finish = (turn_id) => ({ type: "event_msg", payload: { type: "task_complete", duration_ms: 3000, turn_id } });
const header = { type: "session_meta", payload: { id: "reconcile", cwd: "/repo" } };

function lines(records, day = "2026-11-01") {
  return records.map((record, index) => JSON.stringify({ timestamp: new Date(Date.parse(`${day}T10:00:00.000Z`) + index * 1000).toISOString(), ...record }) + "\n").join("");
}

function amounts(result) {
  assert.equal(result.stats.errors, 0, result.warnings.join("\n"));
  return result.rows.reduce(([tokens, messages], row) => [tokens + row.tokens.total, messages + row.messages], [0, 0]);
}

async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), "codex-reconcile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const store = path.join(home, "insights.json");
  const gather = () => collectSnapshot("snapshot", { home, store });
  return { sessions, store, gather };
}

test("an ordinal-bearing paginated root uses the full history increase", async (t) => {
  const { sessions, gather } = await setup(t);
  const paginated = { ...header, payload: { ...header.payload, history_mode: "paginated" } };
  const records = [paginated, turn(), modern("a", 5, 5), snapshot(20, 25)]
    .map((record, ordinal) => ({ ...record, ordinal }));
  await writeFile(path.join(sessions, "root.jsonl"), lines(records));
  assert.deepEqual(amounts(await gather()), [25, 2]);
});

test("a full copy supplies task attribution when a context-free suffix is discovered first", async (t) => {
  const { sessions, gather } = await setup(t);
  const [h, context, record, history, task] = lines([
    header, turn("t", "paid-model"), modern("r", 10, 10, { turn_id: "t" }), snapshot(10, 10), finish("t"),
  ]).trimEnd().split("\n");
  await writeFile(path.join(sessions, "a-suffix.jsonl"), [h, history, task, ""].join("\n"));
  await gather();
  await writeFile(path.join(sessions, "z-full.jsonl"), [h, context, record, history, task, ""].join("\n"));
  const result = await gather();
  assert.deepEqual(result.rows.map((row) => [row.model, row.tokens.total, row.messages, row.activeMs]),
    [["paid-model", 10, 1, 3000]]);
});

const identified = (response_id) => ({ response_id });
const repeatedCheckpoint = { ...snapshot(null, 10), timestamp: "2026-11-01T10:01:00Z" };
const fork = { type: "session_meta", payload: {
  id: "019f0000-2000-7000-8000-000000000001", forked_from_id: "019f0000-1000-7000-8000-000000000001",
} };
const child = turn("019f0000-3000-7000-8000-000000000001");
for (const fullFirst of [true, false]) {
  for (const [total, expected] of [[89, [32, 1]], [95, [38, 2]]]) {
    test(`a copied fork's first interval uses its inherited baseline (full first: ${fullFirst}, total: ${total})`, async (t) => {
      const { sessions, gather } = await setup(t);
      const bytes = lines([fork, snapshot(57, 57), child, modern("owned", 32, 89), snapshot(32, total)])
        .trimEnd().split("\n");
      const clip = [bytes[0], ...bytes.slice(2)];
      const put = (name, rows) => writeFile(path.join(sessions, name), rows.join("\n") + "\n");
      await put("a.jsonl", fullFirst ? bytes : clip);
      const initial = await gather();
      if (fullFirst) assert.deepEqual(amounts(initial), expected);
      await put("z.jsonl", fullFirst ? clip : bytes);
      // Both see the same owned record. Only the complete history can tell
      // whether the snapshot adds no spend or another six unpaid tokens.
      assert.deepEqual(amounts(await gather()), expected);
    });
  }
}

const vectorSnapshot = (input, output) => ({ type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { input_tokens: input, output_tokens: output },
} } });

for (const [name, records, expected, split] of [
  ["counts a response revision only once with a cumulative suffix", [
    modern("r", 10, 10), snapshot(10, 10), modern("r", 15, 15), snapshot(null, 16),
  ], [16, 2], 2],
  ["starts the two counters independently after a legacy prefix", [
    snapshot(50, 50), modern("a", 10, 10), snapshot(10, 60), modern("b", 20, 30), snapshot(20, 80),
  ], [80, 3], 2],
  ["keeps pending spend after a repeated legacy snapshot", [
    snapshot(10, 10), modern("b", 20, 30), snapshot(10, 10), snapshot(null, 35),
  ], [35, 3], 3],
  ["retains the residual outside the recorded response, including output", [
    modern("r", 10, 100, { usage: { ...usage(10), output_tokens: 2 } }), vectorSnapshot(100, 10),
  ], [110, 2], 1],
  ["does not count a fully represented checkpoint as a second response", [
    modern("r", 10, 10), snapshot(null, 10),
  ], [10, 1], 1],
  ["carries a lost history append across an ordinary completed turn", [
    modern("a", 10, 10, { turn_id: "t" }), snapshot(10, 10), modern("b", 30, 40, { turn_id: "t" }), finish("t"),
    turn("next"), modern("c", 5, 45, { turn_id: "next" }), snapshot(5, 45),
  ], [45, 3], 4],
  ["keeps interrupted spend but excludes it from a restored history interval", [
    modern("a", 20, 20, { turn_id: "t" }), snapshot(20, 20), modern("b", 10, 30, { turn_id: "t" }),
    turn("next"), snapshot(20, 40),
  ], [50, 3], 3],
  ["keeps a distinct whole response published after a headerless resume", [
    modern("a", 10, 10, { turn_id: "t" }), snapshot(10, 10), modern("b", 7, 17, { turn_id: "t" }),
    turn("next"), snapshot(20, 30),
  ], [37, 3], 3],
  ["keeps equal-size named responses distinct", [
    modern("a", 10, 10), snapshot(10, 10, identified("a")), modern("b", 10, 20), snapshot(10, 20, identified("b")),
  ], [20, 2], 2],
  ["does not guess that an anonymous record is a second spelling of a later ID", [
    modern("", 10, 10), snapshot(10, 10, identified("a")), modern("a", 10, 20),
  ], [20, 2], 2],
  ["re-baselines a zero checkpoint without adding a message", [
    snapshot(null, 100), snapshot(null, 0), snapshot(null, 110),
  ], [210, 2], 2],
  ["re-baselines a reset confirmed by a zero checkpoint", [
    modern("a", 100, 100), snapshot(100, 100), snapshot(null, 0),
    modern("b", 10, 10), snapshot(10, 10), modern("c", 5, 15), snapshot(null, 15),
  ], [115, 3], 4],
  ["does not suppress unrecorded spend after an epoch reset", [
    modern("a", 5, 5), modern("b", 7, 12), snapshot(null, 12), snapshot(null, 0),
    modern("c", 3, 3), snapshot(null, 7),
  ], [19, 4], 4],
  ["does not revive an old epoch after an exact replay", [
    modern("a", 10, 10), repeatedCheckpoint, modern("b", 20, 30), snapshot(null, 30),
    repeatedCheckpoint, snapshot(null, 35),
  ], [35, 3], 4],
  ["keeps a history-only response even when its vector matches a later turn", [
    modern("a", 10, 10), snapshot(10, 10), turn("B", "history"), snapshot(10, 30), finish("B"),
    turn("C", "record"), modern("c", 20, 30, { turn_id: "C" }), snapshot(20, 50),
  ], [50, 3], 5],
  ["retains an increment for incomplete usage even when last is stale", [
    modern("a", 10, 10), snapshot(10, 10), modern("b", 5, 15), snapshot(10, 18),
  ], [18, 3], 3],
  ["does not double-count stale last when recorded usage covers the increment", [
    modern("a", 10, 10), modern("b", 20, 30), snapshot(20, 20), modern("c", 5, 35), snapshot(20, 25),
  ], [35, 3], 4],
  ["does not consume pending spend from another thread", [
    modern("a", 10, 10), modern("b", 20, 20, { thread_id: "other" }),
    snapshot(20, 20, { thread_id: "other" }), snapshot(null, 15),
  ], [35, 3], 2],
  ["does not use a response already published by name in the legacy prefix to cover later spend", [
    snapshot(10, 10, identified("r")), modern("r", 10, 10), snapshot(10, 15),
  ], [15, 2], 1],
  ["keeps a legacy last-only carrier separate from the history baseline", [
    snapshot(10, null, identified("r")), modern("r", 10, 10), snapshot(null, 15),
  ], [15, 2], 1],
  ["does not overwrite the fork history baseline with a repeated modern counter", [
    fork, modern("a", 10, 10), snapshot(10, 100, identified("a")), modern("a", 10, 10), child, snapshot(null, 105),
  ], [5, 1], 3],
  ["does not carry a replayed offset response into the child balance", [
    fork, snapshot(10, 100, identified("r")), modern("r", 10, 10), child, snapshot(null, 105),
  ], [5, 1], 3],
  ["does not rewind a copied baseline on an older replayed total", [
    fork, snapshot(10, 100), snapshot(20, 120), snapshot(10, 100), child, snapshot(null, 125),
  ], [5, 1], 3],
  ["keeps ordinary session headers independent", [
    snapshot(10, 10), { ...header, payload: { id: "second" } }, snapshot(10, 10),
  ], [20, 2], 2],
]) {
  test(`Codex ${name} in both full and resumed scans`, async (t) => {
    const { sessions, gather } = await setup(t);
    const filename = path.join(sessions, "session.jsonl");
    const all = records[0].type === "session_meta" ? records : [header, ...records];
    const encoded = lines(all).trimEnd().split("\n");
    const boundary = split + (all === records ? 0 : 1);
    const prefix = encoded.slice(0, boundary).join("\n") + "\n";
    const tail = encoded.slice(boundary).join("\n") + "\n";
    await writeFile(filename, prefix);
    amounts(await gather());
    await appendFile(filename, tail);
    const after = await gather();
    assert.equal(after.stats.bytesRead, Buffer.byteLength(tail));
    assert.deepEqual(amounts(after), expected);
    await writeFile(filename, "");
    await gather();
    await writeFile(filename, prefix + tail);
    assert.deepEqual(amounts(await gather()), expected);
  });
}

for (const fragmentFirst of [true, false]) {
  test(`Codex reconciles a copied checkpoint (${fragmentFirst ? "fragment" : "full interval"} first)`, async (t) => {
    const { sessions, gather } = await setup(t);
    const last = { ...snapshot(null, 100), timestamp: "2026-11-01T10:02:00Z" };
    const fragment = lines([header, last]);
    const full = lines([header, modern("r", 10, 10), last]);
    await writeFile(path.join(sessions, "a.jsonl"), fragmentFirst ? fragment : full);
    amounts(await gather());
    await writeFile(path.join(sessions, "b.jsonl"), fragmentFirst ? full : fragment);
    assert.deepEqual(amounts(await gather()), [100, 2]);
  });
}

test("Codex stale-last settlement survives a fragment containing only the same snapshot", async (t) => {
  const { sessions, gather } = await setup(t);
  const last = { ...snapshot(20, 25), timestamp: "2026-11-01T10:02:00Z" };
  await writeFile(path.join(sessions, "a.jsonl"), lines([
    header, modern("a", 10, 10), modern("b", 20, 30), snapshot(20, 20), modern("c", 5, 35), last,
  ]));
  assert.deepEqual(amounts(await gather()), [35, 3]);
  await writeFile(path.join(sessions, "b.jsonl"), lines([header, last]));
  assert.deepEqual(amounts(await gather()), [35, 3]);
});

test("Codex resolves referenced fork history at the ancestor boundary, not at current EOF", async (t) => {
  const { sessions, gather } = await setup(t);
  const ancestor = "019f0000-1000-7000-8000-000000000001";
  const childId = "019f0000-2000-7000-8000-000000000001";
  const prefix = [
    { ...header, payload: { id: ancestor } }, turn("parent", "ancestor"), modern("parent", 5500, 5500), snapshot(5500, 5500),
  ];
  const parentBytes = lines(prefix);
  const referenced = { type: "session_meta", payload: { id: childId, history_base: {
    thread_id: ancestor, end_ordinal_exclusive: prefix.length, end_byte_offset: Buffer.byteLength(parentBytes),
  } } };
  // Discover the child first, before its parent is present.
  await writeFile(path.join(sessions, "a-child.jsonl"), lines([
    referenced, child, modern("own1", 100, 5600), snapshot(100, 5600), modern("own2", 150, 5750), snapshot(150, 5750),
  ]));
  assert.match((await gather()).warnings.join("\n"), /referenced history baseline is unavailable/);
  await writeFile(path.join(sessions, "b-parent.jsonl"), lines([...prefix, modern("parent-later", 10, 5510), snapshot(10, 5510)]));
  const result = await gather();
  assert.deepEqual(amounts(result), [5760, 4]);
  assert.deepEqual(result.rows.filter((row) => row.session === `codex:${childId}`).map((row) => [row.tokens.total, row.messages]), [[250, 2]]);
  assert.doesNotMatch(result.warnings.join("\n"), /referenced history baseline is unavailable/);
});

test("settlement does not share reset vectors or partially subtract an oversized aggregate", () => {
  const vector = (n) => [n, 0, 0, 0, 0];
  const first = settleCodexInterval({ boundary: "modern", fill: "10/5", total: vector(0) });
  first.next.historyTotal[0] = 3;
  assert.deepEqual(settleCodexInterval({ boundary: "modern", total: vector(10) }).charge, vector(10));
  const total = Object.freeze([5, 0, 0, 20, 0]);
  const pending = Object.freeze([10, 0, 0, 10, 0]);
  for (const records of [undefined, Object.freeze({ whole: pending })]) {
    assert.deepEqual(settleCodexInterval({ boundary: "modern", total, pending, records }).charge, total);
  }
});

test("an interrupted record with equal raw input/output cannot cover a different resumed vector", () => {
  const baseline = [2048, 0, 0, 16, 0];
  for (const field of [1, 2, 4]) {
    const interrupted = baseline.slice();
    interrupted[field] = field === 4 ? 3 : 1024;
    const total = baseline.map((n) => n * 2);
    assert.deepEqual(settleCodexInterval({ boundary: "modern", baseline, total, last: baseline, priorLast: baseline,
      pending: interrupted, records: { prior: interrupted }, interrupted, interruptedRecords: { prior: interrupted } }).charge, baseline);
  }
});

test("an ordinary copied fork uses an owned settings marker before an equal-millisecond child turn", async (t) => {
  const { sessions, gather } = await setup(t);
  const thread_id = fork.payload.id;
  const sameMillisecond = thread_id.replace(/1$/, "2");
  await writeFile(path.join(sessions, "ordinary-fork.jsonl"), lines([
    fork, turn(fork.payload.forked_from_id), snapshot(100, 100),
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_id } },
    turn(sameMillisecond), modern("own", 5, 105, { thread_id, turn_id: sameMillisecond }), snapshot(5, 105),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [5, 1]);
  assert.doesNotMatch(result.warnings.join("\n"), /UUIDv7/);
});

test("a zero-charge referenced observation can acquire spend and a task target when its ancestor arrives", async (t) => {
  const { sessions, gather } = await setup(t);
  const ancestor = "019f0000-1000-7000-8000-000000000001";
  const childId = "019f0000-2000-7000-8000-000000000001";
  const parent = lines([{ ...header, payload: { id: ancestor } }, turn(), modern("parent", 100, 100), snapshot(100, 100)]);
  const base = { thread_id: ancestor, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(parent) };
  await writeFile(path.join(sessions, "child.jsonl"), lines([
    { ...header, payload: { id: childId, history_base: base } }, turn("old", "abandoned"),
    modern("abandoned", 125, 225, { turn_id: "old" }), turn("new", "restored"), snapshot(100, 125), finish("new"),
  ]));
  assert.deepEqual(amounts(await gather()), [125, 1]);
  await writeFile(path.join(sessions, "parent.jsonl"), parent);
  const rows = (await gather()).rows.filter((row) => row.session === `codex:${childId}`);
  assert.deepEqual(rows.map((row) => [row.model, row.tokens.total, row.messages, row.activeMs]),
    [["abandoned", 125, 1, 0], ["restored", 25, 1, 3000]]);
});

test("a referenced full copy supplies attribution even when a context-free clip has equal usage depth", async (t) => {
  const { sessions, gather } = await setup(t);
  const ancestor = "019f0000-1000-7000-8000-000000000001";
  const childId = "019f0000-2000-7000-8000-000000000001";
  const parent = lines([{ ...header, payload: { id: ancestor } }, turn(), modern("parent", 100, 100), snapshot(100, 100)]);
  const base = { thread_id: ancestor, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(parent) };
  const [meta, context, usage] = lines([
    { ...header, payload: { id: childId, history_base: base } }, turn("child", "child-model"), snapshot(100, 125),
  ]).trimEnd().split("\n");
  await writeFile(path.join(sessions, "parent.jsonl"), parent);
  await writeFile(path.join(sessions, "a-clip.jsonl"), [meta, usage, ""].join("\n"));
  await gather();
  await writeFile(path.join(sessions, "z-full.jsonl"), [meta, context, usage, ""].join("\n"));
  assert.deepEqual((await gather()).rows.filter((row) => row.session === `codex:${childId}`).map((row) => [row.model, row.tokens.total]),
    [["child-model", 25]]);
});

test("paginated agent projections exclude inherited counters and honor the persisted child ordinal", async (t) => {
  const { sessions, gather } = await setup(t);
  const ancestor = "019f0000-1000-7000-8000-000000000001";
  const baseRows = [{ ...header, payload: { id: ancestor } }, turn(), modern("parent", 100, 100), snapshot(100, 100)];
  const ordinals = (start, data) => lines(data.map((record, i) => ({ ...record, ordinal: start + i })));
  const parent = ordinals(0, baseRows);
  await writeFile(path.join(sessions, `rollout-2026-11-01T10-00-00-${ancestor}.jsonl`), parent);
  for (const [i, referenced] of [true, false].entries()) {
    const id = `019f0000-200${i}-7000-8000-000000000001`;
    const childMeta = { type: "session_meta", payload: { id, session_id: ancestor, forked_from_id: ancestor,
      history_mode: "paginated", thread_source: "subagent", ...(referenced ? { forked_from_ordinal_exclusive: 4,
        history_base: { thread_id: ancestor, end_ordinal_exclusive: 4, end_byte_offset: Buffer.byteLength(parent) } }
        : { subagent_history_start_ordinal: 2 }) } };
    await writeFile(path.join(sessions, `rollout-2026-11-01T10-00-00-${id}.jsonl`), ordinals(referenced ? 4 : 0, [
      childMeta, ...(!referenced ? [{ type: "response_item", payload: { type: "message", role: "user" } }] : []),
      turn(id.replace(/1$/, "2")), ...(referenced ? [snapshot(0, 125)] : [modern("own", 5, 5), snapshot(20, 25)]),
    ]));
  }
  const result = await gather();
  assert.deepEqual(result.rows.map((row) => [row.tokens.total, row.messages]), [[100, 1], [125, 1], [25, 2]]);
  assert.doesNotMatch(result.warnings.join("\n"), /UUIDv7|referenced history baseline/);
});

test("physical rollout references resolve through inherited ordinals and a same-session replacement", async (t) => {
  const { sessions, gather } = await setup(t);
  const id = (n) => `019f0000-${n}000-7000-8000-000000000001`;
  const meta = (n, history_base) => ({ type: "session_meta", payload: { id: id(n), history_mode: "paginated", history_base } });
  const at = (start, records) => lines(records.map((record, i) => ({ ...record, ordinal: start + i })));
  const position = (physical, end_ordinal_exclusive, body) => ({ thread_id: id(physical), end_ordinal_exclusive,
    end_byte_offset: Buffer.byteLength(body) });
  const file = (physical) => path.join(sessions, `rollout-2026-11-01T10-00-00-${id(physical)}.jsonl`);
  const root = at(0, [meta(1), turn(), modern("root", 100, 100), snapshot(100, 100)]);
  const replacement = at(4, [meta(1, position(1, 4, root)), turn("replacement"), snapshot(100, 125), snapshot(100, 150)]);
  const descendant = at(8, [meta(3, position(2, 8, replacement)), turn("child"), modern("child", 5, 5), snapshot(5, 155)]);
  await writeFile(file(1), root);
  await writeFile(file(2), replacement);
  await writeFile(file(3), descendant);
  const result = await gather();
  assert.deepEqual(amounts(result), [155, 4]);
  assert.deepEqual(result.rows.map((row) => [row.session, row.tokens.total, row.messages]),
    [[`codex:${id(1)}`, 150, 3], [`codex:${id(3)}`, 5, 1]]);
  assert.doesNotMatch(result.warnings.join("\n"), /referenced history baseline is unavailable/);
});

for (const [label, original, expected, native] of [["modern", "codex-modern", [300, 3], [180, 2]], ["mixed", "codex-mixed", [523, 7], [403, 6]]]) {
  test(`Codex ${label} native and original snapshot-first import fixtures remain distinct`, async (t) => {
    const { sessions, gather } = await setup(t);
    const file = path.join(sessions, "import.jsonl");
    const body = (suffix) => readFile(new URL(`./fixtures/${original}${suffix}.jsonl`, import.meta.url));
    await writeFile(file, await body("-import"));
    const imported = await gather();
    assert.deepEqual(amounts(imported), expected);
    assert.match(imported.warnings.join("\n"), /carrier (?:timestamps disagree with rollout )?order/);
    await writeFile(file, "");
    await gather();
    await writeFile(file, await body(""));
    const current = await gather();
    assert.deepEqual(amounts(current), native);
    assert.doesNotMatch(current.warnings.join("\n"), /carrier (?:timestamps disagree with rollout )?order/);
  });
}

test("Codex a suffix starting before a revision cannot shrink a complete observation", async (t) => {
  const { sessions, gather } = await setup(t);
  const cached = { input_tokens: 10, cached_input_tokens: 5 };
  const checkpoint = snapshot(10, 10);
  const revised = snapshot(10, 10);
  revised.payload.info.total_token_usage = cached;
  revised.payload.info.last_token_usage = cached;
  const final = snapshot(10, 25);
  final.payload.info.total_token_usage.cached_input_tokens = 5;
  const full = lines([header, turn(), modern("r", 10, 10), checkpoint, modern("r", 10, 10, { usage: cached }),
    revised, modern("b", 10, 20), final]);
  const linesOfFull = full.trimEnd().split("\n");
  await writeFile(path.join(sessions, "z-full.jsonl"), full);
  assert.deepEqual(amounts(await gather()), [25, 3]);
  await writeFile(path.join(sessions, "a-suffix.jsonl"), [linesOfFull[0], ...linesOfFull.slice(3)].join("\n") + "\n");
  assert.deepEqual(amounts(await gather()), [25, 3]);
});

const fill = (last) => ({ type: "event_msg", payload: { type: "token_count", info: {
  model_context_window: 100, total_token_usage: { total_tokens: 100 }, last_token_usage: { total_tokens: last },
} } });
for (const [label, body, expected] of [
  ["records surviving resume do not cover new SpendingOnly usage", [turn("before"), modern("a", 20, 20), snapshot(20, 20),
    modern("interrupted", 30, 50), turn("after"), snapshot(20, 40)], [70, 3]],
  ["a smaller post-resume advance cannot contain a whole unpublished record", [turn(), modern("a", 10, 10), snapshot(10, 10),
    modern("interrupted", 30, 40), snapshot(20, 30)], [60, 3]],
  ["copied inherited last does not override the first local history increment", [fork, snapshot(10, 100), child, snapshot(10, 125)], [25, 1]],
  ["legacy stale last does not override a larger later history increment", [turn(), snapshot(10, 10), snapshot(10, 35)], [35, 2]],
  ["a compaction checkpoint recovers its missing standalone usage record", [turn(), modern("a", 10, 10), snapshot(10, 10),
    { type: "compacted", payload: { compaction_response_id: "lost", latest_token_usage_record: modern("lost", 30, 40).payload } },
    snapshot(10, 10)], [40, 2]],
  ["an identical scalar window reset opens another legacy epoch", [turn(), fill(100), snapshot(10, 10), fill(90), snapshot(10, 10)], [20, 2]],
  ["a rate-limit repetition of the same window fill preserves pending records", [turn(), modern("a", 10, 10), snapshot(10, 10),
    fill(90), modern("b", 20, 30), fill(90), snapshot(20, 20)], [30, 2]],
  ["an untagged snapshot in an import can follow the active delegated turn", [turn("delegate-turn"),
    modern("a", 10, 10, { thread_id: "delegated", turn_id: "delegate-turn" }), snapshot(10, 10)], [10, 1]],
]) {
  test(`Codex ${label}`, async (t) => {
    const { sessions, gather } = await setup(t);
    const pathName = path.join(sessions, "run.jsonl");
    const input = lines([...(body[0].type === "session_meta" ? [] : [header]), ...body]).trimEnd().split("\n");
    const halfway = Math.ceil(input.length / 2);
    await writeFile(pathName, input.slice(0, halfway).join("\n") + "\n");
    await gather();
    await appendFile(pathName, input.slice(halfway).join("\n") + "\n");
    assert.deepEqual(amounts(await gather()), expected);
  });
}

test("Codex retains history-only spend when the fork only copied an independent record counter", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "fork-offset.jsonl"), lines([
    fork, modern("parent", 10, 100), child, modern("child", 5, 105), snapshot(5, 10),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [10, 2]);
  assert.match(result.warnings.join("\n"), /fork accounting may be inaccurate/);
});

for (const marker of [undefined, "different-response"]) {
  test(`a checkpoint recovers its latest named response with ${marker ? "a different" : "no"} compaction ID`, async (t) => {
    const { sessions, gather } = await setup(t);
    const file = path.join(sessions, "checkpoint.jsonl");
    const saved = modern("saved", 30, 40);
    const checkpoint = { type: "compacted", payload: { compaction_response_id: marker, latest_token_usage_record: saved.payload } };
    await writeFile(file, lines([header, turn(), modern("a", 10, 10), snapshot(10, 10), checkpoint]));
    assert.deepEqual(amounts(await gather()), [40, 2]);
    await appendFile(file, lines([saved, checkpoint], "2026-11-02"));
    assert.deepEqual(amounts(await gather()), [40, 2]);
  });
}

test("Codex compaction excludes only its own increment from a deferred history interval", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "compaction.jsonl"), lines([
    header, turn(), modern("a", 10, 10), snapshot(10, 10), modern("compaction", 100, 110),
    modern("deferred", 20, 130), { type: "compacted", payload: { compaction_response_id: "compaction" } },
    snapshot(10, 10), snapshot(20, 35),
  ]));
  assert.deepEqual(amounts(await gather()), [135, 4]);
});

test("Codex preserves raw spend if history reclassifies cache while adding tokens", async (t) => {
  const { sessions, gather } = await setup(t);
  const total = (input_tokens, cached_input_tokens, output_tokens) => ({ type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: { input_tokens, cached_input_tokens, output_tokens } },
  } });
  await writeFile(path.join(sessions, "mixed-sign.jsonl"), lines([
    header, modern("a", 100, 100, { usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 } }),
    total(100, 80, 5), modern("b", 10, 110), total(100, 90, 5), total(115, 30, 7),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [122, 3]);
  assert.deepEqual(result.rows.map(({ tokens }) => [tokens.input, tokens.cacheRead, tokens.output]), [[35, 80, 7]]);
});

test("Codex reclassifies an already counted named legacy response without adding raw spend", async (t) => {
  const { sessions, gather } = await setup(t);
  const revision = snapshot(10, 10, identified("r"));
  revision.payload.info.last_token_usage.cached_input_tokens = 5;
  revision.payload.info.total_token_usage.cached_input_tokens = 5;
  await writeFile(path.join(sessions, "legacy-cache.jsonl"), lines([header, snapshot(10, 10, identified("r")), revision]));
  const result = await gather();
  assert.deepEqual(amounts(result), [10, 1]);
  assert.deepEqual(result.rows.map(({ tokens }) => [tokens.input, tokens.cacheRead]), [[5, 5]]);
});

test("Codex cache reclassification does not increase the raw input of an authoritative response", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "cache.jsonl"), lines([
    header, modern("r", 10, 10), snapshot(10, 10, identified("r")),
    modern("r", 10, 10, { usage: { ...usage(10), cached_input_tokens: 5 } }),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [10, 1]);
  assert.deepEqual(result.rows.map(({ tokens }) => [tokens.input, tokens.cacheRead]), [[5, 5]]);
});

test("Codex resolves an explicitly referenced older turn from a delegated thread", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "older-turn.jsonl"), lines([
    header, turn("old", "cheap"), turn("new", "expensive"),
    modern("parent", 10, 10, { turn_id: "new" }),
    modern("delegated", 20, 20, { turn_id: "old", thread_id: "delegate" }),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [30, 2]);
  assert.deepEqual(result.rows.map(({ session, model }) => [session, model]), [
    ["codex:delegate", "cheap"], ["codex:reconcile", "expensive"],
  ]);
});

test("Codex tasks with identical turn IDs stay in their named threads", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "tasks.jsonl"), lines([
    header, turn("T", "one"), modern("a", 10, 10, { turn_id: "T", thread_id: "one" }),
    turn("T", "two"), modern("b", 20, 20, { turn_id: "T", thread_id: "two" }),
    { ...finish("T"), payload: { ...finish("T").payload, thread_id: "one" } },
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [30, 2]);
  assert.deepEqual(result.rows.map(({ session, activeMs }) => [session, activeMs]), [["codex:one", 3000], ["codex:two", 0]]);
});

test("Codex persists compact interval evidence for a long rollout", async (t) => {
  const { sessions, store, gather } = await setup(t);
  const file = path.join(sessions, "session.jsonl");
  const prefix = [header, turn()];
  for (let i = 1; i <= 3000; i += 1) prefix.push(modern(`r${i}`, 10, i * 10), snapshot(10, i * 10));
  await writeFile(file, lines(prefix));
  assert.deepEqual(amounts(await gather()), [30000, 3000]);
  const { size } = await stat(store);
  // Main stores about 417 kB for this fixture, without separately owned echoes.
  assert.ok(size < 1.8 * 418000, `persisted store is ${size} bytes`);
  const repeat = lines(prefix).split("\n")[3];
  const tail = repeat + "\n" + lines([snapshot(null, 30015)], "2026-11-02");
  await appendFile(file, tail);
  const after = await gather();
  assert.equal(after.stats.bytesRead, Buffer.byteLength(tail));
  assert.deepEqual(amounts(after), [30015, 3001]);
});

for (const [name, swap, expected] of [
  ["in producer order", null, [660, 3]],
  // A producer cannot publish the snapshot before its record, nor emit
  // an older snapshot after a record that belongs to a later interval.
  ["before its response (unsupported order)", 3, [770, 4]],
  ["after the next response (unsupported order)", 4, [990, 4]],
]) {
  test(`Codex reconciles an offset snapshot ${name} across an append`, async (t) => {
    const { sessions, gather } = await setup(t);
    const file = path.join(sessions, "offset.jsonl");
    const records = (await readFile(new URL("./fixtures/codex-offset-echo.jsonl", import.meta.url), "utf8")).trimEnd().split("\n");
    if (swap !== null) [records[swap], records[swap + 1]] = [records[swap + 1], records[swap]];
    const boundary = (swap ?? 4) + 1;
    const prefix = records.slice(0, boundary).join("\n") + "\n";
    await writeFile(file, prefix);
    amounts(await gather());
    const tail = records.slice(boundary).join("\n") + "\n";
    await appendFile(file, tail);
    const result = await gather();
    assert.equal(result.stats.bytesRead, Buffer.byteLength(tail));
    assert.deepEqual(amounts(result), expected);
    assert.equal(result.warnings.some((warning) => /timestamps disagree with rollout order/.test(warning)), swap !== null);
    assert.equal((await gather()).stats.bytesRead, 0);
  });
}

for (const snapshotFirst of [true, false]) {
  test(`Codex reconciles an explicit ID across fragments (${snapshotFirst ? "snapshot" : "response"} first)`, async (t) => {
    const { sessions, gather } = await setup(t);
    const legacyFile = path.join(sessions, snapshotFirst ? "a.jsonl" : "b.jsonl");
    const modernFile = path.join(sessions, snapshotFirst ? "b.jsonl" : "a.jsonl");
    const legacy = lines([header, turn("t", "legacy"), snapshot(10, 10, { response_id: "r", turn_id: "t" }), finish("t")], "2026-11-02");
    const actual = lines([header, turn("t", "modern"), modern("r", 10, 10, { turn_id: "t" })]);
    await writeFile(snapshotFirst ? legacyFile : modernFile, snapshotFirst ? legacy : actual);
    assert.deepEqual(amounts(await gather()), [10, 1]);
    await writeFile(snapshotFirst ? modernFile : legacyFile, snapshotFirst ? actual : legacy);
    const result = await gather();
    assert.deepEqual(amounts(result), [10, 1]);
    assert.deepEqual(result.rows.map(({ day, model, activeMs }) => [day, model, activeMs]), [["2026-11-01", "modern", 3000]]);
    // The task and provisional usage belong to the snapshot fragment even
    // while both are attributed to the modern row.
    await writeFile(modernFile, "");
    const after = await gather();
    assert.deepEqual(amounts(after), [10, 1]);
    assert.deepEqual(after.rows.map(({ day, model, activeMs }) => [day, model, activeMs]), [["2026-11-02", "legacy", 3000]]);
  });
}

test("Codex keeps an anonymous snapshot copy when the file holding its response disappears", async (t) => {
  const { sessions, gather } = await setup(t);
  const last = { ...snapshot(10, 10), timestamp: "2026-11-01T10:01:00Z" };
  const full = path.join(sessions, "b.jsonl");
  await writeFile(path.join(sessions, "a.jsonl"), lines([header, turn(), last]));
  await writeFile(full, lines([header, turn(), modern("r", 10, 10), last]));
  assert.deepEqual(amounts(await gather()), [10, 1]);
  await writeFile(full, "");
  assert.deepEqual(amounts(await gather()), [10, 1]);
});

test("Codex does not move a same-turn task to an older model after a delayed snapshot", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "same-turn-model.jsonl"), lines([
    header, turn("T", "older"), modern("a", 10, 10, { turn_id: "T" }), snapshot(10, 10),
    turn("T", "current"), modern("b", 20, 30, { turn_id: "T" }), snapshot(10, 10, { turn_id: "T" }),
    finish("T"), snapshot(20, 30),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [30, 2]);
  assert.deepEqual(result.rows.map(({ model, activeMs }) => [model, activeMs]), [["current", 3000], ["older", 0]]);
});

test("Codex rebinds a delayed identified echo's explicit turn without moving newer usage", async (t) => {
  const { sessions, gather } = await setup(t);
  await writeFile(path.join(sessions, "tasks.jsonl"), lines([header, turn("T", "a"), modern("r", 10, 10),
    turn("U", "b"), modern("q", 20, 30, { turn_id: "U" }), snapshot(10, 10, { response_id: "r", turn_id: "T" }), finish("T"),
  ]));
  const result = await gather();
  assert.deepEqual(amounts(result), [30, 2]);
  assert.deepEqual(result.rows.map(({ model, activeMs }) => [model, activeMs]), [["a", 3000], ["b", 0]]);
});

test("Codex pairs explicit parent response identity despite missing thread ID on the copied snapshot", async (t) => {
  const { sessions, gather } = await setup(t);
  const parent = "019f0000-1000-7000-8000-000000000001";
  const child = "019f0000-2000-7000-8000-000000000001";
  await writeFile(path.join(sessions, "fork.jsonl"), lines([
    { type: "session_meta", payload: { id: child, forked_from_id: parent } },
    modern("r", 10, null, { thread_id: parent }), snapshot(10, null, { response_id: "r" }),
    turn("019f0000-3000-7000-8000-000000000001", "child"), snapshot(null, 25),
  ]));
  assert.deepEqual(amounts(await gather()), [15, 1]);
});
