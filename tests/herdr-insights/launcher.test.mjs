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
const commands = [];
globalThis.__insightsLauncherTest = { element, commands, theme: { chrome: "#111111", border: "#222222", muted: "#888888" } };
const transformed = source
  .replace(/^import .* from "gpui-kit";$/m, "class View {}\nconst svg = () => globalThis.__insightsLauncherTest.element();")
  .replace(/^import .* from "gpui-base";$/m, "const h_flex = () => globalThis.__insightsLauncherTest.element();")
  .replace(/^import .* from "herdr";$/m, "const theme = () => globalThis.__insightsLauncherTest.theme;\nconst run = (...args) => globalThis.__insightsLauncherTest.commands.push(args);");
const { default: Launcher } = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`);

test("toolbar button matches native panel controls and each click creates a new Insights tab", () => {
  const launcher = new Launcher();
  const root = launcher.render();
  const button = root.children[0];
  assert.equal(button.children[1], "Insights");
  for (const [method, value] of [["h", 26], ["px", 8], ["gap", 5], ["rounded", 6], ["text_size", 12]]) {
    assert.ok(button.calls.some(([name, args]) => name === method && args[0] === value), `${method} matches Herdr's panelButton`);
  }
  assert.deepEqual(commands, [], "render must have no side effects");
  const click = button.calls.find(([name]) => name === "on_click")[1][0];
  click(); click();
  assert.deepEqual(commands, [
    ["tab.new", { name: "Insights", mod: "insights" }],
    ["tab.new", { name: "Insights", mod: "insights" }],
  ]);
  let stopped = false;
  button.calls.find(([name]) => name === "on_mouse_down")[1][1]({}, { stop_propagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(launcher.init, undefined);
  assert.doesNotMatch(source, /layout\.|setShared|exec\(|fetch\(|timer|Overlay|readTextFile|writeTextFile/);
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
