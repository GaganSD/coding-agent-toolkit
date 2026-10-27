import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseColor, truncateToWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { buildCatppuccinTheme, catppuccinThemeName, parseCatppuccinTheme, STYLE_LABELS } from "./catppuccin.ts";

export type ThemeVariant = { name: string; label: string; color?: string };
export type ThemeChoice = { label: string; variants: ThemeVariant[] };

// Keep the picker cycle independent of styles retained for legacy commands.
const PICKER_STYLES = ["pink", "red", "lavender"] as const;

export function slateThemeChoices(initial?: string): ThemeChoice[] {
  const choices: ThemeChoice[] = [
    { label: "System default", variants: [{ name: "system", label: "Terminal palette" }] },
    { label: "Tokyo Night", variants: [{ name: "tokyo-night", label: "Default", color: "#7aa2f7" }] },
    { label: "Black Metal", variants: [{ name: "black-metal", label: "Default", color: "#dd9999" }] },
    { label: "catppuccin-mocha", variants: PICKER_STYLES.map(style => ({
      name: catppuccinThemeName("mocha", style), label: style === "pink" ? "Pink" : STYLE_LABELS[style],
      color: buildCatppuccinTheme("mocha", style).vars.accent,
    })) },
  ];
  if (initial && !choices.some(choice => choice.variants.some(variant => variant.name === initial))) {
    choices.unshift({ label: `${initial} (current)`, variants: [{ name: initial, label: "Current palette" }] });
  }
  return choices;
}

/** A single interaction; variant choices survive theme navigation without writing settings. */
export class ThemeSelector implements Component {
  private selected = 0;
  private variants: number[];
  private error = "";
  private closed = false;

  private choices: ThemeChoice[];
  private tui: Pick<TUI, "requestRender" | "terminal">;
  private theme: () => Theme;
  private keys: Pick<KeybindingsManager, "matches">;
  private preview: (name: string) => string | undefined;
  private done: (name: string | undefined) => void;

  constructor(
    choices: ThemeChoice[], initial: string | undefined,
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: () => Theme, keys: Pick<KeybindingsManager, "matches">,
    preview: (name: string) => string | undefined,
    done: (name: string | undefined) => void,
  ) {
    this.choices = choices; this.tui = tui; this.theme = theme; this.keys = keys;
    this.preview = preview; this.done = done;
    this.variants = choices.map(choice => Math.max(0, choice.variants.findIndex(variant => variant.name === initial)));
    this.selected = Math.max(0, choices.findIndex(choice => choice.variants.some(variant => variant.name === initial)));
    // Prefer the existing Pink palette for a new visit to Catppuccin.
    if (!parseCatppuccinTheme(initial)) {
      const index = choices.findIndex(choice => choice.label === "catppuccin-mocha");
      if (index >= 0) this.variants[index] = Math.max(0, choices[index]!.variants.findIndex(variant => variant.label === "Pink"));
    }
  }

  private current(): ThemeVariant | undefined { return this.choices[this.selected]?.variants[this.variants[this.selected] ?? 0]; }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
      this.closed = true; this.done(undefined); return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      const current = this.current();
      if (!this.error && current) { this.closed = true; this.done(current.name); }
      return;
    }
    if (!this.choices.length) return;
    if (this.keys.matches(data, "tui.select.up")) this.selected = (this.selected + this.choices.length - 1) % this.choices.length;
    else if (this.keys.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.choices.length;
    else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const count = this.choices[this.selected]!.variants.length;
      if (count <= 1) return;
      this.variants[this.selected] = (this.variants[this.selected]! + (matchesKey(data, "right") ? 1 : count - 1)) % count;
    } else return;
    const current = this.current();
    this.error = current ? this.preview(current.name) ?? "" : "No palettes available";
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme();
    const current = this.current();
    const choice = this.choices[this.selected];
    const height = Math.min(22, Math.max(1, this.tui.terminal.rows - 2));
    const fit = (text: string, columns: number) => truncateToWidth(text, Math.max(0, columns), "…", true);
    const status = this.error || (!choice ? "No themes available" : !current ? "No palettes available" : "");
    // Tiny screens trade the frame and list for identity and controls. Geometry
    // still depends only on terminal size, never on names, counts, or errors.
    if (height < 13 || width < 24) {
      const lines = [
        th.fg("accent", choice?.label ?? "No themes available"),
        current ? `${(this.variants[this.selected] ?? 0) + 1}/${choice!.variants.length} · ${current.label}` : "No palettes available",
        th.fg("dim", width < 28 ? "↵ save Esc undo" : "Enter save · Esc restore"),
        status ? th.fg("error", status) : th.fg("dim", "↑↓ theme ←→ color"),
        status ? th.fg("dim", "↑↓ theme ←→ color") : "",
      ];
      return Array.from({ length: height }, (_, i) => fit(lines[i] ?? "", width));
    }
    const inner = width - 4;
    const bodyHeight = height - 7;
    const border = (text: string) => th.fg("border", text);
    const selectedRow = (text: string, selected: boolean, columns: number) => {
      const row = fit(`${selected ? "›" : " "} ${text}`, columns);
      return selected ? th.style(row, { fg: "accent", bg: "selectedBg", bold: true }) : row;
    };
    // Both viewports are bounded and center their selected row, including on
    // resize. Headers carry position and hidden-row counts instead of wrapping.
    const viewport = (title: string, count: number, selected: number, columns: number, rows: number,
      row: (index: number) => string): string[] => {
      const slots = Math.max(1, rows - 1);
      const start = Math.max(0, Math.min(selected - Math.floor(slots / 2), count - slots));
      const end = Math.min(count, start + slots);
      const overflow = `${start ? ` ↑${start}` : ""}${end < count ? ` ↓${count - end}` : ""}`;
      return [th.fg("muted", fit(`${title} ${count ? selected + 1 : 0}/${count}${overflow}`, columns)),
        ...Array.from({ length: rows - 1 }, (_, i) => start + i < end ? fit(row(start + i), columns) : fit("", columns))];
    };
    const themeRows = (columns: number, rows: number) => viewport("Themes", this.choices.length, this.selected, columns, rows,
      i => selectedRow(this.choices[i]!.label, i === this.selected, columns));
    const paletteRows = (columns: number, rows: number) => viewport("Palettes", choice?.variants.length ?? 0,
      this.variants[this.selected] ?? 0, columns, rows, i => {
        const variant = choice!.variants[i]!;
        const swatch = variant.color ? th.style("████", { fg: parseColor(variant.color) }) : th.fg("muted", "▒▒▒▒");
        const label = `${swatch} ${variant.label}${columns >= 34 && variant.color ? `  ${th.fg("dim", variant.color)}` : ""}`;
        return selectedRow(label, i === this.variants[this.selected], columns);
      });
    let body: string[];
    if (width >= 68) {
      const left = Math.floor((inner - 3) * 0.48), right = inner - 3 - left;
      const themes = themeRows(left, bodyHeight), palettes = paletteRows(right, bodyHeight);
      body = themes.map((line, i) => line + border(" │ ") + palettes[i]!);
    } else {
      const top = Math.ceil(bodyHeight / 2);
      body = [...themeRows(inner, top), ...paletteRows(inner, bodyHeight - top)];
    }
    const content = [th.bold("Slate themes"), "", ...body, th.fg("error", status),
      th.fg("dim", "↑↓ theme ←→ palette"), th.fg("dim", width < 44 ? "Enter save/Esc undo" : "Enter save · Esc restore · Ctrl+C cancel")];
    return [border(`╭${"─".repeat(width - 2)}╮`),
      ...content.map(line => border("│ ") + fit(line, inner) + border(" │")),
      border(`╰${"─".repeat(width - 2)}╯`)];
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
    ), { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "100%", margin: 1 } });
    if (selected) confirmed = save(selected);
  } finally {
    if (!confirmed && previewed) {
      const result = ctx.ui.setTheme(original);
      if (!result.success) ctx.ui.notify(result.error ?? "Could not restore original theme", "error");
    }
  }
}
