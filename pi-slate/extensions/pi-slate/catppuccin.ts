import { effortPalette, mixHex } from "./theme-palette.ts";

/** Official Catppuccin flavors (https://catppuccin.com/palette). */
export const FLAVORS = ["latte", "frappe", "macchiato", "mocha"] as const;

export type Flavor = (typeof FLAVORS)[number];

export const FLAVOR_LABELS: Record<Flavor, string> = {
  latte: "Latte",
  frappe: "Frappé",
  macchiato: "Macchiato",
  mocha: "Mocha",
};

/** Picker grouping; Frappé is mid-tone, but it sits with Latte under Light. */
export const FLAVOR_SECTION: Record<Flavor, string> = {
  latte: "Light", frappe: "Light", macchiato: "Dark", mocha: "Dark",
};

/** Every accent hue Catppuccin defines, plus the neutral Default style. */
const ACCENT_STYLES = [
  "rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow",
  "green", "teal", "sky", "sapphire", "blue", "lavender",
] as const;

export const STYLES = [...ACCENT_STYLES, "default", "quiet"] as const;

export type Style = (typeof STYLES)[number];

export function stylesFor(flavor: Flavor): readonly Style[] {
  return flavor === "mocha" ? STYLES : STYLES.filter((style) => style !== "quiet");
}

export const STYLE_LABELS: Record<Style, string> = {
  rosewater: "Rosewater",
  flamingo: "Flamingo",
  pink: "Pink",
  mauve: "Mauve",
  red: "Red",
  maroon: "Maroon",
  peach: "Peach",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  sky: "Sky",
  sapphire: "Sapphire",
  blue: "Blue",
  lavender: "Lavender",
  default: "Default",
  quiet: "Quiet",
};

type Swatch =
  | "rosewater" | "flamingo" | "pink" | "mauve" | "red" | "maroon" | "peach" | "yellow"
  | "green" | "teal" | "sky" | "sapphire" | "blue" | "lavender"
  | "text" | "subtext1" | "subtext0" | "overlay2" | "overlay1" | "overlay0"
  | "surface2" | "surface1" | "surface0" | "base" | "mantle" | "crust";

type Palette = Record<Swatch, string>;

const PALETTES: Record<Flavor, Palette> = {
  latte: {
    rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef",
    red: "#d20f39", maroon: "#e64553", peach: "#fe640b", yellow: "#df8e1d",
    green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5",
    blue: "#1e66f5", lavender: "#7287fd", text: "#4c4f69", subtext1: "#5c5f77",
    subtext0: "#6c6f85", overlay2: "#7c7f93", overlay1: "#8c8fa1", overlay0: "#9ca0b0",
    surface2: "#acb0be", surface1: "#bcc0cc", surface0: "#ccd0da",
    base: "#eff1f5", mantle: "#e6e9ef", crust: "#dce0e8",
  },
  frappe: {
    rosewater: "#f2d5cf", flamingo: "#eebebe", pink: "#f4b8e4", mauve: "#ca9ee6",
    red: "#e78284", maroon: "#ea999c", peach: "#ef9f76", yellow: "#e5c890",
    green: "#a6d189", teal: "#81c8be", sky: "#99d1db", sapphire: "#85c1dc",
    blue: "#8caaee", lavender: "#babbf1", text: "#c6d0f5", subtext1: "#b5bfe2",
    subtext0: "#a5adce", overlay2: "#949cbb", overlay1: "#838ba7", overlay0: "#737994",
    surface2: "#626880", surface1: "#51576d", surface0: "#414559",
    base: "#303446", mantle: "#292c3c", crust: "#232634",
  },
  macchiato: {
    rosewater: "#f4dbd6", flamingo: "#f0c6c6", pink: "#f5bde6", mauve: "#c6a0f6",
    red: "#ed8796", maroon: "#ee99a0", peach: "#f5a97f", yellow: "#eed49f",
    green: "#a6da95", teal: "#8bd5ca", sky: "#91d7e3", sapphire: "#7dc4e4",
    blue: "#8aadf4", lavender: "#b7bdf8", text: "#cad3f5", subtext1: "#b8c0e0",
    subtext0: "#a5adcb", overlay2: "#939ab7", overlay1: "#8087a2", overlay0: "#6e738d",
    surface2: "#5b6078", surface1: "#494d64", surface0: "#363a4f",
    base: "#24273a", mantle: "#1e2030", crust: "#181926",
  },
  mocha: {
    rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7",
    red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387", yellow: "#f9e2af",
    green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec",
    blue: "#89b4fa", lavender: "#b4befe", text: "#cdd6f4", subtext1: "#bac2de",
    subtext0: "#a6adc8", overlay2: "#9399b2", overlay1: "#7f849c", overlay0: "#6c7086",
    surface2: "#585b70", surface1: "#45475a", surface0: "#313244",
    base: "#1e1e2e", mantle: "#181825", crust: "#11111b",
  },
};

type StyleRoles = { accent: Swatch; border: Swatch; heading: Swatch };

const STYLE_ROLES: Record<Style, StyleRoles> = {
  ...Object.fromEntries(ACCENT_STYLES.map((style) => [style, {
    accent: style, border: "overlay0", heading: style,
  } satisfies StyleRoles])),
  default: { accent: "lavender", border: "overlay0", heading: "text" },
  quiet: { accent: "subtext1", border: "surface2", heading: "subtext1" },
} as Record<Style, StyleRoles>;

export const THEME_SCHEMA = "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

export type CatppuccinThemeJson = {
  $schema: string;
  name: string;
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: { pageBg: string; cardBg: string; infoBg: string };
};

export function catppuccinThemeName(flavor: Flavor, style: Style): string {
  return `catppuccin-${flavor}-${style}`;
}

export function buildCatppuccinTheme(flavor: Flavor, style: Style): CatppuccinThemeJson {
  const palette = PALETTES[flavor];
  const roles = STYLE_ROLES[style];
  // Latte's accents sit within a few percent of its neutral border, so a straight
  // blend reverses; darkening the target toward body text keeps it monotonic.
  const accent = palette[roles.accent];
  const target = flavor === "latte" ? mixHex(accent, palette.text, 0.5) : accent;
  const effort = effortPalette(palette[roles.border], target);
  return {
    $schema: THEME_SCHEMA,
    name: catppuccinThemeName(flavor, style),
    vars: {
      ...palette,
      accent: palette[roles.accent],
      border: palette[roles.border],
      heading: palette[roles.heading],
      panel: palette.mantle,
      surface: palette.surface0,
      ...effort.vars,
    },
    colors: {
      accent: "accent",
      border: "border",
      borderAccent: "accent",
      borderMuted: "surface1",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "subtext0",
      dim: "overlay1",
      text: "text",
      thinkingText: "overlay2",
      selectedBg: "surface1",
      scrollbarTrack: "surface0",
      scrollbarThumb: "overlay1",
      searchMatchBg: "teal",
      searchMatchText: "text",
      userMessageBg: "surface",
      userMessageText: "text",
      customMessageBg: "panel",
      customMessageText: "text",
      customMessageLabel: "accent",
      toolPendingBg: "surface",
      toolSuccessBg: "panel",
      toolErrorBg: "crust",
      toolTitle: "text",
      toolOutput: "subtext0",
      mdHeading: "heading",
      mdLink: "accent",
      mdLinkUrl: "overlay1",
      mdCode: "accent",
      mdCodeBlock: "text",
      mdCodeBlockBorder: "overlay0",
      mdQuote: "overlay2",
      mdQuoteBorder: "overlay0",
      mdHr: "overlay0",
      mdListBullet: "accent",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "overlay2",
      syntaxComment: "overlay2",
      syntaxKeyword: "mauve",
      syntaxFunction: "blue",
      syntaxVariable: "text",
      syntaxString: "green",
      syntaxNumber: "peach",
      syntaxType: "yellow",
      syntaxOperator: "sky",
      syntaxPunctuation: "overlay2",
      ...effort.colors,
      bashMode: "green",
    },
    export: {
      pageBg: palette.base,
      cardBg: palette.mantle,
      infoBg: palette.crust,
    },
  };
}

export function allCatppuccinThemes(): CatppuccinThemeJson[] {
  return FLAVORS.flatMap((flavor) => stylesFor(flavor).map((style) => buildCatppuccinTheme(flavor, style)));
}
