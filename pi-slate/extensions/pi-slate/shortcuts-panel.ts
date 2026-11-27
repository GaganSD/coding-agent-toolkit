import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, parseKey, visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { compactPicker, fit, framedPicker, pickerBody, pickerGeometry, PICKER_OVERLAY, sectionRow, selectedRow, viewport } from "./picker-frame.ts";
import { changedShortcuts, classifyKey, SHORTCUT_ACTIONS, shortcutKey, shortcutLabel, shortcutStatus, type KeyClassification, type RecordedShortcut, type ShortcutActionId, type SlateShortcuts } from "./shortcuts.ts";

type Options = { ownsEditor: boolean };
type PanelKeys = Pick<KeybindingsManager, "getDefinition" | "getKeys" | "getResolvedBindings" | "matches">;
type Save = (previous: SlateShortcuts, next: SlateShortcuts, recorded?: RecordedShortcut) => string | undefined;
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
  private removing?: "Del" | "Backspace";
  private closed = false;
  private saved = false;
  private message?: { token: "error" | "success"; text: string };
  private bindings: SlateShortcuts;
  private moved: Partial<Record<ShortcutActionId, MovedKey>> = {};

  private tui: Pick<TUI, "requestRender" | "terminal">;
  private theme: () => Theme;
  private keys: PanelKeys;
  private opts: Options;
  private save: Save;
  private done: (saved: boolean) => void;

  constructor(initial: SlateShortcuts | undefined, tui: Pick<TUI, "requestRender" | "terminal">,
    theme: () => Theme, keys: PanelKeys, opts: Options, save: Save, done: (saved: boolean) => void) {
    this.bindings = { ...initial };
    this.tui = tui; this.theme = theme; this.keys = keys; this.opts = opts; this.save = save; this.done = done;
  }

  private get action() { return SHORTCUT_ACTIONS[this.selected]!; }
  private get disabled() { return this.action.id === "prompts" && !this.opts.ownsEditor; }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(this.saved);
  }

  private apply(next: SlateShortcuts, recorded?: RecordedShortcut, moved?: MovedKey): void {
    const changed = changedShortcuts(this.bindings, next);
    if (!changed.length) return;
    const error = this.save(this.bindings, next, recorded);
    if (error) { this.message = { token: "error", text: error }; return; }
    this.bindings = next;
    for (const id of changed) delete this.moved[id];
    if (moved) this.moved[this.action.id] = moved;
    this.saved = true;
    this.message = { token: "success", text: "✓ Saved — applies when you close" };
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRepeat(data) || isKeyRelease(data)) return;
    if (matchesKey(data, "ctrl+c")) { this.finish(); return; }
    const { id } = this.action;
    const wasRemoving = this.removing;
    this.removing = undefined;
    if (matchesKey(data, "escape") || this.keys.matches(data, "tui.select.cancel")) {
      if (!this.recording) { this.finish(); return; }
      this.recording = false;
      if (this.message?.token === "error") this.message = undefined;
    } else if (this.recording) {
      const result = classifyKey(parseKey(data) ?? "", { id, draft: this.bindings, keys: this.keys, ownsEditor: this.opts.ownsEditor, data });
      if ("key" in result) {
        this.recording = false;
        if (this.message?.token === "error") this.message = undefined;
        const next = { ...this.bindings, [id]: result.key };
        if (result.kind === "moved") for (const owner of result.owners) next[owner] = false;
        this.apply(next, { id, key: result.key, data }, result.kind === "moved" ? result : undefined);
      } else this.message = { token: "error", text: `✕ ${shortcutStatus(result)}` };
    } else if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
      const removalKey = matchesKey(data, "delete") ? "Del" : "Backspace";
      if (shortcutKey(this.bindings, id)) {
        // Legacy terminals can't distinguish auto-repeat from a second press.
        if (wasRemoving === removalKey) this.apply({ ...this.bindings, [id]: false });
        else if (!wasRemoving) this.removing = removalKey;
      }
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.selected = (this.selected + SHORTCUT_ACTIONS.length - 1) % SHORTCUT_ACTIONS.length;
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.selected = (this.selected + 1) % SHORTCUT_ACTIONS.length;
    } else if (this.keys.matches(data, "tui.select.confirm")) this.recording = !this.disabled;
    else if (!wasRemoving) return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme();
    const { height, tiny, inner, bodyHeight } = pickerGeometry(width, this.tui.terminal.rows);
    const { id, label, detail, command } = this.action;
    const title = "Slate shortcuts", key = shortcutKey(this.bindings, id);
    const name = th.style(label, { fg: "accent", bold: true });
    const chip = (text: string, selected = false, pad = true) => {
      const padded = pad ? ` ${text} ` : text;
      // The selected list row paints its entire keycap in bold text on selectedBg.
      return selected ? padded : th.style(padded, { fg: "accent", bg: "userMessageBg" });
    };
    const control = (id: "up" | "down" | "confirm" | "cancel") => this.keys.getKeys(`tui.select.${id}`)
      .filter(key => id !== "cancel" || key !== "ctrl+c").map(key => key === "escape" ? "Esc" : shortcutLabel(key)).join("/");
    const up = control("up"), down = control("down"), confirm = control("confirm"), cancelLabel = control("cancel") || "Esc";
    const nav = up === "Up" && down === "Down" ? "↑↓" : `${up || "—"}/${down || "—"}`;
    const hints = (columns: number) => {
      const pairs: [string, string][] = this.recording ? [[cancelLabel, "Cancel"]] : [[nav, "Move"], [confirm || "—", "Record"], ["Del", "Remove"], [cancelLabel, "Close"]];
      const labeled = pairs.map(([key, label]) => `${chip(key)} ${th.fg("muted", label)}`).join("   ");
      if (visibleWidth(labeled) <= columns) return labeled;
      const chips = pairs.map(([key]) => chip(key)).join(" ");
      return visibleWidth(chips) <= columns ? chips : pairs.map(([key]) => chip(key, false, false)).join(" ");
    };
    const result = key && !this.disabled ? this.moved[id] ?? classifyKey(key, { id, draft: this.bindings, keys: this.keys, ownsEditor: this.opts.ownsEditor }) : undefined;
    const pending = this.removing && key ? th.fg("warning", `Press ${this.removing} again to remove ${shortcutLabel(key)}`) : "";
    const status = this.recording ? th.fg("dim", `${cancelLabel} cancels${process.platform === "darwin" ? " · F-keys may need fn" : ""}`)
      : pending || (this.disabled ? th.fg("error", "✕ Needs the editor surface")
      : !result ? "" : result.kind === "free" ? th.fg("success", "● Ready")
      : result.kind === "pi" ? th.fg("warning", `▲ ${shortcutStatus(result)}`)
      : result.kind === "moved" ? th.fg("accent", `↺ ${shortcutStatus(result)}`) : th.fg("error", `✕ ${shortcutStatus(result)}`));
    const recordingLabel = "[ ● Press a key… ]";
    const binding = this.recording ? th.style(width >= visibleWidth(recordingLabel) + 2 ? ` ${recordingLabel} ` : recordingLabel,
      { fg: "warning", bg: "userMessageBg" }) : key ? chip(`[ ${shortcutLabel(key)} ]`) : th.fg("muted", "Not set");
    const message = this.message ? th.fg(this.message.token, this.message.text) : "";
    if (tiny) {
      const summary = `${name} · ${binding}`, priority = pending || message;
      const identity = visibleWidth(summary) <= width ? summary : binding;
      const lines = priority && height < 3 ? height === 1 ? [priority] : [th.bold(title), priority]
        : [th.bold(title), identity, ...(priority ? [priority] : []), ...(pending ? [] : [status]), hints(width)];
      return compactPicker(lines, width, height);
    }
    const actions = (columns: number, rows: number) => viewport(th, "Actions", this.selected, SHORTCUT_ACTIONS.length,
      ACTION_ROWS.findIndex(row => "index" in row && row.index === this.selected), ACTION_ROWS.length, columns, rows, i => {
        const row = ACTION_ROWS[i]!;
        if ("section" in row) return sectionRow(th, row.section);
        const action = SHORTCUT_ACTIONS[row.index]!, selected = row.index === this.selected;
        const recording = selected && this.recording;
        const bound = recording ? undefined : shortcutKey(this.bindings, action.id), text = bound ? shortcutLabel(bound) : "";
        const keyWidth = bound ? Math.min(visibleWidth(text) + 2, columns - 4) : 2;
        const cap = bound ? chip(fit(text, keyWidth - 2), selected)
          : `${recording ? th.fg("warning", "●") : selected ? "—" : th.fg("dim", "—")} `;
        return selectedRow(th, fit(action.label, columns - 3 - keyWidth) + " " + cap, selected, columns);
      });
    const details = (columns: number, rows: number) => {
      const split = rows >= 7 && visibleWidth(detail) > columns ? detail.lastIndexOf(" ", columns) : -1;
      const description = split < 0 ? [detail] : [detail.slice(0, split), detail.slice(split + 1)];
      const info = [...description.map(line => th.fg("text", line)), th.fg("dim", command)], shortcut = `Shortcut   ${binding}`;
      return compactPicker(rows >= 5 ? [name, ...info, ...(rows >= 6 ? [""] : []), shortcut, status]
        : [name, shortcut, status, ...info], columns, rows);
    };
    const body = pickerBody(th, width, inner, bodyHeight, actions, details);
    return framedPicker(th, width, title, body, ["", hints(inner), message], this.recording ? "borderAccent" : "border");
  }

  invalidate(): void {}
}

export async function openShortcutsPanel(ctx: ExtensionContext, current: SlateShortcuts | undefined, opts: Options, save: Save, signal?: AbortSignal): Promise<boolean> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/shortcuts requires interactive terminal mode", "error"); return false; }
  let panel: ShortcutsPanel | undefined;
  const finish = () => panel?.finish();
  signal?.addEventListener("abort", finish, { once: true });
  try {
    return await ctx.ui.custom<boolean>((tui, _theme, keys, done) => {
      panel = new ShortcutsPanel(current, tui, () => ctx.ui.theme, keys, opts, save, done);
      if (signal?.aborted) panel.finish();
      return panel;
    }, PICKER_OVERLAY);
  } finally { signal?.removeEventListener("abort", finish); }
}
