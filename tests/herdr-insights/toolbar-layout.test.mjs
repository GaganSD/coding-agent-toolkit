import assert from "node:assert/strict";
import test from "node:test";
import { collectSourceFiles, PACKAGE_ROOT } from "../../herdr-insights/scripts/lib.mjs";
import { withInsightsToolbar } from "../../herdr-insights/scripts/toolbar.mjs";
import { SINGLE_TOOLBAR_CONTENT } from "./install-fixtures.mjs";

const BUTTON = {
  id: "insights-toolbar-button",
  type: "block",
  size: { px: 104 },
  content: SINGLE_TOOLBAR_CONTENT,
};

function preservedBar(tabs) {
  return { id: "insights-original-tabs", type: "block", size: { weight: 1 }, content: tabs.content };
}

test("the Insights source includes its toolbar icon", async () => {
  const source = await collectSourceFiles(PACKAGE_ROOT);
  assert.ok(source.files.some((file) => file.relative === "insights.svg"));
});

test("layout composition keeps the original tabs code and points the toolbar at one mod", () => {
  const tabs = { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs", props: { custom: true } } };
  const original = { id: "root", type: "column", theme: "ink", children: [tabs, { id: "main", type: "block", content: { tab: "active" } }] };
  const snapshot = structuredClone(original);
  const integrated = withInsightsToolbar(original, { platform: "darwin" });
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
  assert.deepEqual(row.children, [preservedBar(tabs), BUTTON], "macOS keeps the button after the tab bar");
  assert.throws(() => withInsightsToolbar(integrated), /already contains/);
  assert.throws(() => withInsightsToolbar({ id: "root", type: "row", children: [] }), /cannot be integrated safely/);
  assert.throws(() => withInsightsToolbar({ id: "root", type: "row", children: [tabs, tabs] }), /cannot be integrated safely/);
});

test("Windows and Linux put the button before the tab bar so the window buttons stay last", () => {
  for (const platform of ["win32", "linux"]) {
    const tabs = { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs" } };
    const integrated = withInsightsToolbar({ id: "root", type: "column", children: [tabs] }, { platform });
    const row = integrated.children[0];
    assert.deepEqual(row.children, [BUTTON, preservedBar(tabs)], platform);
    assert.equal(row.children.at(-1).id, "insights-original-tabs",
      "the tab bar, which draws minimize/maximize/close, must be the last item");
  }
});

test("a personal tab-bar clone is composed exactly like the native one", () => {
  const tabs = { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs-graph" } };
  const integrated = withInsightsToolbar({ id: "root", type: "column", children: [tabs] }, { platform: "win32" });
  assert.deepEqual(integrated.children[0].children, [BUTTON, preservedBar(tabs)]);
});

test("a tabs block that is not a tab-bar mod is refused", () => {
  const tabs = { id: "tabs", type: "block", content: { tab: "active" } };
  assert.throws(() => withInsightsToolbar({ id: "root", type: "column", children: [tabs] }),
    /cannot be integrated safely/);
});
