import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../mods/insights/main.js", import.meta.url), "utf8");
const analytics = await readFile(new URL("../mods/insights/analytics.js", import.meta.url), "utf8");

test("native mod keeps timers and shell use inside the Herdr contract", () => {
  assert.doesNotMatch(main, /\bsetTimeout\b/);
  assert.doesNotMatch(main, /\bsetInterval\b/);
  assert.doesNotMatch(main, /this\.cx\b/);
  assert.doesNotMatch(main, /\bsh\s*,\s*\[/);
  assert.doesNotMatch(main, /--rebuild/);
  assert.match(main, /exec\("node", \[/);
  assert.match(main, /configure/);
  assert.match(main, /--config/);
  assert.match(main, /on_size_change/);
  assert.match(main, /overflow_x_scrollbar/);
  assert.match(main, /nextCommand/);
  assert.match(main, /name === "refresh"/);
  assert.match(main, /name === "settings"/);
  assert.match(main, /name === "dashboard"/);
  assert.match(main, /sourceStats/);
  assert.match(main, /EditorState\.new/);
  assert.match(main, /result\.code !== 0/);
  assert.match(main, /\.release\(\)/);
});

test("analytics stays host-free and the UI keeps configuration JSON editable", () => {
  assert.doesNotMatch(analytics, /from\s+["']herdr["']/);
  assert.doesNotMatch(analytics, /from\s+["']gpui-kit["']/);
  assert.doesNotMatch(analytics, /from\s+["']gpui-base["']/);
  assert.match(main, /Configuration JSON/);
  assert.match(main, /Save configuration/);
  assert.doesNotMatch(main, /(^|[^.\w])localStorage\b/);
});
