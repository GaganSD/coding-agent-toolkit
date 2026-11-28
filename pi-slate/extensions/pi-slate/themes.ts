import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allCatppuccinThemes, THEME_SCHEMA, type CatppuccinThemeJson } from "./catppuccin.ts";
import { effortPalette } from "./theme-palette.ts";

/**
 * Single registry for every theme Slate ships. All hex values live in `vars`;
 * entries in `colors` may only reference var names, so every rendered surface
 * (sidebar, composer, transcript, diffs) derives from one palette per theme.
 * tests/themes.test.ts enforces that the committed themes/*.json match this
 * source exactly — regenerate with `npm run themes` after editing.
 */

export type SlateThemeJson = CatppuccinThemeJson;

type ThemeSpec = { name: string; vars: Record<string, string>; colors: Record<string, string> & { border: string; borderAccent: string }; export: { pageBg: string; cardBg: string; infoBg: string } };

function buildTheme(spec: ThemeSpec): SlateThemeJson {
  const effort = effortPalette(spec.vars[spec.colors.border]!, spec.vars[spec.colors.borderAccent]!);
  return {
    $schema: THEME_SCHEMA, name: spec.name,
    vars: { ...spec.vars, ...effort.vars },
    colors: { ...spec.colors, ...effort.colors },
    export: spec.export,
  };
}

const TOKYO_NIGHT = buildTheme({
  name: "tokyo-night",
  vars: {
    bg: "#1a1b26",
    panel: "#1f2335",
    surface: "#24283b",
    text: "#c0caf5",
    muted: "#9aa5ce",
    dim: "#737aa2",
    border: "#3b4261",
    accent: "#7aa2f7",
    green: "#9ece6a",
    red: "#f7768e",
    yellow: "#e0af68",
    orange: "#ff9e64",
    purple: "#bb9af7",
    cyan: "#7dcfff",
  },
  colors: {
    accent: "accent",
    border: "border",
    borderAccent: "accent",
    borderMuted: "border",
    success: "green",
    error: "red",
    warning: "yellow",
    muted: "muted",
    dim: "dim",
    text: "text",
    thinkingText: "muted",
    selectedBg: "surface",
    scrollbarTrack: "bg",
    scrollbarThumb: "border",
    searchMatchBg: "surface",
    searchMatchText: "text",
    userMessageBg: "bg",
    userMessageText: "text",
    customMessageBg: "panel",
    customMessageText: "text",
    customMessageLabel: "accent",
    toolPendingBg: "bg",
    toolSuccessBg: "bg",
    toolErrorBg: "panel",
    toolTitle: "text",
    toolOutput: "muted",
    mdHeading: "text",
    mdLink: "accent",
    mdLinkUrl: "dim",
    mdCode: "accent",
    mdCodeBlock: "text",
    mdCodeBlockBorder: "border",
    mdQuote: "muted",
    mdQuoteBorder: "border",
    mdHr: "border",
    mdListBullet: "accent",
    toolDiffAdded: "green",
    toolDiffRemoved: "red",
    toolDiffContext: "muted",
    syntaxComment: "dim",
    syntaxKeyword: "purple",
    syntaxFunction: "accent",
    syntaxVariable: "text",
    syntaxString: "green",
    syntaxNumber: "orange",
    syntaxType: "yellow",
    syntaxOperator: "cyan",
    syntaxPunctuation: "muted",
    bashMode: "green",
  },
  export: { pageBg: "#1a1b26", cardBg: "#1a1b26", infoBg: "#1f2335" },
});

const BLACK_METAL = buildTheme({
  name: "black-metal",
  vars: {
    text: "#c1c1c1",
    muted: "#999999",
    dim: "#888888",
    border: "#404040",
    borderAccent: "#aaaaaa",
    accent: "#dd9999",
    panel: "#141414",
    panelSoft: "#0d0d0d",
    green: "#486e6f",
    red: "#a06666",
    yellow: "#dd9999",
    orange: "#a06666",
    purple: "#999999",
    errorBg: "#1a0d0d",
    comment: "#666666",
    string: "#a0b4b5",
  },
  colors: {
    accent: "accent",
    border: "border",
    borderAccent: "borderAccent",
    borderMuted: "border",
    success: "green",
    error: "red",
    warning: "yellow",
    muted: "muted",
    dim: "dim",
    text: "text",
    thinkingText: "muted",
    selectedBg: "panel",
    scrollbarTrack: "border",
    scrollbarThumb: "muted",
    searchMatchBg: "panel",
    searchMatchText: "text",
    userMessageBg: "panel",
    userMessageText: "text",
    customMessageBg: "panelSoft",
    customMessageText: "text",
    customMessageLabel: "accent",
    toolPendingBg: "panelSoft",
    toolSuccessBg: "panelSoft",
    toolErrorBg: "errorBg",
    toolTitle: "text",
    toolOutput: "muted",
    mdHeading: "accent",
    mdLink: "accent",
    mdLinkUrl: "dim",
    mdCode: "accent",
    mdCodeBlock: "text",
    mdCodeBlockBorder: "border",
    mdQuote: "muted",
    mdQuoteBorder: "border",
    mdHr: "border",
    mdListBullet: "accent",
    toolDiffAdded: "green",
    toolDiffRemoved: "red",
    toolDiffContext: "muted",
    syntaxComment: "comment",
    syntaxKeyword: "accent",
    syntaxFunction: "text",
    syntaxVariable: "text",
    syntaxString: "string",
    syntaxNumber: "orange",
    syntaxType: "borderAccent",
    syntaxOperator: "muted",
    syntaxPunctuation: "dim",
    bashMode: "green",
  },
  export: { pageBg: "#000000", cardBg: "#0d0d0d", infoBg: "#141414" },
});

// Build once: palette mixing must not repeat on runtime theme lookups.
const SLATE_THEMES = [TOKYO_NIGHT, BLACK_METAL, ...allCatppuccinThemes()];

/** Every theme Slate ships, in registry order. The committed JSON files must match this exactly. */
export function allSlateThemes(): SlateThemeJson[] {
  return [...SLATE_THEMES];
}

/** Fallback copies use a namespaced internal name; Pi de-duplicates themes by name, not filename. */
const USER_THEME_PREFIX = "slate-";

/** Bundled theme name for a shipped theme or its user-directory fallback copy. */
export function slateThemeBase(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = name.startsWith(USER_THEME_PREFIX) ? name.slice(USER_THEME_PREFIX.length) : name;
  return SLATE_THEMES.some((theme) => theme.name === base) ? base : undefined;
}

/** A shipped Slate theme by name (or fallback-copy name), or undefined for external themes. */
export function slateTheme(name: string | undefined): SlateThemeJson | undefined {
  const base = slateThemeBase(name);
  return base ? SLATE_THEMES.find((theme) => theme.name === base) : undefined;
}

/**
 * Write a fallback copy of a Slate theme into Pi's user themes directory.
 * The file keeps the selected theme's name so `theme: "<name>"` still resolves
 * after the package is disabled or removed, while its internal name is
 * namespaced. Pi de-duplicates by internal name, so the bundled theme stays
 * authoritative (and keeps receiving updates) without a theme-conflict warning.
 * Custom user files win; only stock copies from the earlier same-name scheme
 * are upgraded in place. Returns false when the fallback cannot be read or written.
 */
export function ensureUserTheme(name: string | undefined, directory = join(getAgentDir(), "themes")): boolean {
  const theme = slateTheme(name);
  if (!theme) return false;
  const path = join(directory, `${theme.name}.json`);
  try {
    if (existsSync(path)) {
      const existing: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isDeepStrictEqual(existing, theme)) return true;
    }
    const fallback = { ...theme, name: `${USER_THEME_PREFIX}${theme.name}` };
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/** Upgrade stock copies written by earlier builds so Pi stops reporting name collisions. */
export function migrateUserThemeCopies(directory = join(getAgentDir(), "themes")): void {
  for (const theme of SLATE_THEMES) {
    if (existsSync(join(directory, `${theme.name}.json`))) ensureUserTheme(theme.name, directory);
  }
}

/** Raw palette for a Slate theme, or undefined for external themes. */
export function slateThemeVars(name: string | undefined): Record<string, string> | undefined {
  return slateTheme(name)?.vars;
}

/** Syntax-highlighting theme for a shipped theme, or the Slate default for external themes. */
export function slateShikiTheme(name: string | undefined): string {
  const theme = slateTheme(name);
  const catppuccin = /^catppuccin-([a-z]+)-[a-z]+$/.exec(theme?.name ?? "");
  if (catppuccin) return `catppuccin-${catppuccin[1]}`;
  if (theme?.name === "black-metal") return "github-dark";
  return "tokyo-night";
}
