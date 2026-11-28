import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { FLAVOR_LABELS, catppuccinThemeName, stylesFor } from "../extensions/pi-slate/catppuccin.ts";
import { selectSlateTheme, slateThemeChoices, ThemeSelector, type ThemeChoice } from "../extensions/pi-slate/theme-selector.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { initTheme, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { BUILTIN_SLASH_COMMANDS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";

const theme = { name: "external", fg: (_: string, text: string) => text, bold: (text: string) => text,
  style: (text: string) => text } as unknown as Theme;
const keys = new KeybindingsManager();
const up = "\x1b[A", down = "\x1b[B", right = "\x1b[C", left = "\x1b[D", enter = "\r", esc = "\x1b";

function fixture(initial = "catppuccin-mocha-pink", panelKeys = keys) {
  const previews: string[] = [];
  const done: Array<string | undefined> = [];
  const terminal = { rows: 40 };
  const selector = new ThemeSelector(slateThemeChoices(initial), initial, { terminal: terminal as TUI["terminal"], requestRender() {} },
    () => theme, panelKeys, name => { previews.push(name); return undefined; }, value => done.push(value));
  return { selector, previews, done, terminal };
}
const pane = (selector: ThemeSelector, width: number, index = 2) => stripVTControlCharacters(selector.render(width).join("\n"))
  .split("\n").map(line => line.split("│")[index] ?? "");

test("theme choices group the Catppuccin family and keep every palette", () => {
  const choices = slateThemeChoices();
  assert.deepEqual(choices.map(choice => choice.label), [
    "System default", "Latte", "Frappé", "Macchiato", "Mocha", "Tokyo Night", "Black Metal",
  ]);
  assert.deepEqual(choices.map(choice => choice.family), [
    undefined, "Catppuccin", "Catppuccin", "Catppuccin", "Catppuccin", undefined, undefined,
  ]);
  assert.deepEqual(choices.map(choice => choice.section), [
    undefined, "Catppuccin · Light", "Catppuccin · Light", "Catppuccin · Dark", "Catppuccin · Dark", "Other", "Other",
  ]);
  assert.deepEqual(choices.slice(1, 5).map(choice => choice.variants.length), [15, 15, 15, 16]);
  assert.equal(choices[4]!.variants.at(-1)!.label, "Quiet", "Mocha keeps the legacy palette reachable");
  assert.deepEqual(choices[1]!.variants.map(variant => variant.label), [
    "Rosewater", "Flamingo", "Pink", "Mauve", "Red", "Maroon", "Peach", "Yellow",
    "Green", "Teal", "Sky", "Sapphire", "Blue", "Lavender", "Default",
  ]);
  const accents = (index: number) => Object.fromEntries(choices[index]!.variants.map(variant => [variant.label, variant.color]));
  assert.equal(accents(1).Mauve, "#8839ef");
  assert.equal(accents(2).Pink, "#f4b8e4");
  assert.equal(accents(3).Teal, "#8bd5ca");
  assert.equal(accents(4).Lavender, "#b4befe");
  for (const index of [1, 2, 3, 4]) {
    const hues = Object.entries(accents(index)).filter(([label]) => label !== "Default");
    assert.equal(new Set(hues.map(([, color]) => color)).size, index === 4 ? 15 : 14, "hues are distinct");
  }
});

test("theme navigation previews immediately and keeps each flavor's palette", () => {
  const f = fixture();
  assert.deepEqual(f.previews, [], "opening preserves original theme");
  const opened = f.selector.render(88).join("\n");
  assert.match(opened, /── Catppuccin · Light/);
  assert.match(opened, /── Catppuccin · Dark/);
  assert.match(opened, /── Other/);
  assert.match(opened, /› Mocha/);
  assert.match(opened, /Themes 5\/7/);
  assert.match(opened, /Palettes 3\/16/);
  f.selector.handleInput(right);
  assert.deepEqual(f.previews, [], "opening the palette pane does not preview");
  assert.match(f.selector.render(88).join("\n"), /› ████ Pink/);
  f.selector.handleInput(down);
  assert.deepEqual(f.previews, ["catppuccin-mocha-mauve"]);
  f.selector.handleInput(up);
  assert.deepEqual(f.previews, ["catppuccin-mocha-mauve", "catppuccin-mocha-pink"]);
  f.selector.handleInput(enter);
  assert.deepEqual(f.done, ["catppuccin-mocha-pink"]);

  const themes = fixture("catppuccin-mocha-pink");
  themes.selector.handleInput(right);
  themes.selector.handleInput(down);
  assert.equal(themes.previews.at(-1), "catppuccin-mocha-mauve");
  themes.selector.handleInput(left);
  themes.selector.handleInput(down);
  assert.equal(themes.previews.at(-1), "tokyo-night");
  themes.selector.handleInput(up);
  assert.equal(themes.previews.at(-1), "catppuccin-mocha-mauve");
  themes.selector.handleInput(right);
  assert.match(themes.selector.render(88).join("\n"), /› ████ Mauve/);
  assert.deepEqual(themes.done, [], "moving never saves");
  themes.selector.handleInput(esc);
  themes.selector.handleInput(esc);
  assert.deepEqual(themes.done, [undefined]);
});

test("single-palette and external themes stay selectable", () => {
  const f = fixture("tokyo-night");
  const before = f.previews.length;
  f.selector.handleInput(right);
  f.selector.handleInput(up);
  f.selector.handleInput(down);
  f.selector.handleInput(left);
  assert.equal(f.previews.length, before);
  f.selector.handleInput(right);
  f.selector.handleInput(enter);
  assert.deepEqual(f.done, ["tokyo-night"]);

  const choices = slateThemeChoices("external");
  assert.equal(choices[0]!.variants[0]!.name, "external");
  const selector = new ThemeSelector(choices, "external", {
    terminal: { rows: 40 } as TUI["terminal"], requestRender() {},
  }, () => theme, keys, () => assert.fail("opening must not preview"), () => {});
  assert.match(selector.render(58).join("\n"), /› external/);
});

test("selector wraps, cancels, and keeps labels and controls bounded after resizing", () => {
  const f = fixture("system");
  f.selector.handleInput(up);
  assert.equal(f.previews.at(-1), "black-metal");
  f.selector.handleInput(down);
  assert.equal(f.previews.at(-1), "system");
  for (const width of [100, 58, 32, 20, 4, 3, 1]) {
    for (const rows of [40, 16, 8, 3]) {
      f.terminal.rows = rows;
      const lines = f.selector.render(width);
      assert(lines.every(line => visibleWidth(line) <= width), `${width}x${rows}`);
      assert(lines.length <= Math.max(2, rows - 2), `${width}x${rows} height`);
    }
  }
  f.terminal.rows = 8;
  f.selector.handleInput(down);
  assert.equal(f.previews.at(-1), "catppuccin-latte-rosewater");
  assert.match(f.selector.render(58).join("\n"), /Catppuccin Latte · Rosewater/);
  assert.match(f.selector.render(58).join("\n"), /Esc\s+Close/);
  assert.match(f.selector.render(18).join("\n"), /↑↓/);
  assert.match(f.selector.render(18).join("\n"), /Esc/);
  f.selector.handleInput(up);
  f.selector.handleInput(esc);
  assert.deepEqual(f.done, [undefined]);
});

test("back and repeat never save a theme the user did not choose", () => {
  const leftConfirm = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.confirm": "left" }));
  leftConfirm.selector.handleInput(right);
  leftConfirm.selector.handleInput(left);
  assert.deepEqual(leftConfirm.done, [], "Left backs out instead of saving");
  assert.match(leftConfirm.selector.render(88).join("\n"), /Theme/);
  leftConfirm.selector.handleInput(right);
  leftConfirm.selector.handleInput(" ");
  assert.deepEqual(leftConfirm.done, ["catppuccin-mocha-pink"]);

  const repeated = fixture();
  repeated.selector.handleInput(enter);
  repeated.selector.handleInput("\x1b[13;1:2u");
  assert.deepEqual(repeated.done, [], "a held Enter does not save");
  repeated.selector.handleInput(" ");
  assert.deepEqual(repeated.done, ["catppuccin-mocha-pink"]);

  const downRight = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "right" }));
  downRight.selector.handleInput(right);
  downRight.selector.handleInput(esc);
  downRight.selector.handleInput("\x1b[1;1:2C");
  const backLeft = downRight.selector.render(88).join("\n");
  assert.match(backLeft, /Close/);
  assert.doesNotMatch(backLeft, /Back/);
});

test("stacked frames keep the selected palette visible at three detail rows", () => {
  for (const rows of [15, 16]) {
    const f = fixture("catppuccin-mocha-pink");
    f.terminal.rows = rows;
    f.selector.handleInput(right);
    f.selector.handleInput(down);
    const text = f.selector.render(58).join("\n");
    assert.match(text, /Mauve/, `${rows} rows lost the selected palette`);
  }
});

test("configured navigation beats the Space fallback", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "space" }));
  f.selector.handleInput(" ");
  assert.equal(f.previews.at(-1), "tokyo-night");
  assert.deepEqual(f.done, []);
  f.selector.handleInput(" ");
  assert.equal(f.previews.at(-1), "black-metal");
  assert.deepEqual(f.done, []);

  const rightPane = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "space" }));
  rightPane.selector.handleInput(right);
  rightPane.selector.handleInput(" ");
  assert.equal(rightPane.previews.at(-1), "catppuccin-mocha-mauve");
  assert.deepEqual(rightPane.done, []);

  const enterNav = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "enter", "tui.select.confirm": "f6" }));
  enterNav.selector.handleInput(enter);
  assert.equal(enterNav.previews.at(-1), "tokyo-night");
  assert.deepEqual(enterNav.done, []);
  enterNav.selector.handleInput(up);
  enterNav.selector.handleInput(right);
  enterNav.selector.handleInput(enter);
  assert.equal(enterNav.previews.at(-1), "catppuccin-mocha-mauve");
  assert.deepEqual(enterNav.done, []);
  enterNav.selector.handleInput("\x1b[17~");
  assert.deepEqual(enterNav.done, ["catppuccin-mocha-mauve"]);

  const enterOnly = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "enter" }));
  enterOnly.selector.handleInput(enter);
  assert.equal(enterOnly.previews.at(-1), "tokyo-night");
  enterOnly.selector.handleInput(up);
  enterOnly.selector.handleInput(right);
  assert.match(enterOnly.selector.render(88).join("\n"), /Space\s+Save/);
  enterOnly.selector.handleInput(enter);
  assert.equal(enterOnly.previews.at(-1), "catppuccin-mocha-mauve");
  assert.deepEqual(enterOnly.done, []);

  const leftConfirm = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.confirm": "left" }));
  leftConfirm.selector.handleInput(right);
  assert.match(leftConfirm.selector.render(88).join("\n"), /Enter\s+Save/);
  assert.doesNotMatch(leftConfirm.selector.render(88).join("\n"), /←\s+Save/);

  const downConfirm = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.confirm": "down" }));
  downConfirm.selector.handleInput(down);
  assert.equal(downConfirm.previews.at(-1), "tokyo-night");
  downConfirm.selector.handleInput(up);
  downConfirm.selector.handleInput(right);
  downConfirm.selector.handleInput(down);
  assert.equal(downConfirm.previews.at(-1), "catppuccin-mocha-mauve");
  assert.deepEqual(downConfirm.done, []);
  assert.match(downConfirm.selector.render(88).join("\n"), /Enter\s+Save/);
});

test("hints follow terminal aliases for navigation", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "ctrl+m" }));
  f.selector.handleInput(right);
  assert.match(f.selector.render(88).join("\n"), /Space\s+Save/);
  assert.doesNotMatch(f.selector.render(88).join("\n"), /Enter\s+Save/);
});

test("hints skip a confirm key shadowed by cancel", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.confirm": "ctrl+c" }));
  f.selector.handleInput(right);
  assert.match(f.selector.render(88).join("\n"), /Enter\s+Save/);
  assert.doesNotMatch(f.selector.render(88).join("\n"), /Ctrl\+C\s+Save/);
});

test("Right never opens when it is the configured navigation key", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "right", "tui.select.confirm": "right" }));
  f.selector.handleInput(right);
  assert.equal(f.previews.at(-1), "tokyo-night");
  assert.match(f.selector.render(88).join("\n"), /Enter\s+Palettes/);
  f.selector.handleInput(enter);
  assert.match(f.selector.render(88).join("\n"), /Save/);
});

test("Enter opens only when it is not configured navigation", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "ctrl+m" }));
  f.selector.handleInput(enter);
  assert.equal(f.previews.at(-1), "tokyo-night");
  assert.doesNotMatch(f.selector.render(88).join("\n"), /Save/);
});

test("a cancel key shadows the confirm hint", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.cancel": "f6", "tui.select.confirm": "escape" }));
  f.selector.handleInput(right);
  assert.doesNotMatch(f.selector.render(88).join("\n"), /Esc\s+Save/);
  assert.match(f.selector.render(88).join("\n"), /Enter\s+Save/);
});

test("fallback Tab keeps remapped navigation usable", () => {
  const rightNav = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "right" }));
  rightNav.selector.handleInput("\t");
  assert.match(rightNav.selector.render(88).join("\n"), /Save/);
  rightNav.selector.handleInput(" ");
  assert.deepEqual(rightNav.done, ["catppuccin-mocha-pink"]);

  const spaceNav = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "space" }));
  spaceNav.selector.handleInput(right);
  assert.match(spaceNav.selector.render(88).join("\n"), /Tab\s+Save/);
  spaceNav.selector.handleInput("\t");
  assert.deepEqual(spaceNav.done, ["catppuccin-mocha-pink"]);
});

test("Space opens only when no preferred opener remains", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "right", "tui.select.cancel": "tab", "tui.select.confirm": "left" }));
  f.selector.handleInput(" ");
  assert.match(f.selector.render(88).join("\n"), /Save/);
});

test("function-key navigation is filtered from hints", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "f6", "tui.select.confirm": "f6" }));
  f.selector.handleInput(right);
  assert.doesNotMatch(f.selector.render(88).join("\n"), /F6\s+Save/);
  assert.match(f.selector.render(88).join("\n"), /(Enter|Space)\s+Save/);
});

test("unprobed confirm aliases cannot suppress fallback opener", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": ["right", "j"], "tui.select.confirm": "j" }));
  f.selector.handleInput("j");
  assert.equal(f.previews.at(-1), "tokyo-night");
  f.selector.handleInput(" ");
  assert.match(f.selector.render(88).join("\n"), /Save/);
});

test("return aliases are normalized before fallback selection", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "right", "tui.select.confirm": "return" }));
  f.selector.handleInput(enter);
  assert.equal(f.previews.at(-1), "catppuccin-macchiato-rosewater");
  assert.match(f.selector.render(88).join("\n"), /Space\s+Palettes/);
  f.selector.handleInput(" ");
  assert.match(f.selector.render(88).join("\n"), /Save/);
});

test("shadowed confirm aliases fall back to Tab", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "space", "tui.select.confirm": "ctrl+[" }));
  f.selector.handleInput(right);
  f.selector.handleInput("\t");
  assert.deepEqual(f.done, ["catppuccin-mocha-pink"]);
});

test("navigation Left moves and Esc backs", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.down": "left", "tui.select.confirm": "left" }));
  f.selector.handleInput(right);
  f.selector.handleInput(left);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-mauve");
  assert.deepEqual(f.done, []);
  assert.match(f.selector.render(88).join("\n"), /Esc\s+Back/);
});

test("modifier order is canonical before fallback selection", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({ "tui.select.up": ["enter", "ctrl+shift+k"], "tui.select.down": "space", "tui.select.confirm": "shift+ctrl+k" }));
  f.selector.handleInput(right);
  f.selector.handleInput("\t");
  assert.deepEqual(f.done, ["catppuccin-mocha-pink"]);
});

test("default Tab does not save", () => {
  const f = fixture();
  f.selector.handleInput(right);
  f.selector.handleInput("\t");
  assert.deepEqual(f.done, []);
  assert.match(f.selector.render(88).join("\n"), /Save/);
});

test("shadowed navigation, confirm, and cancel keep Open and Save reachable", () => {
  const f = fixture("catppuccin-mocha-pink", new KeybindingsManager({
    "tui.select.up": "enter", "tui.select.down": ["right", "space"],
    "tui.select.cancel": "tab", "tui.select.confirm": "left",
  }));
  assert.match(f.selector.render(88).join("\n"), /Ctrl\+Right\s+Palettes/);
  f.selector.handleInput("\x1b[1;5C");
  assert.match(f.selector.render(88).join("\n"), /Ctrl\+Enter\s+Save/);
  f.selector.handleInput("\x1b[13;5u");
  assert.deepEqual(f.done, ["catppuccin-mocha-pink"]);
});

test("impossible keymaps say which action is unavailable", () => {
  const noOpen = fixture("catppuccin-mocha-pink", new KeybindingsManager({
    "tui.select.up": "enter", "tui.select.down": ["right", "space", "ctrl+right"],
    "tui.select.cancel": "tab", "tui.select.confirm": "left",
  }));
  assert.match(noOpen.selector.render(88).join("\n"), /No palette key available/);
  const noSave = fixture("catppuccin-mocha-pink", new KeybindingsManager({
    "tui.select.up": ["enter", "ctrl+enter"], "tui.select.down": "space",
    "tui.select.cancel": "tab", "tui.select.confirm": "left",
  }));
  noSave.selector.handleInput(right);
  assert.match(noSave.selector.render(88).join("\n"), /No save key available/);
});

test("a namespaced fallback save preselects the bundled theme", () => {
  const choices = slateThemeChoices("slate-catppuccin-mocha-pink");
  assert.equal(choices.length, 7, "the fallback name does not add an external row");
  const f = fixture("slate-catppuccin-mocha-pink");
  const text = f.selector.render(88).join("\n");
  assert.match(text, /› Mocha/);
  assert.match(text, /Palettes 3\/16/);
});

test("one-row terminals use the short theme name when the full one clips", () => {
  const f = fixture();
  f.terminal.rows = 3;
  assert.match(f.selector.render(12).join("\n"), /Mocha/);
  const text = f.selector.render(23).join("\n");
  assert.match(text, /Mocha/);
  assert.match(text, /Pink/);
  assert.doesNotMatch(text, /Catppuccin/);
});

test("single-palette tiny themes keep their name when the palette is generic", () => {
  for (const [name, label] of [["tokyo-night", "Tokyo Night"], ["black-metal", "Black Metal"]] as const) {
    const f = fixture(name);
    f.terminal.rows = 3;
    f.selector.handleInput(right);
    assert.match(f.selector.render(20).join("\n"), new RegExp(label));
  }
});

test("tiny system palette falls back to the full palette label", () => {
  const f = fixture("system");
  f.terminal.rows = 5;
  f.selector.handleInput(right);
  assert.match(f.selector.render(20).join("\n"), /Terminal palette/);
});

test("single-palette tiny panes keep the theme name", () => {
  const f = fixture("tokyo-night");
  f.terminal.rows = 5;
  f.selector.handleInput(right);
  assert.match(f.selector.render(50).join("\n"), /Tokyo Night/);
});

test("one-row terminals keep the active choice above routine status", () => {
  const f = fixture();
  f.terminal.rows = 3;
  assert.match(f.selector.render(50).join("\n"), /Catppuccin Mocha/);
  f.selector.handleInput(right);
  assert.match(f.selector.render(50).join("\n"), /3\/16 · Pink/);
});

test("tiny errors use one status slot and keep the active choice", () => {
  const done: Array<string | undefined> = [];
  const terminal = { rows: 6 };
  const selector = new ThemeSelector([
    { label: "Good", variants: [{ name: "good", label: "Default" }] },
    { label: "Missing", variants: [{ name: "missing", label: "Unavailable" }] },
  ], "good", { terminal: terminal as TUI["terminal"], requestRender() {} }, () => theme, keys,
  name => name === "missing" ? "Could not load missing. Run /reload." : undefined, value => done.push(value));
  selector.handleInput(down);
  const text = selector.render(50).join("\n");
  assert.equal(text.split("Could not load missing").length - 1, 1);
  assert.match(text, /Missing/);
  terminal.rows = 3;
  assert.match(selector.render(50).join("\n"), /Could not load missing/);
  selector.handleInput("\x1b[1;1:2B");
  assert.deepEqual(done, [], "a held Down does not save");
});

test("right pane layout is identical in both focus states", () => {
  for (const [width, rows] of [[100, 30], [70, 20]] as const) {
    const f = fixture();
    f.terminal.rows = rows;
    const before = pane(f.selector, width).join("\n");
    f.selector.handleInput(right);
    const after = pane(f.selector, width).join("\n");
    assert.equal(after, before, `${width}x${rows}`);
    assert.doesNotMatch(after, /● Current|● Preview/);
  }
});

test("description wrapping does not move the palette viewport", () => {
  const slots = (initial: string) => {
    const f = fixture(initial);
    f.terminal.rows = 20;
    const lines = f.selector.render(70).join("\n").split("\n");
    const cells = lines.map(line => line.split("│")[2] ?? "");
    return {
      header: cells.findIndex(cell => cell.includes("Palettes")),
      option: cells.findIndex(cell => /^\s*[› ]\s*████/.test(cell)),
    };
  };
  assert.deepEqual(slots("tokyo-night"), slots("catppuccin-mocha-mauve"));
});

test("wide theme and palette names keep the value and hex columns fixed", () => {
  const choices: ThemeChoice[] = [{
    label: "界🌙é".repeat(30), family: "Family", section: "Family · Dark",
    variants: [{ name: "wide", label: "界🌙é".repeat(30), color: "#f38ba8" }],
  }];
  const selector = new ThemeSelector(choices, "wide", { terminal: { rows: 30 } as TUI["terminal"], requestRender() {} },
    () => theme, keys, () => undefined, () => {});
  for (const width of [100, 70]) {
    const text = stripVTControlCharacters(selector.render(width).join("\n"));
    assert(text.split("\n").every(line => visibleWidth(line) <= width));
    assert.match(text, /#f38ba8/);
    assert.doesNotMatch(text, /● Current|● Preview/);
  }
});

test("tiny terminals keep the active theme or palette", () => {
  const f = fixture();
  f.terminal.rows = 6;
  const leftText = f.selector.render(50).join("\n");
  assert.match(leftText, /Slate themes/);
  assert.match(leftText, /› Catppuccin Mocha · Pink/);
  assert.match(leftText, /↑↓/);
  f.selector.handleInput(right);
  const rightText = f.selector.render(50).join("\n");
  assert.match(rightText, /Catppuccin Mocha/);
  assert.match(rightText, /› 3\/16 · Pink/);
  assert.match(rightText, /↑↓/);
  for (const rows of [5, 4, 3, 2, 1]) {
    f.terminal.rows = rows;
    const lines = f.selector.render(50);
    assert.ok(lines.some(line => /Catppuccin Mocha|3\/16/.test(line)), `${rows} rows lost the active state`);
  }
});

test("the palette cycle wraps in both directions", () => {
  const f = fixture("catppuccin-mocha-rosewater");
  f.selector.handleInput(right);
  f.selector.handleInput(up);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-quiet");
  f.selector.handleInput(down);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-rosewater");
  for (let i = 0; i < 16; i++) f.selector.handleInput(down);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-rosewater");
  assert.equal(f.previews.length, 18);
});

for (const flavor of ["latte", "frappe", "macchiato", "mocha"] as const) {
  test(`${flavor} keeps every shipped palette reachable from the picker`, () => {
    for (const style of stylesFor(flavor)) {
      const initial = catppuccinThemeName(flavor, style);
      const f = fixture(initial);
      assert.deepEqual(f.previews, [], `${initial} opens selected`);
      assert.match(f.selector.render(88).join("\n"), new RegExp(`› ${FLAVOR_LABELS[flavor]}`));
      if (style === "quiet") assert.match(f.selector.render(88).join("\n"), /Palettes 16\/16/);
      f.selector.handleInput(right);
      f.selector.handleInput(enter);
      assert.deepEqual(f.done, [initial]);
    }
  });
}

for (const action of ["save", "cancel", "ctrl-c", "throw", "failed-save", "failed-preview"] as const) {
  test(`selector transaction: ${action}`, async () => {
    const applied: Array<Theme | string> = [];
    const saved: string[] = [];
    class HostTheme { name: string; constructor(name: string) { this.name = name; } }
    const original = new HostTheme(theme.name!);
    let current = original;
    const live = new Proxy({}, { get: (_target, key) => Reflect.get(current, key) });
    let disk = "light/dark";
    const ctx = { mode: "tui", ui: {
      get theme() { return live; },
      getTheme: (name: string) => name === original.name ? original
        : action === "failed-preview" ? undefined : new HostTheme(name),
      setTheme: (value: Theme | string) => {
        applied.push(value);
        if (value instanceof HostTheme) current = value;
        else { disk = String(value); assert.fail("Only host-created instances may preview or restore"); }
        return { success: true };
      },
      notify() {},
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0], options: unknown) => {
        assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "100%", margin: 1 } });
        let result: unknown;
        const component = await factory({ terminal: { rows: 40 }, requestRender() {} } as TUI, theme, keys, value => { result = value; });
        component.handleInput!(down);
        assert.equal(disk, "light/dark", "previews never write settings, including auto-theme pairs");
        if (action !== "failed-preview") assert.equal(Reflect.get(live, "name"), "system", "captured proxy follows preview");
        if (action === "throw") throw new Error("closed");
        if (action === "save" || action === "failed-save") {
          component.handleInput!(right);
          component.handleInput!(enter);
        } else component.handleInput!(action === "ctrl-c" ? "\x03" : "\x1b");
        return result;
      },
    } } as unknown as ExtensionContext;
    const run = () => selectSlateTheme(ctx, name => {
      if (action === "failed-save") return false;
      saved.push(name); disk = name; return true;
    });
    if (action === "throw") await assert.rejects(run, /closed/); else await run();
    if (action === "save") {
      assert.deepEqual(saved, ["system"]); assert.equal(disk, "system");
    } else {
      assert.deepEqual(saved, []);
      if (action === "failed-preview") assert.deepEqual(applied, []);
      else { assert.equal(applied.at(-1), original); assert.equal(current, original); }
      assert.equal(disk, "light/dark");
    }
  });
}

test("installed Pi reserves no /theme command and only string theme assignments persist", () => {
  assert.equal(BUILTIN_SLASH_COMMANDS.some(command => command.name === "theme"), false);
  const applied: Array<Theme | string> = [];
  let disk = "light/dark";
  const host = {
    themeController: {
      setThemeInstance: (theme: Theme) => { applied.push(theme); return { success: true }; },
      setThemeName: (name: string) => { applied.push(name); return { success: true }; },
    },
    settingsManager: { getTheme: () => disk, setTheme: (name: string) => { disk = name; } },
  };
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const ui = create.call(host) as ExtensionContext["ui"];
  const preview = ui.getTheme("dark");
  assert.ok(preview);
  ui.setTheme(preview);
  assert.equal(applied.at(-1), preview);
  assert.equal(disk, "light/dark");
  ui.setTheme("dark");
  assert.equal(disk, "dark");
});

test("real Pi UI proxy is not restorable, but host-loaded snapshots restore after exceptions", async () => {
  initTheme("dark");
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const host = {
    themeController: {
      setThemeInstance: (value: Theme) => { setThemeInstance(value); return { success: true }; },
      setThemeName: () => assert.fail("proxy or foreign instances must not reach the name/persistence path"),
    },
  };
  const ui = create.call(host) as ExtensionContext["ui"];
  const live = ui.theme;
  const snapshot = ui.getTheme("dark")!;
  assert.equal(live instanceof snapshot.constructor, false, "Pi exposes a plain-target live proxy");
  ui.custom = async factory => {
    const component = await factory({ terminal: { rows: 40 }, requestRender() {} } as TUI, live, keys, () => {});
    component.handleInput!(down);
    assert.equal(live.name, "system", "even a previously captured name property now follows the preview");
    throw new Error("UI failed after preview");
  };
  await assert.rejects(() => selectSlateTheme({ mode: "tui", ui } as ExtensionContext,
    () => assert.fail("must not save")), /UI failed after preview/);
  assert.equal(ui.theme.name, "dark");
  assert.equal(ui.theme.fg("accent", "restored"), snapshot.fg("accent", "restored"));
});

test("an unavailable original snapshot refuses previews without writing settings", async () => {
  const notices: string[] = [];
  await selectSlateTheme({ mode: "tui", ui: {
    theme, getTheme: () => undefined, notify: (message: string) => notices.push(message),
    custom: () => assert.fail("cannot safely preview without a restoration snapshot"),
    setTheme: () => assert.fail("must not change themes"),
  } } as unknown as ExtensionContext, () => assert.fail("must not save"));
  assert.match(notices[0]!, /Could not snapshot/);
});

test("geometry is fixed across valid, error, empty-palette and empty-catalog states", () => {
  const terminal = { rows: 40 };
  const valid = fixture();
  const emptyPalettes = new ThemeSelector([{ label: "Empty", variants: [] }], undefined,
    { terminal: terminal as TUI["terminal"], requestRender() {} }, () => theme, keys, () => undefined, () => {});
  const emptyCatalog = new ThemeSelector([], undefined,
    { terminal: terminal as TUI["terminal"], requestRender() {} }, () => theme, keys, () => assert.fail("empty cannot preview"), () => assert.fail("empty cannot save"));
  const error = [
    { label: "Good", variants: [{ name: "good", label: "Default" }] },
    { label: "Missing", variants: [{ name: "missing", label: "Unavailable" }] },
  ] as ThemeChoice[];
  const broken = new ThemeSelector(error, "good", { terminal: terminal as TUI["terminal"], requestRender() {} }, () => theme, keys,
    name => name === "missing" ? "Could not load missing. Run /reload." : undefined, () => {});
  broken.handleInput(down);
  assert.match(broken.render(88).join("\n"), /Could not load missing/);

  for (const width of [100, 88, 68, 67, 44, 32, 24, 23, 20, 4, 1]) {
    for (const rows of [40, 24, 16, 15, 14, 8, 3, 2, 1]) {
      terminal.rows = rows;
      valid.terminal.rows = rows;
      const height = Math.min(22, Math.max(1, rows - 2));
      for (const component of [valid.selector, broken, emptyPalettes, emptyCatalog]) {
        const lines = component.render(width);
        assert.equal(lines.length, height, `${width}x${rows} height`);
        assert(lines.every(line => visibleWidth(line) === width), `${width}x${rows} width`);
      }
    }
  }
});

test("preview errors and missing palettes block save, keep their error visible, and allow recovery or cancel", () => {
  const done: Array<string | undefined> = [];
  const selector = new ThemeSelector([
    { label: "Empty", variants: [] },
    { label: "Missing", variants: [{ name: "missing", label: "Unavailable" }] },
    { label: "Good", variants: [{ name: "good", label: "Default" }] },
  ], undefined, { terminal: { rows: 40 } as TUI["terminal"], requestRender() {} }, () => theme, keys,
  name => name === "missing" ? "Could not load missing. Run /reload." : undefined, value => done.push(value));
  assert.match(selector.render(88).join("\n"), /No palettes available/);
  selector.handleInput(right);
  selector.handleInput(enter); assert.deepEqual(done, []);
  selector.handleInput(left);
  selector.handleInput(down);
  assert.match(selector.render(88).join("\n"), /Could not load missing/);
  assert.match(selector.render(88).join("\n"), /\/reload/);
  selector.handleInput(right);
  selector.handleInput(enter); assert.deepEqual(done, []);
  selector.handleInput(left);
  selector.handleInput(down);
  assert.doesNotMatch(selector.render(88).join("\n"), /Could not load missing/);
  selector.handleInput(right);
  selector.handleInput(enter);
  assert.deepEqual(done, ["good"]);
  const emptyDone: Array<string | undefined> = [];
  const empty = new ThemeSelector([], undefined, { terminal: { rows: 40 } as TUI["terminal"], requestRender() {} },
    () => theme, keys, () => assert.fail("empty cannot preview"), value => emptyDone.push(value));
  assert.match(empty.render(88).join("\n"), /No themes available/);
  empty.handleInput(enter); assert.deepEqual(emptyDone, []);
  empty.handleInput("\x03"); assert.deepEqual(emptyDone, [undefined]);
});

test("many themes and palettes scroll within independent fixed viewports with position cues", () => {
  const choices = Array.from({ length: 100 }, (_, i) => ({ label: `Theme ${i}`, variants:
    Array.from({ length: 100 }, (_, j) => ({ name: `${i}-${j}`, label: `Palette ${j}`, color: "#f38ba8" })) }));
  const terminal = { rows: 40 } as TUI["terminal"];
  const selector = new ThemeSelector(choices, "0-0", { terminal, requestRender() {} }, () => theme, keys,
    () => undefined, () => {});
  for (const width of [88, 40]) {
    for (let i = 0; i < 100; i++) {
      const text = selector.render(width).join("\n");
      assert.match(text, new RegExp(`› Theme ${i}(?![0-9])`));
      assert.match(text, new RegExp(`Themes ${i + 1}/100`));
      assert.match(text, /↑\d|↓\d/);
      selector.handleInput(down);
    }
    selector.handleInput(right);
    for (let j = 0; j < 100; j++) {
      const text = selector.render(width).join("\n");
      assert.match(text, new RegExp(`› ████ Palette ${j}(?![0-9])`));
      assert.match(text, new RegExp(`Palettes ${j + 1}/100`));
      selector.handleInput(down);
    }
    selector.handleInput(left);
  }
});

test("palette swatches retain their concrete colors and selected rows have a full-row background", () => {
  initTheme("dark");
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const ui = create.call({}) as ExtensionContext["ui"];
  const live = ui.getTheme("dark")!;
  const selector = new ThemeSelector(slateThemeChoices(), "catppuccin-latte-mauve", {
    terminal: { rows: 40 } as TUI["terminal"], requestRender() {},
  }, () => live, keys, () => undefined, () => {});
  const text = selector.render(88).join("\n");
  assert(text.includes(live.style("████", { fg: parseColor("#8839ef") })), "Latte mauve swatch");
  selector.handleInput(right);
  for (let i = 0; i < 10; i++) selector.handleInput(down);
  assert(selector.render(88).join("\n").includes(live.style("████", { fg: parseColor("#7287fd") })), "Latte lavender swatch");
  selector.handleInput(left);
  const selected = text.split("\n").find(line => stripVTControlCharacters(line).includes("› Latte"))!;
  assert(selected.includes(live.getFgAnsi("text")), "focused marker uses the text token");
  assert(selected.includes(live.getBgAnsi("selectedBg")), "selected row paints the background");
});

test("selected background survives clipped cells", () => {
  initTheme("dark");
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const ui = create.call({}) as ExtensionContext["ui"];
  const live = ui.getTheme("dark")!;
  const choices: ThemeChoice[] = [{ label: "界".repeat(40), variants: [{ name: "long", label: "Mauve", color: "#cba6f7" }] }];
  const selector = new ThemeSelector(choices, "long", { terminal: { rows: 30 } as TUI["terminal"], requestRender() {} },
    () => live, keys, () => undefined, () => {});
  const selected = selector.render(100).join("\n").split("\n").find(line => stripVTControlCharacters(line).includes("Mauve"))!;
  const cell = selected.split("│")[1] ?? "";
  const value = cell.indexOf("Mauve");
  const bg = live.getBgAnsi("selectedBg");
  assert(value >= 0, "clipped row keeps the palette value");
  const reset = cell.lastIndexOf("\x1b[0m", value);
  assert(reset < 0 ? cell.includes(bg) : cell.slice(reset).includes(bg), "background must continue through the value column");
});

test("non-terminal modes do not start a selector or change themes", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    let notices = 0;
    await selectSlateTheme({ mode, ui: { notify() { notices++; } } } as unknown as ExtensionContext,
      () => assert.fail("must not save"));
    assert.equal(notices, 1);
  }
});
