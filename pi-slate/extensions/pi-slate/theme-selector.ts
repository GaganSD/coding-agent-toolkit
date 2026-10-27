import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseColor, truncateToWidth, visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
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

  private current(): ThemeVariant { return this.choices[this.selected]!.variants[this.variants[this.selected]!]!; }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
      this.closed = true; this.done(undefined); return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (!this.error) { this.closed = true; this.done(this.current().name); }
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) this.selected = (this.selected + this.choices.length - 1) % this.choices.length;
    else if (this.keys.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.choices.length;
    else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const count = this.choices[this.selected]!.variants.length;
      if (count === 1) return;
      this.variants[this.selected] = (this.variants[this.selected]! + (matchesKey(data, "right") ? 1 : count - 1)) % count;
    } else return;
    this.error = this.preview(this.current().name) ?? "";
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme();
    const current = this.current();
    const choice = this.choices[this.selected]!;
    const inner = Math.max(0, width - 4);
    const swatch = (variant: ThemeVariant) => variant.color
      ? th.style("●", { fg: parseColor(variant.color) }) : th.fg("muted", "●");
    const lines = [th.bold("Slate themes"), ...this.choices.map((item, index) =>
      index === this.selected ? th.fg("accent", `› ${item.label}`) : th.fg("muted", `  ${item.label}`)),
    th.fg("accent", `${swatch(current)} ${current.label}`)];
    if (choice.variants.length > 1) {
      // Wrap labeled swatches instead of clipping the active variant off-screen.
      let row = "";
      for (const variant of choice.variants) {
        const label = `${swatch(variant)} ${variant.name === current.name ? `[${variant.label}]` : variant.label}  `;
        if (row && visibleWidth(row + label) > inner) { lines.push(row); row = ""; }
        row += label;
      }
      if (row) lines.push(row);
    }
    if (this.error) lines.push(th.fg("error", this.error));
    lines.push(th.fg("dim", "↑↓ theme · ←→ variant"), th.fg("dim", "Enter save · Esc restore"));
    const available = Math.max(1, this.tui.terminal.rows - 2);
    // Very short terminals retain selection and key hints rather than cutting off controls.
    const content = lines.length + 2 <= available ? lines
      : [th.bold("Slate themes"), th.fg("accent", `${choice.label} · ${current.label}`), ...lines.slice(-2)];
    if (width < 4) return content.slice(0, available).map(line => truncateToWidth(line, width, ""));
    const border = (text: string) => th.fg("border", text);
    return [border(`╭${"─".repeat(width - 2)}╮`),
      ...content.slice(0, Math.max(0, available - 2)).map(line => border("│ ") + truncateToWidth(line, inner, "…", true) + border(" │")),
      border(`╰${"─".repeat(width - 2)}╯`)];
  }

  invalidate(): void {} // Render uses the live theme and current terminal size; no styled cache.
}

export async function selectSlateTheme(ctx: ExtensionContext, save: (name: string) => boolean): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/theme slate requires interactive terminal mode", "error"); return; }
  const original = ctx.ui.theme;
  let confirmed = false;
  let previewed = false;
  try {
    const selected = await ctx.ui.custom<string | undefined>((tui, _theme, keys, done) => new ThemeSelector(
      slateThemeChoices(original.name), original.name, tui, () => ctx.ui.theme, keys,
      name => {
        // Pi persists string setTheme calls. Theme instances preview without touching settings.
        const theme = ctx.ui.getTheme(name);
        if (!theme) return `Could not load ${name}. Run /reload.`;
        previewed = true;
        const result = ctx.ui.setTheme(theme);
        return result.success ? undefined : result.error ?? `Could not preview ${name}`;
      }, done,
    ), { overlay: true, overlayOptions: { anchor: "center", width: 58, maxHeight: "100%" } });
    if (selected) confirmed = save(selected);
  } finally {
    if (!confirmed && previewed) {
      const result = ctx.ui.setTheme(original);
      if (!result.success) ctx.ui.notify(result.error ?? "Could not restore original theme", "error");
    }
  }
}
