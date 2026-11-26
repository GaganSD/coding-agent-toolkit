import test from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { DESCRIPTION, OutputSchema, Parameters, parseRequest, presentNotice, presentRun, presentFinished, presentSummary } from "../src/tool.ts";
import { THINKING_LEVELS, type RunRecord } from "../src/types.ts";

test("accounting is additive, closed and host-only across all run presentations", () => {
  const run = { id: "r", agent: "worker", task: "task", state: "completed", elapsedMs: 1234,
    usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.04 },
    error: "PRIVATE ERROR", question: { id: "q", message: "PRIVATE QUESTION" } } as RunRecord;
  for (const present of [presentNotice, presentRun, presentFinished, presentSummary]) {
    const view = present(run);
    assert.equal(view.elapsedMs, 1234);
    assert.deepEqual(view.usage, run.usage);
    assert(Check(OutputSchema, present === presentSummary ? { runs: [view] } : view));
    assert.equal(present({ ...run, usage: undefined }).usage, undefined);
  }
  const notice = presentNotice(run);
  assert(!JSON.stringify(notice).includes("PRIVATE"));
  assert(!Check(OutputSchema, { ...notice, usage: { ...run.usage, secret: 1 } }));
  assert(!Check(OutputSchema, { ...notice, usage: { ...run.usage, cost: -1 } }));
  assert(!Check(OutputSchema, { ...notice, elapsedMs: -1 }));
});

const task = { mode: "edit", task: "Implement the approved change" };
const valid = [
  { action: "run", tasks: [task] },
  { action: "run", tasks: Array(4).fill(task) },
  { action: "run", tasks: [{ task: "Review", template: "security-reviewer" }] },
  { action: "run", tasks: [{ task: "Review", mode: "inspect", role: "Check auth paths", name: "auth-reviewer" }] },
  ...THINKING_LEVELS.map(thinking => ({ action: "run", tasks: [{ ...task, cwd: "../worktree", model: "fixture/test", thinking }] })),
  { action: "list" }, { action: "list", cwd: "../target" },
  { action: "status" }, { action: "status", id: "run-id" },
  { action: "stop", id: "run-id" },
  { action: "resume", id: "run-id" },
  { action: "steer", id: "run-id", message: "Focus on tests" },
  { action: "followUp", id: "run-id", message: "Run the tests after" },
  { action: "reply", id: "run-id", requestId: "question-id", message: "Use the existing API" },
];
const invalid: unknown[] = [
  null, [], "list", 1, {}, { action: "unknown" },
  { action: "run" }, { action: "run", tasks: [] }, { action: "run", tasks: Array(5).fill(task) },
  { action: "run", tasks: [null] }, { action: "run", tasks: [{}] },
  { action: "run", tasks: [{ mode: "edit" }] }, { action: "run", tasks: [{ agent: "worker", task: "Implement" }] },
  { action: "run", tasks: [{ ...task, mode: "write" }] },
  { action: "run", tasks: [{ ...task, template: "Security Reviewer" }] }, { action: "run", tasks: [{ ...task, name: "../x" }] },
  ...["task", "role", "template", "name", "cwd", "model"].flatMap(field => [
    { action: "run", tasks: [{ ...task, [field]: "" }] },
    { action: "run", tasks: [{ ...task, [field]: 123 }] },
  ]),
  ...Object.entries({ task: 32768, role: 16384, template: 64, name: 64, cwd: 4096, model: 512 }).map(([field, max]) =>
    ({ action: "run", tasks: [{ ...task, [field]: "x".repeat(max + 1) }] })),
  { action: "run", tasks: [{ ...task, thinking: "highest" }] },
  { action: "run", tasks: [{ ...task, extra: true }] },
  { action: "list", cwd: "" }, { action: "list", cwd: "x".repeat(4097) },
  { action: "status", id: "" }, { action: "status", id: "x".repeat(65) },
  { action: "stop" }, { action: "resume" }, { action: "resume", id: "" },
  { action: "resume", id: "run-id", message: "x" },
  { action: "steer", id: "run-id" },
  { action: "steer", message: "Focus" }, { action: "steer", id: "run-id", message: "" },
  { action: "steer", id: "run-id", message: "x".repeat(8193) },
  { action: "followUp", id: "run-id" }, { action: "followUp", message: "x" },
  { action: "followUp", id: "run-id", message: "" },
  { action: "followUp", id: "run-id", message: "x".repeat(8193) },
  { action: "followUp", id: "run-id", message: "x", requestId: "q" },
  { action: "reply", requestId: "q", message: "Yes" },
  { action: "reply", id: "run-id", message: "Yes" },
  { action: "reply", id: "run-id", requestId: "q" },
  { action: "reply", id: "run-id", requestId: "x".repeat(65), message: "Yes" },
  ...valid.map(input => ({ ...input, extra: true })),
  // Fields valid on another action must not leak across branches.
  { action: "run", tasks: [task], id: "run-id" },
  { action: "list", tasks: [task] }, { action: "list", id: "run-id" },
  { action: "status", cwd: "../target" }, { action: "status", message: "Focus" },
  { action: "stop", id: "run-id", requestId: "q" },
  { action: "steer", id: "run-id", message: "Focus", requestId: "q" },
  { action: "reply", id: "run-id", requestId: "q", message: "Yes", tasks: [task] },
];

test("input parameters retain an object root and eight closed action branches; output stays a union", () => {
  const schema = JSON.parse(JSON.stringify(Parameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.anyOf.length, 8);
  assert.deepEqual(schema.anyOf.map((branch: { properties: { action: { const: string } } }) => branch.properties.action.const),
    ["run", "list", "status", "stop", "resume", "steer", "followUp", "reply"]);
  assert(schema.anyOf.every((branch: { type: string; additionalProperties: boolean }) => branch.type === "object" && branch.additionalProperties === false));
  assert.equal(schema.anyOf[0].properties.tasks.items.additionalProperties, false);
  assert.equal(JSON.parse(JSON.stringify(OutputSchema)).type, undefined);
  assert(Check(OutputSchema, { templates: [], folders: { global: "/g" }, starter: "/s.md" }), "template list output");
  assert(!Check(OutputSchema, []), "the retired profile array is not an output shape");
  assert(Check(OutputSchema, { id: "r", state: "waiting_for_agent" }));
});

test("schema and runtime guards agree on all actions, optional fields, bounds and closed field combinations", () => {
  for (const input of valid) {
    assert(Check(Parameters, input), JSON.stringify(input));
    assert.deepEqual(parseRequest(input), input);
  }
  const boundary = { action: "run", tasks: [{ mode: "inspect", name: "a".repeat(64), role: "r".repeat(16384), task: "x".repeat(32768), cwd: "x".repeat(4096), model: "p/" + "x".repeat(510) }] };
  assert(Check(Parameters, boundary));
  assert.deepEqual(parseRequest(boundary), boundary);
  for (const input of invalid) {
    assert(!Check(Parameters, input), "schema accepted invalid input");
    assert.throws(() => parseRequest(input));
  }
  // Existing runtime text/model policy is deliberately stricter than JSON string lengths.
  for (const field of ["task", "role", "cwd", "model"]) {
    for (const value of ["   ", "a\0b"]) {
      const input = { action: "run", tasks: [{ ...task, [field]: value }] };
      assert(Check(Parameters, input));
      assert.throws(() => parseRequest(input));
    }
  }
  assert.throws(() => parseRequest({ action: "run", tasks: [{ ...task, model: "alias" }] }));
  // The flat schema keeps tool tokens small; the runtime guard requires mode or a template.
  assert(Check(Parameters, { action: "run", tasks: [{ task: "x" }] }));
  assert.throws(() => parseRequest({ action: "run", tasks: [{ task: "x" }] }), /needs mode/);
  assert.throws(() => parseRequest({ action: "run", tasks: [{ ...task, model: "fixture/test:high" }] }));
  assert.deepEqual(parseRequest({ action: "list", cwd: " ../target " }), { action: "list", cwd: "../target" });
});

test("actual OpenAI-completions serialization preserves object-root union in onPayload and HTTP body", async () => {
  const model: Model<"openai-completions"> = {
    id: "schema-fixture", name: "Schema fixture", api: "openai-completions", provider: "fixture",
    baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], compat: { supportsStrictMode: true },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128,
  };
  const context = normalizeContext({
    messages: [{ role: "user", content: "List templates", timestamp: 0 }],
    tools: [{ name: "subagent", description: DESCRIPTION, parameters: Parameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" } }],
  });
  let payload: unknown, body: unknown, requests = 0;
  const events = stream(model, context, {
    apiKey: "fixture-only", maxRetries: 0,
    onPayload(value) { payload = JSON.parse(JSON.stringify(value)); },
    async fetch(_url, init) {
      requests++;
      assert.equal(typeof init?.body, "string");
      body = JSON.parse(String(init?.body));
      const chunk = { id: "fixture", object: "chat.completion.chunk", created: 0, model: model.id,
        choices: [{ index: 0, delta: { role: "assistant", content: "Fixture response" }, finish_reason: null }] };
      const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const seen: string[] = [];
  for await (const event of events) seen.push(event.type);
  const result = await events.result();
  assert.equal(result.stopReason, "stop", result.errorMessage ?? "OpenAI-completions fixture did not stop normally");
  assert(seen.includes("text_delta"));
  assert.equal(requests, 1);
  assert.deepEqual(body, payload);
  // Narrow unknown transport data without relying on installed adapter internals.
  const wire = body as { tools: { type: string; function: { name: string; parameters: unknown; strict?: boolean } }[] };
  assert.equal(wire.tools.length, 1);
  assert.equal(wire.tools[0]!.type, "function");
  assert.equal(wire.tools[0]!.function.name, "subagent");
  assert.equal(wire.tools[0]!.function.strict, false, "root action union falls back to non-strict despite strict-mode support");
  assert.deepEqual(wire.tools[0]!.function.parameters, JSON.parse(JSON.stringify(Parameters)));
});
