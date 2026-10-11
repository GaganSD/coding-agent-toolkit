import type { BundledTheme } from "shiki";
import { slateShikiTheme, slateTheme, type SlateThemeJson } from "./themes.ts";

export type DiffColors = {
  fg: string;
  contextBg: string;
  addBg: string;
  removeBg: string;
  addWordBg: string;
  removeWordBg: string;
  lineNumberFg: string;
  borderFg: string;
  headerFg: string;
};

export type DiffConfig = {
  theme: BundledTheme;
  splitMinWidth: number;
  colors: DiffColors;
};

/** Blend `fg` over `bg` at `alpha` — derives diff tints from any theme palette. */
export function mixHex(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, start: number) => parseInt(hex.slice(start, start + 2), 16);
  const out = [1, 3, 5].map((start) => Math.round(channel(bg, start) + (channel(fg, start) - channel(bg, start)) * alpha));
  return `#${out.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Diff colors derive from the active theme's roles, so every Slate theme (and style switch) restyles diffs consistently. */
export function diffColors(theme: SlateThemeJson): DiffColors {
  const role = (name: string): string | undefined => {
    const ref = theme.colors[name];
    return ref ? theme.vars[ref] : undefined;
  };
  const bg = theme.vars.mantle ?? theme.vars.panelSoft ?? theme.vars.panel ?? theme.vars.bg ?? "#000000";
  const green = role("success") ?? "#9ece6a";
  const red = role("error") ?? "#f7768e";
  return {
    fg: role("text") ?? "#c0caf5",
    contextBg: bg,
    addBg: mixHex(green, bg, 0.1),
    removeBg: mixHex(red, bg, 0.12),
    addWordBg: mixHex(green, bg, 0.25),
    removeWordBg: mixHex(red, bg, 0.3),
    lineNumberFg: role("dim") ?? "#737aa2",
    borderFg: role("border") ?? "#3b4261",
    headerFg: role("accent") ?? "#7aa2f7",
  };
}

export function diffAppearance(themeName?: string): Pick<DiffConfig, "theme" | "colors"> {
  const theme = slateTheme(themeName) ?? slateTheme("tokyo-night")!;
  return { theme: slateShikiTheme(themeName) as BundledTheme, colors: diffColors(theme) };
}

export function readDiffConfig(env: NodeJS.ProcessEnv = process.env, themeName?: string): DiffConfig {
  const width = Number(env.SLATE_DIFF_SPLIT_MIN_WIDTH ?? 100);
  return {
    splitMinWidth: Number.isInteger(width) && width >= 60 && width <= 500 ? width : 100,
    ...diffAppearance(themeName),
  };
}

export function ansiColor(hex: string, background = false): string {
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `\x1b[${background ? 48 : 38};2;${rgb.join(";")}m`;
}

/** Never allow source text or paths to issue terminal control sequences. */
export function diffText(text: string): string {
  return text.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export const DIFF_MAX_BYTES = 256 * 1024;
export const DIFF_MAX_ROWS = 2000;
