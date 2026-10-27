import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { selectSlateTheme, slateThemeChoices, ThemeSelector } from "../extensions/pi-slate/theme-selector.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { BUILTIN_SLASH_COMMANDS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";

const theme = { name: "external", fg: (_: string, text: string) => text, bold: (text: string) => text,
  style: (text: string) => text } as unknown as Theme;
const keys = new KeybindingsManager();
const up = "\x1b[A", down = "\x1b[B", right = "\x1b[C", left = "\x1b[D";

function fixture(initial = "catppuccin-mocha-pink") {
  const previews: string[] = [];
  const done: Array<string | undefined> = [];
  const terminal = { rows: 40, columns: 80 };
  let renders = 0;
  const selector = new ThemeSelector(slateThemeChoices(), initial, { terminal: terminal as TUI["terminal"], requestRender: () => { renders++; } },
    () => theme, keys, name => { previews.push(name); return undefined; }, value => done.push(value));
  return { selector, previews, done, terminal, renders: () => renders };
}

test("theme navigation previews immediately and remembers each theme's variant", () => {
  const f = fixture();
  assert.deepEqual(f.previews, [], "opening preserves original theme");
  f.selector.handleInput(right);
  assert.deepEqual(f.previews, ["catppuccin-mocha-red"]);
  assert.match(f.selector.render(58).join("\n"), /\[Red\]/);
  f.selector.handleInput(right);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-lavender");
  f.selector.handleInput(up);
  assert.equal(f.previews.at(-1), "black-metal");
  f.selector.handleInput(right);
  assert.equal(f.previews.length, 3, "single-palette themes ignore horizontal navigation");
  f.selector.handleInput(down);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-lavender");
  f.selector.handleInput(left);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-red");
  f.selector.handleInput("\r");
  f.selector.handleInput(down);
  assert.deepEqual(f.done, ["catppuccin-mocha-red"]);
  assert.equal(f.renders(), 5);
});

test("selector wraps, cancels, and keeps labels and controls bounded after resizing", () => {
  const f = fixture("system");
  f.selector.handleInput(up);
  assert.equal(f.previews.at(-1), "catppuccin-mocha-pink");
  for (const width of [100, 58, 32, 20, 4, 3, 1]) {
    for (const rows of [40, 16, 8, 3]) {
      f.terminal.rows = rows;
      const lines = f.selector.render(width);
      assert(lines.every(line => visibleWidth(line) <= width), `${width}x${rows}`);
      assert(lines.length <= Math.max(2, rows - 2), `${width}x${rows} height`);
    }
  }
  f.terminal.rows = 8;
  assert.match(f.selector.render(58).join("\n"), /catppuccin-mocha · Pink/);
  assert.match(f.selector.render(58).join("\n"), /Esc restore/);
  f.selector.handleInput("\x1b");
  assert.deepEqual(f.done, [undefined]);
});

test("an external original theme stays visibly selected until navigation", () => {
  const choices = slateThemeChoices("external");
  assert.equal(choices[0]!.variants[0]!.name, "external");
  const selector = new ThemeSelector(choices, "external", {
    terminal: { rows: 40 } as TUI["terminal"], requestRender() {},
  }, () => theme, keys, () => assert.fail("opening must not preview"), () => {});
  assert.match(selector.render(58).join("\n"), /› external \(current\)/);
});

test("requested palettes use the exact accents", () => {
  const variants = slateThemeChoices().at(-1)!.variants;
  assert.equal(variants.find(item => item.label === "Pink")!.color, "#f5c2e7");
  assert.equal(variants.find(item => item.label === "Red")!.color, "#f38ba8");
  assert.equal(variants.find(item => item.label === "Lavender")!.color, "#b4befe");
});

for (const action of ["save", "cancel", "throw", "failed-save", "failed-preview"] as const) {
  test(`selector transaction: ${action}`, async () => {
    const applied: Array<Theme | string> = [];
    const saved: string[] = [];
    let current = theme;
    let disk = "light/dark";
    const ctx = { mode: "tui", ui: {
      get theme() { return current; },
      getTheme: (name: string) => action === "failed-preview" ? undefined : { ...theme, name } as Theme,
      setTheme: (value: Theme | string) => {
        applied.push(value);
        if (typeof value === "string") disk = value;
        else current = value;
        return { success: true };
      },
      notify() {},
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0], options: unknown) => {
        assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: 58, maxHeight: "100%" } });
        let result: unknown;
        const component = await factory({ terminal: { rows: 40 }, requestRender() {} } as TUI, theme, keys, value => { result = value; });
        component.handleInput!(down);
        assert.equal(disk, "light/dark", "previews never write settings, including auto-theme pairs");
        if (action === "throw") throw new Error("closed");
        component.handleInput!(action === "cancel" ? "\x1b" : "\r");
        return result;
      },
    } } as unknown as ExtensionContext;
    const run = () => selectSlateTheme(ctx, name => {
      if (action === "failed-save") return false;
      saved.push(name); ctx.ui.setTheme(name); return true;
    });
    if (action === "throw") await assert.rejects(run, /closed/); else await run();
    if (action === "save") {
      assert.deepEqual(saved, ["system"]); assert.equal(disk, "system");
    } else {
      assert.deepEqual(saved, []);
      if (action === "failed-preview") assert.deepEqual(applied, []);
      else assert.equal(applied.at(-1), theme);
      assert.equal(disk, "light/dark");
    }
  });
}

test("installed Pi reserves no /theme command and only string theme assignments persist", () => {
  assert.equal(BUILTIN_SLASH_COMMANDS.some(command => command.name === "theme"), false);
  const applied: Array<Theme | string> = [];
  let disk = "light/dark";
  const host = {
    themeController: {
      setThemeInstance: (theme: Theme) => { applied.push(theme); return { success: true }; },
      setThemeName: (name: string) => { applied.push(name); return { success: true }; },
    },
    settingsManager: { getTheme: () => disk, setTheme: (name: string) => { disk = name; } },
  };
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const ui = create.call(host) as ExtensionContext["ui"];
  const preview = ui.getTheme("dark");
  assert.ok(preview);
  ui.setTheme(preview);
  assert.equal(applied.at(-1), preview);
  assert.equal(disk, "light/dark");
  ui.setTheme("dark");
  assert.equal(disk, "dark");
});

test("non-terminal modes do not start a selector or change themes", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    let notices = 0;
    await selectSlateTheme({ mode, ui: { notify() { notices++; } } } as unknown as ExtensionContext,
      () => assert.fail("must not save"));
    assert.equal(notices, 1);
  }
});
