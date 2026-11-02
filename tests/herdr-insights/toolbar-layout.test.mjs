import assert from "node:assert/strict";
import test from "node:test";
import { collectSourceFiles, PACKAGE_ROOT } from "../../herdr-insights/scripts/lib.mjs";
import { withInsightsToolbar } from "../../herdr-insights/scripts/toolbar.mjs";
import { SINGLE_TOOLBAR_CONTENT } from "./install-fixtures.mjs";

test("the Insights source includes its toolbar icon", async () => {
  const source = await collectSourceFiles(PACKAGE_ROOT);
  assert.ok(source.files.some((file) => file.relative === "insights.svg"));
});

test("layout composition keeps the original tabs code and points the toolbar at one mod", () => {
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
  assert.deepEqual(row.children[1], {
    id: "insights-toolbar-button",
    type: "block",
    size: { px: 104 },
    content: SINGLE_TOOLBAR_CONTENT,
  });
  assert.throws(() => withInsightsToolbar(integrated), /already contains/);
  assert.throws(() => withInsightsToolbar({ id: "root", type: "row", children: [] }), /cannot be integrated safely/);
  assert.throws(() => withInsightsToolbar({ id: "root", type: "row", children: [tabs, tabs] }), /cannot be integrated safely/);
});
