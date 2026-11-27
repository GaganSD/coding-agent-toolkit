import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { compactPicker, fit, pickerBody, pickerFrame, pickerGeometry, PICKER_OVERLAY, selectedRow, viewport } from "./picker-frame.ts";
import { changedShortcuts, classifyKey, hasPiBinding, SHORTCUT_ACTIONS, shortcutKey, shortcutStatus, type KeyClassification, type ShortcutActionId, type ShortcutKeys, type SlateShortcuts } from "./shortcuts.ts";

type Options = { ownsEditor: boolean };
type PanelKeys = ShortcutKeys & Pick<KeybindingsManager, "matches">;
type MovedKey = Extract<KeyClassification, { kind: "moved" }>;

export class ShortcutsPanel implements Component {
  private selected = 0;
  private recording = false;
  private closed = false;
  private error = "";
  private draft: SlateShortcuts;
  private moved: Partial<Record<ShortcutActionId, MovedKey>> = {};
  private altSave: boolean;

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
    this.altSave = hasPiBinding("ctrl+s", keys);
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
    if (matchesKey(data, "ctrl+s") || (this.altSave && matchesKey(data, "alt+s"))) { this.finish(this.draft); return; }
    const { id } = this.action;
    this.error = "";
    if (matchesKey(data, "escape")) {
      if (!this.recording) { this.finish(); return; }
      this.recording = false;
    } else if (this.recording) {
      const result = classifyKey(parseKey(data) ?? "", { id, draft: this.draft, keys: this.keys, ownsEditor: this.opts.ownsEditor, data });
      if ("key" in result) {
        if (result.kind === "moved") {
          for (const owner of result.owners) this.unbind(owner);
          this.moved[id] = result;
        } else delete this.moved[id];
        this.draft[id] = result.key;
        this.recording = false;
      } else this.error = shortcutStatus(result);
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
    const status = this.disabled ? "Needs the editor surface" : key
      ? shortcutStatus(this.moved[id] ?? classifyKey(key, { id, draft: this.draft, keys: this.keys, ownsEditor: this.opts.ownsEditor })) : "free";
    const unsaved = changedShortcuts(this.initial, this.draft).length;
    const title = `Slate shortcuts${unsaved ? ` · ${unsaved} unsaved` : ""}`;
    const hint = this.recording ? "Press a key… (Esc to go back)" : "Press Enter, then the new key.";
    const save = this.altSave ? "Alt+S" : "Ctrl+S";
    const hints: [string, string] = ["↑↓ action · Enter record key · Del unbind", `${save} save · Esc back · Ctrl+C cancel`];
    if (tiny) return compactPicker([
      th.bold(title), th.fg("accent", `${label} · ${key ?? "—"}`),
      this.error ? th.fg("error", this.error) : status, th.fg("dim", this.recording ? hint : "↑↓ · ↵ record · Del"),
      th.fg("dim", width < 38 ? `${this.altSave ? save : "^S"} save Esc back ^C` : hints[1]),
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
  return draft && changedShortcuts(current, draft).length ? draft : undefined;
}
