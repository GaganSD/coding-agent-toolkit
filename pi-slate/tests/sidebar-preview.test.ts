import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Sidebar, DOUBLE_CLICK_MS } from "../extensions/pi-slate/sidebar.ts";
import type { SidebarResources, SidebarSession } from "../extensions/pi-slate/sidebar-data.ts";
import { sessionSidebarSlots } from "../extensions/pi-slate/sidebar-layout.ts";
import { DiffWorkspaceView, type WorkspaceView } from "../extensions/pi-slate/workspace.ts";
import type { BackgroundTask } from "../extensions/pi-slate/background-tasks.ts";

const theme = (code = 32) => ({ fg: (_tone: string, text: string) => `\x1b[${code}m${text}\x1b[0m`, bold: (text: string) => text }) as Theme;
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plain = (lines: string[]) => lines.map(line => stripAnsi(line).replace(/^│ ?/, "").trimEnd());
const session: SidebarSession = { id: "session-a", name: "Sidebar redesign", pid: 8421, cwd: "/tmp/project", model: "sonnet-4.6", thinking: "medium", tokens: 31600, percent: 16, contextWindow: 200000, estimated: false, rate: 82, startedAt: 1000, lastTurnMs: 5000, working: true, turns: 2, messages: 5, usage: { input: 61400, output: 876, total: 62276, cacheRead: 48000, cacheWrite: 6100, cost: 0.12 } };
const resources: SidebarResources = {
  mcp: Array.from({ length: 7 }, (_, i) => ({ name: `server-${i}`, enabled: i !== 2, source: "global" })),
  skills: Array.from({ length: 6 }, (_, i) => ({ name: `skill-${i}`, path: `/tmp/skills/${i}/SKILL.md`, loaded: i === 0, source: "project" })),
  commands: Array.from({ length: 6 }, (_, i) => ({ name: `run-${i}`, source: "extension" })),
  prompts: Array.from({ length: 6 }, (_, i) => ({ name: `prompt-${i}`, source: "prompt", description: `Prompt ${i} description` })),
};
function fixture(rows = 60) {
  let clock = 4000; let renders = 0;
  const sidebar = new Sidebar(() => clock);
  const terminal = { rows, columns: 140 };
  sidebar.attach({ terminal, requestRender() { renders++; }, showOverlay() { return { hide() {} }; } } as unknown as TUI, theme());
  sidebar.setSession(session); sidebar.setResources(resources);
  return { sidebar, terminal, advance: (ms: number) => { clock += ms; }, renders: () => renders };
}
function mouse(y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type: "click", button: "left", x: 2, y, screenX: 112, screenY: y, width: 40, height: 60, shift: false, alt: false, ctrl: false, ...extra };
}
function row(sidebar: Sidebar, text: string, width = 40): number {
  const index = plain(sidebar.render(width)).findIndex(line => line.includes(text));
  assert(index >= 0, `missing ${text}`); return index;
}
function image(id = "a"): WorkspaceView {
  return { id: `image:${id}`, title: `${id}.png`, filePath: `/tmp/${id}.png`, render: (w, h) => Array.from({ length: h }, () => "IMAGE".slice(0, w)), invalidate() {} };
}
function task(i: number): BackgroundTask {
  return { id: `task-${i}`, source: "sample", label: `job-${i}`, kind: "subagent", state: i === 1 ? "waiting" : "running", startedAt: 1000, detail: "No control action is performed" };
}

test("quiet session rail merges usage into context and hides empty shelves", () => {
  const { sidebar } = fixture();
  const lines = plain(sidebar.render(80));
  for (const label of ["SESSION", "Sidebar redesign", "pid 8421", "sonnet-4.6", "16%", "31.6k / 200k · $0.12 · ~82/s", "in 61.4k", "out 876", "cache 48k", "uncached 7.3k", "MCP · 6 enabled", "Skills · 1 loaded", "Prompts · 6"])
    assert(lines.some(line => line.includes(label)), label);
  for (const label of ["Stats", "Tokens · branch", "Commands ·", "Tasks", "Preview", "no selection", "/run-0", "prompt-0"])
    assert(!lines.some(line => line.includes(label)), label);
  assert.match(sidebar.sessionDetails(), /Cache read: 48k/);
});

test("all sizes allocate exact bounded rows, including zero, Unicode, and tiny terminals", () => {
  const { sidebar, terminal } = fixture();
  sidebar.setSession({ ...session, name: "长会话 👩‍💻 café\n\x1b[2J", model: "非常长的模型名字".repeat(8) });
  sidebar.setView(image()); sidebar.setTasks([task(0), task(1), task(2), task(3)]);
  for (let height = 0; height <= 60; height++) {
    terminal.rows = height;
    for (const width of [0, 1, 2, 3, 8, 20, 28, 40, 80]) {
      const lines = sidebar.render(width);
      assert.equal(lines.length, height);
      assert(lines.every(line => visibleWidth(line) <= width), `${width}×${height}`);
      assert(lines.every(line => !line.includes("\x1b[2J") && !line.includes("\n")));
      const slots = sessionSidebarSlots(height, 4, true);
      assert.equal(Object.values(slots).reduce((a, b) => a + b, 0), height);
      assert(Object.values(slots).every(x => x >= 0));
    }
  }
});

test("usage is a single stable label/value lane; full accounting stays in details", () => {
  const { sidebar } = fixture();
  for (const width of [18, 28, 40, 80]) {
    const text = plain(sidebar.render(width)).join("\n");
    assert(text.includes("pid 8421"));
    if (width >= 28) for (const value of ["61.4k", "876", "48k", "7.3k", "$0.12"]) assert(text.includes(value), value);
    if (width >= 40) assert(text.includes("~82/s")); // Narrow rails truncate the merged occupancy tail first.
  }
  assert.match(sidebar.sessionDetails(), /Cache read: 48k · Cache write: 6.1k/);
  assert.match(sidebar.sessionDetails(), /~82 tokens\/sec/);
});

test("native blend header is 13 rows matching the slot constant, ending in the hairline", () => {
  const { sidebar } = fixture();
  assert.equal(sessionSidebarSlots(60, 0, false).header, 13);
  assert.equal(sessionSidebarSlots(30, 0, false).header, 13);
  assert.equal(sessionSidebarSlots(29, 0, false).header, 6, "small-terminal fallback unchanged");
  const lines = plain(sidebar.render(40));
  const hairline = lines.findIndex(line => /^─+$/.test(line));
  assert.equal(hairline, 12, "hairline closes a 13-row header");
  assert(/^Context [█░]+ │ 16%$/.test(lines[6]!), "single context meter row");
  assert(lines[7]!.includes("31.6k / 200k · $0.12 · ~82/s"), "merged occupancy line");
  assert(lines[9]!.includes("in 61.4k") && lines[9]!.includes("cache 48k"));
  assert(lines[10]!.includes("out 876") && lines[10]!.includes("uncached 7.3k"));
});

test("context meter fills the rail with a shaded track and degrades gracefully when narrow", () => {
  const { sidebar } = fixture();
  const meter = (width: number) => {
    const line = plain(sidebar.render(width)).find(line => line.startsWith("Context") || line.endsWith("%"));
    assert(line, `meter at width ${width}`); assert(!line.includes("─"), "meter never uses the divider glyph"); return line;
  };
  assert.equal(meter(80), `Context ${"█".repeat(10)}${"░".repeat(54)} │ 16%`);
  assert.equal(meter(40), `Context ${"█".repeat(4)}${"░".repeat(20)} │ 16%`);
  assert.equal(meter(28), `Context ${"█".repeat(2)}${"░".repeat(10)} │ 16%`);
  sidebar.setSession({ ...session, percent: null });
  assert.equal(meter(40), `Context ${"░".repeat(25)} │ —%`, "null percent is an empty track");
  sidebar.setSession({ ...session, percent: 0 });
  assert.equal(meter(40), `Context ${"░".repeat(25)} │ 0%`);
  sidebar.setSession({ ...session, percent: 100 });
  assert.equal(meter(40), `Context ${"█".repeat(23)} │ 100%`);
  sidebar.setSession(session);
  for (const width of [8, 12, 20]) {
    const line = meter(width);
    assert(visibleWidth(line) <= width - 2, `bounded at ${width}`);
    assert(line.includes("16%"), `percent survives at ${width}`);
    if (width < 16) assert(!line.includes("Context"), `label yields before the percent at ${width}`);
  }
  for (const line of plain(sidebar.render(3))) assert(visibleWidth(line) <= 1, "degenerate rail stays bounded");
});

test("context meter fill follows the theme accent and shifts to the warning tone at 80% and above", () => {
  const codes: Record<string, number> = { muted: 90, dim: 2, accent: 36, warning: 33, text: 37 };
  const toneTheme = { fg: (tone: string, text: string) => `\x1b[${codes[tone] ?? 0}m${text}\x1b[0m`, bold: (text: string) => text } as Theme;
  const { sidebar } = fixture();
  sidebar.setThemeProvider(() => toneTheme); sidebar.invalidate();
  const meterLine = () => sidebar.render(40).find(line => stripAnsi(line).includes("Context"))!;
  for (const [percent, code] of [[0, 36], [79, 36], [80, 33], [100, 33]] as const) {
    sidebar.setSession({ ...session, percent }); sidebar.invalidate();
    const line = meterLine();
    const fill = line.match(/█+/)?.[0] ?? "";
    if (fill) assert(line.includes(`\x1b[${code}m${fill}\x1b[0m`), `${percent}% fills with code ${code}`);
    assert(line.includes("\x1b[2m"), "track and separator stay dim");
  }
  sidebar.setSession({ ...session, percent: null }); sidebar.invalidate();
  assert(!/█/.test(stripAnsi(meterLine())), "null percent fills nothing");
});

test("occupancy and stat rows keep the branch usage inspect action; nulls render as dashes", () => {
  const { sidebar } = fixture(); const inspected: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: title => inspected.push(title) });
  sidebar.setSession({ ...session, estimated: true, usage: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, cost: null } });
  sidebar.handleMouse(mouse(row(sidebar, "~31.6k / 200k · — · ~82/s")));
  sidebar.handleMouse(mouse(row(sidebar, "in —")));
  sidebar.handleMouse(mouse(row(sidebar, "uncached —")));
  assert.deepEqual(inspected, ["Branch usage", "Branch usage", "Branch usage"]);
});

test("a 24-row terminal still renders an image body; a very short one prioritizes tasks", () => {
  const { sidebar, terminal } = fixture(24); sidebar.setView(image()); sidebar.setTasks([task(0)]);
  assert(plain(sidebar.render(40)).some(line => line.includes("IMAGE")), "normal-height thumbnails must not disappear");
  terminal.rows = 14;
  const text = plain(sidebar.render(40)).join("\n");
  assert(text.includes("Tasks")); assert(!text.includes("IMAGE"));
});

test("foldable MCP and Skills sections persist independently and keep counts visible", () => {
  const { sidebar } = fixture(); const saved: unknown[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, persistFold: (section, expanded) => { const folds = { ...sidebar.getFolds(), [section]: expanded }; saved.push(folds); return folds; } });
  assert(!plain(sidebar.render(40)).some(line => line.includes("server-0")));
  const mcp = row(sidebar, "MCP"); sidebar.handleMouse(mouse(mcp));
  assert.equal(sidebar.getFolds().mcp, true);
  assert.equal(sidebar.getFolds().skills, false);
  assert(plain(sidebar.render(40)).some(line => line.includes("server-0")));
  sidebar.handleMouse(mouse(row(sidebar, "Skills")));
  assert.equal(sidebar.getFolds().skills, true);
  assert.deepEqual(saved, [{ mcp: true, skills: false, prompts: false }, { mcp: true, skills: true, prompts: false }]);
  sidebar.handleMouse(mouse(row(sidebar, "MCP")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("server-0")));
  assert(plain(sidebar.render(40)).some(line => line.includes("6 enabled")));
});

test("prompts section folds, scrolls, inspects and shows none when empty", () => {
  const { sidebar } = fixture(); const inspected: string[] = []; const texts: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: (title, text) => { inspected.push(title); texts.push(text); } });
  const collapsed = plain(sidebar.render(40));
  assert(collapsed.some(line => line.includes("› Prompts · 6")), "collapsed heading keeps the count");
  assert(!collapsed.some(line => line.includes("prompt-0")));
  sidebar.handleMouse(mouse(row(sidebar, "Prompts")));
  assert.equal(sidebar.getFolds().prompts, true);
  const expanded = plain(sidebar.render(40));
  assert(expanded.some(line => line.includes("⌄ Prompts · 6")));
  assert(expanded.some(line => line.includes("prompt-0")) && expanded.some(line => line.includes("prompt-2")));
  const promptRow = expanded.find(line => line.includes("prompt-0"))!;
  assert.equal(promptRow.trim(), "prompt-0", "prompt rows carry no redundant right-aligned source column");
  assert(!expanded.some(line => line.includes("prompt-3")), "only three visible");
  assert(!expanded.some(line => line.includes("1–3 / 6")), "scroll range indicator removed");
  sidebar.handleMouse(mouse(row(sidebar, "prompt-0")));
  assert.deepEqual(inspected, ["prompt-0"]);
  assert(texts[0]!.includes("Prompt 0 description") && texts[0]!.includes("Source: prompt"));
  sidebar.handleMouse(mouse(row(sidebar, "prompt-0"), { type: "wheel", wheelDelta: -2 }));
  const scrolled = plain(sidebar.render(40));
  assert(scrolled.some(line => line.includes("prompt-3")));
  assert(!scrolled.some(line => line.includes("prompt-0")));
  sidebar.setResources({ ...resources, prompts: [] });
  assert(plain(sidebar.render(40)).some(line => line.trim() === "none"));
});

test("a failed preference save cannot change the visible fold state", () => {
  const { sidebar } = fixture();
  sidebar.setActions({ copy() {}, openFile() {}, persistFold: () => undefined });
  sidebar.toggleSection("skills");
  assert.equal(sidebar.getFolds().skills, false);
});

test("MCP is limited to five rows; list wheel scroll does not move the session header", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: true, skills: true, prompts: false });
  const before = plain(sidebar.render(40));
  assert.equal(before.filter(line => /server-\d/.test(line)).length, 5);
  assert(!before.some(line => line.includes("server-5")));
  sidebar.handleMouse(mouse(row(sidebar, "server-0"), { type: "wheel", wheelDelta: -1 }));
  const after = plain(sidebar.render(40));
  assert(after.some(line => line.includes("server-5")));
  assert(!after.some(line => line.includes("server-0")));
  assert.equal(after[0], before[0]);
  assert(after.some(line => line.includes("skill-0")), "other list unchanged");
});

test("skill lists scroll and clamp; the rail does not list commands", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: false, skills: true, prompts: false });
  sidebar.handleMouse(mouse(row(sidebar, "skill-0"), { type: "wheel", wheelDelta: -2 }));
  assert(plain(sidebar.render(40)).some(line => line.includes("skill-4")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("/run-0")));
  sidebar.setResources({ ...resources, skills: resources.skills.slice(0, 1), commands: resources.commands.slice(0, 1) });
  assert(plain(sidebar.render(40)).some(line => line.includes("skill-0")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("Commands")));
});

test("read-only task actions preserve the pinned image", () => {
  const { sidebar } = fixture(); const inspected: string[] = [], opened: string[] = [];
  sidebar.setActions({ copy() {}, openFile: x => opened.push(x), inspect: title => inspected.push(title) });
  sidebar.setView(image()); sidebar.pinImage(); sidebar.setTasks([task(0)]);
  sidebar.handleMouse(mouse(row(sidebar, "job-0")));
  assert.deepEqual(inspected, ["job-0"]);
  assert.equal(sidebar.currentViewId(), "image:a");
  assert.equal(sidebar.isImagePinned(), true); assert.deepEqual(opened, []);
});

test("image pin prevents caret replacement; clear only removes selection until caret leaves", () => {
  const { sidebar } = fixture(); sidebar.setView(image("a")); sidebar.pinImage();
  sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:a");
  sidebar.setView(undefined); assert.equal(sidebar.currentViewId(), "image:a");
  sidebar.pinImage(); sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  sidebar.clearImage(); sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), undefined);
  sidebar.setView(undefined); sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  sidebar.setView({ ...image(), id: "diff:file.ts" }); assert.equal(sidebar.currentViewId(), "image:b");
});

test("unpinned image preview hides when the caret leaves and recovers on the next peek", () => {
  const { sidebar } = fixture(); sidebar.setView(image("a"));
  assert.equal(sidebar.currentViewId(), "image:a");
  assert(plain(sidebar.render(40)).some(line => line.includes("Preview")));
  sidebar.setView(undefined);
  assert.equal(sidebar.currentViewId(), undefined);
  const hidden = plain(sidebar.render(40));
  assert(!hidden.some(line => line.includes("Preview") || line.includes("caret")), "hide leaves no preview shelf");
  sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  assert(plain(sidebar.render(40)).some(line => line.includes("Preview")));
});

test("copy/open image hit regions align with painted controls", () => {
  const { sidebar } = fixture(); const copied: string[] = []; const opened: string[] = [];
  sidebar.setActions({ copy: x => copied.push(x), openFile: x => opened.push(x) }); sidebar.setView(image());
  const painted = plain(sidebar.render(80)).join("\n");
  assert(!/caret|\[pin\]|\[clear\]|a\.png/.test(painted), "preview chrome is title plus open/copy");
  const click = (label: string) => { const lines = plain(sidebar.render(80)); const y = lines.findIndex(line => line.includes(label)); assert(y >= 0); return sidebar.handleMouse(mouse(y, { width: 80, x: lines[y]!.indexOf(label) + 2 })); };
  click("[copy]"); assert.deepEqual(copied, ["/tmp/a.png"]);
  click("[open]"); assert.deepEqual(opened, ["/tmp/a.png"]);
});

test("image double-click uses native clickCount or the fallback timer", () => {
  const { sidebar, advance } = fixture(); const opened: string[] = [];
  sidebar.setActions({ copy() {}, openFile: x => opened.push(x) }); sidebar.setView(image());
  const y = row(sidebar, "IMAGE");
  sidebar.handleMouse(mouse(y)); advance(DOUBLE_CLICK_MS + 1); sidebar.handleMouse(mouse(y));
  assert.deepEqual(opened, []); sidebar.handleMouse(mouse(y, { clickCount: 2 }));
  assert.deepEqual(opened, ["/tmp/a.png"]);
});

test("short terminals collapse the image body, keep tasks visible, and scroll middle overflow", () => {
  const { sidebar } = fixture(18); sidebar.setView(image()); sidebar.setTasks([task(0), task(1), task(2)]);
  sidebar.setFolds({ mcp: true, skills: true, prompts: false });
  const lines = plain(sidebar.render(40));
  assert.equal(sidebar.imagePath(), "/tmp/a.png");
  assert(!lines.some(line => line.includes("IMAGE")));
  assert(lines.some(line => line.includes("Tasks")));
  sidebar.handleMouse(mouse(6, { type: "wheel", wheelDelta: -40 }));
  const scrolled = plain(sidebar.render(40));
  assert(scrolled.some(line => /Skills|Prompts|server-\d|skill-\d|prompt-\d/.test(line)));
  assert.equal(scrolled[0], lines[0]);
  assert.equal(sidebar.imagePath(), "/tmp/a.png");
});

test("task shelf scrolls and is not changed by composer height", () => {
  const { sidebar } = fixture(); sidebar.setTasks(Array.from({ length: 7 }, (_, i) => task(i)));
  const initial = plain(sidebar.render(40)); assert.equal(initial.filter(line => /job-\d/.test(line)).length, 3);
  sidebar.handleMouse(mouse(row(sidebar, "job-0"), { type: "wheel", wheelDelta: -2 }));
  assert(plain(sidebar.render(40)).some(line => line.includes("job-4")));
});

test("clock and theme changes invalidate cached output; pure repeated render is reused", () => {
  const { sidebar, advance } = fixture();
  const first = sidebar.render(80); assert.equal(sidebar.render(80), first);
  assert.match(sidebar.sessionDetails(), /Wall time \(this runtime\): 3s/);
  advance(2000); assert.notEqual(sidebar.render(80), first);
  assert.match(sidebar.sessionDetails(), /Wall time \(this runtime\): 5s/);
  let current = theme(31); sidebar.setThemeProvider(() => current);
  assert(sidebar.render(80).some(line => line.includes("\x1b[31m")));
  current = theme(34); sidebar.invalidate();
  assert(sidebar.render(80).some(line => line.includes("\x1b[34m")));
});

test("unknown values and invalid MCP config remain explicit even when folded", () => {
  const { sidebar } = fixture();
  sidebar.setSession({ ...session, percent: null, tokens: null, contextWindow: null, usage: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, cost: null } });
  sidebar.setResources({ ...resources, mcpError: "MCP config unreadable" });
  const lines = plain(sidebar.render(80));
  assert(lines.some(line => line.includes("—%")));
  assert.match(sidebar.sessionDetails(), /Cache read: —/);
  assert(lines.some(line => line.includes("config error")));
  assert(!lines.some(line => line.includes("$0.00")));
});

test("reset discards old images, task rows and hit targets without changing fold preference", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: true, skills: false, prompts: true }); sidebar.setView(image()); sidebar.setTasks([task(0)]);
  sidebar.render(40); sidebar.reset();
  assert.equal(sidebar.currentViewId(), undefined); assert.deepEqual(sidebar.getFolds(), { mcp: true, skills: false, prompts: true });
  assert(!plain(sidebar.render(40)).some(line => line.includes("job-0") || line.includes("server-0")));
  sidebar.dispose(); sidebar.dispose();
});

test("DiffWorkspaceView remains independently usable for transcript diffs", () => {
  const preview = new DiffWorkspaceView("a.ts", "diff", " context\n-removed\n+added", theme());
  const lines = preview.render(80, 3);
  assert.deepEqual(lines.map(stripAnsi), [" context", "-removed", "+added"]);
  assert.equal(preview.handleWheel(1), false);
});
