import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";

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
  return records.map((record, index) => JSON.stringify({ timestamp: `${day}T10:00:${String(index).padStart(2, "0")}.000Z`, ...record }) + "\n").join("");
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
  return { sessions, gather };
}

for (const [name, records, expected] of [
  ["counts a response revision only once with a cumulative suffix", [
    snapshot(10, 10, { response_id: "r" }), modern("r", 10, 10), modern("r", 15, 15), snapshot(null, 16),
  ], [16, 2]],
  ["starts the two counters independently after a legacy prefix", [
    snapshot(50, 50), modern("a", 10, 10), snapshot(10, 60), modern("b", 20, 30), snapshot(20, 80),
  ], [80, 3]],
  ["keeps pending spend after a repeated legacy snapshot", [
    snapshot(10, 10), modern("b", 20, 30), snapshot(10, 10), snapshot(null, 35),
  ], [35, 3]],
  ["recognizes stale history-last when both offset counters advance", [
    modern("a", 10, 10), modern("b", 20, 30), snapshot(20, 20), modern("c", 5, 35), snapshot(20, 25),
  ], [35, 3]],
  ["retains the cumulative residual outside the identified response", [
    snapshot(null, 100, { response_id: "r" }), modern("r", 10, 100),
  ], [100, 2]],
  ["does not count a fully represented checkpoint as a second response", [
    snapshot(null, 10, { response_id: "r" }), modern("r", 10, 10),
  ], [10, 1]],
  ["does not rewind a newer legacy baseline on a delayed identified echo", [
    modern("r", 10, 10), snapshot(20, 30), snapshot(10, 10, { response_id: "r" }), snapshot(null, 35),
  ], [35, 3]],
  ["does not consume pending spend from another thread", [
    modern("a", 10, 10), modern("b", 20, 20, { thread_id: "other" }),
    snapshot(20, 20, { thread_id: "other" }), snapshot(null, 15),
  ], [35, 3]],
]) {
  test(`Codex ${name}`, async (t) => {
    const { sessions, gather } = await setup(t);
    await writeFile(path.join(sessions, "session.jsonl"), lines([header, turn(), ...records]));
    assert.deepEqual(amounts(await gather()), expected);
  });
}

for (const [name, swap] of [["before its response", 3], ["after the next response", 4]]) {
  test(`Codex reconciles an offset snapshot ${name} across an append`, async (t) => {
    const { sessions, gather } = await setup(t);
    const file = path.join(sessions, "offset.jsonl");
    const records = (await readFile(new URL("./fixtures/codex-offset-echo.jsonl", import.meta.url), "utf8")).trimEnd().split("\n");
    [records[swap], records[swap + 1]] = [records[swap + 1], records[swap]];
    const prefix = records.slice(0, swap + 1).join("\n") + "\n";
    await writeFile(file, prefix);
    amounts(await gather());
    const tail = records.slice(swap + 1).join("\n") + "\n";
    await appendFile(file, tail);
    const result = await gather();
    assert.equal(result.stats.bytesRead, Buffer.byteLength(tail));
    assert.deepEqual(amounts(result), [660, 3]);
    assert.deepEqual(result.rows[0].tokens, { input: 600, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 660 });
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
  const prefix = [header, turn(), snapshot(10, 10)];
  const full = path.join(sessions, "b.jsonl");
  await writeFile(path.join(sessions, "a.jsonl"), lines(prefix));
  await writeFile(full, lines([...prefix, modern("r", 10, 10)]));
  assert.deepEqual(amounts(await gather()), [10, 1]);
  await writeFile(full, "");
  assert.deepEqual(amounts(await gather()), [10, 1]);
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
