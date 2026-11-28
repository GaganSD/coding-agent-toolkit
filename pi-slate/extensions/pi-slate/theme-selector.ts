import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, parseColor, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { compactPicker, fit, focusRow, framedPicker, pickerBody, pickerGeometry, PICKER_OVERLAY, sectionedViewport, viewport } from "./picker-frame.ts";
import { aligned, cycle, footerHints, moveAction, panelAction, priorityLines, rightAlign, selectionKeys, type PanelAction, type PanelKeys, type SelectionKeys } from "./panel-focus.ts";
import {
  buildCatppuccinTheme, catppuccinThemeName, FLAVOR_LABELS, FLAVOR_SECTION,
  FLAVORS, STYLE_LABELS, stylesFor,
} from "./catppuccin.ts";
import { SLATE_NATIVE_THEME } from "./install-defaults.ts";
import { slateThemeVars } from "./themes.ts";

export type ThemeVariant = { name: string; label: string; color?: string };
export type ThemeChoice = { label: string; variants: ThemeVariant[]; section?: string; family?: string; description?: string };

/** Catppuccin flavor rows: one theme per flavor, with every palette that flavor ships. */
function flavorChoices(): ThemeChoice[] {
  return FLAVORS.map((flavor) => {
    const variants = stylesFor(flavor).map((style) => ({
      name: catppuccinThemeName(flavor, style),
      label: STYLE_LABELS[style],
      color: buildCatppuccinTheme(flavor, style).vars.accent,
    }));
    return {
      label: FLAVOR_LABELS[flavor],
      family: "Catppuccin",
      section: `Catppuccin · ${FLAVOR_SECTION[flavor]}`,
      description: `${FLAVOR_SECTION[flavor]} · ${variants.length} palettes. Preview updates live.`,
      variants,
    };
  });
}

export function slateThemeChoices(initial?: string): ThemeChoice[] {
  const choices: ThemeChoice[] = [
    { label: "System default", description: "Terminal palette. Preview updates live.", variants: [{ name: SLATE_NATIVE_THEME, label: "Terminal palette" }] },
    ...flavorChoices(),
    { label: "Tokyo Night", section: "Other", description: "1 palette. Preview updates live.", variants: [{ name: "tokyo-night", label: "Default", color: slateThemeVars("tokyo-night")?.accent }] },
    { label: "Black Metal", section: "Other", description: "1 palette. Preview updates live.", variants: [{ name: "black-metal", label: "Default", color: slateThemeVars("black-metal")?.accent }] },
  ];
  // A saved theme outside the shipped rows (an external theme) stays re-selectable.
  if (initial && !choices.some(choice => choice.variants.some(variant => variant.name === initial))) {
    choices.unshift({ label: initial, variants: [{ name: initial, label: "Current palette" }] });
  }
  return choices;
}

const themeTitle = (choice: ThemeChoice | undefined) => !choice ? "No themes" : choice.family ? `${choice.family} ${choice.label}` : choice.label;

/** A single interaction; variant choices survive theme navigation without writing settings. */
export class ThemeSelector implements Component {
  private selected = 0;
  private right = false;
  private variants: number[];
  private error = "";
  private closed = false;
  private readonly initial?: string;

  private choices: ThemeChoice[];
  private tui: Pick<TUI, "requestRender" | "terminal">;
  private theme: () => Theme;
  private controls: SelectionKeys;
  private preview: (name: string) => string | undefined;
  private done: (name: string | undefined) => void;

  constructor(
    choices: ThemeChoice[], initial: string | undefined,
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: () => Theme, keys: PanelKeys,
    preview: (name: string) => string | undefined,
    done: (name: string | undefined) => void,
  ) {
    this.choices = choices; this.tui = tui; this.theme = theme; this.controls = selectionKeys(keys);
    this.preview = preview; this.done = done; this.initial = initial;
    this.variants = choices.map(choice => Math.max(0, choice.variants.findIndex(variant => variant.name === initial)));
    this.selected = Math.max(0, choices.findIndex(choice => choice.variants.some(variant => variant.name === initial)));
  }

  private current(): ThemeVariant | undefined { return this.choices[this.selected]?.variants[this.variants[this.selected] ?? 0]; }
  private choice(): ThemeChoice | undefined { return this.choices[this.selected]; }

  private finish(name?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.done(name);
  }

  private previewCurrent(): void {
    const current = this.current();
    if (!current) { this.error = ""; return; }
    this.error = this.preview(current.name) ?? "";
  }

  private moveTheme(step: number): void {
    if (!this.choices.length) return;
    this.selected = cycle(this.selected, step, this.choices.length);
    this.previewCurrent();
  }

  private moveVariant(step: number): void {
    const choice = this.choice();
    if (!choice || choice.variants.length <= 1) return;
    this.variants[this.selected] = cycle(this.variants[this.selected] ?? 0, step, choice.variants.length);
    this.previewCurrent();
  }

  private actions(): PanelAction[] {
    if (!this.right) {
      const actions = [
        panelAction(this.controls.cancel, "Close", 2, data => this.controls.matchesCancel(data), () => this.finish()),
        panelAction(this.controls.openLabel, "Palettes", 1, this.controls.open, () => {
          this.right = true;
        }),
      ];
      if (this.choices.length > 1) actions.push(moveAction(this.controls, 0, step => this.moveTheme(step), true));
      return actions;
    }

    const actions = [
      panelAction(this.controls.backLabel, "Back", 2, this.controls.back, () => {
        this.right = false;
      }),
      panelAction(this.controls.confirm, "Save", 1, this.controls.confirms, () => {
        const current = this.current();
        if (!this.error && current) this.finish(current.name);
      }),
    ];
    if ((this.choice()?.variants.length ?? 0) > 1) actions.push(moveAction(this.controls, 0, step => this.moveVariant(step), true));
    return actions;
  }

  private statusLine(th: Theme, columns: number, gutter: number): string {
    const choice = this.choice(), current = this.current();
    const status = !choice ? { text: "No themes available", tone: "error" as const }
      : !current ? { text: "No palettes available", tone: "error" as const }
        : this.error ? { text: "Couldn't load", tone: "error" as const }
          : current.name === this.initial ? { text: "Current", tone: "success" as const }
            : { text: "Preview", tone: "success" as const };
    const glyph = status.tone === "error" ? "✕" : "●";
    return " ".repeat(Math.max(0, gutter)) + fit(th.fg(status.tone, `${glyph} ${status.text}`), Math.max(0, columns - gutter));
  }

  private describe(choice: ThemeChoice): string {
    const count = choice.variants.length;
    if (!count) return "No palettes available.";
    return choice.description ?? `${count} ${count === 1 ? "palette" : "palettes"}. Preview updates live.`;
  }

  private paletteRow(th: Theme, columns: number, index: number): string {
    const variant = this.choice()?.variants[index];
    if (!variant) return "";
    const selected = index === (this.variants[this.selected] ?? 0);
    const swatch = variant.color ? th.style("████", { fg: parseColor(variant.color) }) : th.fg("muted", "▒▒▒▒");
    const showHex = columns >= 32 && !!variant.color;
    const headWidth = Math.max(0, columns - 2 - 5);
    const label = selected ? th.fg(this.right ? "text" : "dim", variant.label) : variant.label;
    const cell = showHex ? aligned(label, th.fg("dim", variant.color!), headWidth, 2, 7) : fit(label, headWidth);
    return focusRow(th, `${swatch} ${cell}`, selected, this.right, columns);
  }

  private paletteViewport(th: Theme, columns: number, rows: number): string[] {
    const index = this.variants[this.selected] ?? 0;
    const variants = this.choice()?.variants ?? [];
    return viewport(th, "Palettes", index, variants.length, index, variants.length, columns, rows, i => this.paletteRow(th, columns, i));
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    if (matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
    const action = this.actions().find(candidate => candidate.matches(data));
    if (!action) return;
    if (isKeyRepeat(data) && !action.repeatable) return;
    action.run(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme();
    const { height, tiny, inner, bodyHeight } = pickerGeometry(width, this.tui.terminal.rows);
    const choice = this.choice();
    const current = this.current();
    const actions = this.actions();
    const index = this.variants[this.selected] ?? 0;
    const footer = this.error && choice && current ? th.fg("error", `✕ ${this.error}`) : "";

    if (tiny) {
      const titleLine = this.right ? th.style(themeTitle(choice), { fg: "accent", bold: true }) : th.fg("muted", "Slate themes");
      const paletteLabel = current?.label ?? "No palettes";
      const fullLabel = `${themeTitle(choice)} · ${paletteLabel}`;
      const shortLabel = `${choice?.label ?? themeTitle(choice)} · ${paletteLabel}`;
      const shortIdentity = choice?.variants.length === 1 ? choice.label : `${index + 1}/${choice?.variants.length ?? 0}`;
      const compactLabel = `${shortIdentity} · ${paletteLabel}`;
      const compactFallback = choice?.variants.length === 1 && paletteLabel === "Default" ? choice.label : paletteLabel;
      const active = this.right
        ? focusRow(th, visibleWidth(compactLabel) <= width - 2 ? compactLabel : compactFallback, true, true, width)
        : focusRow(th, visibleWidth(fullLabel) <= width - 2 ? fullLabel : shortLabel, true, true, width);
      const statusPriority = this.error || !current ? 8 : 6;
      return compactPicker(priorityLines([
        { text: titleLine, priority: 2 },
        { text: active, priority: 7 },
        ...(footer ? [{ text: footer, priority: 9 }] : [{ text: this.statusLine(th, width, 0), priority: statusPriority }]),
        { text: footerHints(th, actions, width), priority: 5 },
      ], height), width, height);
    }

    const hints = footerHints(th, actions, inner);
    const themeViewport = (columns: number, rows: number) => {
      const valueWidth = 16;
      const showValues = columns >= 36;
      return sectionedViewport(th, "Themes", this.choices, this.selected, columns, rows, (theme, index) => {
        const selected = index === this.selected;
        const value = theme.variants[this.variants[index] ?? 0]?.label ?? "—";
        const valueCell = showValues ? rightAlign(selected ? value : th.fg("muted", value), valueWidth) : "";
        const text = showValues ? aligned(theme.label, valueCell, columns - 2, 1, valueWidth) : theme.label;
        return focusRow(th, text, selected, !this.right, columns);
      });
    };
    const detail = (columns: number, rows: number) => {
      if (!choice) return compactPicker([this.statusLine(th, columns, 0)], columns, rows);
      const titleLine = th.style(themeTitle(choice), { fg: "accent", bold: true });
      const description = columns > 0 ? wrapTextWithAnsi(th.fg("text", this.describe(choice)), columns) : [];
      const statusLine = this.statusLine(th, columns, Math.min(7, Math.max(0, columns - 1)));
      if (rows < 5) return compactPicker([titleLine, this.paletteRow(th, columns, index), statusLine], columns, rows);
      const desc = Array.from({ length: rows >= 9 ? 2 : rows >= 6 ? 1 : 0 }, (_, i) => description[i] ?? "");
      const paletteRows = rows - 3 - desc.length;
      const lines = [titleLine, ...desc, "", ...this.paletteViewport(th, columns, paletteRows), statusLine];
      return compactPicker(lines, columns, rows);
    };
    const body = pickerBody(th, width, inner, bodyHeight, themeViewport, detail);
    return framedPicker(th, width, "Slate themes", body, ["", hints, footer]);
  }

  invalidate(): void {} // Render uses the live theme and current terminal size; no styled cache.
}

export async function selectSlateTheme(ctx: ExtensionContext, save: (name: string) => boolean): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/theme requires interactive terminal mode", "error"); return; }
  // ui.theme is Pi's live styling proxy, not a concrete Theme: its name changes
  // during previews and setTheme(proxy) can take the persistent string path.
  // Resolve through this host's API (not an imported Theme constructor, whose
  // identity can differ across Pi's bundled host and extension module loaders).
  const originalName = ctx.ui.theme.name;
  const original = originalName ? ctx.ui.getTheme(originalName) : undefined;
  if (!original) {
    ctx.ui.notify("Could not snapshot the current theme. Run /reload before previewing.", "error");
    return;
  }
  let confirmed = false;
  let previewed = false;
  try {
    const selected = await ctx.ui.custom<string | undefined>((tui, _theme, keys, done) => new ThemeSelector(
      slateThemeChoices(originalName), originalName, tui, () => ctx.ui.theme, keys,
      name => {
        // Pi persists string setTheme calls. Theme instances preview without touching settings.
        const theme = ctx.ui.getTheme(name);
        if (!theme) return `Could not load ${name}. Run /reload.`;
        previewed = true;
        const result = ctx.ui.setTheme(theme);
        return result.success ? undefined : result.error ?? `Could not preview ${name}`;
      }, done,
    ), PICKER_OVERLAY);
    if (selected) confirmed = save(selected);
  } finally {
    if (!confirmed && previewed) {
      const result = ctx.ui.setTheme(original);
      if (!result.success) ctx.ui.notify(result.error ?? "Could not restore original theme", "error");
    }
  }
}
