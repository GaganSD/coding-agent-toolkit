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
initTheme("dark");
const markerTheme = getThemeByName("dark")!;
const fg = (token: Parameters<Theme["fg"]>[0], text: string) => markerTheme.fg(token, text);
const styled = (text: string, options: Parameters<Theme["style"]>[1]) => markerTheme.style(text, options);
const selectedBg = markerTheme.getBgAnsi("selectedBg");
const chip = (text: string) => styled(` ${text} `, { fg: "accent", bg: "userMessageBg" });
const up = "\x1b[A", down = "\x1b[B", right = "\x1b[C", left = "\x1b[D", enter = "\r", esc = "\x1b", f2 = "\x1bOQ", del = "\x1b[3~", bs = "\x7f";

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
const record = (f: ReturnType<typeof fixture>, key: string) => f.input(right, enter, key);
const pane = (f: ReturnType<typeof fixture>, width = 100, index = 2) => stripVTControlCharacters(f.render(width)).split("\n").map(line => line.split("│")[index] ?? "");

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

test("two-pane focus keeps the left row and opens the right pane", () => {
  const f = themed({ sidebar: "f8" });
  const render = () => f.render(500);
  const row = (text: string) => render().split("\n").find(line => stripVTControlCharacters(line).includes(text))!;
  assert(row("› Toggle sidebar").includes(fg("text", "›")));
  assert(row("› Toggle sidebar").includes(selectedBg));
  assert(render().includes(chip("→")) && render().includes(fg("muted", "Open")));
  assert.doesNotMatch(render(), /Choose|Back/);
  f.input(enter);
  assert(row("› Toggle sidebar").includes(fg("muted", "›")));
  assert(row("› Record shortcut").includes(fg("text", "›")));
  assert(render().includes(chip("Enter")) && render().includes(fg("muted", "Choose")));
  assert(render().includes(chip("←")) && render().includes(fg("muted", "Back")));
  assert.deepEqual(f.saved, []);
  f.input(left);
  assert(row("› Toggle sidebar").includes(fg("text", "›")));
  assert(row("› Record shortcut").includes(fg("muted", "›")));
  f.input(esc);
  assert.deepEqual(f.done, [false]);
});

test("muted section headers are skipped and navigation wraps both ways", () => {
  const f = themed();
  const render = () => f.render(500);
  for (const label of ["Layout", "Pickers", "Display"]) assert(render().includes(fg("muted", `── ${label}`)));
  for (const label of ["Prompt picker", "Theme picker", "Process ID", "Effort border", "Spacing", "Composer details", "Toggle sidebar"]) {
    f.input(down);
    const selected = render().split("\n").find(line => stripVTControlCharacters(line).includes(`› ${label}`))!;
    assert(selected.includes(fg("text", "›")), label);
    assert(selected.includes(selectedBg), label);
  }
  f.input(up);
  const last = render().split("\n").find(line => stripVTControlCharacters(line).includes("› Composer details"))!;
  assert(last.includes(fg("text", "›")) && last.includes(selectedBg));
});

test("right pane layout is identical in both focus states and its status column aligns", () => {
  for (const [width, rows] of [[100, 30], [70, 20]] as const) {
    const f = fixture({ sidebar: "f8" }, true, undefined, () => markerTheme);
    f.terminal.rows = rows;
    const before = pane(f, width).join("\n");
    f.input(right);
    const after = pane(f, width).join("\n");
    assert.equal(after, before, `${width}x${rows}`);
    assert.match(after, /Shortcut\s+\[ F8 \]/);
    assert.match(after, /Record shortcut/);
    assert.match(after, /Remove shortcut/);
    const option = after.split("\n").find(line => line.includes("Record shortcut"))!;
    const status = after.split("\n").find(line => line.trimStart().startsWith("● Ready"))!;
    assert.equal(visibleWidth(option.slice(0, option.indexOf("Record"))), visibleWidth(status.slice(0, status.indexOf("●"))));
  }
});

test("left list has no health glyph and keycaps share one right-aligned column", () => {
  const f = fixture({ sidebar: "f8", prompts: "ctrl+alt+." });
  const rows = () => pane(f, 100, 1);
  assert.doesNotMatch(rows().join("\n"), /[●○▲✕↺]/);
  const keyEnd = (label: string, suffix: string) => {
    const row = rows().find(cell => cell.includes(label))!;
    const index = row.indexOf(suffix);
    assert(index >= 0, row);
    return visibleWidth(row.slice(0, index + visibleWidth(suffix)));
  };
  const column = keyEnd("› Toggle sidebar", "F8");
  assert.equal(keyEnd("Prompt picker", "Ctrl+Alt+."), column);
  assert.equal(keyEnd("Theme picker", "—"), column);
  f.input(right, enter);
  assert.equal(keyEnd("› Toggle sidebar", "●"), column);
  f.input(esc, esc, down, down);
  assert.equal(keyEnd("› Theme picker", "—"), column);
  f.input(right, enter);
  assert.equal(keyEnd("› Theme picker", "●"), column);

  const long = fixture({ sidebar: "ctrl+shift+alt+super+pageUp" });
  const selectedRow = pane(long, 70, 1).find(line => line.includes("› Toggle"))!;
  const selectedEnd = visibleWidth(selectedRow.trimEnd());
  long.input(down);
  const unboundRow = pane(long, 70, 1).find(line => line.includes("Prompt"))!;
  assert.equal(visibleWidth(unboundRow.trimEnd()), selectedEnd);
});

test("status column stays fixed when the selected action changes", () => {
  const f = fixture({ sidebar: "f8" });
  const statusStart = () => {
    const line = pane(f, 100).find(cell => cell.includes("Record shortcut"))!;
    const match = line.match(/[●○▲✕↺◌]/)!;
    return visibleWidth(line.slice(0, match.index));
  };
  const first = statusStart();
  f.input(down);
  assert.equal(statusStart(), first);
});

test("recording auto-saves each accepted change and Ctrl+S does not close the panel", () => {
  const f = fixture();
  record(f, f2);
  assert.deepEqual(f.saved, [{ sidebar: "f2" }]);
  assert.match(f.render(), /Shortcut\s+\[ F2 \]/);
  assert.match(f.render(), /✓ Saved — applies when you close/);
  f.input(enter, "\x13");
  assert.deepEqual(f.saved, [{ sidebar: "f2" }, { sidebar: "ctrl+s" }]);
  f.input(esc, down, right, enter, "\x1b[98;6u");
  assert.deepEqual(f.saved, [{ sidebar: "f2" }, { sidebar: "ctrl+s" }, { sidebar: "ctrl+s", prompts: "ctrl+shift+b" }]);
  assert.match(f.render(), /Shortcut\s+\[ Ctrl\+Shift\+B \]/);
  assert.deepEqual(f.done, []);
  f.input(esc, esc);
  assert.deepEqual(f.done, [true]);
});

test("plain F1, F5 and F12 are bindable and record legacy function-key sequences", () => {
  for (const [key, raw] of [["f1", "\x1bOP"], ["f5", "\x1b[15~"], ["f12", "\x1b[24~"]] as const) {
    assert.deepEqual(classifyKey(key), { kind: "free", key });
    const f = fixture();
    record(f, raw);
    assert.deepEqual(f.saved, [{ sidebar: key }]);
  }
});

test("Cmd/Win is displayed while recorded keys retain Pi's super spelling", () => {
  const f = fixture();
  record(f, "\x1b[107;9u");
  assert.deepEqual(f.saved, [{ sidebar: "super+k" }]);
  assert.match(f.render(), /Shortcut\s+\[ Cmd\/Win\+K \]/);
  assert.doesNotMatch(f.render(), /super/i);
});

test("Escape backs out of recording; Ctrl+C closes from list, recording or confirmation", () => {
  const f = fixture();
  f.input(right, enter, esc);
  assert.doesNotMatch(f.render(), /Press a key…/);
  assert.deepEqual(f.done, []);
  f.input(esc, esc);
  assert.deepEqual(f.done, [false]);
  for (const mode of [[], [enter], [del]]) {
    const cancel = fixture();
    cancel.input(right, enter, f2, ...mode, "\x03");
    assert.deepEqual(cancel.saved, [{ sidebar: "f2" }]);
    assert.deepEqual(cancel.done, [true]);
  }
});

test("reserved, viewport, editor, bare and unsupported inputs stay in recording and do not save", () => {
  const f = fixture();
  f.input(right, enter);
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
  native.input(right, enter, "\x01");
  assert.deepEqual(native.saved, [{ sidebar: "ctrl+a" }]);
});

test("Kitty and xterm shifted-symbol aliases stay reserved and moves remove all owners at once", () => {
  for (const [physical, data] of [["ctrl+shift+=", "\x1b[61:43;6u"], ["ctrl+shift+-", "\x1b[45:43;6u"], ["ctrl+shift+?", "\x1b[27;6;63~"]] as const) {
    const blocked = fixture(undefined, true, new KeybindingsManager({ "app.interrupt": physical }));
    blocked.input(right, enter, data);
    assert.match(blocked.render(), /Reserved by Pi: Cancel or abort/);
    assert.match(blocked.render(), /Press a key…/);
    assert.deepEqual(blocked.saved, []);
  }
  const initial = { prompts: "ctrl+shift+=", theme: "ctrl++" };
  const moved = fixture(initial);
  moved.input(right, enter, "\x1b[61:43;6u");
  assert.deepEqual(moved.saved, [{ sidebar: "ctrl++", prompts: false, theme: false }]);
  assert.deepEqual(initial, { prompts: "ctrl+shift+=", theme: "ctrl++" });
});

test("footer chips honor remapped select controls and drop labels before chips", () => {
  const f = themed(undefined, true, new KeybindingsManager({ "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n", "tui.select.confirm": "f6" }));
  assert(f.render(500).includes(`${chip("Ctrl+P/Ctrl+N")} ${fg("muted", "Move")}`));
  assert(f.render(500).includes(`${chip("→")} ${fg("muted", "Open")}`));
  f.input(right);
  assert(f.render(500).includes(`${chip("F6")} ${fg("muted", "Choose")}`));
  assert.doesNotMatch(fixture().render(24), /Move|Open|Remove|Close/);
  f.input(left, "\x10");
  assert.match(f.render(), /Actions 7\/7/);
  f.input(right, "\x1b[17~");
  assert(f.render(500).includes(`${chip("Esc")} ${fg("muted", "Cancel")}`));
  for (const label of ["Move", "Choose", "Remove", "Back"]) assert(!f.render(500).includes(fg("muted", label)));
});

test("remapped cancel closes or cancels recording, with Esc and Ctrl+C still available", () => {
  const keys = new KeybindingsManager({ "tui.select.cancel": "f6" });
  for (const close of ["\x1b[17~", esc, "\x03"]) {
    const f = themed(undefined, true, keys);
    assert(f.render(500).includes(`${chip("F6")} ${fg("muted", "Close")}`));
    f.input(right, enter);
    assert(f.render(500).includes(`${chip("F6")} ${fg("muted", "Cancel")}`));
    assert(f.render(500).includes("F6 cancels") && f.render(500).includes(markerTheme.getFgAnsi("dim")));
    f.input("\x1b[17~");
    assert.doesNotMatch(f.render(), /Press a key…/);
    assert.deepEqual(f.done, []);
    f.input(close, close);
    assert.deepEqual(f.done, [false]);
  }
});

test("cancel and confirm collisions never arm removal or save", () => {
  const cancel = new KeybindingsManager({ "tui.select.cancel": "backspace" });
  const closes = themed({ sidebar: "f8" }, true, cancel);
  closes.input(bs);
  assert.deepEqual(closes.saved, []);
  assert.deepEqual(closes.done, [false]);

  const backs = themed({ sidebar: "f8" }, true, cancel);
  backs.input(right);
  backs.input(bs);
  assert.doesNotMatch(backs.render(500), /Press Backspace again to remove/);
  assert.deepEqual(backs.saved, []);
  assert.match(backs.render(500), /Move/);
  backs.input(bs);
  assert.deepEqual(backs.done, [false]);
  assert.deepEqual(backs.saved, []);

  const confirmLeft = themed({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "left" }));
  confirmLeft.input(right);
  confirmLeft.input(left);
  assert.match(confirmLeft.render(500), /Move/);
  assert.deepEqual(confirmLeft.saved, []);
  assert.deepEqual(confirmLeft.done, []);
  confirmLeft.input(esc);
  assert.deepEqual(confirmLeft.done, [false]);
});

test("Space removes only through the Remove option and still needs two presses", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(" ");
  f.input(" ");
  assert.doesNotMatch(f.render(), /Press Space again to remove/);
  assert.deepEqual(f.saved, []);

  f.input(right, down, " ");
  assert.match(f.render(), /Press Space again to remove F8/);
  f.input(" ");
  assert.deepEqual(f.saved, [{ sidebar: false }]);
});

test("arrow keys clear removal confirmation and move in the same event", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(del);
  assert.match(f.render(), /Press Del again to remove F8/);
  f.input(up);
  assert.doesNotMatch(f.render(), /Press Del again to remove F8/);
  assert.match(f.render(), /› Composer details/);
  assert.deepEqual(f.saved, []);
});

test("removal uses the key that armed it and navigation clears first", () => {
  const downConfirm = themed({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "down" }));
  downConfirm.input(right, up, down);
  assert.doesNotMatch(downConfirm.render(500), /Press Down again to remove F8/);
  assert.deepEqual(downConfirm.saved, [], "Down navigates instead of arming removal");
  downConfirm.input(del, del);
  assert.deepEqual(downConfirm.saved, [{ sidebar: false }]);

  const backspaceConfirm = themed({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "backspace" }));
  backspaceConfirm.input(right, up, bs);
  assert.match(backspaceConfirm.render(500), /Press Backspace again to remove F8/);
  backspaceConfirm.input(bs);
  assert.deepEqual(backspaceConfirm.saved, [{ sidebar: false }]);
});

test("unmatched held keys cannot record or clear confirmation", () => {
  const recording = fixture({ sidebar: "f8" });
  recording.input(right, enter);
  recording.input("\x1b[97;1:2u");
  assert.deepEqual(recording.saved, []);
  assert.match(recording.render(), /Press a key…/);
  recording.input(f2);
  assert.deepEqual(recording.saved, [{ sidebar: "f2" }]);

  const pending = fixture({ sidebar: "f8" });
  pending.input(del, "\x1b[97;1:2u");
  assert.match(pending.render(), /Press Del again to remove F8/);
  pending.input(del);
  assert.deepEqual(pending.saved, [{ sidebar: false }]);
});

test("right pane reserves option and status rows across actions and removal", () => {
  const slots = (width: number, lines: string[]) => {
    const plain = lines.map(line => stripVTControlCharacters(line));
    const cells = width >= 68 ? plain.map(line => line.split("│")[2] ?? "") : plain.map(line => line.slice(2, -2));
    return {
      option: plain.findIndex(line => line.includes("Record shortcut")),
      status: cells.findIndex(cell => /^\s*[●○▲✕↺]/.test(cell)),
    };
  };
  for (const [width, rows] of [[100, 30], [70, 20], [58, 15]] as const) {
    const f = fixture({ sidebar: "f8" });
    f.terminal.rows = rows;
    f.input(right);
    const first = slots(width, f.panel.render(width));
    assert(first.option >= 0, `${width}x${rows} option row`);
    assert(first.status >= 0, `${width}x${rows} status row`);
    for (let index = 1; index < 7; index++) {
      f.input(esc, down, right);
      const current = slots(width, f.panel.render(width));
      assert(current.status >= 0, `${width}x${rows} action ${index} status row`);
      assert.deepEqual(current, first, `${width}x${rows} action ${index}`);
    }
  }

  const removed = fixture({ sidebar: "f8" });
  removed.terminal.rows = 30;
  removed.input(right);
  const before = slots(100, removed.panel.render(100));
  removed.input(del, del);
  assert.deepEqual(slots(100, removed.panel.render(100)), before);
});

test("right navigation clears pending removal before the next Choose", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(right, up, enter);
  assert.match(f.render(), /Press Enter again to remove F8/);
  f.input(up);
  assert.doesNotMatch(f.render(), /Press Enter again to remove F8/);
  f.input(enter);
  assert.match(f.render(), /Press a key…/);
  assert.deepEqual(f.saved, []);
});

test("tiny Remove keeps the saved reminder and binding health", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  record(f, f2);
  f.input(up);
  const text = f.render(50);
  assert.match(text, /● Ready/);
  assert.match(text, /✓ Saved — applies/);
});

test("Remove focus keeps the binding health visible", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.input(right, down);
  assert.match(f.render(50), /Ready/);
});

test("removal confirmation marks Remove, not Record", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 30;
  f.input(right, del);
  const lines = f.panel.render(100);
  assert.match(lines.find(line => line.includes("Record shortcut"))!, /● Ready/);
  assert.match(lines.find(line => line.includes("Remove shortcut"))!, /▲ Confirm/);
});

test("tall stacked detail uses spare rows for description and command", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 30;
  f.input(right);
  const text = f.render(58);
  assert.match(text, /Shows or hides the sidebar/);
  assert.match(text, /\/slate focused/);
  assert.match(text, /Record shortcut/);
});

test("narrow stacked recording keeps a full prompt and the active option", () => {
  for (const [width, rows] of [[24, 15], [26, 30]] as const) {
    const f = fixture({ sidebar: "f8" });
    f.terminal.rows = rows;
    f.input(right, enter);
    const text = f.render(width);
    assert.match(text, /Press a key…/, `${width}x${rows}`);
    assert.doesNotMatch(text, /Shortcut {2}\[ ● Press/, `${width}x${rows}`);
    assert.match(text, /Record shortcut/, `${width}x${rows}`);
  }
});

test("saved reminder survives a rejected key and returns after cancel", () => {
  const f = fixture();
  record(f, f2);
  f.input(enter);
  f.input("a");
  assert.match(f.render(), /Add Ctrl, Alt or Cmd\/Win/);
  f.input(esc);
  assert.match(f.render(), /✓ Saved — applies when you close/);
});

test("tiny two-row removal keeps the active choice ahead of the saved reminder", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 4;
  record(f, f2);
  f.input(del);
  const text = f.render(50);
  assert.match(text, /Press Del again/);
  assert.match(text, /Remove shortcut/);
  assert.doesNotMatch(text, /Saved/);
});

test("tiny left removal shows the prompt and saved reminder once each", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  record(f, f2);
  f.input(esc, del);
  const text = f.render(50);
  assert.equal(text.split("Press Del again").length - 1, 1);
  assert.match(text, /✓ Saved — applies/);
});

test("tiny left confirmation closes in one Escape without removing", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(del, esc);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.done, [false]);
});

test("tiny right conflict keeps the specific reason above hints", () => {
  const f = fixture({ prompts: "ctrl+a" });
  f.terminal.rows = 6;
  f.input(down, right);
  const text = f.render(50);
  assert.match(text, /Used by Slate's editor/);
});

test("tiny left detail keeps the blocking reason beside the saved reminder", () => {
  const f = fixture({ prompts: "ctrl+a" });
  f.terminal.rows = 8;
  f.input(right, enter, f2, esc, down);
  const text = f.render(50);
  assert.match(text, /✓ Saved — applies/);
  assert.match(text, /Used by Slate's editor/);
});

test("tiny disabled detail keeps its blocking status beside the saved reminder", () => {
  const f = fixture({}, false);
  record(f, f2);
  f.input(esc, down, right);
  f.terminal.rows = 6;
  const text = f.render(26);
  assert.match(text, /Needs editor/);
  assert.match(text, /✓ Saved — applies/);
});

test("tiny right pane names the action beside the shortcut", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.input(right);
  const text = f.render(50);
  assert.match(text, /Toggle sidebar\s+Shortcut/);
  assert.match(text, /Record shortcut/);
});

test("tiny narrow right pane gives the active choice a full row", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.input(right);
  const text = f.render(26);
  assert.match(text, /Record shortcut/);
  assert.doesNotMatch(text, /Record sh…/);
});

test("narrow right footer keeps labels before dropping the optional removal hint", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.input(right);
  const text = f.render(50);
  assert.match(text, /Move/);
  assert.match(text, /Choose/);
  assert.match(text, /Back/);
  assert.doesNotMatch(text, /Del/);
});

test("configured navigation beats the Space fallback", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "space" }));
  f.input(" ");
  assert.match(f.render(), /Actions 2\/7/);
  assert.deepEqual(f.saved, []);
  f.input(right);
  f.input(" ");
  assert.doesNotMatch(f.render(), /Press a key…/);
  assert.deepEqual(f.saved, []);

  const enterNav = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "enter", "tui.select.confirm": "f6" }));
  enterNav.input(enter);
  assert.match(enterNav.render(), /Actions 2\/7/);
  enterNav.input(right, enter);
  assert.doesNotMatch(enterNav.render(), /Press a key…/);
  assert.deepEqual(enterNav.saved, []);

  const enterOnly = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "enter" }));
  enterOnly.input(enter);
  assert.match(enterOnly.render(), /Actions 2\/7/);
  enterOnly.input(right);
  assert.match(enterOnly.render(500), /Space\s+Choose/);
  enterOnly.input(enter);
  assert.doesNotMatch(enterOnly.render(), /Press a key…/);
  assert.deepEqual(enterOnly.saved, []);

  const leftConfirm = themed({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "left" }));
  leftConfirm.input(right);
  assert(leftConfirm.render(500).includes(`${chip("Enter")} ${fg("muted", "Choose")}`));
  assert(!leftConfirm.render(500).includes(`${chip("←")} ${fg("muted", "Choose")}`));

  const downConfirm = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "down" }));
  downConfirm.input(down);
  assert.match(downConfirm.render(), /Actions 2\/7/);
  downConfirm.input(right, down);
  assert.doesNotMatch(downConfirm.render(), /Press a key…/);
  assert.match(downConfirm.render(), /Enter\s+Choose/);
});

test("one-row terminals keep the active choice above routine status", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 3;
  assert.match(f.render(50), /Toggle sidebar/);
  f.input(right);
  assert.match(f.render(50), /Record shortcut/);
});

test("tiny recording errors outrank the active prompt", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 4;
  f.input(right, enter, "\x14");
  assert.match(f.render(50), /Reserved by Pi/);
  assert.match(f.render(18), /Reserved by Pi/);
  assert.match(f.render(18), /Press a key/);
  f.terminal.rows = 3;
  assert.match(f.render(50), /Reserved by Pi/);
  assert.doesNotMatch(f.render(18), /Press a key/);
});

test("navigation keys never arm direct removal", () => {
  for (const nav of ["delete", "backspace"] as const) {
    const key = nav === "delete" ? del : bs;
    const f = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.down": nav }));
    f.input(key);
    assert.match(f.render(), /Actions 2\/7/);
    assert.match(f.render(500), new RegExp(`${nav === "delete" ? "Backspace" : "Del"}\\s+Remove`));
    f.input(right, key);
    assert.doesNotMatch(f.render(), /again to remove F2/);
    f.input(enter, enter);
    assert.deepEqual(f.saved, [{ sidebar: "f8", prompts: false }]);
  }
});

test("terminal aliases cannot turn navigation into removal", () => {
  const f = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.down": "ctrl+h" }));
  f.input("\x08");
  assert.match(f.render(), /Actions 2\/7/);
  assert.doesNotMatch(f.render(), /again to remove/);
  assert.deepEqual(f.saved, []);
});

test("hints skip shadowed confirm and removal keys", () => {
  const ctrlC = themed({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "ctrl+c" }));
  ctrlC.input(right);
  assert(ctrlC.render(500).includes(`${chip("Enter")} ${fg("muted", "Choose")}`));
  assert(!ctrlC.render(500).includes(`${chip("Ctrl+C")} ${fg("muted", "Choose")}`));

  const deleteConfirm = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "delete" }));
  deleteConfirm.input(right);
  assert.match(deleteConfirm.render(500), /Backspace\s+Remove/);

  const ctrlM = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "ctrl+m" }));
  ctrlM.input(right);
  assert.match(ctrlM.render(500), /Space\s+Choose/);
  assert.doesNotMatch(ctrlM.render(500), /Enter\s+Choose/);
});

test("Right never opens when it is the configured navigation key", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "right", "tui.select.confirm": "right" }));
  f.input(right);
  assert.match(f.render(), /Actions 2\/7/);
  assert.match(f.render(), /Enter\s+Open/);
  f.input(enter);
  assert.match(f.render(), /Choose/);
});

test("Ctrl+H cannot confirm a Backspace removal", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "ctrl+h" }));
  f.input(bs);
  assert.match(f.render(), /Press Backspace again to remove F8/);
  f.input("\x08");
  assert.doesNotMatch(f.render(), /Press Backspace again to remove F8/);
  assert.deepEqual(f.saved, []);
  f.input(bs, bs);
  assert.deepEqual(f.saved, [{ sidebar: false }]);
});

test("Enter opens only when it is not a configured navigation key", () => {
  const f = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.down": "ctrl+m" }));
  f.input(enter);
  assert.match(f.render(), /Actions 2\/7/);
  assert.doesNotMatch(f.render(), /Choose/);
});

test("a cancel key shadows the confirm hint", () => {
  const f = themed({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.cancel": "f6", "tui.select.confirm": "escape" }));
  f.input(right);
  assert(!f.render(500).includes(`${chip("Esc")} ${fg("muted", "Choose")}`));
  assert(f.render(500).includes(`${chip("Enter")} ${fg("muted", "Choose")}`));
});

test("fallback Tab keeps remapped navigation usable", () => {
  const rightNav = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "right" }));
  rightNav.input(right);
  assert.match(rightNav.render(), /Actions 2\/7/);
  rightNav.input("\t");
  assert.match(rightNav.render(), /Choose/);

  const spaceNav = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "space" }));
  spaceNav.input(right);
  assert.match(spaceNav.render(), /Choose/);
  spaceNav.input("\t");
  assert.match(spaceNav.render(), /Press a key…/);
});

test("a different confirm key cannot complete removal", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(right, down, enter);
  assert.match(f.render(), /Press Enter again to remove F8/);
  f.input(" ");
  assert.doesNotMatch(f.render(), /Press Enter again to remove F8/);
  assert.deepEqual(f.saved, []);
});

test("another configured confirm key cannot complete removal", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": ["f6", "f7"] }));
  f.input(right, down, "\x1b[17~");
  assert.match(f.render(), /Press F6 again to remove F8/);
  f.input("\x1b[18~");
  assert.doesNotMatch(f.render(), /Press F6 again to remove F8/);
  assert.deepEqual(f.saved, []);
  f.input("\x1b[17~", "\x1b[17~");
  assert.deepEqual(f.saved, [{ sidebar: false }]);
});

test("function-key navigation is filtered from hints", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "f6", "tui.select.confirm": "f6" }));
  f.input(right);
  assert.doesNotMatch(f.render(500), /F6\s+Choose/);
  assert.match(f.render(500), /(Enter|Space)\s+Choose/);
});

test("Space opens only when no preferred opener remains", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "right", "tui.select.cancel": "tab", "tui.select.confirm": "left" }));
  f.input(" ");
  assert.match(f.render(), /Choose/);
});

test("unprobed confirm aliases cannot suppress fallback opener", () => {
  const f = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": ["right", "j"], "tui.select.confirm": "j" }));
  f.input("j");
  assert.match(f.render(), /Actions 2\/7/);
  f.input(" ");
  assert.match(f.render(), /Choose/);
});

test("return aliases are normalized before fallback selection", () => {
  const f = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "right", "tui.select.confirm": "return" }));
  f.input(enter);
  assert.match(f.render(), /Actions 7\/7/);
  assert.match(f.render(), /Space\s+Open/);
  f.input(" ");
  assert.match(f.render(), /Choose/);
});

test("shadowed confirm aliases fall back to Tab", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.up": "enter", "tui.select.down": "space", "tui.select.confirm": "ctrl+[" }));
  f.input(right);
  f.input("\t");
  assert.match(f.render(), /Press a key…/);
});

test("navigation Left moves and Esc backs", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.down": "left", "tui.select.confirm": "left" }));
  f.input(right, left);
  assert.match(f.render(), /› Remove shortcut/);
  assert.match(f.render(), /Esc\s+Back/);
  assert.deepEqual(f.saved, []);
});

test("disabled detail keeps the saved reminder in the footer", () => {
  const f = fixture({}, false);
  record(f, f2);
  assert.match(f.render(), /✓ Saved — applies when you close/);
  f.input(esc, down);
  const text = f.render();
  assert.match(text, /✕ Needs the editor surface/);
  assert.match(text, /✓ Saved — applies when you close/);
});

test("saved message survives cursor movement and later canceled edits", () => {
  const f = fixture();
  record(f, f2);
  assert.match(f.render(), /✓ Saved — applies when you close/);
  f.input(down);
  assert.match(f.render(), /✓ Saved — applies when you close/);
  f.input(up, enter);
  assert.match(f.render(), /Esc cancels/);
  f.input(esc);
  assert.match(f.render(), /✓ Saved — applies when you close/);
  f.input(del);
  assert.match(f.render(), /Press Del again/);
  f.input(esc);
  assert.match(f.render(), /✓ Saved — applies when you close/);
  f.input(del, "x");
  assert.match(f.render(), /✓ Saved — applies when you close/);
});

test("tiny recording prompt outranks the saved reminder", () => {
  const f = fixture();
  f.terminal.rows = 3;
  record(f, f2);
  f.input(enter);
  const text = f.render(50);
  assert.match(text, /Press/);
  assert.doesNotMatch(text, /Saved/);
});

test("modifier order is canonical before fallback selection", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.up": ["enter", "ctrl+shift+k"], "tui.select.down": "space", "tui.select.confirm": "shift+ctrl+k" }));
  f.input(right);
  f.input("\t");
  assert.match(f.render(), /Press a key…/);
});

test("Ctrl+H removal prompt names Ctrl+H and ignores Backspace", () => {
  const f = fixture({ sidebar: "f8" }, true, new KeybindingsManager({ "tui.select.confirm": "ctrl+h" }));
  f.input(right, down, "\x08");
  assert.match(f.render(), /Press Ctrl\+H again to remove F8/);
  f.input(bs);
  assert.doesNotMatch(f.render(), /Press Ctrl\+H again to remove F8/);
  f.input("\x08", "\x08");
  assert.deepEqual(f.saved, [{ sidebar: false }]);
});

test("Backspace removal survives a Ctrl+H navigation alias", () => {
  const f = fixture({ sidebar: "f8", prompts: "f2" }, true, new KeybindingsManager({ "tui.select.down": "ctrl+h" }));
  f.input("\x08");
  assert.match(f.render(), /Actions 2\/7/);
  f.input(bs, bs);
  assert.deepEqual(f.saved, [{ sidebar: "f8", prompts: false }]);
});

test("default Tab does not confirm", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(right);
  f.input("\t");
  assert.doesNotMatch(f.render(), /Press a key…/);
  assert.deepEqual(f.saved, []);
});

test("keypad Enter confirms a main-Enter removal", () => {
  const f = fixture({ sidebar: "f8" });
  f.input(right, down, enter);
  assert.match(f.render(), /Press Enter again to remove F8/);
  f.input("\x1bOM");
  assert.deepEqual(f.saved, [{ sidebar: false }]);
});

test("narrow terminals keep the active label and recording prompt", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.input(right);
  assert.match(f.render(12), /Record/);
  assert.match(f.render(22), /Ready/);
  f.terminal.rows = 4;
  assert.match(f.render(22), /Record/);
  assert.match(f.render(22), /Ready/);

  const recording = fixture({ sidebar: "f8" });
  recording.terminal.rows = 6;
  recording.input(right, enter);
  assert.match(recording.render(10), /Press/);
  assert.match(recording.render(12), /Press a key/);
  assert.match(recording.render(18), /Press a key/);
  assert.match(recording.render(24), /Press a key/);
});

test("recording prompts requires the editor surface", () => {
  const f = fixture(undefined, false);
  f.input(down, right, enter, f2);
  assert.match(f.render(), /✕ Needs editor/);
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
  f.input(del, "a");
  assert.doesNotMatch(f.render(), /again to remove/);
  f.input(del, down);
  assert.doesNotMatch(f.render(), /again to remove/);
  f.input(del, del);
  assert.deepEqual(f.saved, [{ sidebar: "f8", prompts: false }]);
  assert.match(f.render(), /Shortcut\s+Not set/);
  f.input(up, del, "\x1b[3;1:2~", "\x1b[3;1:3~", del);
  assert.deepEqual(f.saved.at(-1), { sidebar: false, prompts: false });
});

test("six-row terminals prioritize errors, saved messages and pending removal over status and hints", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  f.failures.push("Shortcuts not saved: F2 is now used by Prompt picker.");
  f.input(right, enter, f2);
  assert.match(f.render(), /Shortcuts not saved: F2 is now used by Prompt picker/);
  assert.match(f.render(), /\[ F8 \]/);
  f.input(del);
  assert.match(f.render(), /Press Del again to remove F8/);
  f.input(del);
  assert.match(f.render(), /✓ Saved — applies when you close/);
});

test("tiny terminals keep the active choice, input and status before the title", () => {
  const f = fixture({ sidebar: "f8" });
  f.terminal.rows = 6;
  const left = f.render(50);
  assert.match(left, /Slate shortcuts/);
  assert.match(left, /› Toggle sidebar · F8/);
  assert.match(left, /● Ready/);
  assert.match(left, /↑↓/);
  f.input(right);
  const rightText = f.render(50);
  assert.match(rightText, /Toggle sidebar/);
  assert.match(rightText, /Shortcut\s+\[ F8 \]/);
  assert.match(rightText, /› Record shortcut\s+● Ready/);
  assert.match(rightText, /↑↓/);
  f.terminal.rows = 5;
  assert.match(f.render(50), /Record shortcut/);
  f.terminal.rows = 4;
  const two = f.render(50);
  assert.match(two, /Record shortcut/);
  assert.match(two, /Shortcut/);
});

test("tiny terminals drop duplicate role text before the active choice", () => {
  const recording = fixture({ sidebar: "f8" });
  recording.terminal.rows = 4;
  recording.input(right, enter);
  const recordingText = recording.render(50);
  assert.match(recordingText, /Press a key/);
  assert.ok(recordingText.split("Esc cancels").length - 1 <= 1);
  recording.terminal.rows = 3;
  assert.match(recording.render(50), /Press a key/);
  assert.match(recording.render(18), /Press a key/);
  assert.doesNotMatch(recording.render(18), /Recor/);

  const pending = fixture({ sidebar: "f8" });
  pending.terminal.rows = 4;
  pending.input(del);
  const pendingText = pending.render(50);
  assert.match(pendingText, /› Toggle sidebar · F8/);
  assert.equal(pendingText.split("Press Del again").length - 1, 1);
});

test("failed records and unbinds retain the previous binding and show an error", () => {
  const f = themed({ sidebar: "f8", prompts: "f2" });
  f.failures.push("Could not save settings", "Another session changed this binding");
  f.input(right, enter, f2);
  assert(f.render(500).includes(fg("error", "Could not save settings")));
  assert(f.render(500).includes(styled("[ F8 ]", { fg: "accent", bg: "userMessageBg" })));
  f.input(del, del);
  assert(f.render(500).includes(fg("error", "Another session changed this binding")));
  assert(f.render(500).includes(styled("[ F8 ]", { fg: "accent", bg: "userMessageBg" })));
  f.input(esc, esc);
  assert.deepEqual(f.done, [false]);
});

test("live Latte and system palettes retain legible keycaps and exact ANSI geometry", () => {
  initTheme("system");
  const system = getThemeByName("system")!;
  const latte = loadThemeFromPath(fileURLToPath(new URL("../themes/catppuccin-latte-mauve.json", import.meta.url)), "truecolor");
  let active = latte;
  const f = fixture({ sidebar: "f8", prompts: "ctrl+alt+." }, true, undefined, () => active);
  const light = f.render();
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
      f.input(right, enter); check();
      if (current === latte && width === 88 && rows === 40) {
        const row = f.render(width).split("\n").find(line => stripVTControlCharacters(line).includes("› Toggle sidebar"))!;
        assert(row.includes(latte.getFgAnsi("muted")), "unfocused cursor uses muted");
        assert(!row.includes(latte.getFgAnsi("dim")), "unfocused cursor is not dim");
      }
      if (width === 88 && rows === 40) {
        assert(stripVTControlCharacters(f.render(width)).includes("[ ● Press a key… ]"));
        assert(f.render(width).includes(current.fg("warning", "●")));
      }
      f.input(esc, esc);
    }
    f.terminal.rows = 40;
  }
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
