import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectSourceFiles, PACKAGE_ROOT } from "../../herdr-insights/scripts/lib.mjs";
import { withInsightsToolbar } from "../../herdr-insights/scripts/toolbar.mjs";

const source = await readFile(new URL("../../herdr-insights/mods/insights-launcher/main.js", import.meta.url), "utf8");
function element() {
  const node = { calls: [], children: [] };
  let proxy;
  proxy = new Proxy(node, { get(target, property) {
    if (property in target) return target[property];
    return (...args) => {
      node.calls.push([property, args]);
      if (property === "child") node.children.push(args[0]);
      return proxy;
    };
  } });
  return proxy;
}
const state = { commands: [], panes: [], spaces: [], theme: { chrome: "#111111", border: "#222222", muted: "#888888" } };
globalThis.__insightsLauncherTest = state;
const transformed = source
  .replace(/^import .* from "gpui-kit";$/m, "class View {}\nconst svg = () => globalThis.__insightsLauncherTest.element();")
  .replace(/^import .* from "gpui-base";$/m, "const h_flex = () => globalThis.__insightsLauncherTest.element();")
  .replace(/^import .* from "herdr";$/m, `const theme = () => globalThis.__insightsLauncherTest.theme;
const run = (...args) => globalThis.__insightsLauncherTest.commands.push(args);
const spaces = () => globalThis.__insightsLauncherTest.spaces;
const panes = () => globalThis.__insightsLauncherTest.panes;`);
state.element = element;
const { default: Launcher } = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`);

function buttonOf(launcher) {
  return launcher.render().children[0];
}

function click(launcher) {
  buttonOf(launcher).calls.find(([name]) => name === "on_click")[1][0]();
}

test("toolbar button matches native panel controls and render has no side effects", () => {
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [];
  state.commands.length = 0;
  const launcher = new Launcher();
  const button = buttonOf(launcher);
  assert.equal(button.children[1], "Insights");
  for (const [method, value] of [["h", 26], ["px", 8], ["gap", 5], ["rounded", 6], ["text_size", 12]]) {
    assert.ok(button.calls.some(([name, args]) => name === method && args[0] === value), `${method} matches Herdr's panelButton`);
  }
  assert.deepEqual(state.commands, [], "render must have no side effects");
  let stopped = false;
  button.calls.find(([name]) => name === "on_mouse_down")[1][1]({}, { stop_propagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(launcher.init, undefined);
  assert.doesNotMatch(source, /layout\.|setShared|exec\(|fetch\(|timer|Overlay|readTextFile|writeTextFile/);
});

test("a click shows the space's Insights tab instead of opening another", () => {
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }, { id: "t2" }] }];
  state.panes = [{ pane: "p1", mod: "terminal", tab: "t1" }, { pane: "p2", mod: "insights", tab: "t2" }];
  state.commands.length = 0;
  const launcher = new Launcher();
  click(launcher);
  click(launcher);
  assert.deepEqual(state.commands, [["pane.focus", { pane: "p2" }], ["pane.focus", { pane: "p2" }]]);
});

test("a reused dashboard is focused and revealed behind another pane's zoom", () => {
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }, { id: "t2" }] }];
  state.panes = [
    { pane: "terminal", mod: "terminal", tab: "t2", focused: true, zoomed: true },
    { pane: "dashboard", mod: "insights", tab: "t2", focused: false, zoomed: false },
    { pane: "other", mod: "terminal", tab: "t1", zoomed: true },
  ];
  state.commands.length = 0;
  click(new Launcher());
  assert.deepEqual(state.commands, [
    ["pane.zoom", { pane: "terminal" }],
    ["pane.focus", { pane: "dashboard" }],
  ]);
});

test("reusing an already zoomed dashboard preserves its zoom", () => {
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [{ pane: "dashboard", mod: "insights", tab: "t1", zoomed: true }];
  state.commands.length = 0;
  click(new Launcher());
  assert.deepEqual(state.commands, [["pane.focus", { pane: "dashboard" }]]);
});

test("a click opens the Insights tab only when the space has none", () => {
  state.spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }];
  state.panes = [{ mod: "terminal", tab: "t1" }];
  state.commands.length = 0;
  click(new Launcher());
  assert.deepEqual(state.commands, [["tab.new", { name: "Insights", mod: "insights" }]]);
});

test("an Insights tab in another space never satisfies the current space", () => {
  state.spaces = [
    { id: "s1", active: true, tabs: [{ id: "t1" }] },
    { id: "s2", active: false, tabs: [{ id: "t2" }] },
  ];
  state.panes = [{ mod: "insights", tab: "t2" }];
  state.commands.length = 0;
  click(new Launcher());
  assert.deepEqual(state.commands, [["tab.new", { name: "Insights", mod: "insights" }]]);
});

test("launcher is a normal layout mod, never a floating window", async () => {
  const launcher = await collectSourceFiles(PACKAGE_ROOT, "insights-launcher");
  assert.deepEqual(launcher.files.map((file) => file.relative), ["insights.svg", "main.js", "mod.json"]);
  assert.deepEqual(launcher.modJson, { place: "none", title: "Insights" });
});

test("layout composition keeps the original tabs code and preserves unrelated layout fields", () => {
  const tabs = { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs", props: { custom: true } } };
  const original = { id: "root", type: "column", theme: "ink", children: [tabs, { id: "main", type: "block", content: { tab: "active" } }] };
  const snapshot = structuredClone(original);
  const integrated = withInsightsToolbar(original);
  assert.deepEqual(original, snapshot, "input must not be mutated");
  assert.equal(integrated.theme, "ink");
  assert.deepEqual(integrated.children[1], original.children[1]);
  const row = integrated.children[0];
  assert.equal(row.id, "tabs", "keep existing height/click-state ID on wrapper");
  assert.equal(row.type, "row");
  assert.deepEqual(row.size, { px: 42 });
  assert.equal(row.window_drag, true);
  assert.equal(row.resizable, false);
  assert.equal(row.content, undefined);
  assert.deepEqual(row.children[0].content, tabs.content);
  assert.deepEqual(row.children[0].size, { weight: 1 });
  assert.deepEqual(row.children[1], { id: "insights-toolbar-button", type: "block", size: { px: 104 }, content: { mod: "insights-launcher" } });
  assert.throws(() => withInsightsToolbar(integrated), /already contains/);
  assert.throws(() => withInsightsToolbar({ id: "root", type: "row", children: [] }), /cannot be integrated safely/);
  assert.throws(() => withInsightsToolbar({ id: "root", type: "row", children: [tabs, tabs] }), /cannot be integrated safely/);
});
