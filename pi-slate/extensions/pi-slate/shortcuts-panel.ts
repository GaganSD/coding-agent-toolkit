import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { compactPicker, fit, pickerBody, pickerFrame, pickerGeometry, PICKER_OVERLAY, sectionRow, selectedRow, viewport } from "./picker-frame.ts";
import { changedShortcuts, classifyKey, SHORTCUT_ACTIONS, shortcutKey, shortcutSaveKey, shortcutStatus, type KeyClassification, type ShortcutActionId, type SlateShortcuts } from "./shortcuts.ts";

type Options = { ownsEditor: boolean };
type PanelKeys = Pick<KeybindingsManager, "getDefinition" | "getKeys" | "getResolvedBindings" | "matches">;
const keyLabel = (key: string) => key.replace(/(^|\+)[a-z]/g, part => part.toUpperCase());
type MovedKey = Extract<KeyClassification, { kind: "moved" }>;

// Insert headers without changing the catalog or keyboard traversal order.
const SECTIONS: Partial<Record<ShortcutActionId, string>> = { sidebar: "Layout", prompts: "Pickers", pid: "Display" };
const ACTION_ROWS = SHORTCUT_ACTIONS.flatMap<{ section: string } | { index: number }>(({ id }, index) => {
  const section = SECTIONS[id];
  return section ? [{ section }, { index }] : [{ index }];
});

export class ShortcutsPanel implements Component {
  private selected = 0;
  private recording = false;
  private closed = false;
  private error = "";
  private draft: SlateShortcuts;
  private moved: Partial<Record<ShortcutActionId, MovedKey>> = {};
  private saveKey: ReturnType<typeof shortcutSaveKey>;

  private initial: SlateShortcuts | undefined;
  private tui: Pick<TUI, "requestRender" | "terminal">;
  private theme: () => Theme;
  private keys: PanelKeys;
  private opts: Options;
  private done: (value: SlateShortcuts | undefined) => void;

  constructor(initial: SlateShortcuts | undefined, tui: Pick<TUI, "requestRender" | "terminal">,
    theme: () => Theme, keys: PanelKeys, opts: Options, done: (value: SlateShortcuts | undefined) => void) {
    this.initial = initial; this.tui = tui; this.theme = theme; this.keys = keys; this.opts = opts; this.done = done;
    this.draft = { ...initial };
    this.saveKey = shortcutSaveKey(keys);
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
    if (this.saveKey && matchesKey(data, this.saveKey)) { this.finish(this.draft); return; }
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
    const th = this.theme();
    const { height, tiny, inner, bodyHeight } = pickerGeometry(width, this.tui.terminal.rows);
    const { id, label, detail } = this.action;
    const key = shortcutKey(this.draft, id);
    const result = key && !this.disabled ? this.moved[id] ?? classifyKey(key, { id, draft: this.draft, keys: this.keys, ownsEditor: this.opts.ownsEditor }) : undefined;
    const kind = result?.kind ?? "free";
    const [color, glyph]: [Parameters<Theme["fg"]>[0], string] = this.disabled ? ["error", "✕"] : kind === "free" ? ["success", "●"]
      : kind === "pi" ? ["warning", "▲"] : kind === "moved" ? ["accent", "↺"] : ["error", "✕"];
    const status = th.fg(color, `${glyph} ${this.disabled ? "Needs the editor surface" : result ? shortcutStatus(result) : "free"}`);
    const error = this.error ? `✕ ${this.error}` : "";
    const unsaved = changedShortcuts(this.initial, this.draft).length;
    const title = "Slate shortcuts", suffix = unsaved ? th.fg("warning", ` · ${unsaved} unsaved`) : "";
    const name = th.style(label, { fg: "accent", bold: true });
    const recording = th.fg("accent", "● Recording");
    const keycap = (bound: string | undefined, selected = false, columns?: number) => {
      if (!bound) return selected ? "—" : th.fg("dim", "—");
      const text = keyLabel(bound);
      const cap = ` ${columns === undefined ? text : fit(text, columns - 2)} `;
      // The selected row paints its entire keycap in bold text on selectedBg.
      return selected ? cap : th.style(cap, { fg: "accent", bg: "userMessageBg" });
    };
    const control = (id: "up" | "down" | "confirm") => this.keys.getKeys(`tui.select.${id}`).map(keyLabel).join("/");
    const up = control("up"), down = control("down"), confirm = control("confirm");
    const nav = up === "Up" && down === "Down" ? "↑↓" : `${up || "—"}/${down || "—"}`;
    const hint = this.recording ? "Press a key… (Esc to go back)" : confirm ? `Press ${confirm}, then the new key.` : "No record key assigned.";
    const save = this.saveKey ? `${keyLabel(this.saveKey)} save` : "Save blocked";
    const back = unsaved && !this.recording ? "Esc discard" : "Esc back";
    const hints: [string, string] = [`${nav} action · ${confirm || "—"} record key · Del unbind`, `${save} · ${back} · Ctrl+C cancel`];
    if (tiny) return compactPicker([
      th.bold(title) + suffix, `${name} · ${keycap(key)}`,
      error ? th.fg("error", error) : this.recording ? recording : status,
      ...(error && height >= 6 ? [recording] : []),
      th.fg("dim", this.recording ? hint : `${nav} · ${confirm || "—"} record · Del`),
      th.fg("dim", width < 38 ? `${save} · ${back}` : hints[1]),
    ], width, height);
    const actions = (columns: number, rows: number) => viewport(th, "Actions", this.selected, SHORTCUT_ACTIONS.length,
      ACTION_ROWS.findIndex(row => "index" in row && row.index === this.selected), ACTION_ROWS.length, columns, rows, i => {
        const row = ACTION_ROWS[i]!;
        if ("section" in row) return sectionRow(th, row.section);
        const action = SHORTCUT_ACTIONS[row.index]!, selected = row.index === this.selected;
        const bound = shortcutKey(this.draft, action.id);
        const keyWidth = bound ? Math.min(visibleWidth(keyLabel(bound)) + 2, columns - 4) : 1;
        return selectedRow(th, fit(action.label, columns - 3 - keyWidth) + " " + keycap(bound, selected, keyWidth), selected, columns);
      });
    const details = (columns: number, rows: number) => {
      const description = th.fg("muted", detail), keyLine = `Key    ${keycap(key)}`, statusLine = `Status ${status}`;
      const actionHint = this.disabled ? key ? "Del removes it." : "" : hint;
      const removeHint = this.disabled ? "" : "Del removes it.";
      const controls = this.recording ? [recording, hint] : [actionHint, removeHint];
      const lines = rows >= 8 ? [name, description, "", keyLine, statusLine, "", ...controls]
        : rows >= 6 ? [name, description, keyLine, statusLine, ...controls]
        : [statusLine, ...(this.recording ? controls : [actionHint, description, removeHint]), keyLine];
      return compactPicker(lines, columns, rows);
    };
    const body = pickerBody(th, width, inner, bodyHeight, actions, details);
    return pickerFrame(th, width, title, body, error, hints, this.recording ? "borderAccent" : "border", suffix);
  }

  invalidate(): void {}
}

export async function openShortcutsPanel(ctx: ExtensionContext, current: SlateShortcuts | undefined, opts: Options): Promise<SlateShortcuts | undefined> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/shortcuts requires interactive terminal mode", "error"); return; }
  const draft = await ctx.ui.custom<SlateShortcuts | undefined>((tui, _theme, keys, done) =>
    new ShortcutsPanel(current, tui, () => ctx.ui.theme, keys, opts, done), PICKER_OVERLAY);
  return draft && changedShortcuts(current, draft).length ? draft : undefined;
}
