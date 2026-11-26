import assert from "node:assert/strict";
import test from "node:test";
import { loadShortcuts, parseKeyChord, parsePromptShortcut, promptShortcutKey, sidebarShortcutKey } from "../extensions/pi-slate/shortcuts.ts";

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
