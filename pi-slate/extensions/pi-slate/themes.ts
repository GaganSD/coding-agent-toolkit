import { allCatppuccinThemes, THEME_SCHEMA, type CatppuccinThemeJson } from "./catppuccin.ts";

/**
 * Single registry for every theme Slate ships. All hex values live in `vars`;
 * entries in `colors` may only reference var names, so every rendered surface
 * (sidebar, composer, transcript, diffs) derives from one palette per theme.
 * tests/themes.test.ts enforces that the committed themes/*.json match this
 * source exactly — regenerate with `npm run themes` after editing.
 */

export type SlateThemeJson = CatppuccinThemeJson;

type ThemeSpec = { name: string; vars: Record<string, string>; colors: Record<string, string>; export: { pageBg: string; cardBg: string; infoBg: string } };

function buildTheme(spec: ThemeSpec): SlateThemeJson {
  return { $schema: THEME_SCHEMA, name: spec.name, vars: spec.vars, colors: spec.colors, export: spec.export };
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
    thinkingOff: "border",
    thinkingMinimal: "dim",
    thinkingLow: "muted",
    thinkingMedium: "accent",
    thinkingHigh: "cyan",
    thinkingXhigh: "purple",
    thinkingMax: "red",
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
    thinkOff: "#333333",
    thinkMinimal: "#444444",
    thinkLow: "#555555",
    thinkMedium: "#777777",
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
    thinkingOff: "thinkOff",
    thinkingMinimal: "thinkMinimal",
    thinkingLow: "thinkLow",
    thinkingMedium: "thinkMedium",
    thinkingHigh: "muted",
    thinkingXhigh: "borderAccent",
    thinkingMax: "text",
    bashMode: "green",
  },
  export: { pageBg: "#000000", cardBg: "#0d0d0d", infoBg: "#141414" },
});

/** Every theme Slate ships, in registry order. The committed JSON files must match this exactly. */
export function allSlateThemes(): SlateThemeJson[] {
  return [TOKYO_NIGHT, BLACK_METAL, ...allCatppuccinThemes()];
}

/** A shipped Slate theme by name, or undefined for external themes. */
export function slateTheme(name: string | undefined): SlateThemeJson | undefined {
  if (!name) return undefined;
  return allSlateThemes().find((theme) => theme.name === name);
}

/** Raw palette for a Slate theme, or undefined for external themes. */
export function slateThemeVars(name: string | undefined): Record<string, string> | undefined {
  return slateTheme(name)?.vars;
}

/** Syntax-highlighting theme for a shipped theme, or the Slate default for external themes. */
export function slateShikiTheme(name: string | undefined): string {
  const theme = slateTheme(name);
  if (theme?.name.startsWith("catppuccin-")) return "catppuccin-mocha";
  if (theme?.name === "black-metal") return "github-dark";
  return "tokyo-night";
}
