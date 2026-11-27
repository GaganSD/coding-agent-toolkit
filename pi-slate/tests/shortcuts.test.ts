import assert from "node:assert/strict";
import test from "node:test";
import { classifyKey, loadShortcuts, parseKeyChord, parsePromptShortcut, promptShortcutKey, SHORTCUT_ACTIONS, sidebarShortcutKey } from "../extensions/pi-slate/shortcuts.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

test("parseKeyChord accepts Pi chords and rejects bare letters", () => {
  assert.equal(parseKeyChord("ctrl+alt+."), "ctrl+alt+.");
  assert.equal(parseKeyChord("  Ctrl+Alt+.  "), "ctrl+alt+.");
  assert.equal(parseKeyChord("alt+ctrl+."), "ctrl+alt+.");
  assert.equal(parseKeyChord("ctrl+shift+alt+super+."), "ctrl+shift+alt+super+.");
  assert.equal(parseKeyChord("f5"), "f5");
  assert.equal(parseKeyChord("pageUp"), "pageUp");
  assert.equal(parseKeyChord("p"), undefined);
  assert.equal(parseKeyChord("ctrl+"), undefined);
  assert.equal(parseKeyChord("ctrl+alt+. extra"), undefined);
  assert.equal(parseKeyChord("ctrl+ctrl+p"), undefined);
  assert.equal(parseKeyChord("meta+p"), undefined);
});

test("parsePromptShortcut treats unset and opt-out as no chord", () => {
  assert.equal(parsePromptShortcut(undefined), undefined);
  assert.equal(parsePromptShortcut(false), false);
  assert.equal(parsePromptShortcut("none"), false);
  assert.equal(parsePromptShortcut(""), false);
  assert.equal(parsePromptShortcut("ctrl+alt+."), "ctrl+alt+.");
  assert.equal(parsePromptShortcut(true), undefined);
  assert.equal(parsePromptShortcut(1), undefined);
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
  assert.equal(promptShortcutKey({ prompts: false }), undefined);
  assert.equal(promptShortcutKey({ prompts: "ctrl+alt+." }), "ctrl+alt+.");
  assert.equal(sidebarShortcutKey({ sidebar: false }), undefined);
  assert.equal(sidebarShortcutKey({ sidebar: "ctrl+shift+b" }), "ctrl+shift+b");
});

test("loadShortcuts parses every catalog action and drops unknown or invalid values", () => {
  const saved = { sidebar: "F8", prompts: "none", theme: "F2", pid: "Alt+P", "effort-border": "alt+e", density: "f9", footer: "f10" };
  assert.deepEqual(SHORTCUT_ACTIONS.map(({ id }) => id), Object.keys(saved));
  assert.deepEqual(loadShortcuts({ ...saved, unknown: "f1" }), {
    sidebar: "f8", prompts: false, theme: "f2", pid: "alt+p", "effort-border": "alt+e", density: "f9", footer: "f10",
  });
  assert.equal(loadShortcuts({ unknown: "f1", theme: "a" }), undefined);
});

test("classification uses resolved Pi remaps and gives reserved bindings precedence", () => {
  const keys = new KeybindingsManager();
  keys.setUserBindings({ "app.thinking.toggle": ["f8", "shift+ctrl+b"], "tui.select.up": ["f8", "f9"] });
  const draft = { prompts: "Ctrl+Shift+B", theme: "f9" };
  assert.notEqual(classifyKey("ctrl+t", "sidebar", draft, keys).kind, "reserved");
  assert.equal(classifyKey("ctrl+shift+b", "sidebar", draft, keys).kind, "reserved");
  assert.equal(classifyKey("F8", "sidebar", draft, keys).kind, "reserved");
  assert.deepEqual(classifyKey("f9", "sidebar", draft, keys), { kind: "moved", from: "theme" });
  assert.deepEqual(classifyKey("F9", "theme", draft, keys), { kind: "pi", description: "Move selection up" });
});
