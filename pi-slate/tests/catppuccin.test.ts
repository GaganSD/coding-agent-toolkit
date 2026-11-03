import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_FLAVOR,
  DEFAULT_STYLE,
  FLAVORS,
  FLAVOR_LABELS,
  FLAVOR_SECTIONS,
  PALETTE_STYLES,
  STYLES,
  STYLE_LABELS,
  allCatppuccinThemes,
  buildCatppuccinTheme,
  catppuccinThemeName,
  parseCatppuccinTheme,
  parseFlavor,
  parseStyle,
  resolveCatppuccinTheme,
  stylesFor,
  themeMessage,
} from "../extensions/pi-slate/catppuccin.ts";

const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../themes");
const REQUIRED_COLORS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText",
  "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
  "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
  "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
  "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
  "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
  "bashMode",
];
const REQUIRED_STYLES = [
  "rosewater", "flamingo", "pink", "mauve", "red", "maroon",
  "peach", "teal", "yellow", "green",
];

test("all four official flavors and their sections stay official", () => {
  assert.deepEqual([...FLAVORS], ["latte", "frappe", "macchiato", "mocha"]);
  assert.deepEqual(FLAVOR_LABELS, { latte: "Latte", frappe: "Frappé", macchiato: "Macchiato", mocha: "Mocha" });
  assert.deepEqual(FLAVOR_SECTIONS.map(section => [section.label, [...section.flavors]]), [
    ["Light", ["latte", "frappe"]],
    ["Dark", ["macchiato", "mocha"]],
  ]);
  assert.equal(parseFlavor("Mocha"), "mocha");
  assert.equal(parseFlavor("Latte"), "latte");
  assert.equal(parseFlavor("Frappé"), "frappe");
  assert.equal(parseFlavor("frappe"), "frappe");
  assert.equal(parseFlavor("Macchiato"), "macchiato");
  assert.equal(parseFlavor("ink"), undefined);
});

test("fifteen palette styles ship for every flavor, plus legacy Mocha Quiet", () => {
  assert.equal(PALETTE_STYLES.length, 15);
  for (const style of REQUIRED_STYLES) assert.ok(PALETTE_STYLES.includes(style as never), style);
  assert.equal(STYLES.length, 16);
  assert.equal(new Set(STYLES.map(style => STYLE_LABELS[style])).size, STYLES.length, "labels are unique");
  for (const flavor of FLAVORS) {
    assert.equal(stylesFor(flavor).length, flavor === "mocha" ? 16 : 15, flavor);
  }
  assert.equal(parseStyle("Mauve"), "mauve");
  assert.equal(parseStyle("Rosewater"), "rosewater");
  assert.equal(parseStyle("pink"), "pink");
  assert.equal(parseStyle("catppuccin-mocha-pink"), "pink");
  assert.equal(parseStyle("catppuccin-latte-blue"), "blue");
  assert.equal(parseStyle("canonical"), "default");
  assert.equal(parseStyle("quiet"), "quiet");
  assert.equal(parseStyle("ember"), undefined);
});

test("theme names encode flavor and style", () => {
  assert.equal(catppuccinThemeName("mocha", "mauve"), "catppuccin-mocha-mauve");
  assert.deepEqual(parseCatppuccinTheme("catppuccin-mocha-quiet"), { flavor: "mocha", style: "quiet" });
  assert.deepEqual(parseCatppuccinTheme("catppuccin-mocha-pink"), { flavor: "mocha", style: "pink" });
  assert.deepEqual(parseCatppuccinTheme("catppuccin-latte-rosewater"), { flavor: "latte", style: "rosewater" });
  assert.deepEqual(parseCatppuccinTheme("catppuccin-macchiato-lavender"), { flavor: "macchiato", style: "lavender" });
  assert.equal(parseCatppuccinTheme("catppuccin-latte-quiet"), undefined, "quiet stays Mocha-only");
  assert.equal(parseCatppuccinTheme("pi-slate"), undefined);
  assert.deepEqual(resolveCatppuccinTheme("pi-slate"), {
    flavor: DEFAULT_FLAVOR,
    style: DEFAULT_STYLE,
    name: "catppuccin-mocha-mauve",
  });
  assert.deepEqual(resolveCatppuccinTheme("catppuccin-mocha-teal", "latte", "peach"), {
    flavor: "latte",
    style: "peach",
    name: "catppuccin-latte-peach",
  });
  assert.deepEqual(resolveCatppuccinTheme("catppuccin-mocha-quiet", "latte"), {
    flavor: "latte",
    style: DEFAULT_STYLE,
    name: "catppuccin-latte-mauve",
  });
  assert.equal(themeMessage("mocha", "mauve"), "Theme set to Mocha · Mauve");
  assert.equal(themeMessage("latte", "rosewater"), "Theme set to Latte · Rosewater");
});

test("every flavor and style is a valid theme file of palette tokens", () => {
  const built = allCatppuccinThemes();
  assert.equal(built.length, (FLAVORS.length - 1) * PALETTE_STYLES.length + STYLES.length);
  for (const theme of built) {
    const path = join(THEMES_DIR, `${theme.name}.json`);
    const disk = JSON.parse(readFileSync(path, "utf8")) as typeof theme;
    assert.deepEqual(disk, theme);
    assert.equal(disk.name, theme.name);
    for (const color of REQUIRED_COLORS) assert.ok(color in disk.colors, color);
    const hex = /^#[0-9a-f]{6}$/;
    for (const value of Object.values(disk.vars)) assert.match(value, hex);
    assert.match(disk.export.pageBg, hex);
  }
  const latte = buildCatppuccinTheme("latte", "mauve");
  assert.equal(latte.vars.mauve, "#8839ef");
  assert.equal(latte.vars.accent, "#8839ef");
  assert.equal(latte.export.pageBg, "#eff1f5");
  const mocha = buildCatppuccinTheme("mocha", "mauve");
  assert.equal(mocha.vars.mauve, "#cba6f7");
  assert.equal(mocha.export.pageBg, "#1e1e2e");
  const frappe = buildCatppuccinTheme("frappe", "pink");
  assert.equal(frappe.export.pageBg, "#303446");
  const macchiato = buildCatppuccinTheme("macchiato", "teal");
  assert.equal(macchiato.export.pageBg, "#24273a");
  const catppuccinFiles = readdirSync(THEMES_DIR).filter((name) => name.startsWith("catppuccin-"));
  assert.equal(catppuccinFiles.length, built.length);
});

test("each flavor keeps its fifteen accents distinct", () => {
  for (const flavor of FLAVORS) {
    const accents = PALETTE_STYLES.map((style) => buildCatppuccinTheme(flavor, style).vars.accent);
    const hues = PALETTE_STYLES.filter((style) => style !== "default").map((style) => buildCatppuccinTheme(flavor, style).vars.accent);
    assert.equal(new Set(hues).size, 14, `${flavor}: one accent per hue`);
    assert.equal(accents.at(-1), buildCatppuccinTheme(flavor, "lavender").vars.accent, "default reuses lavender");
  }
});

test("light flavors stay light and dark flavors stay dark", () => {
  const luminance = (hex: string) => [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  for (const flavor of ["latte", "frappe"] as const) {
    for (const style of stylesFor(flavor)) {
      assert.ok(luminance(buildCatppuccinTheme(flavor, style).export.pageBg) > 0.02, `${flavor}-${style}`);
    }
  }
  assert.ok(luminance(buildCatppuccinTheme("latte", "default").export.pageBg) > luminance(buildCatppuccinTheme("mocha", "default").export.pageBg));
  assert.ok(luminance(buildCatppuccinTheme("frappe", "default").export.pageBg) > luminance(buildCatppuccinTheme("macchiato", "default").export.pageBg));
  assert.ok(luminance(buildCatppuccinTheme("macchiato", "default").export.pageBg) > luminance(buildCatppuccinTheme("mocha", "default").export.pageBg));
});
