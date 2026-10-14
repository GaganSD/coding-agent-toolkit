import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileArtifacts } from "../src/artifacts.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { loadProfiles } from "../src/agents.ts";
import { RunManager } from "../src/runs.ts";
import { prepareNative, type NativeOptions } from "../src/session.ts";
import { presentNotice, presentSummary } from "../src/tool.ts";
import { MemoryStore, plan, temp, waitForAbort } from "./helpers.ts";
import type { PreparedTask } from "../src/types.ts";

function setup(options: ConstructorParameters<typeof RunManager>[0] extends infer T ? Partial<T> : never = {}) {
  const store = new MemoryStore();
  const manager = new RunManager({ owner: "test-agent", config: { ...DEFAULT_CONFIG }, store, ...options });
  return { manager, store };
}

function transient(starts: { count: number }, workspace = "/repo", mode: "inspect" | "edit" = "inspect"): PreparedTask {
  return plan(undefined, {
    mode, agent: mode === "edit" ? "worker" : "reviewer", workspace, cwd: workspace,
    async start(context, options) {
      starts.count++;
      if (options?.resumeFrom && !options.resumeFrom.sessionPath.endsWith("test.jsonl")) {
        throw new Error(`resume opened the wrong transcript: ${options.resumeFrom.sessionPath}`);
      }
      context.transcript(context.directory + "/transcript/test.jsonl");
      const current = starts.count;
      return {
        prompt: async () => {
          if (current === 1) throw new Error("503 Service Unavailable");
          return { report: `recovered-${current}`, toolErrors: 0 };
        },
        steer: async () => "queued", abort: async () => {},
        failure: () => current === 1 ? { kind: "transient_provider" as const } : undefined,
        dispose() {},
      };
    },
  });
}

test("1 startup failure without a transcript cannot be resumed", async () => {
  const { manager } = setup();
  let starts = 0;
  const [id] = await manager.launch([plan(undefined, {
    async start() {
      starts++;
      throw new Error("503 Service Unavailable");
    },
  })]);
  await manager.settled(id!);
  const failed = manager.status(id!);
  assert.equal(failed.state, "failed");
  assert.equal(failed.sessionPath, undefined);
  assert.equal(failed.resume?.eligible, false);
  await assert.rejects(manager.resume(id!), /failed transient provider/);
  assert.equal(starts, 1);
});

test("2 unclassified errors stay ineligible even with a transcript", async () => {
  const { manager } = setup();
  let starts = 0;
  const [id] = await manager.launch([plan(undefined, {
    async start(context) {
      starts++;
      context.transcript(context.directory + "/transcript/test.jsonl");
      return {
        prompt: async () => { throw new Error("503 Service Unavailable"); },
        steer: async () => "queued", abort: async () => {},
        dispose() {},
      };
    },
  })]);
  await manager.settled(id!);
  assert.equal(manager.status(id!).sessionPath?.endsWith("test.jsonl"), true);
  assert.equal(manager.status(id!).resume?.eligible, false);
  await assert.rejects(manager.resume(id!), /failed transient provider/);
  assert.equal(starts, 1);
});

test("3 stop on a failed eligible run is a no-op and does not block resume", async () => {
  const { manager } = setup();
  const starts = { count: 0 };
  const [id] = await manager.launch([transient(starts)]);
  await manager.settled(id!);
  await manager.stop(id!);
  assert.equal(manager.status(id!).state, "failed");
  assert.equal(manager.status(id!).resume?.eligible, true);
  await manager.resume(id!);
  await manager.settled(id!);
  assert.equal(manager.status(id!).state, "completed");
  assert.equal(starts.count, 2);
});

test("4 steer and reply on a failed eligible run cannot start work", async () => {
  const { manager } = setup();
  const starts = { count: 0 };
  const [id] = await manager.launch([transient(starts)]);
  await manager.settled(id!);
  await assert.rejects(manager.steer(id!, "keep going"), /Steer requires a running sub-agent/);
  await assert.rejects(manager.reply(id!, "missing", "x"), /No matching pending question/);
  assert.equal(starts.count, 1);
  assert.equal(manager.status(id!).state, "failed");
  assert.equal(manager.status(id!).resume?.eligible, true);
});

test("5 shutdown then resume must not start and must stay closed", async () => {
  const { manager } = setup();
  const starts = { count: 0 };
  const [id] = await manager.launch([transient(starts)]);
  await manager.settled(id!);
  await manager.shutdown();
  await assert.rejects(manager.resume(id!), /runtime is closed/);
  assert.equal(starts.count, 1);
  assert.equal(manager.status(id!).state, "failed");
});

test("6 a cleanup-unknown neighbor keeps the workspace reserved against resume", async () => {
  const { manager } = setup();
  const starts = { count: 0 };
  const [failedId] = await manager.launch([transient(starts, "/repo-a", "edit")]);
  await manager.settled(failedId!);
  const [poisoned] = await manager.launch([plan(undefined, {
    mode: "inspect", agent: "reviewer", workspace: "/repo-a/child", cwd: "/repo-a/child",
    async start() {
      return {
        prompt: async () => ({ report: "x", toolErrors: 0 }),
        steer: async () => "queued", abort: async () => {},
        dispose() { throw new Error("dispose failed"); },
      };
    },
  })]);
  await manager.settled(poisoned!);
  assert.equal(manager.status(poisoned!).state, "cleanup_unknown");
  await assert.rejects(manager.resume(failedId!), /unknown cleanup|Conflicting delegated workspaces|runtime is closed|Restart Pi/);
  assert.equal(starts.count, 1);
});

test("7 concurrent resumes of two failed writers in one workspace start only one", async () => {
  const { manager } = setup();
  const aStarts = { count: 0 }, bStarts = { count: 0 };
  const [a] = await manager.launch([transient(aStarts, "/shared", "edit")]);
  await manager.settled(a!);
  const [b] = await manager.launch([transient(bStarts, "/shared", "edit")]);
  await manager.settled(b!);
  const results = await Promise.allSettled([manager.resume(a!), manager.resume(b!)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  await Promise.allSettled([manager.settled(a!), manager.settled(b!)]);
  const states = [manager.status(a!).state, manager.status(b!).state];
  assert.equal(states.filter(state => state === "completed").length, 1);
  assert.equal(states.filter(state => state === "failed").length, 1);
  assert.equal(aStarts.count + bStarts.count, 3);
});

test("8 a thrown resume start must not stay starting or count as success", async () => {
  const { manager } = setup();
  let starts = 0;
  const [id] = await manager.launch([plan(undefined, {
    async start(context, options) {
      starts++;
      context.transcript(context.directory + "/transcript/test.jsonl");
      if (options?.resumeFrom) throw new Error("ENOENT: transcript missing");
      return {
        prompt: async () => { throw new Error("503 Service Unavailable"); },
        steer: async () => "queued", abort: async () => {},
        failure: () => ({ kind: "transient_provider" as const }),
        dispose() {},
      };
    },
  })]);
  await manager.settled(id!);
  await assert.doesNotReject(manager.resume(id!));
  await manager.settled(id!);
  const after = manager.status(id!);
  assert.equal(after.state, "failed");
  assert.match(after.error ?? "", /transcript missing/);
  assert.equal(after.resume?.eligible, false);
  assert.equal(starts, 2);
  await assert.rejects(manager.resume(id!), /allowance exhausted|failed transient provider/);
});

test("9 failed runs do not occupy concurrency; a live neighbor can still block the last slot", async t => {
  const { manager } = setup({ config: { ...DEFAULT_CONFIG, maxConcurrent: 1 } });
  t.after(() => manager.shutdown());
  const starts = { count: 0 };
  const [failedId] = await manager.launch([transient(starts, "/repo-a")]);
  await manager.settled(failedId!);
  assert.equal(manager.activeCount, 0);
  await manager.resume(failedId!);
  await manager.settled(failedId!);
  assert.equal(starts.count, 2);
  const again = { count: 0 };
  const [otherFailed] = await manager.launch([transient(again, "/repo-b")]);
  await manager.settled(otherFailed!);
  const [live] = await manager.launch([plan(waitForAbort, { workspace: "/repo-c", cwd: "/repo-c" })]);
  await assert.rejects(manager.resume(otherFailed!), /Concurrent sub-agent limit/);
  assert.equal(again.count, 1);
  await manager.stop(live!);
});

test("10 notice/list hide exhausted resume; a new manager cannot revive artifacts", async () => {
  const { manager, store } = setup();
  const [id] = await manager.launch([plan(undefined, {
    async start(context) {
      context.transcript(context.directory + "/transcript/test.jsonl");
      return {
        prompt: async () => { throw new Error("503 Service Unavailable"); },
        steer: async () => "queued", abort: async () => {},
        failure: () => ({ kind: "transient_provider" as const }),
        dispose() {},
      };
    },
  })]);
  await manager.settled(id!);
  const eligible = manager.status(id!);
  assert.deepEqual(presentSummary(eligible).resume, { eligible: true, attempts: 0, maxAttempts: 3 });
  assert.equal(presentNotice(eligible).resume?.eligible, true);
  for (let i = 0; i < 3; i++) {
    await manager.resume(id!);
    await manager.settled(id!);
  }
  const exhausted = manager.status(id!);
  assert.equal(exhausted.resume?.eligible, false);
  assert.equal(presentSummary(exhausted).resume, undefined);
  assert.equal(presentNotice(exhausted).resume, undefined);
  const other = new RunManager({ owner: "test-agent", config: { ...DEFAULT_CONFIG }, store });
  await assert.rejects(other.resume(id!), /Unknown run ID/);
});

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function response(model: Model<Api>, content: AssistantMessage["content"], stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop", errorMessage = "503 Service Unavailable"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content, usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { ...zero } },
    stopReason, timestamp: Date.now(), ...(stopReason === "error" ? { errorMessage } : {}),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
    else stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

test("bonus: deleting the native transcript cannot complete a resume", async t => {
  const root = await temp(t);
  const cwd = path.join(root, "repo"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "catalog.json"), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider("fixture", {
    api: "openai-completions", baseUrl: "http://invalid.test", apiKey: "fixture-not-a-secret",
    models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], cost: zero, contextWindow: 64000, maxTokens: 2048 }],
    streamSimple: model => {
      calls++;
      if (calls === 1) return response(model, [], "error", "503 Service Unavailable");
      return response(model, [{ type: "text", text: "should not complete after a missing transcript" }]);
    },
  });
  const profiles = await loadProfiles(agentDir, cwd, true);
  const options: NativeOptions = {
    agentDir, cwd, workspace: cwd, runtime, task: { agent: "reviewer", task: "Review fixture" },
    profile: profiles.get("reviewer")!, agentModel: "fixture/test", agentThinking: "off", scopedModels: [],
  };
  const manager = new RunManager({ owner: "fixture-owner", config: { ...DEFAULT_CONFIG }, store: new FileArtifacts(path.join(root, "runs")) });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([prepareNative(options)]);
  await manager.settled(id!);
  const failed = manager.status(id!);
  assert.equal(failed.state, "failed");
  assert.equal(failed.resume?.eligible, true);
  await rm(failed.sessionPath!);
  await manager.resume(id!).catch(() => {});
  await manager.settled(id!);
  const after = manager.status(id!);
  assert.equal(after.state, "failed", after.error ?? after.state);
  assert.match(after.error ?? "", /saved transcript; it is missing/);
  assert.equal(after.resume?.eligible, false);
  assert.equal(calls, 1, "missing transcript must not prompt the model");
});

async function nativeFailed(t: Parameters<typeof temp>[0], onCall?: (n: number, model: Model<Api>) => AssistantMessageEventStream) {
  const root = await temp(t);
  const cwd = path.join(root, "repo"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "catalog.json"), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider("fixture", {
    api: "openai-completions", baseUrl: "http://invalid.test", apiKey: "fixture-not-a-secret",
    models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], cost: zero, contextWindow: 64000, maxTokens: 2048 }],
    streamSimple: model => {
      calls++;
      return onCall?.(calls, model) ?? (calls === 1
        ? response(model, [], "error", "503 Service Unavailable")
        : response(model, [{ type: "text", text: "should not complete a broken resume" }]));
    },
  });
  const profiles = await loadProfiles(agentDir, cwd, true);
  const options: NativeOptions = {
    agentDir, cwd, workspace: cwd, runtime, task: { agent: "reviewer", task: "Review fixture" },
    profile: profiles.get("reviewer")!, agentModel: "fixture/test", agentThinking: "off", scopedModels: [],
  };
  const manager = new RunManager({ owner: "fixture-owner", config: { ...DEFAULT_CONFIG }, store: new FileArtifacts(path.join(root, "runs")) });
  t.after(() => manager.shutdown());
  const [id] = await manager.launch([prepareNative(options)]);
  await manager.settled(id!);
  const failed = manager.status(id!);
  assert.equal(failed.state, "failed", failed.error ?? failed.state);
  assert.equal(failed.resume?.eligible, true);
  assert(failed.sessionPath);
  assert(failed.sessionId);
  return { calls: () => calls, failed, id: id!, manager, options };
}

async function resumeSettled(manager: RunManager, id: string) {
  await manager.resume(id).catch(() => {});
  await manager.settled(id);
  return manager.status(id);
}

test("11 empty transcript cannot complete a resume", async t => {
  const f = await nativeFailed(t);
  await writeFile(f.failed.sessionPath!, "");
  const after = await resumeSettled(f.manager, f.id);
  assert.equal(after.state, "failed", after.error ?? after.state);
  assert.match(after.error ?? "", /saved transcript; it is missing/);
  assert.equal(f.calls(), 1);
});

test("12 a directory at the transcript path cannot complete a resume", async t => {
  const f = await nativeFailed(t);
  await rm(f.failed.sessionPath!);
  await mkdir(f.failed.sessionPath!);
  const after = await resumeSettled(f.manager, f.id);
  assert.equal(after.state, "failed", after.error ?? after.state);
  assert.match(after.error ?? "", /saved transcript; it is missing/);
  assert.equal(f.calls(), 1);
});

test("13 garbage transcript cannot complete a resume", async t => {
  const f = await nativeFailed(t);
  await writeFile(f.failed.sessionPath!, "not-a-pi-session\n{broken\n");
  const after = await resumeSettled(f.manager, f.id);
  assert.equal(after.state, "failed", after.error ?? after.state);
  assert.notEqual(after.state, "completed");
  assert.equal(f.calls(), 1);
});

test("14 swapping another run's transcript cannot complete a resume", async t => {
  const a = await nativeFailed(t);
  const b = await nativeFailed(t);
  await copyFile(b.failed.sessionPath!, a.failed.sessionPath!);
  const after = await resumeSettled(a.manager, a.id);
  assert.equal(after.state, "failed", after.error ?? after.state);
  assert.match(after.error ?? "", /session identity changed/);
  assert.equal(a.calls(), 1);
});

test("15 resume without a native session id cannot open a replacement transcript", async t => {
  const a = await nativeFailed(t);
  const b = await nativeFailed(t);
  await copyFile(b.failed.sessionPath!, a.failed.sessionPath!);
  await assert.rejects(prepareNative(a.options).start({
    signal: new AbortController().signal,
    directory: path.join(path.dirname(a.failed.sessionPath!), "orphan"),
    own() {}, progress() {}, preview() {}, transcript() {},
    ask: async () => "no",
  }, { resumeFrom: { sessionPath: a.failed.sessionPath!, launchHead: a.failed.launchHead } }), /native session identity/);
  assert.equal(a.calls(), 1);
});

test("16 unreadable transcript cannot complete a resume", async t => {
  const f = await nativeFailed(t);
  await chmod(f.failed.sessionPath!, 0);
  t.after(() => chmod(f.failed.sessionPath!, 0o600).catch(() => {}));
  const after = await resumeSettled(f.manager, f.id);
  assert.equal(after.state, "failed", after.error ?? after.state);
  assert.notEqual(after.state, "completed");
  assert.equal(f.calls(), 1);
});
