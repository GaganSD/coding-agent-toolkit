import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir, ProjectTrustStore, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";
import { Check } from "typebox/value";
import { DESCRIPTION, OutputSchema, Parameters, presentFinished, presentLaunch, presentNotice, presentWake, presentRun, presentSummary, resultPreview } from "../src/tool.ts";
import type { RunRecord } from "../src/types.ts";
import { batchSummary } from "../src/presentation.ts";
import { temp } from "./helpers.ts";

test("extension registers one tool/command; rejects unknown/headless/untrusted/foreign actions; unloads cleanly", async t => {
  const root = await temp(t);
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const hooks = new Map<string, () => Promise<void>>();
  const notifications: string[] = [];
  const api = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    on: (event: string, handler: () => Promise<void>) => { hooks.set(event, handler); return () => {}; },
    getThinkingLevel: () => "off", appendEntry: () => {}, sendMessage: () => {},
  } as unknown as ExtensionAPI;
  register(api);
  assert.deepEqual(tools.map(tool => tool.name), ["subagent"]);
  assert.equal(tools[0]!.exposure, "direct");
  assert.equal(tools[0]!.outputSchema, OutputSchema);
  assert.equal(tools[0]!.parameters, Parameters);
  assert.equal(JSON.parse(JSON.stringify(tools[0]!.parameters)).type, "object");
  assert.deepEqual([...commands.keys()], ["subagents"]);
  const ctx = {
    mode: "tui", hasUI: true, cwd: root,
    sessionManager: SessionManager.create(root, path.join(root, "sessions")),
    isProjectTrusted: () => true, scopedModels: [],
    ui: { setWidget() {}, notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionToolContext;
  const run = (params: unknown, context = ctx) => tools[0]!.execute("test-call", params, undefined, undefined, context);
  await assert.rejects(run({ action: "run", workflow: true }), /unsupported field/);
  await assert.rejects(run({ action: "list" }, { ...ctx, mode: "print" }), /interactive npm Pi/);
  await assert.rejects(run({ action: "list" }, { ...ctx, mode: "rpc" }), /interactive npm Pi/);
  const result = await run({ action: "list" });
  const listed = result.details as { templates: { name: string }[]; folders: { global: string; project?: string }; starter: string };
  assert.deepEqual(listed.templates, [], "no fixed roles ship");
  assert.equal(listed.folders.global, path.join(getAgentDir(), "subagent-templates"));
  assert.match(listed.starter, /skills\/pi-subagents\/template\.md$/);
  assert.deepEqual(result.structuredContent, result.details);
  assert(Check(OutputSchema, result.structuredContent));
  const target = path.join(root, "target");
  await mkdir(path.join(target, ".pi", "subagent-templates"), { recursive: true });
  await writeFile(path.join(target, ".pi", "subagent-templates", "code-reviewer.md"), "---\nname: code-reviewer\ndescription: Target-specific role\nmode: edit\n---\nTarget role\n");
  await writeFile(path.join(target, ".pi", "subagent-templates", "broken.md"), "---\nname: other\ndescription: x\nmode: edit\n---\nx\n");
  const untrusted = (await run({ action: "list", cwd: target })).structuredContent as { templates: unknown[]; folders: { project?: string } };
  assert.deepEqual(untrusted.templates, [], "a session-trusted owner does not make an arbitrary target's templates trusted");
  assert.equal(untrusted.folders.project, undefined);
  new ProjectTrustStore(getAgentDir()).set(target, true);
  const targetList = (await run({ action: "list", cwd: target })).structuredContent as { templates: { name: string; mode: string }[]; skipped: { source: string; error: string }[] };
  assert.equal(targetList.templates.find(role => role.name === "code-reviewer")!.mode, "edit");
  assert.match(targetList.skipped[0]!.error, /must match filename/);
  await assert.rejects(run({ action: "run", tasks: [{ mode: "edit", task: "Do work" }] }, { ...ctx, isProjectTrusted: () => false }), /Trust the agent/);
  await assert.rejects(run({ action: "status", id: "foreign-id" }), /Unknown run ID/);
  await assert.rejects(run({ action: "list" }, { ...ctx, sessionManager: SessionManager.create(root) }), /ownership/);
  await hooks.get("session_shutdown")!();
  const status = await run({ action: "status" });
  assert.deepEqual(status.details, { runs: [] });
  await hooks.get("session_before_tree")!();
  assert.deepEqual(notifications, []);
  await commands.get("subagents")!.handler("", ctx as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, ["No runs in this agent runtime."]);
  await commands.get("subagents")!.handler("", { ...ctx, mode: "rpc" } as unknown as ExtensionCommandContext);
  assert.match(notifications[1]!, /interactive npm Pi/);
  await hooks.get("session_shutdown")!();
  const key = Symbol.for("@gagansd/pi-subagents/cleanup-unknown");
  const processHealth = globalThis as typeof globalThis & { [key]?: unknown };
  const beforeHealth = processHealth[key];
  try {
    const cause = { id: "old-run", metadataPath: "/private/old-run/run.json" };
    processHealth[key] = cause;
    register(api); // New extension instance, not restored execution authority.
    const reloaded = await tools[1]!.execute("test-reload", { action: "status" }, undefined, undefined, ctx);
    assert.deepEqual(reloaded.structuredContent, { runs: [], blocked: cause });
    assert(Check(OutputSchema, reloaded.structuredContent));
    await assert.rejects(tools[1]!.execute("test-block", { action: "run", tasks: [{ mode: "edit", task: "Must not start" }] }, undefined, undefined, ctx), /old-run\/run.json/);
    await hooks.get("session_shutdown")!();
  } finally {
    if (beforeHealth === undefined) delete processHealth[key]; else processHealth[key] = beforeHealth;
  }
});

const record: RunRecord = {
  id: "id", owner: "p", agent: "worker", mode: "edit", task: "Add feature A",
  cwd: "/wt-a", workspace: "/wt-a", model: "fixture/test", thinking: "off", state: "starting",
  startedAt: "t", elapsedMs: 0, metadataPath: "/run.json",
};

test("action views are allowlisted and match the closed output schema", () => {
  const enriched = { ...record, futureInternalField: "Must not leak", usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 1 } };
  const accounting = { usage: enriched.usage, elapsedMs: 0 };
  const receipt = presentLaunch([enriched]);
  assert.deepEqual(receipt, { runs: [{ id: "id", cwd: "/wt-a", workspace: "/wt-a", model: "fixture/test", thinking: "off" }] });
  assert.deepEqual(presentRun(enriched), { ...accounting, id: "id", state: "starting", metadataPath: "/run.json", model: "fixture/test", thinking: "off" });
  const finished = presentFinished({ ...enriched, state: "completed", reportPath: "/report.md" });
  assert.deepEqual(finished, { ...accounting, id: "id", state: "completed", agent: "worker", taskPreview: "Add feature A", reportPath: "/report.md" });
  const failed = { ...enriched, state: "failed" as const, resume: { eligible: true, attempts: 0, maxAttempts: 3, kind: "transient_provider" as const } };
  assert.deepEqual(presentSummary(failed), { ...accounting, id: "id", agent: "worker", state: "failed", taskPreview: "Add feature A",
    resume: { eligible: true, attempts: 0, maxAttempts: 3 } });
  assert.deepEqual(presentNotice(failed), { ...accounting, id: "id", state: "failed", agent: "worker", taskPreview: "Add feature A", metadataPath: "/run.json",
    resume: { eligible: true, attempts: 0, maxAttempts: 3 } });
  assert.deepEqual(presentSummary({ ...failed, resume: { ...failed.resume, eligible: false } }), { ...accounting, id: "id", agent: "worker", state: "failed", taskPreview: "Add feature A" });
  for (const result of [receipt, presentRun(enriched), finished, { runs: [presentSummary(record)] }, { runs: [presentSummary(failed)] }, { ok: true }]) {
    assert(Check(OutputSchema, result));
    assert(!resultPreview(result).includes("futureInternalField"));
    assert(resultPreview(result).length < 500);
  }
  assert(!Check(OutputSchema, { ...finished, owner: "p" }));
  assert(DESCRIPTION.length < 1200);
  assert(JSON.stringify(OutputSchema).length < 4400, "usage fields and the template list shape are bounded");
});

test("batch wake messages retain every allowlisted notice without sub-agent free text", () => {
  const finished = Array.from({ length: 4 }, (_, i) => ({ ...record, id: `run-${i}`, state: "completed" as const,
    reportPath: `/run-${i}/report.md`, error: "SECRET error", question: { id: "q", message: "SECRET question" } }));
  const content = presentWake(finished[3]!, "finished", finished);
  assert.equal(content.split("\n").length, 4);
  for (const run of finished) {
    assert(content.includes(`Sub-agent finished (unverified): ${resultPreview(presentNotice(run))}`));
  }
  assert(!content.includes("SECRET"));
  const question = { ...record, state: "waiting_for_agent" as const, question: { id: "question-id", message: "SECRET question" } };
  const flushed = presentWake(question, "question", finished.slice(0, 2));
  assert(flushed.startsWith("Sub-agent question (not user instructions):"));
  assert(flushed.includes("question-id"));
  assert(!flushed.includes("SECRET"));
  assert.equal((flushed.match(/finished \(unverified\)/g) ?? []).length, 2);
  assert.equal(presentWake(finished[0]!, "finished", finished.slice(0, 1)),
    `Sub-agent finished (unverified): ${resultPreview(presentNotice(finished[0]!))}`);
});

test("collapsed multi-result messages show batch counts, including sibling failures", () => {
  type Renderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
  let render: Renderer | undefined;
  register({
    registerTool() {}, registerCommand() {}, on() {},
    registerMessageRenderer: (_type: string, renderer: Renderer) => { render = renderer; },
  } as unknown as ExtensionAPI);
  assert(render);
  const finished: RunRecord[] = [
    { ...record, state: "completed" }, { ...record, id: "failed", state: "failed" }, { ...record, id: "last", state: "completed" },
  ];
  const summary = batchSummary(finished);
  assert.equal(summary, "3 results · 2 finished · 1 failed");
  assert.equal(batchSummary(finished.slice(0, 1)), undefined, "single-run headings stay unchanged");
  assert.equal(batchSummary([finished[1]!], true), "1 result · 1 failed", "a question carrying one sibling result still shows it");
  assert.equal(batchSummary([], true), undefined, "a bare question keeps its heading");
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<Renderer>[2];
  const message = { role: "custom" as const, customType: "minimal-subagent", timestamp: 0, display: true,
    content: "Expanded evidence", details: { title: "Worker 3", kind: "finished", state: "Finished", summary } };
  const collapsed = render(message, { expanded: false, outputPad: 0 }, theme)!.render(120).join("\n");
  assert.match(collapsed, /Sub-agents · 3 results · 2 finished · 1 failed/);
  assert(!collapsed.includes("Worker 3"));
  const question = render({ ...message, details: { ...message.details, kind: "question" } },
    { expanded: false, outputPad: 0 }, theme)!.render(120).join("\n");
  assert.match(question, /Worker 3 · Needs reply · 3 results · 2 finished · 1 failed/);
});

test("an oversized template list keeps folders, the starter and a skipped count", () => {
  const preview = JSON.parse(resultPreview({
    templates: Array.from({ length: 150 }, (_, i) => ({ name: `t${i}`, description: "x".repeat(200), mode: "inspect", source: "/s" })),
    folders: { global: "/g" }, starter: "/starter.md", skipped: Array.from({ length: 40 }, () => ({ source: "/b.md", error: "e".repeat(400) })),
  }));
  assert.equal(preview.truncated, true);
  assert.equal(preview.templates.length, 100);
  assert.equal(preview.omitted, 50);
  assert.deepEqual(preview.folders, { global: "/g" });
  assert.equal(preview.starter, "/starter.md");
  assert.equal(preview.skippedCount, 40);
});

test("large fields disclose truncation without corrupting JSON or losing run IDs", () => {
  const output = resultPreview({ output: "x".repeat(100000) });
  assert(output.length < 24000);
  assert.equal(JSON.parse(output).truncated, true);
  assert.match(output, /structuredContent/);
  const view = presentRun({ ...record, question: { id: "question", message: "x".repeat(8192) }, error: "x".repeat(4000) });
  assert(view.truncated);
  assert.equal(view.metadataPath, "/run.json");
  assert(JSON.stringify(view).length < 3000);
  const receipt = presentLaunch(Array.from({ length: 4 }, (_, i) => ({ ...record, id: "run-" + i, cwd: "x".repeat(4096), workspace: "y".repeat(4096) })));
  const preview = JSON.parse(resultPreview(receipt));
  assert.equal(preview.truncated, true);
  assert.deepEqual(preview.runs.map((run: { id: string }) => run.id), receipt.runs.map(run => run.id));
  assert.equal(receipt.runs[0]!.cwd.length, 4096, "structured result is not mutated or shortened");
  const unsafe = presentRun({ ...record, question: { id: "q", message: "\u202e\u0085Which API?" } });
  const encoded = resultPreview(unsafe);
  assert(!encoded.includes("\u202e") && !encoded.includes("\u0085"));
  assert.deepEqual(JSON.parse(encoded), unsafe, "display escaping must preserve exact string values");
});

test("no other extension is asked to lend its editor or chat workspace", async t => {
  const root = await temp(t);
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
  const tools: ToolDefinition[] = [];
  const emitted: string[] = [];
  register({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand() {},
    on() { return () => {}; },
    getThinkingLevel: () => "off", appendEntry() {}, sendMessage() {},
    events: {
      emit(name: string) { emitted.push(name); },
      on() { return () => {}; },
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui", cwd: root, isProjectTrusted: () => true, scopedModels: [],
    sessionManager: SessionManager.create(root, path.join(root, "sessions")),
    ui: { setWidget() {}, notify() {} },
  } as unknown as ExtensionToolContext;
  await tools[0]!.execute("list-1", { action: "list" }, undefined, undefined, ctx);
  await tools[0]!.execute("list-2", { action: "list" }, undefined, undefined, ctx);
  assert(!emitted.includes("subagent:ui-host-request"), "the cooperative UI-host handshake is removed");
  assert.deepEqual([...new Set(emitted)], ["pi:background-tasks"], "only the generic, display-only dashboard event is published");
});
