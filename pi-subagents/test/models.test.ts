import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  InMemoryCredentialStore, createAssistantMessageEventStream, getCurrentTools,
  type Api, type Model, type StreamOptions, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AgentSession, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderBridge } from "../src/models.ts";
import { prepareNative, INSPECT_TOOLS, type NativeOptions } from "../src/session.ts";
import { loadProfiles } from "../src/agents.ts";
import { FileArtifacts } from "../src/artifacts.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunManager } from "../src/runs.ts";
import { temp } from "./helpers.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const definition = { id: "test/with-slash", name: "Fixture", reasoning: false, input: ["text"] as ["text"], cost, contextWindow: 64000, maxTokens: 2048 };
const name = "fixture/test/with-slash";
function response(model: Model<Api>, text = "Bridge report", transient = false) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = {
      role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
      content: transient ? [] : [{ type: "text" as const, text }],
      usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost },
      stopReason: transient ? "error" as const : "stop" as const, timestamp: Date.now(),
      ...(transient ? { errorMessage: "503 Service Unavailable" } : {}),
    };
    stream.push({ type: "start", partial: message });
    if (transient) stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}
async function fixture(t: Parameters<typeof temp>[0]) {
  const root = await temp(t), cwd = path.join(root, "repo"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const credentials = new InMemoryCredentialStore();
  const parent = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
  let registry = new ModelRegistry(parent);
  const bridge = await ProviderBridge.create(() => registry);
  let calls = 0;
  let handler = (model: Model<Api>, _context: TranscriptContext, _options?: SimpleStreamOptions) => response(model);
  const register = (text = "Bridge report", apiKey: string | null = "fake-only") => {
    handler = model => response(model, text);
    registry.registerProvider("fixture", {
      api: "openai-completions", baseUrl: "http://invalid.test", apiKey: apiKey ?? undefined,
      models: [definition], streamSimple: (model, context, options) => { calls++; return handler(model, context, options); },
    });
  };
  register();
  bridge.ensure("fixture");
  const profiles = await loadProfiles(agentDir, cwd, true);
  let scope = [name];
  const options: NativeOptions = {
    agentDir, cwd, workspace: cwd, runtime: bridge.runtime, checkAuth: bridge.checkAuth,
    task: { agent: "reviewer", task: "ONLY_CHILD_BRIEF" }, profile: profiles.get("reviewer")!,
    agentModel: name, agentThinking: "off", scopedModels: () => scope,
  };
  const manager = new RunManager({ owner: "fixture-owner", config: { ...DEFAULT_CONFIG }, store: new FileArtifacts(path.join(root, "runs")) });
  t.after(() => manager.shutdown());
  const run = async () => {
    const [id] = await manager.launch([prepareNative(options)]);
    await manager.settled(id!);
    const record = manager.status(id!);
    assert.equal(record.state, "completed", record.error ?? "missing error");
    return readFile(record.reportPath!, "utf8");
  };
  return { root, credentials, parent, bridge, registry, options, manager, run, register,
    setScope(value: string[]) { scope = value; }, setRegistry(value: ModelRegistry) { registry = value; },
    setHandler(value: typeof handler) { handler = value; }, calls: () => calls };
}

test("bridge: real separate SDK runtime, fixed tools, literal child context, no copied credentials", async t => {
  const f = await fixture(t);
  assert.notEqual(f.bridge.runtime, f.parent);
  f.setHandler((model, context) => {
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), [...INSPECT_TOOLS].sort());
    assert.equal(context.messages.filter(message => message.role === "user").length, 1);
    assert(JSON.stringify(context.messages).includes("ONLY_CHILD_BRIEF"));
    return response(model);
  });
  assert.match(await f.run(), /Bridge report/);
  assert.deepEqual(await f.bridge.runtime.listCredentials(), []);
  assert.deepEqual((await f.bridge.runtime.getAuth("fixture"))?.auth, {});
  assert.equal(f.calls(), 1);
});

test("bridge: registration, replacement, removal and late registration stay live without recreating runtime", async t => {
  const f = await fixture(t), runtime = f.bridge.runtime;
  assert.match(await f.run(), /Bridge report/);
  f.register("Replacement report");
  assert.match(await f.run(), /Replacement report/);
  f.registry.unregisterProvider("fixture");
  assert.throws(() => prepareNative(f.options), /unavailable/);
  f.register("Late report");
  assert.match(await f.run(), /Late report/);
  assert.equal(f.bridge.runtime, runtime);
  // The adapter does not capture a stale registry wrapper either.
  const other = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  f.setRegistry(new ModelRegistry(other));
  assert.throws(() => prepareNative(f.options), /unavailable/);
});

test("bridge: native providers keep live catalogs, auth endpoints/headers/env, options and abort signals", async t => {
  const f = await fixture(t);
  let models: Model<Api>[] = [{ ...definition, api: "fixture-api", provider: "fixture", baseUrl: "http://catalog.invalid" }];
  let refreshes = 0;
  let key = "fake-first";
  const signal = new AbortController().signal;
  const onPayload = () => {};
  const stream = (model: Model<Api>, _context: TranscriptContext, options?: StreamOptions) => {
    assert.equal(model.baseUrl, "http://auth.invalid");
    assert.equal(options?.apiKey, key);
    assert.equal(options?.headers?.["x-auth"], "auth-value");
    assert.equal(options?.headers?.["x-child"], "child-value");
    assert.equal(options?.env?.FIXTURE_ENV, "scoped-value");
    assert.equal(options?.signal, signal);
    assert.equal(options?.onPayload, onPayload);
    return response(model);
  };
  f.registry.registerProvider({
    id: "fixture", name: "Native fixture", getModels: () => models,
    refreshModels: async () => { refreshes++; },
    auth: { apiKey: { name: "Native auth", check: async () => ({ type: "api_key" }),
      resolve: async () => ({ auth: { apiKey: key, baseUrl: "http://auth.invalid", headers: { "x-auth": "auth-value" } }, env: { FIXTURE_ENV: "scoped-value" } }),
    } }, streamSimple: stream, stream,
  });
  await f.parent.refresh({ allowNetwork: false, providers: ["fixture"] });
  const before = refreshes;
  const model = f.bridge.runtime.getPhysicalModel("fixture", definition.id)!;
  for (const method of ["streamSimple", "stream"] as const) {
    const result = await f.bridge.runtime[method](model, { messages: [] }, { signal, onPayload, headers: { "x-child": "child-value" } }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage ?? "missing error");
    key = "fake-rotated";
  }
  assert.equal(refreshes, before, "child requests never schedule parent catalog refresh");
  models = [];
  assert.throws(() => prepareNative(f.options), /unavailable/);
});

test("bridge: parent runtime-only keys rotate and disappear without child key seeding", async t => {
  const f = await fixture(t);
  f.registry.unregisterProvider("fixture");
  f.register("Runtime auth", null);
  await assert.rejects(async () => { await prepareNative(f.options).validate!(); }, /configured authentication or credential permissions/);
  await f.parent.setRuntimeApiKey("fixture", "fake-runtime-key");
  f.setHandler((model, _context, options) => {
    assert.equal(options?.apiKey, "fake-runtime-key");
    return response(model);
  });
  assert.match(await f.run(), /Bridge report/);
  assert.deepEqual(await f.bridge.runtime.listCredentials(), []);
  await f.parent.removeRuntimeApiKey("fixture");
  await assert.rejects(async () => { await prepareNative(f.options).validate!(); }, /configured authentication or credential permissions/);
});

test("bridge: validation diagnoses provider removal during an auth check as unavailable", async t => {
  const f = await fixture(t);
  const plan = prepareNative({ ...f.options, checkAuth: async () => {
    f.registry.unregisterProvider("fixture");
    return false;
  } });
  await assert.rejects(async () => { await plan.validate(); }, /Exact native model .* is unavailable/);
});

test("bridge: one auth validation per admission and startup phase", async t => {
  const f = await fixture(t);
  let checks = 0;
  const plan = prepareNative({ ...f.options, checkAuth: async (model, signal) => {
    checks++;
    return f.bridge.checkAuth(model, signal);
  } });
  const [id] = await f.manager.launch([plan]);
  await f.manager.settled(id!);
  assert.equal(f.manager.status(id!).state, "completed");
  assert.equal(checks, 2);
});

test("bridge: model metadata changes cannot mix an old endpoint with new provider auth", async t => {
  const f = await fixture(t);
  const admitted = structuredClone(f.bridge.runtime.getPhysicalModel("fixture", definition.id)!);
  f.registry.registerProvider("fixture", { baseUrl: "http://replacement.invalid" });
  const result = await f.bridge.runtime.streamSimple(admitted, { messages: [] }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /changed during this attempt/);
  assert.equal(f.calls(), 0);
  assert.match(await f.run(), /Bridge report/, "the next attempt uses current metadata");
});

test("bridge: virtual selections and virtual replacement during an active attempt fail closed", async t => {
  const f = await fixture(t);
  f.registry.registerVirtualModel({ provider: "fixture", id: "virtual", name: "Virtual", route: async () => { throw new Error("MUST_NOT_ROUTE"); } });
  assert.throws(() => prepareNative({ ...f.options, agentModel: "fixture/virtual" }), /unavailable/);
  const admitted = f.bridge.runtime.getPhysicalModel("fixture", definition.id)!;
  f.registry.unregisterProvider("fixture");
  f.registry.registerVirtualModel({ provider: "fixture", id: definition.id, name: "Replaced", route: async () => { throw new Error("MUST_NOT_ROUTE"); } });
  const result = await f.bridge.runtime.streamSimple(admitted, { messages: [] }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /unavailable/);
  assert(!result.errorMessage!.includes("MUST_NOT_ROUTE"));
  assert.equal(f.calls(), 0);
});

test("bridge: OAuth refresh remains serialized in the parent credential store", async t => {
  const f = await fixture(t);
  f.registry.unregisterProvider("fixture");
  await f.credentials.modify("fixture", async () => ({ type: "oauth", access: "fake-expired", refresh: "fake-refresh", expires: 0 }));
  let refreshes = 0;
  const stream = (model: Model<Api>, _context: TranscriptContext, options?: StreamOptions) => {
    assert.equal(options?.apiKey, "fake-refreshed");
    return response(model);
  };
  f.registry.registerProvider({
    id: "fixture", name: "OAuth fixture",
    getModels: () => [{ ...definition, provider: "fixture", api: "fixture-api", baseUrl: "http://invalid.test" }],
    auth: { oauth: {
      name: "OAuth fixture", login: async () => { throw new Error("Do not log in from a child"); },
      refresh: async credential => { refreshes++; return { ...credential, access: "fake-refreshed", expires: Date.now() + 3600000 }; },
      toAuth: async credential => ({ apiKey: credential.access }),
    } }, stream, streamSimple: stream,
  });
  const model = f.bridge.runtime.getPhysicalModel("fixture", definition.id)!;
  assert(await f.bridge.checkAuth(model));
  const responses = await Promise.all([1, 2].map(() => f.bridge.runtime.streamSimple(model, { messages: [] }).result()));
  assert(responses.every(message => message.stopReason === "stop"), JSON.stringify(responses));
  assert.equal(refreshes, 1, "two children share the parent's OAuth refresh lock");
  assert.deepEqual(await f.bridge.runtime.listCredentials(), []);
});

test("bridge: legacy in-memory refreshed catalogs are visible without child refresh jobs", async t => {
  const f = await fixture(t);
  let refreshes = 0;
  f.registry.registerProvider("fixture", {
    ...f.registry.getRegisteredProviderConfig("fixture")!,
    refreshModels: async () => { refreshes++; return [{ ...definition, id: "refreshed" }]; },
  });
  await f.parent.refresh({ allowNetwork: true, providers: ["fixture"] });
  const before = refreshes;
  assert(f.bridge.runtime.getPhysicalModel("fixture", "refreshed"));
  assert.equal(f.bridge.runtime.getPhysicalModel("fixture", definition.id), undefined);
  const result = await f.bridge.runtime.streamSimple(f.bridge.runtime.getPhysicalModel("fixture", "refreshed")!, { messages: [] }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(refreshes, before);
});

test("bridge: native SDK compaction and subsequent turns use the same provider transport", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.options.agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 },
  }));
  let native!: AgentSession;
  const observe = (session: AgentSession) => { native = session; };
  const original = AgentSession.prototype.bindExtensions;
  let subAgent: Awaited<ReturnType<ReturnType<typeof prepareNative>["start"]>> | undefined;
  try {
    AgentSession.prototype.bindExtensions = function (bindings) { observe(this); return original.call(this, bindings); };
    subAgent = await prepareNative(f.options).start({
      signal: new AbortController().signal, directory: path.join(f.root, "compact"),
      own() {}, progress() {}, preview() {}, transcript() {}, ask: async () => "answer",
    });
  } finally { AgentSession.prototype.bindExtensions = original; }
  try {
    await subAgent!.prompt();
    await native.compact();
    await subAgent!.prompt("Continue the bounded task");
    assert(f.calls() >= 3, "normal turns and compaction all traverse the parent provider");
  } finally { await subAgent?.dispose(); }
});

test("bridge: prepared batch revalidates policy before allocating runs or consuming budget", async t => {
  const f = await fixture(t);
  const prepared = prepareNative(f.options);
  f.setScope(["different/model"]);
  await assert.rejects(f.manager.launch([prepared]), /outside the agent's model scope/);
  assert.equal(f.manager.list().length, 0);
  assert.equal(f.calls(), 0);
  f.setScope([name]);
  assert.match(await f.run(), /Bridge report/);
});

for (const change of ["scope", "provider", "auth", "thinking"] as const) {
  test(`bridge: resume revalidates ${change} before mutating transcript or spending allowance`, async t => {
    const f = await fixture(t);
    f.setHandler(model => response(model, "", true));
    const [id] = await f.manager.launch([prepareNative(f.options)]);
    await f.manager.settled(id!);
    const before = f.manager.status(id!);
    assert.equal(before.resume?.eligible, true, before.error ?? "missing error");
    const transcript = await readFile(before.sessionPath!, "utf8");
    if (change === "scope") f.setScope(["different/model"]);
    if (change === "provider") f.registry.unregisterProvider("fixture");
    if (change === "auth") {
      f.registry.unregisterProvider("fixture"); f.register("No auth", null);
    }
    if (change === "thinking") f.registry.registerProvider("fixture", {
      api: "openai-completions", baseUrl: "http://invalid.test", models: [{ ...definition, reasoning: true, thinkingLevelMap: { off: null } }],
    });
    await assert.rejects(f.manager.resume(id!), change === "scope" ? /scope/ : change === "provider" ? /unavailable/ : change === "auth" ? /authentication/ : /unsupported/);
    assert.deepEqual(f.manager.status(id!), before);
    assert.equal(await readFile(before.sessionPath!, "utf8"), transcript);
    assert.equal(f.calls(), 1);
  });
}
