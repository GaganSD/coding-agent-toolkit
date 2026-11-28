import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, parseKey, visibleWidth, wrapTextWithAnsi, type Component, type KeyId, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { compactPicker, fit, framedPicker, pickerBody, pickerGeometry, PICKER_OVERLAY } from "./picker-frame.ts";
import { aligned, cycle, focusRow, footerHints, moveAction, panelAction, priorityLines, rightAlign, sectionedViewport, selectionKeys, type PanelAction, type SelectionKeys } from "./panel-focus.ts";
import { changedShortcuts, classifyKey, SHORTCUT_ACTIONS, shortcutKey, shortcutLabel, shortcutStatus, type KeyClassification, type RecordedShortcut, type ShortcutActionId, type SlateShortcuts } from "./shortcuts.ts";

type Options = { ownsEditor: boolean };
type PanelKeys = Pick<KeybindingsManager, "getDefinition" | "getKeys" | "getResolvedBindings" | "getUserBindings" | "matches">;
type Save = (previous: SlateShortcuts, next: SlateShortcuts, recorded?: RecordedShortcut) => string | undefined;
type MovedKey = Extract<KeyClassification, { kind: "moved" }>;
type Tone = "success" | "warning" | "error" | "accent" | "muted" | "dim";
type OptionStatus = { glyph?: string; text: string; tone: Tone };
type StatusLine = { tone: Tone; text: string };
type StatusModel = { short: OptionStatus; detail: StatusLine; footerPriority?: number };
type PanelOption = { kind: "record" | "remove"; label: string };
const RECORD_OPTION: PanelOption = { kind: "record", label: "Record shortcut" };
const REMOVE_OPTION: PanelOption = { kind: "remove", label: "Remove shortcut" };
type Mode =
  | { kind: "list" }
  | { kind: "detail"; option: "record" | "remove" }
  | { kind: "recording" };

const BADGES = {
  ready: { glyph: "●", text: "Ready", tone: "success" },
  notSet: { glyph: "○", text: "Not set", tone: "muted" },
  inPi: { glyph: "▲", text: "In Pi", tone: "warning" },
  moved: { glyph: "↺", text: "Moved", tone: "accent" },
  inUse: { glyph: "✕", text: "In use", tone: "error" },
  recording: { glyph: "◌", text: "Press a key…", tone: "warning" },
  needsEditor: { glyph: "✕", text: "Needs editor", tone: "error" },
  confirm: { glyph: "▲", text: "Confirm", tone: "warning" },
} as const satisfies Record<string, OptionStatus>;

export class ShortcutsPanel implements Component {
  private selected = 0;
  private mode: Mode = { kind: "list" };
  private removal?: { token: string; label: string };
  private closed = false;
  private saved = false;
  private message?: string;
  private bindings: SlateShortcuts;
  private moved: Partial<Record<ShortcutActionId, MovedKey>> = {};

  private tui: Pick<TUI, "requestRender" | "terminal">;
  private theme: () => Theme;
  private keys: PanelKeys;
  private controls: SelectionKeys;
  private opts: Options;
  private save: Save;
  private done: (saved: boolean) => void;

  constructor(initial: SlateShortcuts | undefined, tui: Pick<TUI, "requestRender" | "terminal">,
    theme: () => Theme, keys: PanelKeys, opts: Options, save: Save, done: (saved: boolean) => void) {
    this.bindings = { ...initial };
    this.tui = tui; this.theme = theme; this.keys = keys; this.controls = selectionKeys(keys);
    this.opts = opts; this.save = save; this.done = done;
  }

  private get action() { return SHORTCUT_ACTIONS[this.selected]!; }
  private get key() { return shortcutKey(this.bindings, this.action.id); }
  private get right() { return this.mode.kind !== "list"; }
  private get recording() { return this.mode.kind === "recording"; }
  private get removing() { return this.removal; }
  private get disabled() { return this.action.id === "prompts" && !this.opts.ownsEditor; }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(this.saved);
  }

  private keyId(data: string): string {
    return parseKey(data) ?? data;
  }

  private recordBadge(result = this.classification()): OptionStatus {
    if (this.disabled) return BADGES.needsEditor;
    if (!this.key || !result) return BADGES.notSet;
    if (result.kind === "free") return BADGES.ready;
    if (result.kind === "pi") return BADGES.inPi;
    if (result.kind === "moved") return BADGES.moved;
    return BADGES.inUse;
  }

  private classification(): KeyClassification | undefined {
    const key = this.key;
    if (!key || this.disabled) return undefined;
    return this.moved[this.action.id] ?? classifyKey(key, { id: this.action.id, draft: this.bindings, keys: this.keys, ownsEditor: this.opts.ownsEditor });
  }

  private status(): StatusModel {
    if (this.removing && this.key) {
      const text = `▲ Press ${this.removing.label} again to remove ${shortcutLabel(this.key)}`;
      const line = { tone: "warning" as const, text };
      return { short: BADGES.confirm, detail: line, footerPriority: 9 };
    }
    if (this.recording) {
      const text = `${this.controls.cancel} cancels${process.platform === "darwin" ? " · F-keys may need fn" : ""}`;
      const line = { tone: "dim" as const, text };
      return { short: BADGES.recording, detail: line, footerPriority: 6 };
    }
    if (this.disabled) {
      const text = "✕ Needs the editor surface";
      const line = { tone: "error" as const, text };
      return { short: BADGES.needsEditor, detail: line };
    }
    const result = this.classification();
    const badge = this.recordBadge(result);
    if (!result || badge === BADGES.notSet) return { short: badge, detail: { tone: badge.tone, text: `${badge.glyph} ${badge.text}` } };
    return { short: badge, detail: { tone: badge.tone, text: `${badge.glyph} ${shortcutStatus(result)}` } };
  }

  private optionKinds(): PanelOption[] {
    return this.key ? [RECORD_OPTION, REMOVE_OPTION] : [RECORD_OPTION];
  }

  private currentOption(): PanelOption {
    if (this.key && (this.removal || (this.mode.kind === "detail" && this.mode.option === "remove"))) return REMOVE_OPTION;
    return RECORD_OPTION;
  }

  private optionStatus(option: PanelOption, short: OptionStatus): OptionStatus {
    if (option.kind === "record") return this.removing ? this.recordBadge() : short;
    return this.removing ? BADGES.confirm : { text: this.controls.removeLabel ?? "—", tone: "muted" };
  }

  private bindingChip(th: Theme): string {
    if (this.recording) return th.style("[ ● Press a key… ]", { fg: "warning", bg: "userMessageBg" });
    const key = this.key;
    return key ? th.style(`[ ${shortcutLabel(key)} ]`, { fg: "accent", bg: "userMessageBg" }) : th.fg("muted", "Not set");
  }

  private statusCell(th: Theme, status: OptionStatus): string {
    return th.fg(status.tone, status.glyph ? `${status.glyph} ${status.text}` : status.text);
  }

  private chooseOption(option: PanelOption, data: string): void {
    if (option.kind === "record") this.startRecording();
    else this.armRemoval(data);
  }

  private actionTable(): PanelAction[] {
    const back = panelAction(this.controls.backLabel, "Back", 3, this.controls.back, () => this.leaveRight());
    const close = panelAction(this.controls.cancel, "Close", 3, data => this.controls.matchesCancel(data), () => this.finish());
    const removeKeys = this.controls.remove;
    const remove = this.key && removeKeys.length
      ? { ...panelAction(this.controls.removeLabel ?? "Remove", "Remove", 2,
        data => removeKeys.some(key => matchesKey(data, key as KeyId)) && !this.controls.matchesUp(data) && !this.controls.matchesDown(data),
        data => this.armRemoval(data)), optional: true }
      : undefined;
    const moveOption = (hint: number) => moveAction(this.controls, hint, () => {
      const next = this.currentOption().kind === "record" ? "remove" : "record";
      this.removal = undefined;
      this.mode = { kind: "detail", option: next };
    });

    if (this.recording) return [panelAction(this.controls.cancel, "Cancel", 0, data => this.controls.matchesCancel(data), () => {
      this.mode = { kind: "detail", option: "record" };
      this.message = undefined;
    })];

    const options = this.optionKinds();
    const active = this.currentOption();
    if (this.removing) {
      const actions = [
        this.right ? back : close,
        ...(this.right
          ? options.length > 1 ? [moveOption(1)] : []
          : [moveAction(this.controls, 0, step => { this.selectAction(step); })]),
        panelAction(this.removing.label, "Confirm", 0, data => this.removing!.token === this.removalToken(data), () => this.confirmRemoval()),
      ];
      return actions;
    }

    if (!this.right) {
      const actions = [
        // Cancel/back is first so a remapped cancel wins over removal.
        close,
        panelAction(this.controls.openLabel, "Open", 1, this.controls.open, () => {
          this.mode = { kind: "detail", option: "record" };
        }),
      ];
      if (remove) actions.push(remove);
      actions.push(moveAction(this.controls, 0, step => { this.selectAction(step); }));
      return actions;
    }

    const actions = [
      back,
      panelAction(this.controls.confirm, "Choose", 1, this.controls.confirms, data => {
        this.chooseOption(active, data);
      }),
    ];
    if (remove) actions.push(remove);
    if (options.length > 1) actions.push(moveOption(0));
    return actions;
  }

  private selectAction(step: number): void {
    this.removal = undefined;
    this.selected = cycle(this.selected, step, SHORTCUT_ACTIONS.length);
    this.mode = { kind: "list" };
  }

  private startRecording(): void {
    if (this.disabled) return;
    this.removal = undefined;
    this.mode = { kind: "recording" };
    this.message = undefined;
  }

  private removalToken(data: string): string {
    if (matchesKey(data, "enter")) return "enter";
    if (matchesKey(data, "space")) return "space";
    if (matchesKey(data, "tab")) return "tab";
    return this.controls.confirmKeys.find(key => matchesKey(data, key as KeyId)) ?? this.keyId(data);
  }

  private removalLabel(key: string): string {
    return key === "delete" ? "Del" : shortcutLabel(key);
  }

  private armRemoval(data: string): void {
    if (!this.key) return;
    const token = this.removalToken(data);
    this.removal = { token, label: this.removalLabel(token) };
    this.message = undefined;
  }

  private confirmRemoval(): void {
    this.removal = undefined;
    const removed = this.apply({ ...this.bindings, [this.action.id]: false });
    if (this.mode.kind === "detail") this.mode = { kind: "detail", option: removed ? "record" : "remove" };
  }

  private leaveRight(): void {
    this.removal = undefined;
    this.mode = { kind: "list" };
  }

  private apply(next: SlateShortcuts, recorded?: RecordedShortcut, moved?: MovedKey): boolean {
    const changed = changedShortcuts(this.bindings, next);
    if (!changed.length) return false;
    const error = this.save(this.bindings, next, recorded);
    if (error) { this.message = error; return false; }
    this.bindings = next;
    for (const id of changed) delete this.moved[id];
    if (moved) this.moved[this.action.id] = moved;
    this.saved = true;
    this.message = undefined;
    return true;
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data) || isKeyRepeat(data)) return;
    if (matchesKey(data, "ctrl+c")) { this.finish(); return; }
    const action = this.actionTable().find(candidate => candidate.matches(data));
    if (action) {
      action.run(data);
      this.tui.requestRender();
      return;
    }
    if (this.removal) {
      this.removal = undefined;
      this.tui.requestRender();
      return;
    }
    switch (this.mode.kind) {
      case "recording": {
        const result = classifyKey(parseKey(data) ?? "", { id: this.action.id, draft: this.bindings, keys: this.keys, ownsEditor: this.opts.ownsEditor, data });
        if ("key" in result) {
          this.message = undefined;
          const next = { ...this.bindings, [this.action.id]: result.key };
          if (result.kind === "moved") for (const owner of result.owners) next[owner] = false;
          this.mode = { kind: "detail", option: "record" };
          this.apply(next, { id: this.action.id, key: result.key, data }, result.kind === "moved" ? result : undefined);
        } else this.message = `✕ ${shortcutStatus(result)}`;
        this.tui.requestRender();
        return;
      }
      case "list":
      case "detail":
        return;
    }
  }

  render(width: number): string[] {
    const th = this.theme();
    const { height, tiny, inner, bodyHeight } = pickerGeometry(width, this.tui.terminal.rows);
    const actions = this.actionTable();
    const options = this.optionKinds();
    const active = this.currentOption();
    const model = this.status();
    const detailLine = th.fg(model.detail.tone, model.detail.text);
    const errorMessage = this.message !== undefined;
    const keyProblem = this.right
      ? this.controls.confirmUnavailable ? "No confirm key available; adjust tui.select keybindings" : ""
      : this.controls.openUnavailable ? "No open key available; adjust tui.select keybindings" : "";
    const keyProblemText = keyProblem ? th.fg("error", `✕ ${keyProblem}`) : "";
    const savedFooter = this.saved ? th.fg("success", "✓ Saved — applies when you close") : "";
    const transient = keyProblemText || (errorMessage ? th.fg("error", this.message!)
      : model.footerPriority !== undefined ? detailLine : "");
    const footerTransient = tiny || errorMessage || keyProblem ? transient : "";
    const combinedFooter = !!footerTransient && !!savedFooter && visibleWidth(footerTransient) + visibleWidth(savedFooter) + 3 <= inner;
    const footer = combinedFooter ? `${savedFooter}   ${footerTransient}` : footerTransient || savedFooter;
    const footerPriority = errorMessage || keyProblem ? 9 : model.footerPriority ?? (savedFooter ? 8 : 9);
    const optionRows = options.map(option => ({ option, status: this.optionStatus(option, model.short), selected: option.kind === active.kind }));
    const activeRow = optionRows.find(row => row.selected)!;
    const maxStatusWidth = Math.max(1, ...Object.values(BADGES).map(status => visibleWidth(this.statusCell(th, status))));
    const key = this.key;
    const title = "Slate shortcuts";

    if (tiny) {
      if (this.recording) {
        const label = ["◌ Press a key…", "Press a key…", "Press…", "…"].find(text => visibleWidth(text) <= width) ?? "";
        const prompt = visibleWidth(label) + 2 <= width ? focusRow(th, label, true, true, width) : fit(label, width);
        const promptHints = footerHints(th, actions, width);
        return compactPicker(priorityLines([
          ...(keyProblemText ? [{ text: keyProblemText, priority: 9 }] : []),
          ...(errorMessage ? [{ text: transient, priority: 9 }] : []),
          { text: prompt, priority: errorMessage || keyProblem ? 8 : 9 },
          ...(savedFooter ? [{ text: savedFooter, priority: 6 }] : []),
          { text: promptHints, priority: 5 },
        ], height), width, height);
      }
      const statusWidth = Math.min(maxStatusWidth, Math.max(8, width - 2 - 2 - 12));
      const keyText = key ? shortcutLabel(key) : "Not set";
      const showBadge = width >= 24 && width - 2 - 2 - statusWidth >= visibleWidth(activeRow.option.label);
      const identity = this.right
        ? showBadge
          ? focusRow(th, aligned(activeRow.option.label, this.statusCell(th, activeRow.status), Math.max(0, width - 2), 2, statusWidth), true, true, width)
          : focusRow(th, activeRow.option.label, true, true, width)
        : focusRow(th, `${this.action.label} · ${keyText}`, true, true, width);
      return compactPicker(priorityLines([
        { text: this.right ? th.style(this.action.label, { fg: "accent", bold: true }) : th.fg("muted", title), priority: 2 },
        ...(this.right ? [{ text: `${this.action.label}  Shortcut  ${this.bindingChip(th)}`, priority: 6 }] : []),
        { text: identity, priority: 7 },
        ...(this.right && !this.removal && activeRow.option.kind === "remove" ? [{ text: detailLine, priority: 7 }] : []),
        ...(!showBadge && this.right && activeRow.option.kind === "record"
          && (!footer || activeRow.status.tone === "error")
          ? [{ text: this.statusCell(th, activeRow.status), priority: activeRow.status.tone === "error" ? 8 : 7 }] : []),
        ...(this.right && model.detail.tone === "error" ? [{ text: detailLine, priority: 6 }] : []),
        ...(footer ? [{ text: footer, priority: footerPriority }] : []),
        ...(savedFooter && !combinedFooter && footer !== savedFooter ? [{ text: savedFooter, priority: 6 }] : []),
        ...(!this.right && model.footerPriority === undefined ? [{ text: detailLine, priority: 7 }] : []),
        { text: footerHints(th, actions, width), priority: 5 },
      ], height), width, height);
    }

    const hints = footerHints(th, actions, inner);
    const list = (columns: number, rows: number) => {
      const keyWidth = Math.min(
        Math.max(3, ...SHORTCUT_ACTIONS.map(action => shortcutKey(this.bindings, action.id)).filter((value): value is string => !!value).map(value => visibleWidth(shortcutLabel(value)) + 2)),
        Math.max(3, columns - 2 - 8),
      );
      return sectionedViewport(th, "Actions", SHORTCUT_ACTIONS, this.selected, columns, rows, (action, index) => {
        const selected = index === this.selected;
        const recording = selected && this.recording;
        const bound = recording ? undefined : shortcutKey(this.bindings, action.id);
        const keyText = recording ? th.fg("warning", "●") : bound ? shortcutLabel(bound) : th.fg("muted", "—");
        const padded = ` ${rightAlign(keyText, Math.max(0, keyWidth - 2))} `;
        const keyCell = bound && !selected && !recording
          ? th.style(padded, { fg: "accent", bg: "userMessageBg" })
          : padded;
        return focusRow(th, aligned(action.label, keyCell, columns - 2, 1, keyWidth), selected, !this.right, columns);
      });
    };
    const detail = (columns: number, rows: number) => {
      const statusWidth = Math.min(maxStatusWidth, Math.max(8, columns - 2 - 2 - 16));
      const titleLine = th.style(this.action.label, { fg: "accent", bold: true });
      const description = wrapTextWithAnsi(th.fg("text", this.action.detail), columns);
      const command = th.fg("dim", this.action.command);
      const fieldLabel = `Shortcut  ${this.bindingChip(th)}`;
      const field = this.recording && visibleWidth(fieldLabel) > columns
        ? focusRow(th, `${BADGES.recording.glyph ?? "◌"} Press a key…`, true, true, columns)
        : fieldLabel;
      const statusLine = detailLine ? "  " + fit(detailLine, Math.max(0, columns - 2)) : "";
      const optionLines = optionRows.map(row =>
        focusRow(th, columns < 28 ? row.option.label
          : aligned(row.option.label, this.statusCell(th, row.status), columns - 2, 2, statusWidth),
        row.selected, this.right, columns));
      while (optionLines.length < 2) optionLines.push("");
      const desc = [description[0] ?? "", description[1] ?? ""];
      if (this.recording) {
        const prompt = focusRow(th, `${BADGES.recording.glyph ?? "◌"} Press a key…`, true, true, columns);
        if (rows === 3) return compactPicker([prompt, optionLines[0] ?? "", statusLine], columns, rows);
        if (rows === 4) return compactPicker([titleLine, prompt, optionLines[0] ?? "", statusLine], columns, rows);
      }
      if (rows >= 9) return compactPicker([titleLine, ...desc, command, "", field, ...optionLines, statusLine], columns, rows);
      if (rows >= 7) return compactPicker([titleLine, description[0] ?? "", command, field, ...optionLines, statusLine], columns, rows);
      if (rows >= 5) return compactPicker([titleLine, field, ...optionLines, statusLine], columns, rows);
      if (rows === 4) return compactPicker([titleLine, ...optionLines, statusLine], columns, rows);
      return compactPicker([...optionLines, statusLine], columns, rows);
    };
    const body = pickerBody(th, width, inner, bodyHeight, list, detail);
    return framedPicker(th, width, title, body, ["", hints, footer], this.recording ? "borderAccent" : "border");
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
