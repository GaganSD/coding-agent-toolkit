import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { openShortcutsPanel, ShortcutsPanel } from "../extensions/pi-slate/shortcuts-panel.ts";
import type { SlateShortcuts } from "../extensions/pi-slate/shortcuts.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text } as unknown as Theme;
const up = "\x1b[A", down = "\x1b[B", esc = "\x1b", f2 = "\x1bOQ";

function fixture(initial?: SlateShortcuts, ownsEditor = true) {
  const done: Array<SlateShortcuts | undefined> = [];
  const terminal = { rows: 40 };
  const panel = new ShortcutsPanel(initial, { terminal: terminal as TUI["terminal"], requestRender() {} }, theme,
    new KeybindingsManager(), { ownsEditor }, value => done.push(value));
  const input = (...sequences: string[]) => sequences.forEach(seq => panel.handleInput(seq));
  const render = (width = 88) => panel.render(width).join("\n");
  return { panel, input, render, terminal, done };
}

test("shortcuts uses the picker geometry at wide, stacked, and tiny sizes", () => {
  const f = fixture({ sidebar: "f8", prompts: "ctrl+alt+." });
  for (const width of [88, 68, 67, 58, 24, 23, 18, 4, 1]) {
    for (const rows of [40, 15, 14, 8, 3]) {
      f.terminal.rows = rows;
      const lines = f.panel.render(width);
      assert.equal(lines.length, Math.min(22, Math.max(1, rows - 2)));
      assert(lines.every(line => visibleWidth(line) === width), `${width}x${rows}`);
    }
  }
  f.terminal.rows = 40;
  assert.match(f.render(), /Actions 1\/7\s+│ Toggle sidebar/);
  assert.match(f.render(), /› Toggle sidebar\s+f8 │ Same as \/slate focused/);
  assert.match(f.render(58), /Actions 1\/7/);
  assert.match(f.render(58), /Status\s+free/);
  f.terminal.rows = 15;
  assert.match(f.render(58), /Actions 1\/7 ↓\d/);
  assert.match(f.render(18), /Slate shortcuts/);
  assert.doesNotMatch(f.render(18), /╭/);
});

test("selection wraps both ways", () => {
  const f = fixture();
  f.input(up);
  assert.match(f.render(), /Actions 7\/7/);
  assert.match(f.render(), /› Composer metadata/);
  f.input(down);
  assert.match(f.render(), /› Toggle sidebar/);
});

test("records a function key and a normalized Kitty chord, then saves the draft", () => {
  const f = fixture();
  f.input("\r");
  assert.match(f.render(), /Press a key…/);
  f.input(f2);
  assert.match(f.render(), /Key\s+f2/);
  assert.doesNotMatch(f.render(), /Press a key…/);
  f.input(down, "\r", "\x1b[98;6u");
  assert.match(f.render(), /Key\s+ctrl\+shift\+b/);
  assert.match(f.render(), /Slate shortcuts · 2 unsaved/);
  f.input("\r", "\x13"); // Save takes precedence over recording.
  assert.deepEqual(f.done, [{ sidebar: "f2", prompts: "ctrl+shift+b" }]);
});

test("Escape backs out of recording before discarding the list; Ctrl+C discards anywhere", () => {
  const f = fixture();
  f.input("\r", f2, "\r", esc);
  assert.match(f.render(), /Press Enter, then the new key/);
  assert.deepEqual(f.done, []);
  f.input(esc);
  assert.deepEqual(f.done, [undefined]);
  for (const recording of [false, true]) {
    const cancel = fixture();
    cancel.input("\r", f2);
    if (recording) cancel.input("\r");
    cancel.input("\x03");
    assert.deepEqual(cancel.done, [undefined]);
  }
});

test("reserved and bare keys are rejected without leaving recording", () => {
  const f = fixture();
  f.input("\r", "\x14");
  assert.match(f.render(), /Reserved by Pi:/);
  assert.match(f.render(), /Press a key…/);
  f.input("a");
  assert.match(f.render(), /Add ctrl or alt/);
  assert.match(f.render(), /Press a key…/);
  f.input(f2);
  assert.doesNotMatch(f.render(), /Add ctrl or alt|Press a key…/);
});

test("non-reserved Pi keys can be replaced", () => {
  const f = fixture();
  f.input("\r", up);
  assert.match(f.render(), /Key\s+up/);
  assert.match(f.render(), /Replaces Pi:/);
});

test("assignment moves a duplicate key and clears its old binding on save", () => {
  const initial = { prompts: "f2" };
  const f = fixture(initial);
  f.input("\r", f2);
  assert.match(f.render(), /Moved from Prompt picker/);
  assert.match(f.render(), /Slate shortcuts · 2 unsaved/);
  assert.match(f.render(), /Prompt picker\s+—/);
  f.input("\x13");
  assert.deepEqual(f.done, [{ sidebar: "f2", prompts: false }]);
  assert.deepEqual(initial, { prompts: "f2" });
});

test("recording prompts requires the editor surface", () => {
  const f = fixture(undefined, false);
  f.input(down, "\r", f2);
  assert.match(f.render(), /Needs the editor surface/);
  assert.doesNotMatch(f.render(), /f2|unsaved|Press a key…/);
});

test("Delete or Backspace unbinds a saved key; unbinding a new key restores the initial draft", () => {
  for (const del of ["\x1b[3~", "\x7f"]) {
    const f = fixture({ sidebar: "f2" });
    f.input(del);
    assert.match(f.render(), /Key\s+—/);
    assert.match(f.render(), /Slate shortcuts · 1 unsaved/);
    f.input("\x13");
    assert.deepEqual(f.done, [{ sidebar: false }]);
  }
  const f = fixture();
  f.input("\r", f2, "\x1b[3~", "\x13");
  assert.doesNotMatch(f.render(), /unsaved/);
  assert.deepEqual(f.done, [{}]);
});

test("opening the panel uses the shared overlay and suppresses unchanged drafts", async () => {
  const ctx = { mode: "tui", ui: { custom: async (_: unknown, options: unknown) => {
    assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "100%", margin: 1 } });
    return { sidebar: "f2" };
  } } } as unknown as ExtensionContext;
  assert.equal(await openShortcutsPanel(ctx, { sidebar: "f2" }, { ownsEditor: true }), undefined);
});

test("non-terminal modes do not open a shortcuts panel", async () => {
  const ctx = { mode: "rpc", ui: {
    notify: (message: string) => assert.equal(message, "/shortcuts requires interactive terminal mode"),
    custom: () => assert.fail("must not open a panel"),
  } } as unknown as ExtensionContext;
  assert.equal(await openShortcutsPanel(ctx, undefined, { ownsEditor: true }), undefined);
});
