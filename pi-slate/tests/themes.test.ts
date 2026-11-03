import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { allSlateThemes, slateShikiTheme } from "../extensions/pi-slate/themes.ts";
import { diffAppearance, diffColors } from "../extensions/pi-slate/diff-config.ts";
import { mixHex } from "../extensions/pi-slate/theme-palette.ts";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ComposerEditor, type ComposerSource } from "../extensions/pi-slate/composer.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const THEMES_DIR = join(import.meta.dirname, "..", "themes");
const role = (theme: ReturnType<typeof allSlateThemes>[number], token: string) => theme.vars[theme.colors[token]!]!;

test("every committed theme JSON matches the registry; run npm run themes after editing", () => {
  const built = allSlateThemes();
  const onDisk = readdirSync(THEMES_DIR).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(onDisk, built.map((theme) => `${theme.name}.json`).sort());
  for (const theme of built) {
    const disk = JSON.parse(readFileSync(join(THEMES_DIR, `${theme.name}.json`), "utf8"));
    assert.deepEqual(disk, theme, `${theme.name}.json is stale; regenerate with npm run themes`);
  }
});

test("colors only reference palette vars; hex lives exclusively in vars and export", () => {
  const hex = /^#[0-9a-f]{6}$/;
  for (const theme of allSlateThemes()) {
    for (const [role, value] of Object.entries(theme.colors)) {
      assert.ok(value in theme.vars, `${theme.name}: colors.${role} references unknown var "${value}"`);
      assert.match(theme.vars[value]!, hex, `${theme.name}: vars.${value} must be a hex color`);
    }
    for (const value of Object.values(theme.export)) assert.match(value, hex);
  }
});

test("diff colors derive from each theme's roles, never a name-matched hardcode", () => {
  for (const theme of allSlateThemes()) {
    const colors = diffColors(theme);
    assert.equal(colors.headerFg, role(theme, "accent"), theme.name);
    assert.equal(colors.fg, role(theme, "text"), theme.name);
    assert.equal(colors.lineNumberFg, role(theme, "dim"), theme.name);
    assert.equal(colors.borderFg, role(theme, "border"), theme.name);
    const bg = theme.vars.mantle ?? theme.vars.panelSoft ?? theme.vars.panel ?? theme.vars.bg!;
    assert.equal(colors.contextBg, bg, theme.name);
    assert.equal(colors.addBg, mixHex(role(theme, "success"), bg, 0.1), theme.name);
  }
});

test("shiki mapping follows the theme family", () => {
  assert.equal(slateShikiTheme("catppuccin-mocha-mauve"), "catppuccin-mocha");
  assert.equal(slateShikiTheme("catppuccin-latte-rosewater"), "catppuccin-latte");
  assert.equal(slateShikiTheme("catppuccin-frappe-pink"), "catppuccin-frappe");
  assert.equal(slateShikiTheme("catppuccin-macchiato-teal"), "catppuccin-macchiato");
  assert.equal(slateShikiTheme("black-metal"), "github-dark");
  assert.equal(slateShikiTheme("tokyo-night"), "tokyo-night");
  assert.equal(slateShikiTheme(undefined), "tokyo-night");
});

test("unregistered themes use the same fallback for diff colors and syntax", () => {
  const fallback = diffAppearance("tokyo-night");
  for (const name of [undefined, "unknown", "catppuccin-latte-nope", "catppuccin-mocha", "catppuccin-mocha-custom", "catppuccin-latte-quiet"]) {
    assert.equal(slateShikiTheme(name), fallback.theme, name ?? "unnamed");
    assert.deepEqual(diffAppearance(name), fallback, name ?? "unnamed");
  }
});

test("mixHex blends foreground over background", () => {
  assert.equal(mixHex("#ffffff", "#000000", 0), "#000000");
  assert.equal(mixHex("#ffffff", "#000000", 1), "#ffffff");
  assert.equal(mixHex("#9ece6a", "#1f2335", 0.1), "#2c343a");
});

const EFFORT = [
  ["off", "thinkingOff"], ["minimal", "thinkingMinimal"], ["low", "thinkingLow"],
  ["medium", "thinkingMedium"], ["high", "thinkingHigh"], ["xhigh", "thinkingXhigh"], ["max", "thinkingMax"],
] as const;


test("bundled effort ramps start neutral and brighten toward each theme's border accent", () => {
  const approvedMax: Record<string, string> = {
    "tokyo-night": "#6785ca", "black-metal": "#8a8a8a",
    "catppuccin-mocha-default": "#9ea7da", "catppuccin-mocha-quiet": "#9da3bd",
    "catppuccin-mocha-mauve": "#af96d5", "catppuccin-mocha-pink": "#cca9ca",
    "catppuccin-mocha-red": "#cb839e", "catppuccin-mocha-lavender": "#9ea7da",
    "catppuccin-mocha-sapphire": "#72adcd",
    "catppuccin-mocha-peach": "#cf9f87", "catppuccin-mocha-teal": "#88c0bd",
  };
  for (const theme of allSlateThemes()) {
    const ramp = EFFORT.map(([, token]) => role(theme, token));
    const border = role(theme, "border"), accent = role(theme, "borderAccent");
    const stops = [0, 0.10, 0.20, 0.32, 0.44, 0.57, 0.70];
    assert.equal(ramp[0], border, `${theme.name}: off matches the neutral frame`);
    ramp.forEach((value, index) => assert.equal(value, mixHex(accent, border, stops[index]!), `${theme.name}: stop ${index}`));
    assert.equal(ramp.at(-1), mixHex(accent, border, 0.70), `${theme.name}: approved max tint`);
    if (approvedMax[theme.name]) assert.equal(ramp.at(-1), approvedMax[theme.name], `${theme.name}: pinned tint`);
    assert.equal(new Set(ramp).size, 7, `${theme.name}: distinct truecolor stops`);
    // Every stop is a bounded blend: 70% of the way to the accent at most, so the
    // ramp never becomes the accent color, on light or dark flavors.
    const rgb = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
    const distance = (from: number[], to: number[]) => Math.hypot(...from.map((value, index) => value - to[index]!));
    const full = distance(rgb(border), rgb(accent));
    for (const stop of ramp) assert.ok(distance(rgb(stop), rgb(border)) < full, `${theme.name}: restrained stop`);
    assert.equal(role(theme, "bashMode"), role(theme, "success"), "bash keeps its separate mode color");
  }
});

for (const mode of ["truecolor", "256color"] as const) {
  test(`native ${mode} palettes paint all efforts and preserve live neutral/external-theme behavior`, () => {
    const paths = [
      ...allSlateThemes().map(theme => join(THEMES_DIR, `${theme.name}.json`)),
      ...["dark", "light"].map(name => new URL(`../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`, import.meta.url).pathname),
    ];
    const state: ComposerSource = {
      project: "slate", branch: null, model: undefined, footer: "standard",
      theme: loadThemeFromPath(paths[0]!, mode), effortBorderColor: true,
    };
    const plain = (text: string) => text;
    const editor = new ComposerEditor({ terminal: { rows: 40, columns: 80 }, requestRender() {} } as TUI,
      { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } },
      new KeybindingsManager(), () => state);
    editor.setText("prompt");
    for (const path of paths) {
      const native = loadThemeFromPath(path, mode);
      state.theme = native; // A theme switch must restyle the same editor instance.
      for (const [level, token] of EFFORT) {
        state.thinking = level;
        state.effortBorderColor = true;
        editor.borderColor = native.getThinkingBorderColor(level);
        const colored = editor.render(80);
        for (const glyph of ["┌", "┐", "│", "└", "┘"]) {
          assert.ok(colored.join("\n").includes(native.fg(token, glyph)), `${native.name}/${level}/${glyph}`);
        }
        state.effortBorderColor = false;
        const neutral = editor.render(80);
        assert.ok(neutral.join("\n").includes(native.fg("border", "│")));
        assert.deepEqual(colored.map(stripVTControlCharacters), neutral.map(stripVTControlCharacters));
        assert.ok(colored.every(row => visibleWidth(row) <= 80));
      }
      state.effortBorderColor = true;
      editor.borderColor = native.getBashModeBorderColor();
      assert.ok(editor.render(80).join("\n").includes(native.fg("bashMode", "│")));
    }
  });
}
