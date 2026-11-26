import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_TASK_TRANSCRIPT_AGGREGATE_CHARS, BACKGROUND_TASK_TRANSCRIPT_MAX_CHARS,
  BACKGROUND_TASK_TRANSCRIPT_MAX_LINES, backgroundTaskDetails, backgroundTaskStatus,
  BackgroundTaskShelf, parseBackgroundTaskSnapshot,
} from "../extensions/pi-slate/background-tasks.ts";

function snapshot(tasks: unknown[], sessionId = "owner", source = "pi-subagents") {
  return { version: 1, source, sessionId, tasks };
}

function task(id = "run-1") {
  return {
    id, kind: "subagent", label: "reviewer: inspect parser", state: "running",
    startedAt: Date.parse("2026-10-09T12:00:00.000Z"), pid: 42,
    usage: { input: 1200, output: 80, cacheRead: 300, cacheWrite: 10, cost: 0.04 },
    detail: "model · medium\nNative session: child\nPID is shared with the owning Pi process.",
  };
}

test("public v1 snapshots accept bounded publisher names and stay session/version scoped", () => {
  assert.equal(parseBackgroundTaskSnapshot(snapshot([task()]), undefined), undefined);
  assert.equal(parseBackgroundTaskSnapshot({ ...snapshot([task()]), version: 2 }, "owner"), undefined);
  assert.equal(parseBackgroundTaskSnapshot(snapshot([task()], "other"), "owner"), undefined);
  assert.equal(parseBackgroundTaskSnapshot({ ...snapshot([task()]), tasks: {} }, "owner"), undefined);
  for (const source of ["", "   ", "\x1b[2J", "x".repeat(129)]) {
    assert.equal(parseBackgroundTaskSnapshot(snapshot([task()], "owner", source), "owner"), undefined);
  }

  const parsed = parseBackgroundTaskSnapshot(snapshot(Array.from({ length: 80 }, (_, i) => task(`run-${i}`)), "owner", "compatible-publisher"), "owner")!;
  assert.equal(parsed.source, "compatible-publisher");
  assert.equal(parsed.tasks.length, 64);
  assert(parsed.tasks.every(item => item.source === "compatible-publisher" && item.label.length <= 160));
});

test("invalid rows are skipped, settled states leave the shelf, and optional fields stay defensive", () => {
  const rows = parseBackgroundTaskSnapshot(snapshot([
    task(), task(),
    { ...task("done"), state: "completed" },
    { ...task("bad-kind"), kind: "tool" },
    { ...task("waiting"), state: "waiting", pid: 1.5, startedAt: -1, usage: { input: -1, output: 2 } },
    { ...task("idle"), state: "idle" },
    { ...task("escaped"), label: "bad\x1b[2J\nlabel", name: "worker\x1b[2J\nname",
      task: `${"task line\n".repeat(100)}tail`, transcript: `${"transcript line\n".repeat(400)}tail`,
      detail: `${"line\n".repeat(30)}tail` },
  ]), "owner")!.tasks;
  assert.deepEqual(rows.map(row => row.id), ["run-1", "waiting", "idle", "escaped"]);
  assert.equal(rows[1]!.pid, undefined);
  assert.equal(rows[1]!.startedAt, undefined);
  assert.deepEqual(rows[1]!.usage, { output: 2 });
  assert(!/[\x00-\x1f\x7f-\x9f]/.test(rows[3]!.label));
  assert.equal(rows[3]!.name, "worker name");
  assert((rows[3]!.task?.length ?? 0) <= 8192);
  assert((rows[3]!.detail?.split("\n").length ?? 0) <= 16);
  assert((rows[3]!.transcript?.split("\n").length ?? 0) <= BACKGROUND_TASK_TRANSCRIPT_MAX_LINES);
  assert((rows[3]!.transcript?.length ?? 0) <= BACKGROUND_TASK_TRANSCRIPT_MAX_CHARS);
  assert(!rows[3]!.transcript!.includes("\x1b"));
});

test("display states map exactly to idle, active, or wait", () => {
  assert.equal(backgroundTaskStatus("idle"), "idle");
  assert.equal(backgroundTaskStatus("running"), "active");
  for (const state of ["starting", "waiting", "cleanup_unknown"]) assert.equal(backgroundTaskStatus(state), "wait");
});

test("shelf keeps independent publisher snapshots and keys rows by source plus id", () => {
  const changes: string[][] = [];
  const shelf = new BackgroundTaskShelf(tasks => changes.push(tasks.map(task => `${task.source}/${task.id}`)));
  shelf.switchSession("owner");
  assert.equal(shelf.accept(snapshot([task()])), true);
  assert.equal(shelf.accept(snapshot([task()], "owner", "compatible-publisher")), true);
  assert.deepEqual(shelf.snapshot().map(item => `${item.source}/${item.id}`), ["pi-subagents/run-1", "compatible-publisher/run-1"]);

  assert.equal(shelf.accept(snapshot([task("updated")], "owner", "pi-subagents")), true);
  assert.deepEqual(shelf.snapshot().map(item => `${item.source}/${item.id}`), ["pi-subagents/updated", "compatible-publisher/run-1"]);
  assert.equal(shelf.accept(snapshot([], "owner", "pi-subagents")), true);
  assert.deepEqual(shelf.snapshot().map(item => `${item.source}/${item.id}`), ["compatible-publisher/run-1"]);

  assert.equal(shelf.accept(snapshot([task("foreign")], "other", "compatible-publisher")), false);
  assert.equal(shelf.accept({ ...snapshot([], "owner", "compatible-publisher"), source: "" }), false);
  assert.deepEqual(shelf.snapshot().map(item => item.id), ["run-1"]);
  shelf.switchSession("next");
  assert.deepEqual(shelf.snapshot(), []);
  assert.equal(shelf.accept(snapshot([task()], "owner")), false);
  shelf.clear();
  assert.deepEqual(changes.at(-1), []);
});

test("shelf bounds publishers and aggregate rows while sharing display capacity", () => {
  const shelf = new BackgroundTaskShelf(() => {});
  shelf.switchSession("owner");
  for (let i = 0; i < 20; i++) shelf.accept(snapshot([task(`run-${i}`)], "owner", `publisher-${i}`));
  assert.equal(shelf.snapshot().length, 16);

  shelf.switchSession("owner");
  assert.equal(shelf.accept(snapshot(Array.from({ length: 80 }, (_, i) => task(`bulk-${i}`)), "owner", "bulk")), true);
  assert.equal(shelf.accept(snapshot([task("peer")], "owner", "peer")), true);
  const tasks = shelf.snapshot();
  assert.equal(tasks.length, 64);
  assert(tasks.some(item => item.source === "peer" && item.id === "peer"));
});

test("shelf bounds aggregate retained transcript memory across publishers", () => {
  const shelf = new BackgroundTaskShelf(() => {});
  shelf.switchSession("owner");
  for (let source = 0; source < 16; source++) {
    shelf.accept(snapshot(Array.from({ length: 64 }, (_, i) => ({
      ...task(`run-${source}-${i}`), transcript: "x".repeat(BACKGROUND_TASK_TRANSCRIPT_MAX_CHARS),
    })), "owner", `publisher-${source}`));
  }
  const retained = shelf.snapshot().reduce((total, item) => total + (item.transcript?.length ?? 0), 0);
  assert(retained <= BACKGROUND_TASK_TRANSCRIPT_AGGREGATE_CHARS);
});

test("click details append the bounded task and full available transcript after publisher detail", () => {
  const parsed = parseBackgroundTaskSnapshot(snapshot([{ ...task(), name: "reviewer", task: "Inspect the parser", transcript: "you: inspect\nagent: checking", usagePartial: true }]), "owner")!.tasks[0]!;
  const details = backgroundTaskDetails(parsed);
  assert.match(details, /Source: pi-subagents/);
  assert.match(details, /State: active/);
  assert.match(details, /Run: run-1/);
  assert.match(details, /Usage \(partial\): input 1\.2k/);
  assert.match(details, /Cost: \$0\.04/);
  assert.match(details, /Native session: child/);
  assert.match(details, /Native session: child[\s\S]*\nTask:\nInspect the parser\n\nTranscript:\nyou: inspect\nagent: checking$/);
  assert.doesNotMatch(details, /Outcome:|Stop|Resume/);

  const unusualSource = parseBackgroundTaskSnapshot(snapshot([task()], "owner", "publisher\nname"), "owner")!.tasks[0]!;
  assert.match(backgroundTaskDetails(unusualSource), /^Source: publisher name\n/);
});
