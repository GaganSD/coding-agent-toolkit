import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { loadSkillsFromDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { loadTemplates, parseTemplate, projectTrusted, resolveRole, STARTER } from "../src/templates.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { parseCommand, resolveRun } from "../src/inspect.ts";
import { formatEntry, readTranscript } from "../src/transcript.ts";
import { OutputSchema, parseRequest, presentLaunch, presentRun } from "../src/tool.ts";
import type { RunRecord } from "../src/types.ts";
import { formatElapsed, nextLive, plain, rows } from "../src/ui.ts";
import { fileURLToPath } from "node:url";
import { temp } from "./helpers.ts";

test("requests reject invalid action/field combinations", () => {
  assert.deepEqual(parseRequest({ action: "run", tasks: [{ mode: "edit", task: "Implement" }] }), { action: "run", tasks: [{ mode: "edit", task: "Implement" }] });
  assert.deepEqual(parseRequest({ action: "run", tasks: [{ template: "security-reviewer", name: "sec", role: " Focus on auth ", task: "Review", thinking: "low" }] }),
    { action: "run", tasks: [{ template: "security-reviewer", name: "sec", role: "Focus on auth", task: "Review", thinking: "low" }] });
  for (const input of [
    { mode: "edit", task: "Old direct syntax" }, { action: "run", workflow: true },
    { action: "run", tasks: [] }, { action: "run", tasks: Array(5).fill({ mode: "edit", task: "x" }) },
    { action: "resume" }, { action: "resume", id: "x", message: "y" }, { action: "run", tasks: [{ mode: "edit", task: "x", async: true }] },
    { action: "list", config: {} }, { action: "stop" }, { action: "steer", id: "x" },
    { action: "reply", id: "x", message: "answer" }, { action: "run", tasks: [{ agent: "worker", task: "x" }] },
    { action: "run", tasks: [{ mode: "write", task: "x" }] }, { action: "run", tasks: [{ template: "Bad Name", task: "x" }] },
    { action: "run", tasks: [{ name: "../x", mode: "edit", task: "x" }] }, { action: "run", tasks: [{ role: "", mode: "edit", task: "x" }] },
    { action: "run", tasks: [{ mode: "edit", task: "x", model: "alias" }] },
    { action: "run", tasks: [{ mode: "edit", task: "x", thinking: "highest" }] },
    { action: "run", tasks: [{ mode: "edit", task: "\0" }] },
  ]) assert.throws(() => parseRequest(input));
  assert.throws(() => parseRequest({ action: "run", tasks: [{ task: "x" }] }), /needs mode/, "rejected before any discovery");
  assert.deepEqual(parseRequest({ action: "list", cwd: "../target" }), { action: "list", cwd: "../target" });
  assert.throws(() => parseRequest({ action: "status", cwd: "../target" }));
  assert.deepEqual(parseRequest({ action: "status" }), { action: "status" });
  assert.deepEqual(parseRequest({ action: "resume", id: " run-a " }), { action: "resume", id: "run-a" });
  assert.deepEqual(parseRequest({ action: "reply", id: "a", requestId: "b", message: "yes" }), { action: "reply", id: "a", requestId: "b", message: "yes" });
});

test("exact-ID status presents cached context and current tool inside the closed output schema", () => {
  const base: RunRecord = {
    id: "run-a", owner: "p", agent: "worker", mode: "edit", task: "A",
    cwd: "/wt", workspace: "/wt", model: "fixture/test", thinking: "off", state: "running",
    startedAt: "t", elapsedMs: 0, metadataPath: "/a.json",
    currentTool: "bash", contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
  };
  const view = presentRun(base);
  assert.equal(view.currentTool, "bash");
  assert.deepEqual(view.contextUsage, { tokens: 10, contextWindow: 100, percent: 10 });
  assert(Check(OutputSchema, view));
  const unknown = presentRun({ ...base, currentTool: undefined, contextUsage: { tokens: null, percent: null, contextWindow: 64000 } });
  assert(!("currentTool" in unknown));
  assert.deepEqual(unknown.contextUsage, { tokens: null, percent: null, contextWindow: 64000 }, "unknown stays unknown, never zero");
  assert(Check(OutputSchema, unknown));
});

test("config is bounded and rejects unknown or unsafe limits", () => {
  assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
  assert.equal(parseConfig({ maxConcurrent: 2 }).maxConcurrent, 2);
  assert.equal(DEFAULT_CONFIG.timeoutMs, 1_800_000, "the default remains thirty minutes");
  assert.equal(parseConfig({ timeoutMs: 21_600_000 }).timeoutMs, 21_600_000, "six-hour deadlines are explicit opt-in");
  assert.throws(() => parseConfig({ timeoutMs: 21_600_001 }), /between 1000 and 21600000/);
  assert.deepEqual(parseConfig({ historyLimit: 1 }), DEFAULT_CONFIG, "retired history settings do not evict exact run IDs");
  for (const value of [{ maxConcurrent: 5 }, { maxRuns: 0 }, { timeoutMs: Infinity }, { timeoutMs: 500 }, { historyLimit: -1 }, { maxRuns: 1.5 }, { asyncByDefault: true }, []]) assert.throws(() => parseConfig(value));
});

const template = (name: string, body = "Role prompt", mode = "inspect") => `---\nname: ${name}\ndescription: A role\nmode: ${mode}\n---\n${body}\n`;
test("no fixed roles ship; global and trusted project templates load, project overrides global", async t => {
  const root = await temp(t);
  const user = path.join(root, "user");
  const repo = path.join(root, "repo");
  const empty = await loadTemplates(user, repo, true);
  assert.equal(empty.templates.size, 0);
  assert.deepEqual(empty.skipped, []);
  assert.deepEqual(empty.folders, { global: path.join(user, "subagent-templates"), project: path.join(repo, ".pi", "subagent-templates") });
  assert.equal((await loadTemplates(user, repo, false)).folders.project, undefined, "untrusted projects expose no project folder");
  await mkdir(path.join(user, "subagent-templates"), { recursive: true });
  await mkdir(path.join(repo, ".pi", "subagent-templates"), { recursive: true });
  await writeFile(path.join(user, "subagent-templates", "code-reviewer.md"), template("code-reviewer", "User role"));
  await writeFile(path.join(repo, ".pi", "subagent-templates", "code-reviewer.md"), template("code-reviewer", "Project role"));
  await writeFile(path.join(user, "subagent-templates", "broken.md"), "No YAML");
  const global = await loadTemplates(user, repo, false);
  assert.equal(global.templates.get("code-reviewer")!.prompt, "User role");
  assert.deepEqual(global.skipped.map(item => path.basename(item.source)), ["broken.md"], "broken templates are disclosed, not silently dropped");
  assert.match(global.skipped[0]!.error, /frontmatter/);
  assert.equal((await loadTemplates(user, repo, true)).templates.get("code-reviewer")!.prompt, "Project role");
  // A broken project override makes the name unavailable instead of silently launching the global role.
  await writeFile(path.join(repo, ".pi", "subagent-templates", "code-reviewer.md"), template("code-reviewer").replace("mode: inspect", "mode: write"));
  const shadowed = await loadTemplates(user, repo, true);
  assert.equal(shadowed.templates.get("code-reviewer"), undefined);
  assert.throws(() => resolveRole({ task: "x", template: "code-reviewer" }, shadowed.templates, shadowed.broken), /failed to load: .*needs mode/);
  assert.equal((await loadTemplates(user, repo, false)).templates.get("code-reviewer")!.prompt, "User role", "without the project folder the global role is used");
  // An unreadable project folder could hide an override for any name: template launches fail, inline roles still work.
  await writeFile(path.join(repo, ".pi", "subagent-templates", "code-reviewer.md"), template("code-reviewer", "Project role"));
  const { chmod } = await import("node:fs/promises");
  await chmod(path.join(repo, ".pi", "subagent-templates"), 0o000);
  const blocked = await loadTemplates(user, repo, true);
  await chmod(path.join(repo, ".pi", "subagent-templates"), 0o700); // Restore before temp cleanup.
  if (process.getuid?.() !== 0) {
    assert.match(blocked.unreadable ?? "", /EACCES|permission/i);
    assert(blocked.skipped.some(item => item.source === path.join(repo, ".pi", "subagent-templates")), "list still discloses the folder error");
    assert.throws(() => resolveRole({ task: "x", template: "code-reviewer" }, blocked.templates, blocked.broken, blocked.unreadable), /project template folder is unreadable/);
    assert.equal(resolveRole({ task: "x", mode: "inspect", role: "Inline" }, blocked.templates, blocked.broken, blocked.unreadable).prompt, "Inline");
  }
});

test("project templates need an explicit saved trust decision for the target", async t => {
  const root = await temp(t);
  const agentDir = path.join(root, "agent"), repo = path.join(root, "repo"), child = path.join(repo, "pkg");
  await mkdir(child, { recursive: true }); await mkdir(agentDir);
  assert.equal(projectTrusted(agentDir, repo), false, "no decision is not trust");
  new ProjectTrustStore(agentDir).set(repo, true);
  assert.equal(projectTrusted(agentDir, repo), true);
  assert.equal(projectTrusted(agentDir, child), true, "a trusted parent folder covers its children");
  new ProjectTrustStore(agentDir).set(child, false);
  assert.equal(projectTrusted(agentDir, child), false);
});

test("the package exposes exactly one skill; the starter beside it is not a skill", () => {
  const { skills } = loadSkillsFromDir({ dir: fileURLToPath(new URL("../skills", import.meta.url)), source: "package" });
  assert.deepEqual(skills.map(skill => skill.name), ["pi-subagents"]);
});

test("roles resolve from inline instructions, a template, or both; mode is never implicit", () => {
  const saved = new Map([["security-reviewer", parseTemplate(template("security-reviewer", "Find auth bugs."), "/t/security-reviewer.md")]]);
  assert.throws(() => resolveRole({ task: "x" }, saved), /needs mode/);
  assert.throws(() => resolveRole({ task: "x", template: "missing" }, saved), /Unknown template 'missing'/);
  assert.deepEqual(resolveRole({ task: "x", mode: "edit" }, saved), { name: "worker", description: "Inline role", mode: "edit", prompt: "", source: "inline" });
  assert.equal(resolveRole({ task: "x", mode: "inspect", role: "Research only." }, saved).name, "inspector");
  const combined = resolveRole({ task: "x", template: "security-reviewer", role: "Focus on src/auth." }, saved);
  assert.equal(combined.mode, "inspect");
  assert.equal(combined.name, "security-reviewer");
  assert.equal(combined.prompt, "Find auth bugs.\n\nFocus on src/auth.");
  assert.equal(resolveRole({ task: "x", template: "security-reviewer", mode: "edit", name: "fixer" }, saved).mode, "edit", "the agent decides; task mode wins");
});

test("templates reject unknown fields, malformed/duplicate YAML, mismatches and oversized prompts", () => {
  assert.equal(parseTemplate(template("reviewer"), "/roles/reviewer.md").mode, "inspect");
  for (const text of [
    template("worker"), template("reviewer").replace("mode: inspect", "mode: inspect\ntools: bash"),
    template("reviewer").replace("mode: inspect", "mode: invalid"),
    template("reviewer").replace("mode: inspect", "mode: inspect\nmode: edit"),
    template("reviewer").replace("mode: inspect", "mode: inspect\nmodel: alias"),
    template("reviewer").replace("mode: inspect", "mode: inspect\nthinking: highest"),
    "No YAML", template("reviewer", "x".repeat(33000)),
  ]) assert.throws(() => parseTemplate(text, "/roles/reviewer.md"));
});

test("the starter is a guide with a skeleton that loads once its placeholders are filled", async () => {
  const contents = await readFile(STARTER, "utf8");
  assert.doesNotMatch(contents, /^---\n/, "the starter itself is not a launchable template");
  for (const archetype of ["implementer", "verifier", "code-reviewer", "security-reviewer", "researcher"]) assert.match(contents, new RegExp(archetype));
  const skeleton = /```markdown\n([\s\S]*?)\n```/.exec(contents)![1]!;
  assert.throws(() => parseTemplate(skeleton, "/t/x.md"), "unfilled placeholders never load");
  const filled = skeleton
    .replace(/^name: .*$/m, "name: auth-reviewer")
    .replace(/^description: .*$/m, "description: Reviews auth changes")
    .replace(/^mode: .*$/m, "mode: inspect");
  const parsed = parseTemplate(filled, "/t/auth-reviewer.md");
  assert.equal(parsed.mode, "inspect");
  assert.match(parsed.prompt, /## Verification metrics/);
});

test("launch receipts map each requested task to an exact run identity", () => {
  const receipt = presentLaunch([
    {
      id: "run-a", owner: "p", agent: "worker", mode: "edit", task: "A",
      cwd: "/wt-a", workspace: "/repo-a", model: "fixture/test", thinking: "off", state: "starting",
      startedAt: "t", elapsedMs: 0, metadataPath: "/a.json",
    },
    {
      id: "run-b", owner: "p", agent: "worker", mode: "edit", task: "B",
      cwd: "/wt-b", workspace: "/repo-b", model: "fixture/test", thinking: "off", state: "starting",
      startedAt: "t", elapsedMs: 0, metadataPath: "/b.json",
    },
  ]);
  assert.deepEqual(receipt.runs, [
    { id: "run-a", cwd: "/wt-a", workspace: "/repo-a", model: "fixture/test", thinking: "off" },
    { id: "run-b", cwd: "/wt-b", workspace: "/repo-b", model: "fixture/test", thinking: "off" },
  ]);
});

test("UI sanitizes terminal controls and bidi content", () => {
  assert(!plain("\u001b]title\n\u202efake").includes("\u001b"));
  assert(!plain("\u202efake").includes("\u202e"));
  assert.equal(rows([]).length, 0);
});

test("elapsed time is natural and down cycles live threads then agent", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(12_000), "12s");
  assert.equal(formatElapsed(59_000), "59s");
  assert.equal(formatElapsed(60_000), "1m");
  assert.equal(formatElapsed(65_000), "1m 5s");
  assert.equal(formatElapsed(3_600_000), "1h");
  assert.equal(formatElapsed(3_723_000), "1h 2m");
  const live = ["aaaaaaaa-1", "bbbbbbbb-2"].map(id => ({
    id, owner: "p", agent: "worker", mode: "edit" as const, task: id, cwd: "/", workspace: "/",
    model: "fixture/test", thinking: "off" as const, state: "running" as const, startedAt: "t", elapsedMs: 65_000, metadataPath: "/m",
  }));
  assert.equal(nextLive(live, live[0]!.id), live[1]!.id);
  assert.equal(nextLive(live, live[1]!.id), undefined);
  assert.equal(rows(live)[0], "Sub-agents");
  assert.match(rows(live)[1]!, /Worker 1.*Running/);
  assert.match(rows(live)[2]!, /Worker 2.*Running/);
});

test("human command parse and unique prefix attach", () => {
  assert.deepEqual(parseCommand(""), { action: "list" });
  assert.deepEqual(parseCommand("400163b5"), { action: "attach", id: "400163b5" });
  assert.deepEqual(parseCommand("stop 400163b5-6198-4959-83d3-952535a67ce3"), { action: "stop", id: "400163b5-6198-4959-83d3-952535a67ce3" });
  assert.deepEqual(parseCommand("steer 400163b5 focus on the hero"), { action: "steer", id: "400163b5", message: "focus on the hero" });
  assert.deepEqual(parseCommand("followUp 400163b5 run the tests after"), { action: "followUp", id: "400163b5", message: "run the tests after" });
  assert.deepEqual(parseCommand("reply 400163b5 use the existing API"), { action: "reply", id: "400163b5", message: "use the existing API" });
  // The id may be a substring of the head word; the message must still start after the id token.
  assert.deepEqual(parseCommand("steer ee focus the hero"), { action: "steer", id: "ee", message: "focus the hero" });
  assert.deepEqual(parseCommand("resume 400163b5-6198-4959-83d3-952535a67ce3"), { action: "resume", id: "400163b5-6198-4959-83d3-952535a67ce3" });
  assert.deepEqual(parseCommand("resume 400163b5"), { action: "resume", id: "400163b5" });
  assert.throws(() => parseCommand("resume"), /Usage/);
  assert.throws(() => parseCommand("resume a b"), /Usage/);
  const runs = ["aaaaaaaa-1111", "bbbbbbbb-2222"].map(id => ({
    id, owner: "p", agent: "worker", mode: "edit" as const, task: id, cwd: "/", workspace: "/",
    model: "fixture/test", thinking: "off" as const, state: "running" as const, startedAt: "t", elapsedMs: 1, metadataPath: "/m",
  }));
  assert.equal(resolveRun(runs, "aaaa").id, "aaaaaaaa-1111");
  assert.throws(() => resolveRun(runs, "zzz"), /Unknown/);
});

test("transcript extract skips session headers and keeps user/sub-agent/tool lines", async t => {
  const root = await temp(t);
  const file = path.join(root, "session.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Build cat.html" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "write" }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "wrote cat.html" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
  ].join("\n") + "\n");
  assert.deepEqual(await readTranscript(file), [
    "you   Build cat.html",
    "sub-agent tool write",
    "out   wrote cat.html",
    "sub-agent Done",
  ]);
  assert.equal(formatEntry({ type: "session" }), undefined);
  assert.deepEqual(await readTranscript(undefined), ["(no transcript yet)"]);
});

test("widget lists live runs and drops settled completions", () => {
  const stub = (id: string, state: "running" | "completed"): import("../src/types.ts").RunRecord => ({
    id, owner: "p", agent: "worker", mode: "edit", task: id, cwd: "/" + id, workspace: "/" + id,
    model: "fixture/test", thinking: "off", state, startedAt: "t", elapsedMs: 1, metadataPath: "/" + id,
  });
  const live = [stub("aaaaaaaa-1", "running"), stub("bbbbbbbb-2", "running"), stub("cccccccc-3", "running")];
  assert.equal(rows(live).length, 4);
  const completed = rows(live.map(run => ({ ...run, state: "completed" })));
  assert.deepEqual(completed, []);
  assert.equal(rows([live[0]!, { ...live[1]!, state: "completed" }, { ...live[2]!, state: "completed" }]).length, 2);
});
