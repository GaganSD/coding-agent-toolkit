import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { RunManager } from "../src/runs.ts";
import { wrapSession } from "../src/session.ts";
import { backgroundTaskSnapshot } from "../src/dashboard.ts";
import { OutputSchema, presentNotice, presentRun } from "../src/tool.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RunContext } from "../src/types.ts";
import { deferred, MemoryStore, plan, until } from "./helpers.ts";

const usage = (cost: number) => ({ input: 12, output: 3, cacheRead: 4, cacheWrite: 5, cost });
const sample = (context: RunContext, cost?: number) => context.telemetry!({ pid: process.pid,
  contextUsage: { tokens: 12, percent: 1, contextWindow: 1000 }, ...(cost === undefined ? {} : { usage: usage(cost) }) });

test("missing live accounting retains the last copied cumulative sample without a spurious update", async t => {
  const finish = deferred<void>();
  let context!: RunContext, changes = 0;
  const manager = new RunManager({ owner: "owner", config: DEFAULT_CONFIG, store: new MemoryStore(), changed: () => { changes++; } });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([plan(async ctx => { context = ctx; await finish.promise; return { report: "done", toolErrors: 0 }; })]);
  await until(() => !!context);
  sample(context, 0.42);
  const before = changes;
  sample(context);
  assert.equal(manager.status(id!).usage!.cost, 0.42);
  assert.equal(changes, before);
  sample(context, 0.52);
  assert.equal(manager.status(id!).usage!.cost, 0.52);
  finish.resolve(); await manager.settled(id!);
});

test("a successful prompt without result.usage does not erase live spend during report persistence", async t => {
  const store = new MemoryStore(), saving = deferred<void>();
  let reportStarted = false;
  store.report = async () => { reportStarted = true; await saving.promise; return "/report.md"; };
  const manager = new RunManager({ owner: "owner", config: DEFAULT_CONFIG, store });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([plan(async ctx => { sample(ctx, 0.42); return { report: "done", toolErrors: 0 }; })]);
  await until(() => reportStarted);
  assert.equal(manager.status(id!).usage!.cost, 0.42);
  saving.resolve(); await manager.settled(id!);
  assert.equal(manager.status(id!).usage!.cost, 0.42);
});

test("final evidence failure retains explicitly partial spend instead of claiming full measurement", async t => {
  const manager = new RunManager({ owner: "owner", config: DEFAULT_CONFIG, store: new MemoryStore() });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([plan(undefined, { start: async ctx => ({
    async prompt() { sample(ctx, 0.19); throw new Error("provider failed"); },
    evidence() { throw new Error("statistics unavailable"); },
    steer: async () => "queued", followUp: async () => "queued", abort: async () => {}, dispose() {},
  }) })]);
  await manager.settled(id!);
  const record = manager.status(id!);
  assert.equal(record.state, "failed"); assert.equal(record.usage!.cost, 0.19); assert.equal(record.usagePartial, true);
  for (const view of [presentRun(record), presentNotice(record)]) { assert.equal(view.usagePartial, true); assert(Check(OutputSchema, view)); }
  const totals = backgroundTaskSnapshot("owner", manager.list()).totals;
  assert.equal(totals.measuredRuns, 0); assert.equal(totals.partialRuns, 1); assert.equal(totals.usage!.cost, 0.19);
});

test("empty SDK accumulators are unknown, but an observed zero-cost zero-token response is measured", async () => {
  let assistantMessages = 0;
  const session = { sessionId: "native", subscribe: () => () => {}, dispose() {},
    getSessionStats: () => ({ assistantMessages, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
  } as unknown as AgentSession;
  const subAgent = wrapSession(session, "task", { signal: new AbortController().signal } as RunContext);
  assert.equal(subAgent.evidence!()!.usage, undefined);
  assistantMessages = 1;
  assert.deepEqual(subAgent.evidence!()!.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  await subAgent.dispose();
});

test("SDK context projection is reused and message_end never scans cumulative accounting", async () => {
  let listener!: AgentSessionEventListener, projections = 0, stats = 0;
  const session = { sessionId: "native", subscribe: (fn: AgentSessionEventListener) => { listener = fn; return () => {}; }, dispose() {},
    getContextUsage: () => { projections++; return { tokens: 12, percent: 1, contextWindow: 1000 }; },
    getSessionStats: () => { stats++; return { assistantMessages: 1, tokens: usage(0.04), cost: 0.04, contextUsage: session.getContextUsage() }; },
  };
  const subAgent = wrapSession(session as unknown as AgentSession, "task", {
    signal: new AbortController().signal, telemetry() {}, preview() {},
  } as unknown as RunContext);
  for (let i = 0; i < 10; i++) {
    listener({ type: "message_end", message: { role: "user", content: "tool-heavy fixture", timestamp: 0 } });
    await Promise.resolve();
  }
  assert.equal(stats, 0); assert.equal(projections, 10);
  listener({ type: "turn_end" } as Parameters<AgentSessionEventListener>[0]);
  await Promise.resolve();
  assert.equal(stats, 1); assert.equal(projections, 11, "the stats call already performed the only context projection");
  await subAgent.dispose();
});

test("verified resume replaces cumulative accounting, never sums attempts", async t => {
  let attempt = 0;
  const manager = new RunManager({ owner: "owner", config: DEFAULT_CONFIG, store: new MemoryStore() });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([plan(undefined, { start: async (ctx, resume) => {
    const current = ++attempt;
    if (resume) assert.equal(manager.status(id!).usage!.cost, 0.09, "preserved throughout startup");
    ctx.transcript("/session.jsonl");
    return { async prompt() { if (current === 1) throw new Error("503"); sample(ctx, 0.22); return { report: "done", toolErrors: 0 }; },
      failure: () => "transient_provider", evidence: () => ({ usage: usage(current === 1 ? 0.09 : 0.22), toolErrors: 0 }),
      steer: async () => "queued", followUp: async () => "queued", abort: async () => {}, dispose() {} };
  } })]);
  await manager.settled(id!); await manager.resume(id!); await manager.settled(id!);
  assert.equal(manager.status(id!).usage!.cost, 0.22);
  assert.equal(backgroundTaskSnapshot("owner", manager.list()).totals.usage!.cost, 0.22);
});

test("late accounting after cleanup_unknown notifies observers without a new state or finish notice", async t => {
  const finish = deferred<void>();
  let ready = false, changes = 0, notices = 0;
  const store = new MemoryStore();
  const manager = new RunManager({ owner: "owner", config: DEFAULT_CONFIG, store, cleanupMs: 10,
    changed: () => { changes++; }, notify: async () => { notices++; } });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([plan(undefined, { start: async ctx => ({
    async prompt() { sample(ctx, 0.09); ready = true; await finish.promise; return { report: "late", toolErrors: 0 }; },
    evidence: () => ({ usage: usage(0.22), toolErrors: 0 }),
    steer: async () => "queued", followUp: async () => "queued", abort: async () => {}, dispose() {},
  }) })]);
  await until(() => ready); await manager.stop(id!);
  assert.equal(manager.status(id!).state, "cleanup_unknown");
  await until(() => notices === 1); // stop() is bounded; the first finish notice can still be submitting.
  const before = changes, beforeNotices = notices;
  finish.resolve(); await manager.settled(id!);
  assert.equal(manager.status(id!).state, "cleanup_unknown"); assert.equal(manager.status(id!).usage!.cost, 0.22);
  assert(changes > before); assert.equal(notices, beforeNotices);
  assert.equal(store.records.get(id!)!.usage!.cost, 0.22);
});
