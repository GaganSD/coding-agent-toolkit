import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { allSlateThemes, slateShikiTheme } from "../extensions/pi-slate/themes.ts";
import { diffColors, mixHex } from "../extensions/pi-slate/diff-config.ts";

const THEMES_DIR = join(import.meta.dirname, "..", "themes");

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
  const role = (theme: ReturnType<typeof allSlateThemes>[number], name: string) => theme.vars[theme.colors[name]!]!;
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
  assert.equal(slateShikiTheme("black-metal"), "github-dark");
  assert.equal(slateShikiTheme("tokyo-night"), "tokyo-night");
  assert.equal(slateShikiTheme(undefined), "tokyo-night");
});

test("mixHex blends foreground over background", () => {
  assert.equal(mixHex("#ffffff", "#000000", 0), "#000000");
  assert.equal(mixHex("#ffffff", "#000000", 1), "#ffffff");
  assert.equal(mixHex("#9ece6a", "#1f2335", 0.1), "#2c343a");
});
