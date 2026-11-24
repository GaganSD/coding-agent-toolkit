import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunManager, type ManagerOptions } from "../src/runs.ts";
import type { RunRecord, SubAgentResult } from "../src/types.ts";
import { deferred, MemoryStore, plan, until, waitForAbort } from "./helpers.ts";

function setup(options: Partial<ManagerOptions> = {}) {
  const notices: { record: RunRecord; kind: string; finished: RunRecord[] }[] = [];
  const manager = new RunManager({ owner: "batch-owner", config: { ...DEFAULT_CONFIG }, store: new MemoryStore(),
    notify: async (record, kind, finished) => { notices.push({ record, kind, finished }); }, ...options });
  return { manager, notices };
}
const result = { report: "Unverified report", toolErrors: 0 };

test("four siblings publish immediately but wake once, in completion order", async () => {
  let changes = 0;
  const { manager, notices } = setup({ changed: () => { changes++; } });
  const gates = Array.from({ length: 4 }, () => deferred<SubAgentResult>());
  const ids = await manager.launch(gates.map(gate => plan(() => gate.promise)));
  const order = [2, 0, 3, 1];
  for (const index of order) {
    const before = changes;
    gates[index]!.resolve(result);
    await manager.settled(ids[index]!);
    assert.equal(manager.status(ids[index]!).state, "completed");
    assert(changes > before, "per-run UI updates are not buffered");
    assert.equal(notices.length, index === 1 ? 1 : 0);
  }
  assert.deepEqual(notices[0]!.finished.map(run => run.id), order.map(index => ids[index]));
});

test("questions flush buffered siblings and later results cannot wait behind a pending answer", async () => {
  const { manager, notices } = setup();
  const questionGate = deferred<void>();
  const last = deferred<SubAgentResult>();
  const ids = await manager.launch([
    plan(),
    plan(async context => { await questionGate.promise; await context.ask("Untrusted question text"); return result; }),
    plan(() => last.promise),
  ]);
  await manager.settled(ids[0]!);
  assert.equal(notices.length, 0);
  questionGate.resolve();
  await until(() => notices.length === 1);
  assert.equal(notices[0]!.kind, "question");
  assert.deepEqual(notices[0]!.finished.map(run => run.id), [ids[0]]);
  last.resolve(result);
  await manager.settled(ids[2]!);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1]!.finished.map(run => run.id), [ids[2]]);
  const question = manager.status(ids[1]!).question!;
  await manager.reply(ids[1]!, question.id, "Answer");
  await manager.settled(ids[1]!);
  assert.equal(notices.length, 3);
  assert.deepEqual(notices[2]!.finished.map(run => run.id), [ids[1]]);
});

test("failed, stopped and timed-out siblings all settle the batch", async () => {
  for (const mode of ["stop", "timeout"] as const) {
    const { manager, notices } = setup({ config: { ...DEFAULT_CONFIG, timeoutMs: mode === "timeout" ? 30 : 1000 } });
    const ids = await manager.launch([
      plan(async () => { throw new Error("failed"); }), plan(waitForAbort),
    ]);
    await manager.settled(ids[0]!);
    assert.equal(notices.length, 0);
    if (mode === "stop") await manager.stop(ids[1]!);
    await manager.settled(ids[1]!);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0]!.finished.map(run => run.state), ["failed", "cancelled"]);
  }
});

test("cleanup_unknown retains capacity but does not block batch notices", async () => {
  const { manager, notices } = setup({ cleanupMs: 10 });
  const gate = deferred<SubAgentResult>();
  const ids = await manager.launch([
    plan(() => gate.promise),
    plan(undefined, { async start() { return new Promise(() => {}); } }),
  ]);
  await manager.stop(ids[1]!);
  await until(() => manager.status(ids[1]!).state === "cleanup_unknown");
  gate.resolve(result);
  await manager.settled(ids[0]!);
  await until(() => notices.length === 1);
  assert.equal(manager.activeCount, 1);
  assert.deepEqual(new Set(notices[0]!.finished.map(run => run.state)), new Set(["completed", "cleanup_unknown"]));
  await manager.shutdown();
});

test("resuming a failed member uses a singleton batch even while its original sibling is live", async () => {
  const { manager, notices } = setup();
  const sibling = deferred<SubAgentResult>();
  let starts = 0;
  const ids = await manager.launch([
    plan(undefined, { async start(context) {
      const attempt = ++starts;
      context.transcript(context.directory + "/session.jsonl");
      return {
        prompt: async () => { if (attempt === 1) throw new Error("503"); return result; },
        failure: () => attempt === 1 ? "transient_provider" : undefined,
        steer: async () => "queued", followUp: async () => "queued", abort: async () => {}, dispose() {},
      };
    } }),
    plan(() => sibling.promise),
  ]);
  await manager.settled(ids[0]!);
  assert.equal(notices.length, 0);
  await manager.resume(ids[0]!);
  await manager.settled(ids[0]!);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]!.finished.map(run => run.state), ["completed"]);
  sibling.resolve(result);
  await manager.settled(ids[1]!);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1]!.finished.map(run => run.state), ["failed", "completed"]);
});

test("teardown drops buffered results; a replacement owner receives only its own notices", async () => {
  const { manager, notices } = setup();
  const ids = await manager.launch([plan(), plan(waitForAbort)]);
  await manager.settled(ids[0]!);
  assert.equal(notices.length, 0);
  await manager.shutdown();
  assert.equal(notices.length, 0);
  const replacement = setup({ owner: "replacement" });
  const [id] = await replacement.manager.launch([plan()]);
  await replacement.manager.settled(id!);
  assert.equal(replacement.notices.length, 1);
  assert.equal(replacement.notices[0]!.record.owner, "replacement");
});

test("a stalled batch notification submission remains bounded", async () => {
  let submissions = 0;
  const { manager } = setup({ cleanupMs: 10, notify: async () => { submissions++; await new Promise(() => {}); } });
  const ids = await manager.launch([plan(), plan()]);
  await Promise.all(ids.map(id => manager.settled(id)));
  assert.equal(submissions, 1);
  assert(manager.list().some(run => run.notificationError?.includes("Notification submission deadline")));
  await manager.shutdown();
});
