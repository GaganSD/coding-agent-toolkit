import assert from "node:assert/strict";
import test from "node:test";
import { parseSubagentSnapshot, SubagentShelf, subagentTaskDetails } from "../extensions/pi-slate/background-tasks.ts";

function snapshot(tasks: unknown[], sessionId = "owner") {
  return { version: 1, source: "pi-subagents", sessionId, tasks };
}

function task(id = "run-1") {
  return {
    id, kind: "subagent", label: "reviewer: inspect parser", state: "running",
    startedAt: Date.parse("2026-10-09T12:00:00.000Z"), pid: 42,
    usage: { input: 1200, output: 80, cacheRead: 300, cacheWrite: 10, cost: 0.04 },
    detail: "model · medium\nNative session: child\nPID is shared with the owning Pi process.",
  };
}

test("public v1 snapshots are session/source/version scoped and bounded", () => {
  assert.equal(parseSubagentSnapshot(snapshot([task()]), undefined), undefined);
  assert.equal(parseSubagentSnapshot({ ...snapshot([task()]), version: 2 }, "owner"), undefined);
  assert.equal(parseSubagentSnapshot({ ...snapshot([task()]), source: "archimedes" }, "owner"), undefined);
  assert.equal(parseSubagentSnapshot(snapshot([task()], "other"), "owner"), undefined);
  assert.equal(parseSubagentSnapshot({ ...snapshot([task()]), tasks: {} }, "owner"), undefined);

  const tasks = parseSubagentSnapshot(snapshot(Array.from({ length: 80 }, (_, i) => task(`run-${i}`))), "owner")!;
  assert.equal(tasks.length, 64);
  assert(tasks.every(item => item.label.length <= 160));
});

test("invalid rows are skipped, settled states leave the shelf, and optional fields stay defensive", () => {
  const rows = parseSubagentSnapshot(snapshot([
    task(), task(),
    { ...task("done"), state: "completed" },
    { ...task("bad-kind"), kind: "tool" },
    { ...task("waiting"), state: "waiting", pid: 1.5, startedAt: -1, usage: { input: -1, output: 2 } },
    { ...task("escaped"), label: "bad\x1b[2J\nlabel", detail: `${"line\n".repeat(30)}tail` },
  ]), "owner")!;
  assert.deepEqual(rows.map(row => row.id), ["run-1", "waiting", "escaped"]);
  assert.equal(rows[1]!.pid, undefined);
  assert.equal(rows[1]!.startedAt, undefined);
  assert.deepEqual(rows[1]!.usage, { output: 2 });
  assert(!/[\x00-\x1f\x7f-\x9f]/.test(rows[2]!.label));
  assert((rows[2]!.detail?.split("\n").length ?? 0) <= 16);
});

test("shelf clears on session changes and ignores stale or malformed publications", () => {
  const changes: string[][] = [];
  const shelf = new SubagentShelf(tasks => changes.push(tasks.map(task => task.id)));
  shelf.switchSession("owner");
  assert.equal(shelf.accept(snapshot([task()])), true);
  assert.equal(shelf.accept(snapshot([task("foreign")], "other")), false);
  assert.deepEqual(shelf.snapshot().map(item => item.id), ["run-1"]);
  shelf.switchSession("next");
  assert.deepEqual(shelf.snapshot(), []);
  assert.equal(shelf.accept(snapshot([task()], "owner")), false);
  shelf.clear();
  assert.deepEqual(changes, [[], ["run-1"], [], []]);
});

test("click details contain only bounded public task fields", () => {
  const parsed = parseSubagentSnapshot(snapshot([{ ...task(), usagePartial: true }]), "owner")![0]!;
  const details = subagentTaskDetails(parsed);
  assert.match(details, /State: running/);
  assert.match(details, /Run: run-1/);
  assert.match(details, /Usage \(partial\): input 1\.2k/);
  assert.match(details, /Cost: \$0\.04/);
  assert.match(details, /Native session: child/);
  assert.doesNotMatch(details, /Outcome:|Stop|Resume/);
});
