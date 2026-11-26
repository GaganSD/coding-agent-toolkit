import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath, SYSTEM_THEME_NAME } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ComposerEditor, type ComposerSource } from "../extensions/pi-slate/composer.ts";
import { dashboardColumnWidth, formatCompactTokenCount, parseSlateArgs } from "../extensions/pi-slate/layout.ts";
import { SLATE_NATIVE_THEME, SLATE_THEME } from "../extensions/pi-slate/install-defaults.ts";
import { sessionSidebarSlots, sidebarCost } from "../extensions/pi-slate/sidebar-layout.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import { perfFixture } from "./perf-fixture.ts";
import type { SidebarSession } from "../extensions/pi-slate/sidebar-data.ts";

const theme = loadThemeFromPath(new URL("../themes/tokyo-night.json", import.meta.url).pathname, "truecolor");
const session: SidebarSession = { id: "example-session", pid: 8421, cwd: "/tmp/project",
  model: "sample-model", thinking: "medium", tokens: 55000, percent: 11, contextWindow: 500000,
  estimated: false, rate: 82, startedAt: 1000, lastTurnMs: 14000, working: true, turns: 4, messages: 8,
  usage: { input: 128400, output: 6800, total: 135200, cacheRead: 94000, cacheWrite: 22000, uncached: 12400, cost: 1.24 }, perf: perfFixture(1000) };

test("bundled default Tokyo Night loads with the native validator and restrained backgrounds", () => {
  assert.equal(SLATE_THEME, "tokyo-night"); assert.equal(theme.name, SLATE_THEME);
  assert.equal(SLATE_NATIVE_THEME, SYSTEM_THEME_NAME);
  assert.match(theme.fg("accent", "x"), /38;2;122;162;247/);
  assert.match(theme.fg("text", "x"), /38;2;192;202;245/);
  assert.equal(theme.getBgAnsi("toolPendingBg"), theme.getBgAnsi("userMessageBg"));
  assert.equal(theme.getBgAnsi("toolSuccessBg"), theme.getBgAnsi("userMessageBg"));
  assert.notEqual(theme.getBgAnsi("customMessageBg"), theme.getBgAnsi("userMessageBg"));
});

test("theme selection belongs to the picker: /slate theme and /slate style take no arguments", () => {
  assert.deepEqual(parseSlateArgs("theme"), { ok: true, kind: "theme-menu" });
  for (const args of ["theme default", "theme tokyo-night", "theme tokyonight", "theme black-metal",
    "theme mocha default", "theme mocha mauve", "theme latte", "theme tokyo-night extra"]) {
    assert.deepEqual(parseSlateArgs(args), { ok: false }, args);
  }
  for (const args of ["style", "style default", "style mauve"]) {
    assert.deepEqual(parseSlateArgs(args), { ok: false }, args);
  }
});

test("compact viewport hides the rail without changing stored width or focus", () => {
  assert.equal(dashboardColumnWidth(140, 40), 28);
  assert.equal(dashboardColumnWidth(140, 29, 40), 0);
  assert.equal(dashboardColumnWidth(99, 40, 40), 0);
  assert.equal(dashboardColumnWidth(100, 30, 40), 40);
  assert.equal(dashboardColumnWidth(140, 40, -1), 0);
});

test("empty shelves allocate zero rows and all allocations remain bounded", () => {
  for (let height = 0; height < 80; height++) {
    assert.equal(sessionSidebarSlots(height, 11, false).image, 0);
    for (const image of [false, true]) {
      const values = Object.values(sessionSidebarSlots(height, 11, image));
      assert.equal(values.reduce((a, b) => a + b, 0), height);
      assert(values.every(n => n >= 0));
    }
  }
});

test("growing usage and money keep a stable label lane and value edge with the real theme", () => {
  const sidebar = new Sidebar(() => 10000);
  sidebar.attach({ terminal: { rows: 50, columns: 140 }, requestRender() {} } as unknown as TUI, theme);
  for (const width of [28, 40, 80]) {
    for (const value of [0, 999, 128400, 999900000, 1e12, 1e20, 1e308, null]) {
      sidebar.setSession({ ...session, usage: { ...session.usage, input: value, output: value, cost: value } });
      const rows = sidebar.render(width).map(stripVTControlCharacters);
      assert(rows.every(row => visibleWidth(row) === width), `bounded rows at ${width} for ${value}`);
      const status = rows[1]!;
      if (value !== null && value > 0) assert(status.includes(sidebarCost(value)), `${sidebarCost(value)} on the status line`);
      else assert(!status.includes("$"));
    }
  }
  assert.equal(formatCompactTokenCount(1e9), "1B"); assert.equal(formatCompactTokenCount(1e12), "1T");
  assert.equal(sidebarCost(null), "—"); assert.equal(sidebarCost(Number.NaN), "—");
  assert.equal(sidebarCost(-1), "—"); assert.equal(sidebarCost(1.24), "$1.24");
  assert.equal(sidebarCost(1e308), "$1.0e+308");
  sidebar.dispose();
});

test("high context usage and cache reads follow live accent changes within the same theme family", () => {
  const lavender = loadThemeFromPath(new URL("../themes/catppuccin-mocha-lavender.json", import.meta.url).pathname, "truecolor");
  const peach = loadThemeFromPath(new URL("../themes/catppuccin-mocha-peach.json", import.meta.url).pathname, "truecolor");
  let active = lavender;
  const sidebar = new Sidebar(() => 10000);
  sidebar.attach({ terminal: { rows: 40, columns: 140 }, requestRender() {} } as unknown as TUI, lavender);
  sidebar.setThemeProvider(() => active);
  sidebar.setSession({ ...session, percent: 88 });
  const contextFill = "█".repeat(21) + "▏";
  const cacheBar = () => sidebar.render(28).find(row => stripVTControlCharacters(row).includes("━".repeat(24)))!;
  const reads = "━".repeat(18);
  assert.equal(lavender.fg("success", reads), peach.fg("success", reads), "status color is fixed across these accents");
  assert(cacheBar().includes(lavender.fg("accent", reads)));
  assert(sidebar.render(28).some(row => row.includes(lavender.fg("accent", contextFill))));
  active = peach;
  const after = cacheBar();
  assert(after.includes(peach.fg("accent", reads)));
  assert(!after.includes(lavender.fg("accent", reads)));
  assert(sidebar.render(28).some(row => row.includes(peach.fg("accent", contextFill))));
  sidebar.dispose();
});

test("short terminals keep the CONTEXT heading row grammar with the real theme", () => {
  const sidebar = new Sidebar(() => 10000);
  sidebar.attach({ terminal: { rows: 30, columns: 140 }, requestRender() {} } as unknown as TUI, theme);
  for (const width of [28, 40, 80]) {
    sidebar.setSession(session);
    const rows = sidebar.render(width);
    const line = rows.find(row => stripVTControlCharacters(row).includes("CONTEXT"))!;
    assert(line, `context row at ${width}`);
    assert.match(stripVTControlCharacters(line), /^│ CONTEXT +11% /, `label left, percent right at ${width}`);
    assert.doesNotMatch(stripVTControlCharacters(line), /[█░│]{2}|Context /, "no legacy inline meter");
    assert.equal(visibleWidth(line), width);
  }
});

test("quiet editor avoids duplicate identity/model and restores compact facts without losing its draft", () => {
  const source: ComposerSource = { project: "project", branch: "feat/workbench", model: { id: "sample-model", provider: "sample" },
    thinking: "medium", footer: "standard", theme, paddingX: 4, workspaceHeader: true, dashboardVisible: true,
    context: { tokens: "11%/500k tokens", resources: "ctx 11% · 2 mcp" } };
  const editor = new ComposerEditor({ terminal: { rows: 40, columns: 140 }, requestRender() {} } as unknown as TUI,
    { borderColor: text => text } as EditorTheme, new KeybindingsManager(), () => source, { paddingX: 4 });
  editor.setPaddingX(0); // Native host copies its own padding after the factory returns.
  editor.setText("Preserve this draft");
  let text = editor.render(100).map(stripVTControlCharacters).join("\n");
  assert.match(text, /› Preserve this draft/);
  assert.equal(editor.getPaddingX(), 4, "density must restore native cursor and mouse geometry");
  assert.match(text, /project \/ feat\/workbench/);
  assert.match(text, /sample-model/);
  assert.doesNotMatch(text, /enter send|Ready when you are/);
  source.working = true; assert.match(editor.render(100).map(stripVTControlCharacters).join("\n"), /project \/ feat\/workbench/);
  source.dashboardVisible = false;
  for (const width of [38, 80, 100]) {
    const lines = editor.render(width);
    assert(lines.every(line => visibleWidth(line) <= width));
    text = lines.map(stripVTControlCharacters).join("\n");
    assert.match(text, /ctx 11%/);
    assert.doesNotMatch(stripVTControlCharacters(lines.at(-1)!), /ctx 11%/);
    assert.match(text, /project/);
    if (width >= 42) assert.match(text, /project \/ feat\/workbench/);
    if (width >= 66) {
      const bottom = stripVTControlCharacters(lines.at(-1)!);
      assert.doesNotMatch(bottom, /ctx 11%/);
      assert.match(bottom, /sample-model · medium/);
    } else {
      assert.match(stripVTControlCharacters(lines.at(-1)!), /medium/);
    }
  }
  assert.equal(editor.getText(), "Preserve this draft");
  const focused = editor.render(100).map(stripVTControlCharacters);
  assert.match(focused[0]!, /ctx 11% · 2 mcp/);
  assert.doesNotMatch(focused[0]!, /medium/);
  assert.match(focused.at(-1)!, /sample-model · medium/);
});
