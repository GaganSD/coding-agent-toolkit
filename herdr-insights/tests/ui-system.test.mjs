import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { PACKAGE_ROOT, collectSourceFiles } from "../scripts/lib.mjs";

const uiSource = await readFile(new URL("../mods/insights/ui.js", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../mods/insights/main.js", import.meta.url), "utf8");

function createElement(type) {
  const node = { type, calls: [], childNodes: [], style: {} };
  let element;
  const methods = {
    child(value) {
      node.calls.push(["child", [value]]);
      node.childNodes.push(value);
      return element;
    },
    children(values) {
      node.calls.push(["children", [values]]);
      node.childNodes.push(...values);
      return element;
    },
    when(condition, branch) {
      if (condition) branch(element);
      return element;
    },
    id(value) {
      node.calls.push(["id", [value]]);
      node.style.id = value;
      return element;
    },
  };
  element = new Proxy(node, {
    get(target, property) {
      if (property in methods) return methods[property];
      if (property in target) return target[property];
      if (typeof property === "symbol") return undefined;
      return (...args) => {
        node.calls.push([property, args]);
        return element;
      };
    },
  });
  return element;
}

globalThis.__uiTestNative = { create: createElement };
const transformedUi = uiSource
  .replace(/^import \{ div \} from "gpui-kit";$/m, 'const div = () => globalThis.__uiTestNative.create("div");')
  .replace(
    /^import \{[^}]*\} from "gpui-base";$/m,
    `const v_flex = () => globalThis.__uiTestNative.create("v_flex");
const h_flex = () => globalThis.__uiTestNative.create("h_flex");
const Button = { new: (id) => globalThis.__uiTestNative.create("Button") };
const Toggle = { new: (id) => globalThis.__uiTestNative.create("Toggle") };`,
  );
const uiUrl = `data:text/javascript;base64,${Buffer.from(transformedUi).toString("base64")}`;
const ui = await import(uiUrl);
const {
  G,
  H,
  R,
  T,
  button,
  card,
  controlInput,
  segmented,
  statCell,
  toggleSwitch,
  tokens,
} = ui;

const darkTheme = {
  background: "#101010",
  canvas: "#0b0b0b",
  surface: "#181818",
  popover: "#1c1c1c",
  raised: "#222222",
  hover: "#292929",
  selected: "#303030",
  border: "#333333",
  input: "#3b3b3b",
  foreground: "#f5f5f5",
  muted: "#9a9a9a",
  dim: "#707070",
  accent: "#5aa7ff",
  accent_foreground: "#06101d",
  solid: "#f5f5f5",
  solid_foreground: "#111111",
  blocked: "#ff6b6b",
  done: "#5bd48a",
  ansi1: "#ff6b6b",
  ansi2: "#5bd48a",
};

const lightTheme = {
  background: "#ffffff",
  canvas: "#f6f6f6",
  surface: "#ffffff",
  popover: "#ffffff",
  raised: "#f1f1f1",
  hover: "#ececec",
  selected: "#e8e8e8",
  border: "#dddddd",
  input: "#cccccc",
  foreground: "#1a1a1a",
  muted: "#666666",
  dim: "#888888",
  accent: "#2563eb",
  accent_foreground: "#ffffff",
  solid: "#1a1a1a",
  solid_foreground: "#ffffff",
  blocked: "#c62828",
  done: "#18794e",
  ansi1: "#c62828",
  ansi2: "#18794e",
};

const callsFor = (element, name) => element.calls.filter(([call]) => call === name);
const lastCall = (element, name) => callsFor(element, name).at(-1);
const colorOf = (element, name) => lastCall(element, name)?.[1][0];
const has = (source, pattern) => assert.match(source, pattern);

test("semantic tokens pair every surface with its foreground and keep action emphasis separate from data accent", () => {
  for (const raw of [darkTheme, lightTheme]) {
    const c = tokens(raw);
    assert.equal(c.primary, raw.solid);
    assert.equal(c.primaryForeground, raw.solid_foreground);
    assert.equal(c.card, raw.surface);
    assert.equal(c.canvas, raw.canvas);
    assert.equal(c.popover, raw.popover);
    assert.equal(c.mutedForeground, raw.muted);
    assert.equal(c.ring, raw.accent);
    assert.equal(c.destructive, raw.blocked);
    assert.notEqual(c.primary, c.accent, "primary actions must not reuse the data accent");
    assert.notEqual(c.primary, c.ring, "focus is the one accent; actions stay monochrome");
  }

  const partial = tokens({ background: "#000000" });
  assert.equal(partial.canvas, "#000000");
  assert.equal(partial.card, "#000000");
  assert.equal(partial.primary, undefined, "missing semantic colors stay explicit rather than invented");
});

test("cards and data cells keep one radius, a 1px border and no shadow", () => {
  const c = tokens(darkTheme);
  const surface = card(c);
  assert.equal(colorOf(surface, "rounded"), R.card);
  assert.equal(R.card, 8);
  assert.equal(lastCall(surface, "border_1")?.[0], "border_1");
  assert.equal(colorOf(surface, "border_color"), c.border);
  assert.equal(callsFor(surface, "shadow_md").length, 0);
  assert.equal(callsFor(surface, "shadow_sm").length, 0);

  const stat = statCell("Input", "1.2M", c, { tooltip: "1,234,567 input tokens", note: "included" });
  assert.equal(stat.childNodes.length, 3);
  assert.equal(lastCall(stat.childNodes[1], "tooltip")?.[1][0], "1,234,567 input tokens");
  assert.equal(lastCall(stat.childNodes[2], "child")?.[1][0], "included");
  assert.equal(G.xs, 4);
  assert.equal(T.value, 12.5);
});

test("button variants express primary, secondary, outline and ghost priority", () => {
  const c = tokens(darkTheme);
  const noop = () => {};
  const primary = button("save", "Save", noop, c, { variant: "primary" });
  const secondary = button("secondary", "Secondary", noop, c);
  const outline = button("outline", "Outline", noop, c, { variant: "outline" });
  const ghost = button("ghost", "Ghost", noop, c, { variant: "ghost" });

  assert.equal(colorOf(primary, "bg"), c.primary);
  assert.equal(colorOf(primary, "border_color"), c.primary);
  assert.equal(colorOf(secondary, "bg"), c.secondary);
  assert.equal(colorOf(outline, "bg"), c.card);
  assert.equal(colorOf(outline, "border_color"), c.border);
  assert.equal(callsFor(ghost, "bg").length, 0);
  assert.equal(lastCall(ghost, "border_0")?.[0], "border_0");
  for (const element of [primary, secondary, outline, ghost]) {
    assert.equal(colorOf(element, "h"), H.control);
    assert.equal(colorOf(element, "rounded"), R.control);
  }

  const focus = callsFor(primary, "focus")[0][1][0];
  const focusTarget = createElement("focus");
  focus(focusTarget);
  assert.equal(colorOf(focusTarget, "border_color"), c.ring);

  const disabled = button("disabled", "Disabled", noop, c, { disabled: true });
  assert.equal(colorOf(disabled, "opacity"), 0.5);
  const click = callsFor(disabled, "on_click")[0][1][0];
  let clicked = false;
  click({}, { notify() { clicked = true; } });
  assert.equal(clicked, false, "a disabled button never runs its action");
});

test("segmented controls and toggles use native selected/pressed state", () => {
  const c = tokens(darkTheme);
  const group = segmented("period", [
    { key: "week", label: "Week" },
    { key: "month", label: "Month" },
  ], "month", () => {}, c);

  const items = group.childNodes;
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "Button");
  assert.equal(items[1].type, "Button");
  assert.equal(colorOf(items[0], "h"), H.compact);
  assert.equal(lastCall(items[0], "selected")?.[1][0], false);
  assert.equal(lastCall(items[1], "selected")?.[1][0], true);
  assert.equal(colorOf(items[1], "bg"), c.card);
  assert.equal(colorOf(items[1], "border_color"), c.border);

  const toggle = toggleSwitch("cache", true, () => {}, c, { label: "Include cache" });
  assert.equal(toggle.type, "Toggle");
  assert.equal(lastCall(toggle, "pressed")?.[1][0], true);
  assert.equal(lastCall(toggle, "accessibility_label")?.[1][0], "Include cache");
  assert.equal(callsFor(toggle, "on_change").length, 1);
  const focus = callsFor(toggle, "focus")[0][1][0];
  const focusTarget = createElement("focus");
  focus(focusTarget);
  assert.equal(colorOf(focusTarget, "border_color"), c.ring);

  const input = controlInput(createElement("Input").w_full(), c);
  assert.equal(colorOf(input, "h"), H.control);
  assert.equal(colorOf(input, "rounded"), R.control);
  assert.equal(colorOf(input, "border_color"), c.input);
  assert.equal(colorOf(input, "bg"), c.canvas);
});

test("the shared visual module is theme-driven, shadow-free and part of the installed source", async () => {
  assert.doesNotMatch(uiSource, /#[0-9a-f]{6}/i, "no hardcoded colors in the visual system");
  assert.doesNotMatch(uiSource, /shadow_/);
  assert.doesNotMatch(uiSource, /setTimeout|setInterval/);
  assert.doesNotMatch(mainSource, /shadow_md|shadow_sm|shadow_lg/);
  has(mainSource, /from "\.\/ui\.js"/);

  const source = await collectSourceFiles(PACKAGE_ROOT);
  assert.equal(source.files.some((file) => file.relative === "ui.js"), true, "installer copies mods/insights recursively");
});
