import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry, Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { commandResources, parseMcpFile, parseSidebarFolds, sidebarMessageCounts, sidebarMcp, sidebarText, sidebarUsage, SidebarSkills } from "../extensions/pi-slate/sidebar-data.ts";

const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, reasoning: 10, totalTokens: 470, cost: { total: 0.25 } };
function entry(id: string, fields: Record<string, unknown>): SessionEntry { return { id, parentId: null, timestamp: "0", ...fields } as unknown as SessionEntry; }
function message(id: string, role: string, fields: Record<string, unknown> = {}): SessionEntry { return entry(id, { type: "message", message: { role, ...fields } }); }
function command(name: string, source = "skill", path = `/skills/${name}/SKILL.md`): SlashCommandInfo {
  return { name: source === "skill" ? `skill:${name}` : name, source, description: "description", sourceInfo: { path, scope: "user", origin: "top-level", source: "user" } } as SlashCommandInfo;
}
function skill(name: string): Skill { return { name, filePath: `/skills/${name}/SKILL.md`, sourceInfo: { scope: "user" } } as Skill; }

test("usage input includes cache categories once; reasoning is already part of output", () => {
  const a = message("a", "assistant", { usage });
  const result = sidebarUsage([a, a]);
  assert.deepEqual(result, { input: 450, output: 20, cacheRead: 300, cacheWrite: 50, total: 470, cost: 0.25 });
});

test("tool nested usage, compaction, branch summaries and cache warming each count once", () => {
  const entries = [message("a", "assistant", { usage }), message("t", "toolResult", { usage, nestedCalls: { calls: [{ usage }], complete: true } }), entry("c", { type: "compaction", usage }), entry("b", { type: "branch_summary", usage }), entry("w", { type: "usage", kind: "cache_warm", usage })];
  const result = sidebarUsage(entries);
  assert.equal(result.input, 2250); assert.equal(result.output, 100); assert.equal(result.cost, 1.25);
});

test("ordinary tool results without usage are not invented model requests", () => {
  assert.deepEqual(sidebarUsage([message("t", "toolResult")]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
});

test("missing or invalid provider facts show unknown rather than fake zero", () => {
  assert.deepEqual(sidebarUsage([message("a", "assistant")]), { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, cost: null });
  const result = sidebarUsage([message("a", "assistant", { usage: { ...usage, cacheRead: NaN, cost: { total: -1 } } })]);
  assert.equal(result.input, null); assert.equal(result.output, 20); assert.equal(result.cacheWrite, 50); assert.equal(result.total, null); assert.equal(result.cost, null);
});

test("legacy summaries without usage make billed totals unknown rather than silently free", () => {
  for (const type of ["compaction", "branch_summary"]) {
    const result = sidebarUsage([message("a", "assistant", { usage }), entry("summary", { type })]);
    assert.equal(result.input, null); assert.equal(result.cost, null);
  }
});

test("overflow in otherwise finite usage never manufactures Infinity metrics", () => {
  const huge = { ...usage, input: 1e308, output: 1e308, cacheRead: 1e308, cacheWrite: 1e308, cost: { total: 1e308 } };
  const result = sidebarUsage([message("a", "assistant", { usage: huge }), message("b", "assistant", { usage: huge })]);
  assert(Object.values(result).every(value => value === null || Number.isFinite(value)));
  assert.equal(result.input, null); assert.equal(result.cost, null);
});

test("counts are conversation turns/messages, not tools, system or custom notices", () => {
  assert.deepEqual(sidebarMessageCounts([message("u", "user"), message("a", "assistant"), message("t", "toolResult"), message("s", "system"), entry("c", { type: "custom_message" })]), { turns: 1, messages: 2 });
});

test("skill catalog is not the loaded set; commands exclude skill invocations", () => {
  const r = commandResources([command("review"), command("review"), command("hello", "extension"), command("plan", "prompt")]);
  assert.equal(r.skills.length, 1); assert.equal(r.skills[0]!.loaded, false);
  assert.deepEqual(r.commands.map(x => x.name), ["hello"]);
});

test("prompt commands leave the command lane and dedupe by name", () => {
  const r = commandResources([command("plan", "prompt"), command("plan", "prompt"), command("review"), command("ship", "prompt")]);
  assert.deepEqual(r.prompts.map(x => x.name), ["plan", "ship"]);
  assert.deepEqual(r.prompts[0], { name: "plan", source: "prompt", description: "description" });
  assert.deepEqual(r.commands, []);
});

test("successful canonical skill reads load instructions; failed or non-skill reads do not", () => {
  const tracker = new SidebarSkills(); tracker.reset([command("review"), command("plan")]);
  tracker.readStart("r", "read", { path: "/skills/review/SKILL.md" }, "/repo"); tracker.readEnd("r", false);
  tracker.readStart("p", "read", { path: "/skills/plan/SKILL.md" }, "/repo"); tracker.readEnd("p", true);
  tracker.readStart("x", "read", { path: "/repo/README.md" }, "/repo"); tracker.readEnd("x", false);
  assert.deepEqual(tracker.snapshot().map(x => [x.name, x.loaded]), [["review", true], ["plan", false]]);
});

test("uncatalogued successful instruction reads remain visible, including home-relative paths", () => {
  const tracker = new SidebarSkills(); tracker.reset([]);
  tracker.readStart("manual", "read", { path: "~/manual-skill/SKILL.md" }, "/repo"); tracker.readEnd("manual", false);
  assert.deepEqual(tracker.snapshot(), [{ name: "manual-skill", path: join(homedir(), "manual-skill", "SKILL.md"), source: "observed", loaded: true }]);
  tracker.restore([], "/repo"); assert.deepEqual(tracker.snapshot(), []);
});

test("live nested reads load only successful instructions and cannot overwrite a pending outer read", () => {
  const tracker = new SidebarSkills(); tracker.reset([command("review"), command("plan")]);
  tracker.readStart("shared-id", "read", { path: "/skills/plan/SKILL.md" }, "/repo");
  tracker.observeNested([{ name: "read", arguments: { path: "/skills/review/SKILL.md" }, status: "ok" }, { name: "read", arguments: { path: "/skills/plan/SKILL.md" }, status: "error" }], "/repo");
  assert.deepEqual(tracker.snapshot().map(x => [x.name, x.loaded]), [["review", true], ["plan", false]]);
  tracker.readEnd("shared-id", false); assert(tracker.snapshot().every(x => x.loaded));
});

test("restore uses the supplied active branch, including successful nested reads", () => {
  const tracker = new SidebarSkills(); tracker.reset([command("review"), command("plan")]);
  tracker.restore([message("a", "assistant", { content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "/skills/review/SKILL.md" } }] }), message("r", "toolResult", { toolCallId: "r", isError: false, nestedCalls: { calls: [{ id: "nested", name: "read", arguments: { path: "/skills/plan/SKILL.md" }, status: "ok" }], complete: true } })], "/repo");
  assert(tracker.snapshot().every(x => x.loaded));
  tracker.restore([], "/repo"); assert(tracker.snapshot().every(x => !x.loaded));
});

test("explicit skill invocation and structured catalog work with skill commands disabled", () => {
  const tracker = new SidebarSkills(); tracker.reset([]);
  tracker.discover([skill("review")]);
  tracker.observePrompt('<skill name="review" location="/skills/review/SKILL.md">\nInstructions\n</skill>');
  assert.equal(tracker.snapshot()[0]!.loaded, true);
  tracker.reset([]); assert.deepEqual(tracker.snapshot(), []);
});

test("MCP data re-exports remain configuration-only and independent of host modules", () => {
  assert.deepEqual(sidebarMcp([], parseMcpFile('{"mcpServers":{"future":{"type":"future-transport","enabled":false}}}')),
    [{ name: "future", source: "global", enabled: false }]);
});

test("fold config defaults safely and display strings neutralize terminal escape/control data", () => {
  assert.deepEqual(parseSidebarFolds(undefined), { mcp: false, skills: false, prompts: false });
  assert.deepEqual(parseSidebarFolds({ mcp: true, skills: "true" }), { mcp: true, skills: false, prompts: false });
  assert.deepEqual(parseSidebarFolds({ prompts: true, future: "keep" }), { mcp: false, skills: false, prompts: true });
  const text = sidebarText("bad\x1b[2J\n\x1b]52;c;evil\x07server");
  assert(!/[\x00-\x1f\x7f-\x9f]/.test(text)); assert(!text.includes("\x1b[2J"));
  assert.equal(sidebarText("长名字", 2), "长名");
});

test("supported @ read forms match real catalog identities for direct, nested and restored evidence", () => {
  for (const [path, canonical] of [["@/skills/review/SKILL.md", "/skills/review/SKILL.md"], ["@relative/review/SKILL.md", "/repo/relative/review/SKILL.md"], ["@~/skills/review/SKILL.md", join(homedir(), "skills/review/SKILL.md")]]) {
    const s = new SidebarSkills(); s.reset([command("review", "skill", canonical)]);
    const check = () => { assert.equal(s.snapshot().length, 1); assert.equal(s.snapshot()[0]!.loaded, true); };
    s.readStart("read", "read", { path }, "/repo"); s.readEnd("read", false); check();
    s.reset([command("review", "skill", canonical)]); s.observeNested([{ name: "read", arguments: { path }, status: "ok" }], "/repo"); check();
    s.restore([message("call", "assistant", { content: [{ type: "toolCall", name: "read", id: "read", arguments: { path } }] }), message("result", "toolResult", { toolCallId: "read", isError: false })], "/repo"); check();
  }
});
