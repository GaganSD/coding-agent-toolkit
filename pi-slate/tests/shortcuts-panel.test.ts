import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { openShortcutsPanel, ShortcutsPanel } from "../extensions/pi-slate/shortcuts-panel.ts";
import { classifyKey, type SlateShortcuts } from "../extensions/pi-slate/shortcuts.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getThemeByName, initTheme, loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text } as unknown as Theme;
const warningDot = "\x1b[33m●\x1b[39m";
const markerTheme = {
  // Use a zero-width token marker for the dot so the right-aligned cell doesn't clip it.
  fg: (token: string, text: string) => token === "warning" && text === "●" ? warningDot : `<${token}>${text}</${token}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
  style: (text: string, { fg, bg, bold }: Parameters<Theme["style"]>[1]) => {
    const marker = [fg, bg, bold && "bold"].filter(Boolean).join(" ");
    return `<${marker}>${text}</${marker}>`;
  },
} as unknown as Theme;
const up = "\x1b[A", down = "\x1b[B", esc = "\x1b", f2 = "\x1bOQ", del = "\x1b[3~", bs = "\x7f";

function fixture(initial?: SlateShortcuts, ownsEditor = true, keys = new KeybindingsManager(), getTheme = () => theme) {
  const done: boolean[] = [], saved: SlateShortcuts[] = [];
  const terminal = { rows: 40 }, failures: string[] = [];
  const panel = new ShortcutsPanel(initial, { terminal: terminal as TUI["terminal"], requestRender() {} }, getTheme,
    keys, { ownsEditor }, (_previous, next) => {
      const error = failures.shift();
      if (error) return error;
      saved.push(next);
    }, value => done.push(value));
  const input = (...sequences: string[]) => sequences.forEach(seq => panel.handleInput(seq));
  const render = (width = 88) => panel.render(width).join("\n");
  return { panel, input, render, terminal, done, saved, failures };
}
const themed = (initial?: SlateShortcuts, ownsEditor = true, keys?: KeybindingsManager) => fixture(initial, ownsEditor, keys, () => markerTheme);

test("shortcuts uses the picker geometry at wide, stacked, and tiny sizes", () => {
  const f = fixture({ sidebar: "f8", prompts: "ctrl+alt+." });
  for (const width of [88, 68, 67, 58, 24, 23, 18, 4, 1]) for (const rows of [40, 15, 14, 8, 3]) {
    f.terminal.rows = rows;
    const lines = f.panel.render(width);
    assert.equal(lines.length, Math.min(22, Math.max(1, rows - 2)));
    assert(lines.every(line => visibleWidth(line) === width), `${width}x${rows}`);
  }
  f.terminal.rows = 40;
  assert.match(f.render(), /Actions 1\/7\s+│ Toggle sidebar/);
  assert.match(f.render(), /› Toggle sidebar\s+F8\s+│/);
  assert.match(f.render(58), /Shortcut\s+\[ F8 \]/);
  f.terminal.rows = 15;
  assert.match(f.render(58), /Actions 1\/7 ↓\d/);
  assert.match(f.render(18), /Slate shortcuts/);
  assert.doesNotMatch(f.render(18), /╭/);
});

test("muted section headers are skipped and navigation wraps both ways", () => {
  const f = themed();
  const render = () => f.render(160);
  for (const label of ["Layout", "Pickers", "Display"]) assert(render().includes(`<muted>── ${label}</muted>`));
  for (const label of ["Prompt picker", "Theme picker", "PID display", "Effort border color", "Density", "Composer metadata", "Toggle sidebar"]) {
    f.input(down);
    assert(render().includes(`<text selectedBg bold>› ${label}`));
  }
  f.input(up);
  assert(render().includes("<text selectedBg bold>› Composer metadata"));
});

test("details show one themed state, with the command and selected-row contrast", () => {
  const rowTheme = { ...markerTheme, style: (text: string, options: Parameters<Theme["style"]>[1]) =>
    options.bg === "selectedBg" ? text : markerTheme.style(text, options) } as unknown as Theme;
  const f = fixture({ sidebar: "f8", prompts: "f2" }, true, undefined, () => rowTheme);
  const render = () => f.render(160);
  for (const part of ["<border>╭", "<bold>Slate shortcuts</bold>", "<accent bold>Toggle sidebar", "<text>Shows or hides the sidebar</text>",
    "<dim>/slate focused</dim>", "<success>● Ready</success>", "<accent userMessageBg> [ F8 ] "]) assert(render().includes(part), part);
  const selected = () => render().split("\n").find(line => line.includes("› Toggle sidebar"))!;
  const recordingChip = "<warning userMessageBg> [ ● Press a key… ] ";
  assert(!selected().includes("<accent userMessageBg>"));
  assert(!selected().includes(warningDot));
  assert(!render().includes(recordingChip));
  assert(themed().render(160).includes("<muted>Not set</muted>"));
  assert.doesNotMatch(themed().render(160), /free|Ready/);
  assert(themed({ sidebar: "ctrl+b" }, false).render(160).includes("<warning>▲ Also bound in Pi:"));
  for (const [key, message] of [["ctrl+t", "Reserved by Pi:"], ["left", "Used for editing"], ["ctrl+escape", "Not supported by Pi"],
    ["ctrl+shift+d", "Used by Pi"]] as const) assert(themed({ sidebar: key }).render(160).includes(`<error>✕ ${message}`));
  f.input(del);
  assert(render().includes("<warning>Press Del again to remove F8</warning>"));
  assert(!render().includes("● Ready"));
  f.input("\r");
  assert(render().includes("<borderAccent>╭"));
  assert(render().includes(recordingChip));
  assert(selected().includes(warningDot));
  assert(!selected().includes("F8"));
  assert(render().includes(`<dim>Esc cancels${process.platform === "darwin" ? " · F-keys may need fn" : ""}</dim>`));
  assert.doesNotMatch(render(), /● Ready|Press Del again/);
  f.input(f2);
  assert(render().includes("<accent>↺ Moved from Prompt picker</accent>"));
  assert(render().includes("<success>✓ Saved — applies when you close</success>"));
  assert(!selected().includes(warningDot));
  assert(!render().includes(recordingChip));
});

test("live Latte and system palettes retain legible keycaps and exact ANSI geometry", () => {
  initTheme("system");
  const system = getThemeByName("system")!;
  const latte = loadThemeFromPath(fileURLToPath(new URL("../themes/catppuccin-latte-mauve.json", import.meta.url)), "truecolor");
  let active = latte;
  const f = fixture({ sidebar: "f8", prompts: "ctrl+alt+." }, true, undefined, () => active);
  const light = f.render();
  assert(light.includes(latte.style(`${"› Toggle sidebar".padEnd(34)} F8 `, { fg: "text", bg: "selectedBg", bold: true })));
  assert(light.includes(latte.style(" Ctrl+Alt+. ", { fg: "accent", bg: "userMessageBg" })));
  assert.notEqual(light, stripVTControlCharacters(light), "Latte emits ANSI styling");
  for (const current of [latte, system]) {
    active = current;
    if (current === system) assert.notEqual(f.render(), light, "the open panel picks up the new palette");
    assert.match(stripVTControlCharacters(f.render()), /Prompt picker\s+Ctrl\+Alt\+\./);
    for (const width of [88, 58, 18]) for (const rows of [40, 15, 8]) {
      f.terminal.rows = rows;
      const check = () => assert(f.panel.render(width).every(line => visibleWidth(line) === width), `${current.name} ${width}x${rows}`);
      check();
      f.input(del); check();
      f.input("\r"); check();
      assert(stripVTControlCharacters(f.render(width)).includes("[ ● Press a key… ]"));
      if (width === 88 && rows === 40) {
        assert(f.render(width).includes(current.fg("warning", "●")));
        assert(f.render(width).includes(current.style(" [ ● Press a key… ] ", { fg: "warning", bg: "userMessageBg" })));
      }
      f.input(esc);
    }
    f.terminal.rows = 40;
  }
});

test("recording auto-saves each accepted change and Ctrl+S does not close the panel", () => {
  const f = fixture();
  f.input("\r", f2);
  assert.deepEqual(f.saved, [{ sidebar: "f2" }]);
  assert.match(f.render(), /Shortcut\s+\[ F2 \]/);
  f.input("\x13", down, "\r", "\x1b[98;6u");
  assert.deepEqual(f.saved, [{ sidebar: "f2" }, { sidebar: "f2", prompts: "ctrl+shift+b" }]);
  assert.match(f.render(), /Shortcut\s+\[ Ctrl\+Shift\+B \]/);
  assert.deepEqual(f.done, []);
  f.input(esc);
  assert.deepEqual(f.done, [true]);
  const noSaveChord = fixture();
  noSaveChord.input("\r", "\x13");
  assert.deepEqual(noSaveChord.saved, [{ sidebar: "ctrl+s" }]);
  assert.deepEqual(noSaveChord.done, []);
});

test("plain F1, F5 and F12 are bindable and record legacy function-key sequences", () => {
  for (const [key, raw] of [["f1", "\x1bOP"], ["f5", "\x1b[15~"], ["f12", "\x1b[24~"]] as const) {
    assert.deepEqual(classifyKey(key), { kind: "free", key });
    const f = fixture();
    f.input("\r", raw);
    assert.deepEqual(f.saved, [{ sidebar: key }]);
  }
});

test("Cmd/Win is displayed while recorded keys retain Pi's super spelling", () => {
  const f = fixture();
  f.input("\r", "\x1b[107;9u");
  assert.deepEqual(f.saved, [{ sidebar: "super+k" }]);
  assert.match(f.render(), /Shortcut\s+\[ Cmd\/Win\+K \]/);
  assert.doesNotMatch(f.render(), /super/i);
});

test("Escape backs out of recording; Ctrl+C closes from list, recording or confirmation", () => {
  const f = fixture();
  f.input("\r", esc);
  assert.doesNotMatch(f.render(), /Press a key…/);
  assert.deepEqual(f.done, []);
  f.input(esc);
  assert.deepEqual(f.done, [false]);
  for (const mode of [[], ["\r"], [del]]) {
    const cancel = fixture();
    cancel.input("\r", f2, ...mode, "\x03");
    assert.deepEqual(cancel.saved, [{ sidebar: "f2" }]);
    assert.deepEqual(cancel.done, [true]);
  }
});

test("reserved, viewport, editor, bare and unsupported inputs stay in recording and do not save", () => {
  const f = fixture();
  f.input("\r");
  for (const [data, status] of [
    ...["\x14", "\x1b[109;5u", "\x1b[91;5u"].map(data => [data, /Reserved by Pi:/] as const),
    ["\x1b[1;5H", /Used by Pi's viewport/], ["\x01", /Used by Slate's editor/],
    ...["a", "A", "\x1b[97;2u"].map(data => [data, /Add Ctrl, Alt or Cmd\/Win/] as const),
    ...[" ", "\x1b[32;2u", "\x1b[D", "\x1b[1;2D", "\x1b[5~", "\x1b[105;5u"].map(data => [data, /Used for editing/] as const),
    ["\x1b[27;5u", /Not supported by Pi/],
  ] as const) {
    f.input(data);
    assert.match(f.render(), status);
    assert.match(f.render(), /Press a key…/);
    assert.deepEqual(f.saved, []);
  }
  f.input("\x1b[43;5u");
  assert.deepEqual(f.saved, [{ sidebar: "ctrl++" }]);
  const native = fixture(undefined, false);
  native.input("\r", "\x01");
  assert.deepEqual(native.saved, [{ sidebar: "ctrl+a" }]);
});

test("Kitty and xterm shifted-symbol aliases stay reserved and moves remove all owners at once", () => {
  for (const [physical, data] of [["ctrl+shift+=", "\x1b[61:43;6u"], ["ctrl+shift+-", "\x1b[45:43;6u"], ["ctrl+shift+?", "\x1b[27;6;63~"]] as const) {
    const blocked = fixture(undefined, true, new KeybindingsManager({ "app.interrupt": physical }));
    blocked.input("\r", data);
    assert.match(blocked.render(), /Reserved by Pi: Cancel or abort/);
    assert.match(blocked.render(), /Press a key…/);
    assert.deepEqual(blocked.saved, []);
  }
  const initial = { prompts: "ctrl+shift+=", theme: "ctrl++" };
  const moved = fixture(initial);
  moved.input("\r", "\x1b[61:43;6u");
  assert.deepEqual(moved.saved, [{ sidebar: "ctrl++", prompts: false, theme: false }]);
  assert.deepEqual(initial, { prompts: "ctrl+shift+=", theme: "ctrl++" });
});

test("footer chips honor remapped select controls and drop labels before chips", () => {
  const f = themed(undefined, true, new KeybindingsManager({ "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n", "tui.select.confirm": "f6" }));
  assert.match(f.render(360), /<accent userMessageBg> Ctrl\+P\/Ctrl\+N <\/accent userMessageBg> <muted>Move<\/muted>/);
  assert.match(f.render(360), /<accent userMessageBg> F6 <\/accent userMessageBg> <muted>Record<\/muted>/);
  assert.match(fixture().render(24), /↑↓ Enter Del Esc/);
  assert.doesNotMatch(fixture().render(24), /Move|Record|Remove|Close/);
  f.input("\x10");
  assert.match(f.render(), /Actions 7\/7/);
  f.input("\x0e", "\x1b[17~");
  assert.match(f.render(160), /<accent userMessageBg> Esc <\/accent userMessageBg> <muted>Cancel<\/muted>/);
  assert.doesNotMatch(f.render(160), /<muted>(Move|Record|Remove|Close)<\/muted>/);
});

test("remapped cancel closes or cancels recording, with Esc and Ctrl+C still available", () => {
  const keys = new KeybindingsManager({ "tui.select.cancel": "f6" });
  for (const close of ["\x1b[17~", esc, "\x03"]) {
    const f = themed(undefined, true, keys);
    assert.match(f.render(360), /<accent userMessageBg> F6 <\/accent userMessageBg> <muted>Close<\/muted>/);
    f.input("\r");
    assert.match(f.render(160), /<accent userMessageBg> F6 <\/accent userMessageBg> <muted>Cancel<\/muted>/);
    assert.match(f.render(160), /<dim>F6 cancels/);
    f.input("\x1b[17~");
    assert.doesNotMatch(f.render(), /Press a key…/);
    assert.deepEqual(f.done, []);
    f.input(close);
    assert.deepEqual(f.done, [false]);
  }
});

test("recording prompts requires the editor surface", () => {
  const f = fixture(undefined, false);
  f.input(down, "\r", f2);
  assert.match(f.render(), /✕ Needs the editor surface/);
  assert.doesNotMatch(f.render(), /F2|Press a key…/);
});

test("unbind requires two matching presses and ignores Kitty repeats and releases", () => {
  const f = fixture({ sidebar: "f8", prompts: "f2" });
  f.input(del, "\x1b[3;1:2~", "\x1b[3;1:3~");
  assert.match(f.render(), /Press Del again to remove F8/);
  assert.deepEqual(f.saved, []);
  f.input(bs);
  assert.doesNotMatch(f.render(), /again to remove/);
  assert.deepEqual(f.saved, []);
  f.input(bs);
  assert.match(f.render(), /Press Backspace again to remove F8/);
  f.input(del);
  assert.doesNotMatch(f.render(), /again to remove/);
  assert.deepEqual(f.saved, []);
  f.input(del, "a", del, down);
  assert.doesNotMatch(f.render(), /again to remove/);
  f.input(bs, bs, del, del);
  assert.deepEqual(f.saved, [{ sidebar: "f8", prompts: false }]);
  assert.match(f.render(), /Shortcut\s+Not set/);
  f.input(up, del, "\x1b[3;1:2~", "\x1b[3;1:3~", del);
  assert.deepEqual(f.saved.at(-1), { sidebar: false, prompts: false });
});

test("six-row terminals prioritize errors, saved messages and pending removal over status and hints", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.failures.push("Shortcuts not saved: F2 is now used by Prompt picker.");
  f.input("\r", f2);
  assert.match(f.render(), /Shortcuts not saved: F2 is now used by Prompt picker/);
  assert.match(f.render(), /\[ F8 \]/);
  assert.doesNotMatch(f.render(), /Move.*Record/);
  f.input(del);
  assert.match(f.render(), /Press Del again to remove F8/);
  f.input(del);
  assert.match(f.render(), /✓ Saved — applies when you close/);
});

test("keycaps, unbound dashes and recording dots end in the same list column", () => {
  const f = fixture({ sidebar: "f8", prompts: "ctrl+alt+." });
  const keyColumn = (label: string, suffix: string) => {
    const row = f.panel.render(88).map(line => line.split("│")[1]).find(cell => cell?.includes(label))!;
    const end = row.trimEnd();
    assert(end.endsWith(suffix), row);
    return visibleWidth(end);
  };
  const column = keyColumn("› Toggle sidebar", "F8");
  assert.equal(keyColumn("Prompt picker", "Ctrl+Alt+."), column);
  assert.equal(keyColumn("Theme picker", "—"), column);
  f.input("\r");
  assert.equal(keyColumn("› Toggle sidebar", "●"), column);
  f.input(esc, down, down);
  assert.equal(keyColumn("› Theme picker", "—"), column);
  f.input("\r");
  assert.equal(keyColumn("› Theme picker", "●"), column);
});

test("failed records and unbinds retain the previous binding and show an error", () => {
  const f = themed({ sidebar: "f8", prompts: "f2" });
  f.failures.push("Could not save settings", "Another session changed this binding");
  f.input("\r", f2);
  assert(f.render(160).includes("<error>Could not save settings</error>"));
  assert(f.render(160).includes("<accent userMessageBg> [ F8 ] "));
  f.input(down);
  assert(f.render(160).includes("<accent userMessageBg> [ F2 ] "));
  f.input(up);
  f.input(del, del);
  assert(f.render(160).includes("<error>Another session changed this binding</error>"));
  assert(f.render(160).includes("<accent userMessageBg> [ F8 ] "));
  f.input(esc);
  assert.deepEqual(f.done, [false]);
});

test("opening uses the shared overlay and non-terminal modes do not open it", async () => {
  const ctx = { mode: "tui", ui: { custom: async (_: unknown, options: unknown) => {
    assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "100%", margin: 1 } });
    return false;
  } } } as unknown as ExtensionContext;
  const save = () => assert.fail("must not save");
  assert.equal(await openShortcutsPanel(ctx, undefined, { ownsEditor: true }, save), false);
  const rpc = { mode: "rpc", ui: {
    notify: (message: string) => assert.equal(message, "/shortcuts requires interactive terminal mode"),
    custom: () => assert.fail("must not open a panel"),
  } } as unknown as ExtensionContext;
  assert.equal(await openShortcutsPanel(rpc, undefined, { ownsEditor: true }, save), false);
});
