import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SidebarSplit } from "../extensions/pi-slate/sidebar-split.ts";
import { Sidebar, DOUBLE_CLICK_MS } from "../extensions/pi-slate/sidebar.ts";
import { perfFixture } from "./perf-fixture.ts";
import { EMPTY_PERF } from "../extensions/pi-slate/perf-stats.ts";
import { sidebarUsage, SidebarMcpFiles, type SidebarResources, type SidebarSession, type SidebarUsage } from "../extensions/pi-slate/sidebar-data.ts";
import { DiffWorkspaceView, type WorkspaceView } from "../extensions/pi-slate/workspace.ts";
import { dashboardColumnWidth } from "../extensions/pi-slate/layout.ts";

const theme = (code = 32) => ({ fg: (_tone: string, text: string) => `\x1b[${code}m${text}\x1b[0m`, bold: (text: string) => text }) as Theme;
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plain = (lines: string[]) => lines.map(line => stripAnsi(line).replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd());
const session: SidebarSession = { id: "session-a", pid: 8421, cwd: "/tmp/project", model: "sonnet-4.6", thinking: "medium", tokens: 31600, percent: 16, contextWindow: 200000, estimated: false, rate: 82, startedAt: 1000, lastTurnMs: 5000, working: true, turns: 2, messages: 5, usage: { input: 61400, output: 876, total: 62276, cacheRead: 48000, cacheWrite: 6100, uncached: 7300, cost: 0.12 }, perf: perfFixture(1000) };
const noUsage: SidebarUsage = { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, uncached: null, cost: null };
const resources: SidebarResources = {
  mcp: Array.from({ length: 7 }, (_, i) => ({ name: `server-${i}`, enabled: i !== 2, source: "global", runtime: "idle" as const })),
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

for (const method of ["view", "legacy", "throwing"] as const) {
  test(`sidebar paints only changed visible rows (${method} host)`, () => {
    let now = 4000, view = 0, full = 0, forced = 0, faults = 0;
    let fullBlocked = false, forceBlocked = false;
    const chat = new Text("chat", 0, 0);
    const tui = {
      [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
      layoutRoot: chat as Component | undefined,
      setLayoutRoot(component: Component | undefined) { this.layoutRoot = component; },
      terminal: { rows: 60, columns: 200 },
      requestRender(force?: boolean) {
        if (force) { forced++; if (forceBlocked) throw new Error("force scheduler unavailable"); return; }
        full++;
        if (fullBlocked) throw new Error("content scheduler unavailable");
        if (method === "throwing") this.requestViewRender?.();
      },
      ...(method !== "legacy" ? { requestViewRender() { view++; if (method === "throwing") throw new Error("view scheduler unavailable"); } } : {}),
    };
    const sidebar = new Sidebar(() => now);
    sidebar.attach(tui as unknown as TUI, theme(), undefined, () => { faults++; });
    const split = tui.layoutRoot as SidebarSplit;
    const pane = () => split.children[1]!;
    const first = pane();
    pane().render(40);
    now += 1000;
    sidebar.invalidate();
    sidebar.tick();
    assert.deepEqual([view, full], [0, 0], "an idle second with no visible timer is unchanged even after invalidation");

    const live = { ...session, turnStartedAt: now, perf: EMPTY_PERF };
    sidebar.setSession(live);
    assert.equal(pane() === first, method === "legacy", "supported view renders renew only the sidebar leaf");
    assert.equal(split.children[0], chat);
    assert.match(plain(pane().render(40))[1]!, /0:00$/);
    sidebar.setSession({ ...live, cwd: "/different-detail-only-path" });
    assert.deepEqual([view, full, forced], method === "view" ? [1, 0, 0] : method === "legacy" ? [0, 1, 0] : [1, 0, 1]);
    now += 1000;
    sidebar.tick();
    assert.match(plain(pane().render(40))[1]!, /0:01$/);
    assert.deepEqual([view, full, forced], method === "view" ? [2, 0, 0] : method === "legacy" ? [0, 2, 0] : [1, 0, 2]);

    sidebar.setResources(resources);
    assert.equal(pane().handleMouse?.(mouse(row(sidebar, "MCP")))?.render, false, "fold clicks schedule their own repaint");
    const serverRow = row(sidebar, "server-0");
    const counts = [view, full, forced];
    sidebar.setResources({ ...resources, mcp: resources.mcp.map(server => ({ ...server, source: "project" })) });
    assert.deepEqual([view, full, forced], counts);
    let detail = "";
    sidebar.setActions({ copy() {}, openFile() {}, inspect(_title, text) { detail = text; } });
    pane().handleMouse?.(mouse(serverRow));
    assert.match(detail, /Source: project/, "unchanged rows still get current details and hit regions");
    const wheel = mouse(row(sidebar, "server-0"), { type: "wheel", wheelDelta: -1 });
    assert.equal(split.handleMouse(wheel), undefined);
    assert.deepEqual(pane().handleMouse?.(wheel)?.render, false, "do not ask dispatch for a full frame");
    assert.match(plain(pane().render(40)).join("\n"), /server-5/);
    assert.deepEqual([view - counts[0]!, full - counts[1]!, forced - counts[2]!],
      method === "view" ? [1, 0, 0] : method === "legacy" ? [0, 1, 0] : [0, 0, 1]);
    if (method === "throwing") {
      now += 1000; forceBlocked = true;
      assert.doesNotThrow(() => sidebar.tick(), "the forced fallback may throw too");
      const failed = forced;
      forceBlocked = false;
      sidebar.tick();
      assert.equal(forced, failed + 1, "retry a necessary frame after scheduling failed");
      sidebar.tick();
      assert.equal(forced, failed + 1, "do not retry after scheduling succeeded");
      const beforeResize = [view, full, forced];
      assert.doesNotThrow(() => sidebar.setPreferredWidth(36));
      assert.deepEqual([view, full, forced], beforeResize.map(count => count + 1),
        "layout still tries a normal redraw before forcing when it delegates to the failed scheduler");
    }
    sidebar.setHidden(true);
    const hiddenCounts = [view, full, forced];
    now += 1000;
    sidebar.tick();
    assert.deepEqual([view, full, forced], hiddenCounts);
    assert.equal(faults, method === "throwing" ? 1 : 0, "only a throwing host is diagnosed, once per lease");
    if (method === "view") {
      const beforeReveal = [view, full, forced];
      const leaf = pane();
      forceBlocked = true;
      sidebar.setHidden(false);
      sidebar.setSession({ ...live, model: "replacement-model" });
      assert.deepEqual([view, full, forced], [beforeReveal[0], beforeReveal[1], beforeReveal[2]! + 2],
        "a visible pane change cannot downgrade a pending forced layout redraw");
      assert.equal(pane(), leaf);
      forceBlocked = false;
      sidebar.tick();
      assert.deepEqual([view, full, forced], [beforeReveal[0], beforeReveal[1], beforeReveal[2]! + 3],
        "the next tick retries the original forced redraw");
      sidebar.tick();
      assert.equal(forced, beforeReveal[2]! + 3, "the successful retry clears the pending intent");

      const beforeResize = [view, full, forced];
      fullBlocked = forceBlocked = true;
      sidebar.setPreferredWidth(36);
      assert.deepEqual([view, full, forced], [beforeResize[0], beforeResize[1]! + 1, beforeResize[2]! + 1]);
      fullBlocked = forceBlocked = false;
      sidebar.tick();
      assert.deepEqual([view, full, forced], [beforeResize[0], beforeResize[1]! + 2, beforeResize[2]! + 1],
        "a width change still retries as a layout redraw when pane rows also change");
      assert.equal(pane(), leaf);
    }
  });
}

test("a throwing view getter does not escape or disable ordinary layout retries", () => {
  const requests: boolean[] = [];
  let lookups = 0, faults = 0, layoutBlocked = false, forceBlocked = false;
  const tui = {
    [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
    layoutRoot: new Text("chat", 0, 0) as Component | undefined,
    setLayoutRoot(root: Component | undefined) { this.layoutRoot = root; },
    terminal: { rows: 60, columns: 200 },
    get requestViewRender() { lookups++; throw new Error("view capability unavailable"); },
    requestRender(force = false) {
      requests.push(force);
      if (force ? forceBlocked : layoutBlocked) throw new Error("redraw unavailable");
    },
  };
  const sidebar = new Sidebar(() => 4000);
  sidebar.attach(tui as unknown as TUI, theme(), undefined, () => { faults++; });
  assert.doesNotThrow(() => sidebar.setSession(session));
  assert.deepEqual(requests, [true]);
  assert.deepEqual([lookups, faults], [1, 1]);

  layoutBlocked = forceBlocked = true;
  sidebar.setPreferredWidth(36);
  assert.deepEqual(requests, [true, false, true]);
  layoutBlocked = false;
  sidebar.tick();
  assert.deepEqual(requests, [true, false, true, false], "the layout retry succeeds without a forced redraw");
  sidebar.tick();
  assert.deepEqual(requests, [true, false, true, false]);
  assert.deepEqual([lookups, faults], [1, 1]);
});

test("quiet session rail merges usage into context and hides empty shelves", () => {
  const { sidebar } = fixture();
  const lines = plain(sidebar.render(80));
  for (const label of ["Working", "session-", "sonnet-4.6", "16%", "31.6k/200k", "SPEED", "CACHE", "78.18% hit", "MCP · 6 Enabled", "Skills · 1 Loaded", "Prompts · 6"])
    assert(lines.some(line => line.includes(label)), label);
  for (const label of ["Stats", "Tokens · branch", "Commands ·", "Preview", "no selection", "/run-0", "prompt-0"])
    assert(!lines.some(line => line.includes(label)), label);
  assert.match(sidebar.sessionDetails(), /Cache read: 48k/);
});

test("session identity keeps the ID while a separate title copies the full name", () => {
  const { sidebar } = fixture();
  const copied: string[] = [];
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  const name = "Slate 的会话标题";
  sidebar.setSession({ ...session, id, name });
  sidebar.setActions({ copy: (value) => copied.push(value), openFile() {} });
  const lines = plain(sidebar.render(40));
  assert(lines[2]!.startsWith(name) && lines[2]!.endsWith("01234567"), "title left, short ID right, on one row");
  sidebar.handleMouse(mouse(2, { x: 37 }));
  sidebar.handleMouse(mouse(2));
  assert.deepEqual(copied, [id, name]);
  assert.ok(sidebar.sessionDetails().startsWith(`Session ${id} · PID 8421\n`));
  assert.match(sidebar.sessionDetails(), /Title: Slate 的会话标题/);
  sidebar.setSession({ ...session, id: "" });
  assert.match(plain(sidebar.render(40))[2]!, /^Session\s+—$/, "unnamed sessions fall back to a Session heading");
  assert.match(sidebar.sessionDetails(), /Title: —/);
});

test("long titles stay bounded, copy without ellipsis, and refresh on same-session renames", () => {
  const { sidebar } = fixture();
  const copied: string[] = [];
  const name = "中文会话 👩‍💻 café —— ".repeat(100).trim();
  assert(name.length > 512, "full title survives the default sidebar text limit");
  sidebar.setActions({ copy: value => copied.push(value), openFile() {} });
  sidebar.setSession({ ...session, name: `\x1b[31m${name}\x1b[0m\n` });
  const before = sidebar.render(28);
  const title = plain(before)[2]!;
  assert.match(title, /…/);
  assert(before.every(line => visibleWidth(line) <= 28));
  assert(!before.some(line => line.includes("\x1b[31m") || line.includes("\n")), "untrusted title styling and line breaks are removed");
  sidebar.handleMouse(mouse(2, { width: 28 }));
  assert.deepEqual(copied, [name], "copy uses the complete sanitized title, not its painted ellipsis");
  assert(sidebar.sessionDetails().includes(`Title: ${name}\n`));
  sidebar.setSession({ ...session, name: "改名后的会话" });
  sidebar.handleMouse(mouse(2, { width: 28 }));
  assert.deepEqual(copied, [name, name], "a click before repaint still copies the painted title");
  const after = sidebar.render(28);
  assert.notEqual(after, before, "renaming invalidates cached rows even with the same clock and ID");
  assert(plain(after)[2]!.startsWith("改名后的会话"));
  sidebar.setSession({ ...session, name: " \n\x1b[2J" });
  sidebar.handleMouse(mouse(2, { width: 28 }));
  assert.deepEqual(copied, [name, name, "改名后的会话"], "the renamed title stays clickable until its replacement paints");
  assert.match(plain(sidebar.render(28))[2]!, /^Session/);
  assert.equal(sidebar.handleMouse(mouse(2, { width: 28 })), undefined, "an empty title has no stale copy hit");
  assert.deepEqual(copied, [name, name, "改名后的会话"]);
});

test("top title uses bold theme accent and follows theme changes independently of the identity", () => {
  const { sidebar } = fixture();
  const name = "特别的标题 👩‍💻 café";
  const copied: string[] = [];
  const titleTheme = (accent: number) => ({
    fg: (tone: string, text: string) => `\x1b[${tone === "accent" ? accent : tone === "mdHeading" ? 33 : 37}m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  }) as Theme;
  let current = titleTheme(36);
  sidebar.setThemeProvider(() => current);
  sidebar.setSession({ ...session, name });
  sidebar.setActions({ copy: value => copied.push(value), openFile() {} });
  for (const width of [8, 28, 40, 80]) {
    const lines = sidebar.render(width);
    assert.match(lines[2]!, /\x1b\[36m/, "title uses accent rather than body text or heading color");
    assert.match(lines[2]!, /\x1b\[1m/, "title is bold");
    assert(lines.every(line => visibleWidth(line) <= width));
  }
  const before = sidebar.render(40);
  current = titleTheme(35);
  const after = sidebar.render(40);
  assert.notEqual(after, before, "theme changes refresh the cached title");
  assert.match(after[2]!, /\x1b\[35m/);
  assert.doesNotMatch(after[2]!, /\x1b\[36m/);
  assert.match(after[2]!, /\x1b\[1m/);
  sidebar.handleMouse(mouse(2));
  assert.deepEqual(copied, [name], "copy contains no styling");
});

test("all sizes allocate exact bounded rows, including zero, Unicode, and tiny terminals", () => {
  const { sidebar, terminal } = fixture();
  sidebar.setSession({ ...session, id: "长会话 👩‍💻 café\n\x1b[2J", name: "标题 👩‍💻 café\n\x1b[2J".repeat(8), model: "非常长的模型名字".repeat(8) });
  sidebar.setView(image());
  for (let height = 0; height <= 60; height++) {
    terminal.rows = height;
    for (const width of [0, 1, 2, 3, 8, 20, 28, 40, 80]) {
      const lines = sidebar.render(width);
      assert.equal(lines.length, height);
      assert(lines.every(line => visibleWidth(line) <= width), `${width}×${height}`);
      assert(lines.every(line => !line.includes("\x1b[2J") && !line.includes("\n")));
    }
  }
});

test("speed and cache replace the usage lane; full accounting stays in details", () => {
  const { sidebar } = fixture();
  for (const width of [18, 28, 40, 80]) {
    const text = plain(sidebar.render(width)).join("\n").replace(/ {2,}/g, " ");
    assert(text.includes("CACHE") && text.includes("SPEED"));
    assert.doesNotMatch(text, /● streaming/);
    if (width >= 28) for (const value of ["read 48k", "new 7.3k", "$0.12", "78.18%"]) assert(text.includes(value), value);
    assert(!/\bCached\b|Uncached|\bPID\b/.test(text), "old usage rows are gone");
  }
  assert.match(sidebar.sessionDetails(), /Cache read: 48k · Cache write: 6.1k/);
  assert.match(sidebar.sessionDetails(), /~82 tokens\/sec/);
  assert.match(sidebar.sessionDetails(), /PID 8421/);
  assert.match(sidebar.sessionDetails(), /Speed & cache\n.*output tokens ÷ Pi's recorded provider-stream duration/);
  assert.match(sidebar.sessionDetails(), /Cache hit % = cache read ÷ \(uncached \+ cache read \+ cache write\)/);
});

test("the two-column header height stays fixed across terminal tiers", () => {
  const { sidebar, terminal } = fixture();
  sidebar.setSession({ ...session, name: "Slate session title" });
  for (const rows of [60, 44, 43, 30]) {
    terminal.rows = rows;
    assert.equal(plain(sidebar.render(40)).findIndex(line => /^├─+┤$/.test(line)), 14, `rows ${rows}`);
  }
  terminal.rows = 60;
  const lines = plain(sidebar.render(40));
  assert.match(lines[0]!, /^┌─+┐$/, "top bar");
  assert.match(lines.at(-1)!, /^└─+┘$/, "bottom bar");
  assert.match(lines[1]!, /^○ Idle|^● Working/);
  assert(lines[2]!.startsWith("Slate session title") && lines[2]!.endsWith("session-"));
  assert(lines[5]!.startsWith("CONTEXT") && lines[5]!.includes("16%") && lines[5]!.includes("31.6k/200k"));
  assert(/^[█-▏░]+$/.test(lines[6]!) && lines[7] === "", "one-row context bar");
});

test("context row keeps the heading grammar and degrades gracefully when narrow", () => {
  const { sidebar } = fixture(30);
  const context = (width: number) => {
    const line = plain(sidebar.render(width)).find(line => line.startsWith("CONTEXT") || /\d+%|—/.test(line) && !line.includes("tok/s") && !line.includes("Idle") && !line.includes("Working"));
    assert(line, `context at width ${width}`); return line;
  };
  assert.match(context(80), /^CONTEXT {2,}16% {2}31\.6k\/200k$/);
  assert.match(context(40), /^CONTEXT {2,}16% {2}31\.6k\/200k$/);
  sidebar.setSession({ ...session, percent: null });
  assert.match(context(40), /^CONTEXT .*—/, "unknown percent shows a dash");
  sidebar.setSession(session);
  for (const width of [20, 28]) {
    const line = context(width);
    assert(visibleWidth(line) <= width - 4, `bounded at ${width}`);
    assert(line.includes("16%"), `percent survives at ${width}`);
  }
  for (const line of sidebar.render(3)) assert(visibleWidth(line) <= 3, "degenerate rail stays bounded");
});

test("context meter keeps the theme accent at every usage level", () => {
  const codes: Record<string, number> = { muted: 90, dim: 2, accent: 36, warning: 33, text: 37 };
  const toneTheme = { fg: (tone: string, text: string) => `\x1b[${codes[tone] ?? 0}m${text}\x1b[0m`, bold: (text: string) => text } as Theme;
  const { sidebar } = fixture();
  sidebar.setThemeProvider(() => toneTheme);
  const meterLine = () => sidebar.render(40).find(line => /^│ ?[█-▏░]{4}/.test(stripAnsi(line)))!;
  for (const percent of [0, 79, 80, 88, 100]) {
    sidebar.setSession({ ...session, percent });
    const line = meterLine();
    const fill = stripAnsi(line).match(/[█-▏]+/)?.[0] ?? "";
    if (percent > 0) assert(fill && line.includes(toneTheme.fg("accent", fill)), `${percent}% uses the theme accent`);
    if (percent < 100) assert(line.includes("\x1b[2m"), "track stays dim");
    const heading = sidebar.render(40).find(line => stripAnsi(line).includes("CONTEXT"))!;
    assert(heading.includes(toneTheme.fg("text", `${percent}%`)), "percentage keeps the normal value color");
  }
  sidebar.setSession({ ...session, percent: null });
  assert(!/[█-▏]/.test(stripAnsi(meterLine())), "null percent fills nothing");
});

test("context rows keep the branch usage inspect action; nulls render as dashes", () => {
  const { sidebar } = fixture(); const inspected: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: title => inspected.push(title) });
  sidebar.setSession({ ...session, estimated: true, usage: noUsage });
  const heading = row(sidebar, "~31.6k/200k");
  sidebar.handleMouse(mouse(heading));
  sidebar.handleMouse(mouse(heading + 1));
  assert.deepEqual(inspected, ["Branch usage", "Branch usage"]);
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
  assert(plain(sidebar.render(40)).some(line => line.includes("6 Enabled")));
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

test("MCP dots show runtime while details retain configured state", () => {
  const { sidebar } = fixture(); const details: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: (_title, text) => details.push(text) });
  sidebar.setResources({ ...resources, mcp: [
    { name: "enabled-server", enabled: true, source: "global", runtime: "active" },
    { name: "disabled-server", enabled: false, source: "global", runtime: "error" },
    { name: "unknown-server", enabled: null, source: "extension", runtime: "idle" },
  ] });
  sidebar.setThemeProvider(() => ({
    fg: (tone: string, text: string) => tone === "success" ? `\x1b[32m${text}\x1b[0m` : tone === "error" ? `\x1b[31m${text}\x1b[0m` : tone === "dim" ? `\x1b[90m${text}\x1b[0m` : text,
    bold: (text: string) => text,
  }) as Theme);
  sidebar.setFolds({ mcp: true, skills: true, prompts: false });
  const rendered = sidebar.render(80), lines = plain(rendered);
  for (const expected of ["● enabled-server", "● disabled-server", "● unknown-server", "● skill-0", "○ skill-1"])
    assert(lines.some(line => line.trim() === expected), expected);
  assert(rendered.some(line => line.includes("\x1b[32m●\x1b[0m") && line.includes("enabled-server")));
  assert(rendered.some(line => line.includes("\x1b[31m●\x1b[0m") && line.includes("disabled-server")));
  assert(rendered.some(line => line.includes("\x1b[90m●\x1b[0m") && line.includes("unknown-server")));
  sidebar.handleMouse(mouse(row(sidebar, "unknown-server")));
  assert.match(details[0]!, /^— \(configured state\)\nRuntime: idle/);
  sidebar.handleMouse(mouse(row(sidebar, "disabled-server")));
  assert.match(details[1]!, /^disabled \(configured state\)\nRuntime: last completed call failed/);
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

test("the image shelf follows the caret and ignores non-image views", () => {
  const { sidebar } = fixture(); sidebar.setView(image("a"));
  sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  sidebar.setView({ ...image(), id: "diff:file.ts" }); assert.equal(sidebar.currentViewId(), "image:b");
  sidebar.setView(undefined); assert.equal(sidebar.currentViewId(), undefined);
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

test("the compact rail keeps the image while the middle scrolls", () => {
  const { sidebar } = fixture(30); sidebar.setView(image());
  sidebar.setFolds({ mcp: true, skills: true, prompts: false });
  const lines = plain(sidebar.render(40));
  assert.equal(sidebar.currentViewId(), "image:a");
  assert(lines.some(line => line.includes("IMAGE")));
  sidebar.handleMouse(mouse(row(sidebar, "MCP"), { type: "wheel", wheelDelta: -40 }));
  const scrolled = plain(sidebar.render(40));
  assert(scrolled.some(line => /Skills|Prompts|skill-\d|prompt-\d/.test(line)));
  assert.notDeepEqual(scrolled, lines);
  assert.equal(scrolled[0], lines[0]);
  assert.equal(sidebar.currentViewId(), "image:a");
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
  sidebar.setSession({ ...session, percent: null, tokens: null, contextWindow: null, usage: noUsage });
  sidebar.setResources({ ...resources, mcpError: "MCP config unreadable" });
  const lines = plain(sidebar.render(80));
  assert(lines.some(line => /^CONTEXT\s+—\s+—\/—$/.test(line)));
  assert.match(sidebar.sessionDetails(), /Cache read: —/);
  assert(lines.some(line => line.includes("MCP · 6 Enabled · 1 Error")));
  assert(!lines.some(line => line.includes("MCP config unreadable") || line.includes("config error")));
  sidebar.setThemeProvider(() => ({ fg: (tone: string, text: string) => tone === "error" ? `\x1b[31m${text}\x1b[0m` : text, bold: (text: string) => text }) as Theme);
  assert(sidebar.render(80).some(line => line.includes("\x1b[31m · 1 Error\x1b[0m")));
  assert(lines.some(line => /read +—/.test(line)) && lines.some(line => /new +—/.test(line)));
  assert(!lines[1]!.includes("$"));
});

test("unknown MCP declarations are neutral when folded or expanded and inspection explains the boundary", () => {
  const { sidebar } = fixture();
  const details: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: (_title, text) => details.push(text) });
  sidebar.setResources({ ...resources, mcp: [{ name: "unknown-server", enabled: null, source: "global", runtime: "idle" }] });
  const folded = plain(sidebar.render(80));
  assert(folded.some(line => line.includes("› MCP · —")));
  assert(!folded.some(line => /Error|Warning|0 Enabled/.test(line)));
  sidebar.setFolds({ mcp: true, skills: false, prompts: false });
  const expanded = plain(sidebar.render(80));
  assert(expanded.some(line => line.includes("⌄ MCP · —")));
  assert(expanded.some(line => line.trim() === "● unknown-server"));
  sidebar.setThemeProvider(() => ({ fg: (tone: string, text: string) => tone === "warning" ? `\x1b[33m${text}\x1b[0m` : tone === "error" ? `\x1b[31m${text}\x1b[0m` : text, bold: (text: string) => text }) as Theme);
  assert(!/\x1b\[(?:33|31)m/.test(sidebar.render(80).filter(line => /MCP|unknown-server/.test(stripAnsi(line))).join("\n")));
  sidebar.handleMouse(mouse(row(sidebar, "unknown-server")));
  assert.match(details[0]!, /Slate does not validate MCP/);
  assert.match(details[0]!, /Use \/mcp/);
});

test("readable MCP declarations render without a host adapter; actual file failures remain visible", async t => {
  const root = await mkdtemp(join(tmpdir(), "slate-mcp-configured-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "mcp.json"), '\uFEFF{"mcpServers":{"docs":{"type":"future-transport"}}}');
  const snapshot = new SidebarMcpFiles().snapshot(root, root, false, []);
  const { sidebar } = fixture();
  sidebar.setResources({ skills: [], commands: [], prompts: [], ...snapshot });
  const lines = plain(sidebar.render(80));
  assert.equal(snapshot.mcpError, undefined);
  assert.equal(snapshot.mcp[0]!.enabled, true);
  assert(lines.some(line => line.includes("MCP · 1 Enabled")));
  assert(!lines.some(line => /Error|Warning/.test(line)));
  sidebar.setResources({ skills: [], commands: [], prompts: [], ...snapshot, mcpError: "MCP config unreadable" });
  assert(plain(sidebar.render(80)).some(line => line.includes("MCP · 1 Enabled · 1 Error")));
});

test("reset discards old titles, images and hit targets without changing fold preference", () => {
  const { sidebar } = fixture();
  const copied: string[] = [];
  sidebar.setActions({ copy: value => copied.push(value), openFile() {} });
  sidebar.setSession({ ...session, name: "Old title" });
  sidebar.setFolds({ mcp: true, skills: false, prompts: true }); sidebar.setView(image());
  const titleRow = row(sidebar, "Old title");
  sidebar.reset();
  assert.equal(sidebar.handleMouse(mouse(titleRow)), undefined, "reset clears the old title hit before another paint");
  assert.deepEqual(copied, []);
  assert.equal(sidebar.currentViewId(), undefined); assert.deepEqual(sidebar.getFolds(), { mcp: true, skills: false, prompts: true });
  assert(!plain(sidebar.render(40)).some(line => line.includes("Old title") || line.includes("server-0")));
  sidebar.dispose(); sidebar.dispose();
});

test("DiffWorkspaceView remains independently usable for transcript diffs", () => {
  const preview = new DiffWorkspaceView("a.ts", "diff", " context\n-removed\n+added", theme());
  const lines = preview.render(80, 3);
  assert.deepEqual(lines.map(stripAnsi), [" context", "-removed", "+added"]);
  assert.equal(preview.handleWheel(1), false);
});

test("sidebar closes both rails and joins every horizontal divider at the right edge", () => {
  const { sidebar } = fixture();
  for (const width of [4, 8, 28, 40, 80]) {
    const lines = sidebar.render(width).map(stripAnsi);
    assert.equal(lines[0], "┌" + "─".repeat(width - 2) + "┐");
    assert.equal(lines.at(-1), "└" + "─".repeat(width - 2) + "┘");
    assert.equal(lines.find((l, i) => i > 0 && l.startsWith("├")), "├" + "─".repeat(width - 2) + "┤", "header divider joins both rails");
    for (const line of lines) {
      assert.equal(visibleWidth(line), width);
      assert.match(line, /^[│┌├└]/);
      assert.match(line, /[│┐┤┘]$/);
    }
  }
  sidebar.setView(image());
  for (const line of sidebar.render(40).map(stripAnsi)) assert.match(line, /[│┐┤┘]$/, "preview rows keep the right border");
});

test("working status shows the running turn's elapsed time and ticks each second", () => {
  const { sidebar, advance } = fixture();
  sidebar.setSession({ ...session, working: true, turnStartedAt: 4000 - 42_000 });
  assert.match(plain(sidebar.render(44))[1]!, /● Working\s+\$0\.12 · 0:42$/);
  assert.match(plain(sidebar.render(24))[1]!, /● Working\s+0:42$/);
  advance(1000);
  assert.match(plain(sidebar.render(44))[1]!, /0:43$/);
  sidebar.setSession({ ...session, working: false, turnStartedAt: null });
  assert.match(plain(sidebar.render(44))[1]!, /○ Idle · 2 turns\s+\$0\.12 · last 5s$/);
});

test("status spend is normal text, shown only for positive known cost", () => {
  const { sidebar } = fixture();
  const tinted = (tone: string, text: string) => tone === "text" ? `\x1b[37m${text}\x1b[0m` : tone === "dim" ? `\x1b[90m${text}\x1b[0m` : text;
  sidebar.setThemeProvider(() => ({ fg: tinted, bold: (text: string) => text }) as Theme);
  for (const cost of [0.09, null, 0]) {
    sidebar.setSession({ ...session, working: false, turns: 1, lastTurnMs: 95_000, usage: { ...session.usage, cost } });
    const lines = sidebar.render(44);
    const status = lines[1]!;
    assert.equal(status.includes(tinted("text", "$0.09")), cost === 0.09);
    assert(status.includes(tinted("dim", "last 1m 35s")));
    assert.equal(lines.slice(2).some(line => line.includes("$")), false);
    if (cost === 0.09) {
      const narrow = sidebar.render(28);
      assert.match(plain(narrow)[1]!, /^○ Idle · 1 turn +\$0\.09$/);
      assert.equal(visibleWidth(narrow[1]!), 28);
    } else assert(!status.includes("$"));
  }
});

test("sub-cent spend that rounds to zero does not displace the last turn", () => {
  const { sidebar } = fixture();
  const status = (cost: number, width: number) => {
    sidebar.setSession({ ...session, working: false, turns: 1, lastTurnMs: 95_000, usage: { ...session.usage, cost } });
    return plain(sidebar.render(width))[1]!;
  };
  for (const width of [28, 44]) {
    assert.match(status(0.0049, width), /last 1m 35s$/);
    assert.doesNotMatch(status(0.0049, width), /\$/);
    assert.match(status(0.005, width), /\$0\.01\b/);
  }
});

test("the first reply does not shift MCP at 100×30 with a preview", () => {
  const { sidebar, terminal } = fixture(30);
  terminal.columns = 100;
  const width = dashboardColumnWidth(terminal.columns, terminal.rows);
  sidebar.setView(image());
  sidebar.setSession({ ...session, usage: sidebarUsage([]), perf: EMPTY_PERF });
  const mcp = row(sidebar, "MCP", width);
  sidebar.setSession(session);
  assert(row(sidebar, "read 48k", width) > 0);
  assert.equal(row(sidebar, "MCP", width), mcp);
});

test("the first reply fills the performance charts without shifting the resource list", () => {
  for (const height of [38, 60]) for (const width of [24, 30, 40, 50, 51, 56]) {
    const { sidebar } = fixture(height);
    sidebar.setSession({ ...session, percent: 0, tokens: 0, usage: sidebarUsage([]), perf: EMPTY_PERF });
    const empty = plain(sidebar.render(width));
    const mcp = empty.findIndex(line => line.includes("MCP"));
    assert(mcp > 0);
    assert(empty.some(line => line.includes("— tok/s")));
    assert(empty.some(line => line.includes("—% hit")));
    assert(empty.some(line => /read +0/.test(line)));
    assert(empty.some(line => /new +0/.test(line)));
    assert(!empty[1]!.includes("$"));
    sidebar.setSession(session);
    const full = plain(sidebar.render(width)).map(line => line.replace(/ {2,}/g, " "));
    assert.equal(full.findIndex(line => line.includes("MCP")), mcp, `${width}×${height}`);
    for (const stat of ["avg 26.7", "peak 45.0", "78.18% hit", "read 48k", "new 7.3k"]) {
      assert(full.some(line => line.includes(stat)), `missing ${stat} at ${width}×${height}`);
    }
  }
});

const perfPreviewSession: SidebarSession = { ...session, working: false, lastTurnMs: 95_000, turns: 1,
  usage: { input: 118_378, output: 1700, total: 120_078, cacheRead: 87_600, cacheWrite: 578, uncached: 30_200, cost: 0.09 },
  perf: { timedReplies: 10, rates: [9, 16, 12, 20, 21, 17, 24, 20, 27.2, 22.4], peak: 27.2,
    turn: { output: 1700, rate: 20.9 }, cache: { lastHit: 0.74 } } };

test("performance cards switch at 28 inner columns and align within the painted rails", () => {
  const { sidebar } = fixture(38);
  const populated = perfPreviewSession;
  const empty: SidebarSession = { ...session, working: false, lastTurnMs: null, turns: 0, usage: sidebarUsage([]), perf: EMPTY_PERF };
  const dividers = new Map<number, number>();
  for (const inner of [24, 27, 28, 32, 40]) for (const [state, data] of [["empty", empty], ["populated", populated]] as const) {
    sidebar.setSession(data);
    const painted = sidebar.render(inner + 4);
    assert(painted.every(line => visibleWidth(line) === inner + 4));
    const lines = plain(painted);
    const speed = lines.findIndex(line => line.startsWith("SPEED"));
    const cache = lines.findIndex(line => line.includes("CACHE"));
    const track = state === "empty" ? "─" : "━";
    if (inner < 28) {
      assert(cache > speed);
      assert.equal(lines[cache - 1], "");
      assert.equal(lines[cache + 1], track.repeat(inner));
    } else {
      const left = Math.floor((inner - 2) / 2);
      const offset = left + 2;
      const half = (row: number) => [lines[speed + row]!.slice(0, left).trimEnd(), lines[speed + row]!.slice(offset)];
      assert.equal(cache, speed);
      assert.equal(lines[speed]!.indexOf("CACHE"), offset);
      assert.deepEqual(half(1), state === "empty" ? ["— tok/s", "—% hit"] : ["22.4 tok/s", "74% hit"]);
      assert.match(half(2)[0]!, state === "empty" ? /^─+$/ : /^[▁-█]+$/);
      assert.equal(half(2)[1], track.repeat(inner - offset));
      assert.deepEqual([3, 4].map(half), state === "empty"
        ? [["avg  —", "read  0"], ["peak —", "new   0"]]
        : [["avg  20.9", "read  87.6k"], ["peak 27.2", "new   30.2k"]]);
    }
    const divider = lines.findIndex(line => line.startsWith("├"));
    if (state === "empty") dividers.set(inner, divider);
    else assert.equal(divider, dividers.get(inner), `header height at ${inner}`);
    assert.equal(lines[divider - 1], "");
    assert.notEqual(lines[divider - 2], "");
    assert.doesNotMatch(lines.slice(speed, divider).join("\n"), /\bwrite\b/);
  }
});

test("full-tier performance previews show no cache savings estimate", () => {
  const { sidebar } = fixture(60);
  sidebar.setSession({ ...perfPreviewSession, usage: { ...perfPreviewSession.usage, input: 117_800, total: 119_500, cacheWrite: 0 } });
  for (const inner of [24, 30, 47, 49, 52]) {
    const painted = sidebar.render(inner + 4);
    const lines = plain(painted);
    const speed = lines.findIndex(line => line.startsWith("SPEED"));
    const divider = lines.findIndex(line => line.startsWith("├"));
    assert.doesNotMatch(lines.slice(speed, divider).join("\n"), /\bsaved\b/);
    assert(painted.every(line => visibleWidth(line) === inner + 4));
  }
});
