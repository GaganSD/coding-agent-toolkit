import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, visibleWidth, type Component, type KeybindingsManager, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { compactPicker, fit, pickerBody, pickerFrame, pickerGeometry, PICKER_OVERLAY, selectedRow, viewport } from "./picker-frame.ts";
import { blockedShortcutText, classifyKey, parseKeyChord, SHORTCUT_ACTIONS, shortcutKey, shortcutOwners, type KeyClassification, type ShortcutActionId, type ShortcutKeys, type SlateShortcuts } from "./shortcuts.ts";

type Options = { ownsEditor: boolean };
type PanelKeys = ShortcutKeys & Pick<KeybindingsManager, "matches">;
const changedCount = (a: SlateShortcuts | undefined, b: SlateShortcuts | undefined) =>
  SHORTCUT_ACTIONS.filter(({ id }) => shortcutKey(a, id) !== shortcutKey(b, id)).length;

function statusText(result: KeyClassification): string {
  switch (result.kind) {
    case "free": return "free";
    case "pi": return `Replaces Pi: ${result.description}`;
    case "reserved": case "viewport": case "editor": return blockedShortcutText(result);
    case "moved": return `Moved from ${SHORTCUT_ACTIONS.find(({ id }) => id === result.from)!.label}`;
    case "needs-modifier": return "Add ctrl, alt or super";
    case "unsupported": return "Not supported by Pi";
  }
}

export class ShortcutsPanel implements Component {
  private selected = 0;
  private recording = false;
  private closed = false;
  private error = "";
  private draft: SlateShortcuts;
  private moved: Partial<Record<ShortcutActionId, ShortcutActionId>> = {};

  private initial: SlateShortcuts | undefined;
  private tui: Pick<TUI, "requestRender" | "terminal">;
  private theme: Theme;
  private keys: PanelKeys;
  private opts: Options;
  private done: (value: SlateShortcuts | undefined) => void;

  constructor(initial: SlateShortcuts | undefined, tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme, keys: PanelKeys, opts: Options, done: (value: SlateShortcuts | undefined) => void) {
    this.initial = initial; this.tui = tui; this.theme = theme; this.keys = keys; this.opts = opts; this.done = done;
    this.draft = { ...initial };
  }

  private get action() { return SHORTCUT_ACTIONS[this.selected]!; }
  private get disabled() { return this.action.id === "prompts" && !this.opts.ownsEditor; }

  private finish(value?: SlateShortcuts): void { this.closed = true; this.done(value); }

  private unbind(id: ShortcutActionId): void {
    if (this.initial?.[id] !== undefined) this.draft[id] = false;
    else delete this.draft[id];
    delete this.moved[id];
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+c")) { this.finish(); return; }
    if (matchesKey(data, "ctrl+s")) { this.finish(this.draft); return; }
    const { id } = this.action;
    this.error = "";
    if (matchesKey(data, "escape")) {
      if (!this.recording) { this.finish(); return; }
      this.recording = false;
    } else if (this.recording) {
      const key = parseKeyChord(parseKey(data) ?? "");
      if (!key) this.error = statusText({ kind: "needs-modifier" });
      else if (!matchesKey(data, key as KeyId)) this.error = statusText({ kind: "unsupported" });
      else {
        const result = classifyKey(key, id, this.draft, this.keys, this.opts.ownsEditor);
        if (result.kind === "free" || result.kind === "pi" || result.kind === "moved") {
          if (result.kind === "moved") {
            for (const owner of shortcutOwners(key, id, this.draft)) this.unbind(owner);
            this.moved[id] = result.from;
          } else delete this.moved[id];
          this.draft[id] = key;
          this.recording = false;
        } else this.error = statusText(result);
      }
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.selected = (this.selected + SHORTCUT_ACTIONS.length - 1) % SHORTCUT_ACTIONS.length;
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.selected = (this.selected + 1) % SHORTCUT_ACTIONS.length;
    } else if (this.keys.matches(data, "tui.select.confirm")) this.recording = !this.disabled;
    else if (matchesKey(data, "delete") || matchesKey(data, "backspace")) this.unbind(id);
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const { height, tiny, inner, bodyHeight } = pickerGeometry(width, this.tui.terminal.rows);
    const { id, label, detail } = this.action;
    const key = shortcutKey(this.draft, id);
    const from = this.moved[id];
    const status = this.disabled ? "Needs the editor surface" : from ? statusText({ kind: "moved", from })
      : key ? statusText(classifyKey(key, id, this.draft, this.keys, this.opts.ownsEditor)) : "free";
    const unsaved = changedCount(this.initial, this.draft);
    const title = `Slate shortcuts${unsaved ? ` · ${unsaved} unsaved` : ""}`;
    const hint = this.recording ? "Press a key… (Esc to go back)" : "Press Enter, then the new key.";
    const hints: [string, string] = ["↑↓ action · Enter record key · Del unbind", "Ctrl+S save · Esc back · Ctrl+C cancel"];
    if (tiny) return compactPicker([
      th.bold(title), th.fg("accent", `${label} · ${key ?? "—"}`),
      this.error ? th.fg("error", this.error) : status, th.fg("dim", this.recording ? hint : "↑↓ · ↵ record · Del"),
      th.fg("dim", width < 38 ? "^S save Esc back ^C" : hints[1]),
    ], width, height);
    const actions = (columns: number, rows: number) => viewport(th, "Actions", this.selected, SHORTCUT_ACTIONS.length,
      this.selected, SHORTCUT_ACTIONS.length, columns, rows, i => {
        const action = SHORTCUT_ACTIONS[i]!;
        const bound = shortcutKey(this.draft, action.id) ?? "—";
        const keyWidth = Math.min(visibleWidth(bound), columns - 4);
        return selectedRow(th, fit(action.label, columns - 3 - keyWidth) + " " + fit(bound, keyWidth), i === this.selected, columns);
      });
    const details = (columns: number, rows: number) => {
      const name = th.bold(label), keyLine = `Key      ${key ?? "—"}`, statusLine = `Status   ${status}`;
      const actionHint = this.disabled && !key ? "" : this.disabled ? "Del removes it." : hint;
      const removeHint = this.recording || this.disabled ? "" : "Del removes it.";
      const lines = rows >= 8 ? [name, detail, "", keyLine, statusLine, "", actionHint, removeHint]
        : rows >= 6 ? [name, detail, keyLine, statusLine, actionHint, removeHint]
        : [statusLine, actionHint, detail, removeHint, keyLine];
      return compactPicker(lines, columns, rows);
    };
    const body = pickerBody(th, width, inner, bodyHeight, actions, details);
    return pickerFrame(th, width, title, body, this.error, hints);
  }

  invalidate(): void {}
}

export async function openShortcutsPanel(ctx: ExtensionContext, current: SlateShortcuts | undefined, opts: Options): Promise<SlateShortcuts | undefined> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/shortcuts requires interactive terminal mode", "error"); return; }
  const draft = await ctx.ui.custom<SlateShortcuts | undefined>((tui, theme, keys, done) =>
    new ShortcutsPanel(current, tui, theme, keys, opts, done), PICKER_OVERLAY);
  return draft && changedCount(current, draft) ? draft : undefined;
}
