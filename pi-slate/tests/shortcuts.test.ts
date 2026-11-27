import assert from "node:assert/strict";
import test from "node:test";
import { classifyKey, loadShortcuts, parseShortcut, SHORTCUT_ACTIONS, shortcutKey } from "../extensions/pi-slate/shortcuts.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

test("parseShortcut normalizes Pi chords without deciding which keys may be registered", () => {
  assert.equal(parseShortcut("ctrl+alt+."), "ctrl+alt+.");
  assert.equal(parseShortcut("  Ctrl+Alt+.  "), "ctrl+alt+.");
  assert.equal(parseShortcut("alt+ctrl+."), "ctrl+alt+.");
  assert.equal(parseShortcut("ctrl+shift+alt+super+."), "ctrl+shift+alt+super+.");
  assert.equal(parseShortcut("ctrl+pageUp"), "ctrl+pageUp");
  assert.equal(parseShortcut("Ctrl++"), "ctrl++");
  for (const key of ["ctrl+", "ctrl+alt+. extra", "ctrl+ctrl+p", "meta+p"]) assert.equal(parseShortcut(key), undefined);
  for (const key of ["p", "shift+a", "Shift+1", "shift+.", "+"]) assert.equal(classifyKey(key).kind, "needs-modifier");
  for (const key of ["f5", "f12", "ctrl+space", "super+a", "alt+left", "ctrl+clear"]) assert.deepEqual(classifyKey(key), { kind: "free", key });
});

test("editing and navigation keys need a modifier other than Shift", () => {
  for (const key of ["up", "down", "left", "right", "home", "end", "pageUp", "pageDown", "insert", "delete", "backspace", "tab", "enter", "return", "escape", "space", "clear"]) {
    for (const chord of [key, `shift+${key}`]) {
      assert.equal(classifyKey(chord).kind, "editing", chord);
    }
  }
  assert.equal(classifyKey("ctrl+i").kind, "editing");
});

test("load retains blocked keys so the panel can explain why they are disabled", () => {
  for (const key of ["left", "ctrl+escape", "shift+f2", "ctrl+shift+d"]) assert.deepEqual(loadShortcuts({ sidebar: key }), { sidebar: key });
});

test("parseShortcut treats unset and opt-out as no chord", () => {
  for (const key of [false, "none", ""]) assert.equal(parseShortcut(key), false);
  for (const key of [undefined, true, 1]) assert.equal(parseShortcut(key), undefined);
});

test("loadShortcuts keeps parsed prompt and sidebar bindings", () => {
  assert.equal(loadShortcuts(undefined), undefined);
  assert.equal(loadShortcuts("ctrl+alt+."), undefined);
  assert.deepEqual(loadShortcuts({ prompts: "none" }), { prompts: false });
  assert.deepEqual(loadShortcuts({ prompts: "Ctrl+Alt+." }), { prompts: "ctrl+alt+." });
  assert.deepEqual(loadShortcuts({ sidebar: "Ctrl+Shift+B" }), { sidebar: "ctrl+shift+b" });
  assert.deepEqual(loadShortcuts({ prompts: "nope", sidebar: "Alt+S" }), { sidebar: "alt+s" });
  assert.deepEqual(loadShortcuts({ prompts: "Ctrl+Alt+.", sidebar: false }), { prompts: "ctrl+alt+.", sidebar: false });
  assert.equal(loadShortcuts({ prompts: "nope" }), undefined);
  assert.equal(shortcutKey({ prompts: false }, "prompts"), undefined);
  assert.equal(shortcutKey({ prompts: "ctrl+alt+." }, "prompts"), "ctrl+alt+.");
  assert.equal(shortcutKey({ sidebar: false }, "sidebar"), undefined);
  assert.equal(shortcutKey({ sidebar: "ctrl+shift+b" }, "sidebar"), "ctrl+shift+b");
});

test("loadShortcuts parses every catalog action and drops unknown or invalid values", () => {
  const saved = { sidebar: "F8", prompts: "none", theme: "F2", pid: "Alt+P", "effort-border": "alt+e", density: "f9", footer: "f10" };
  assert.deepEqual(SHORTCUT_ACTIONS.map(({ id }) => id), Object.keys(saved));
  assert.deepEqual(loadShortcuts({ ...saved, unknown: "f1" }), {
    sidebar: "f8", prompts: false, theme: "f2", pid: "alt+p", "effort-border": "alt+e", density: "f9", footer: "f10",
  });
  assert.equal(loadShortcuts({ unknown: "f1", theme: "not a key" }), undefined);
});

test("loadShortcuts keeps the first effective chord in catalog order", () => {
  const raw = { theme: "f2", prompts: "F2", sidebar: "f2", pid: "ctrl+-", "effort-border": "ctrl+_", density: "shift+a", footer: "space" };
  assert.deepEqual(loadShortcuts(raw), { sidebar: "f2", prompts: false, theme: false, pid: "ctrl+-", "effort-border": false, density: "shift+a", footer: "space" });
  assert.deepEqual(loadShortcuts({ theme: "ctrl++", sidebar: "ctrl+shift+=" }), { sidebar: "ctrl+shift+=", theme: false });
  assert.deepEqual(loadShortcuts({ theme: "ctrl+shift+?", sidebar: "ctrl+?" }), { sidebar: "ctrl+?", theme: false });
});

test("classification uses resolved Pi remaps and gives reserved bindings precedence", () => {
  const keys = new KeybindingsManager();
  keys.setUserBindings({ "app.thinking.toggle": ["f8", "shift+ctrl+b"], "tui.select.up": ["f8", "f9"] });
  const draft = { prompts: "Ctrl+Shift+B", theme: "f9" };
  const opts = { id: "sidebar", draft, keys } as const;
  assert.notEqual(classifyKey("ctrl+t", opts).kind, "reserved");
  assert.equal(classifyKey("ctrl+shift+b", opts).kind, "reserved");
  assert.equal(classifyKey("F8", opts).kind, "reserved");
  assert.deepEqual(classifyKey("f9", opts), { kind: "moved", key: "f9", owners: ["theme"] });
  assert.deepEqual(classifyKey("F9", { ...opts, id: "theme" }), { kind: "pi", key: "f9", description: "Move selection up" });
});

test("classification checks legacy aliases against resolved bindings, even for Kitty input", () => {
  const keys = new KeybindingsManager();
  keys.setUserBindings({ "tui.input.copy": ["tab", "backspace", "ctrl+backspace"] });
  for (const key of ["ctrl+m", "ctrl+[", "ctrl+j", "ctrl+i", "ctrl+h"]) {
    assert.equal(classifyKey(key, { keys }).kind, "reserved", key);
  }
  keys.setUserBindings({ "tui.altScreen.lineUp": "f8" });
  assert.equal(classifyKey("f8", { keys }).kind, "viewport");
  assert.equal(classifyKey("ctrl+a", { keys, ownsEditor: true }).kind, "editor");
});
