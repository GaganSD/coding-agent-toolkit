import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { STYLES, catppuccinThemeName } from "../extensions/pi-slate/catppuccin.ts";
import { selectSlateTheme, slateThemeChoices, ThemeSelector, type ThemeChoice } from "../extensions/pi-slate/theme-selector.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { initTheme, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
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
  const selector = new ThemeSelector(slateThemeChoices(initial), initial, { terminal: terminal as TUI["terminal"], requestRender: () => { renders++; } },
    () => theme, keys, name => { previews.push(name); return undefined; }, value => done.push(value));
  return { selector, previews, done, terminal, renders: () => renders };
}

test("theme navigation previews immediately and remembers each theme's variant", () => {
  const f = fixture();
  assert.deepEqual(f.previews, [], "opening preserves original theme");
  f.selector.handleInput(right);
  assert.deepEqual(f.previews, ["catppuccin-mocha-red"]);
  assert.match(f.selector.render(58).join("\n"), /› ████ Red/);
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
  assert.match(f.selector.render(58).join("\n"), /catppuccin-mocha\s*\n1\/3 · Pink/);
  assert.match(f.selector.render(58).join("\n"), /Esc restore/);
  assert.match(f.selector.render(18).join("\n"), /↵ save Esc undo/);
  assert.match(f.selector.render(18).join("\n"), /1\/3 · Pink/);
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

test("picker palettes are exactly Pink, Red, Lavender in order with exact accents", () => {
  assert.deepEqual(slateThemeChoices().at(-1)!.variants, [
    { name: "catppuccin-mocha-pink", label: "Pink", color: "#f5c2e7" },
    { name: "catppuccin-mocha-red", label: "Red", color: "#f38ba8" },
    { name: "catppuccin-mocha-lavender", label: "Lavender", color: "#b4befe" },
  ]);
});

test("three-palette cycle wraps in both directions without legacy styles", () => {
  const f = fixture();
  for (const key of [right, right, right, left, left, left]) f.selector.handleInput(key);
  assert.deepEqual(f.previews, [
    "catppuccin-mocha-red", "catppuccin-mocha-lavender", "catppuccin-mocha-pink",
    "catppuccin-mocha-lavender", "catppuccin-mocha-red", "catppuccin-mocha-pink",
  ]);
});

for (const style of STYLES.filter(style => !["pink", "red", "lavender"].includes(style))) {
  test(`legacy ${style} stays current outside the normal picker cycle`, () => {
    const initial = catppuccinThemeName("mocha", style);
    const f = fixture(initial);
    assert.deepEqual(f.previews, []);
    assert.match(f.selector.render(58).join("\n"), new RegExp(`› ${initial} \\(current\\)`));
    f.selector.handleInput(right);
    f.selector.handleInput(left);
    assert.deepEqual(f.previews, [], "current row does not cycle");
    f.selector.handleInput(up);
    assert.equal(f.previews.at(-1), "catppuccin-mocha-pink");
    for (let i = 0; i < 3; i++) f.selector.handleInput(right);
    assert.equal(f.previews.at(-1), "catppuccin-mocha-pink");
    f.selector.handleInput(down);
    assert.equal(f.previews.at(-1), initial);
    f.selector.handleInput("\r");
    assert.deepEqual(f.done, [initial]);
  });
}

for (const action of ["save", "cancel", "ctrl-c", "throw", "failed-save", "failed-preview"] as const) {
  test(`selector transaction: ${action}`, async () => {
    const applied: Array<Theme | string> = [];
    const saved: string[] = [];
    // Host instances deliberately have a different constructor from extension
    // imports; the live styling proxy is neither a host instance nor a snapshot.
    class HostTheme { name: string; constructor(name: string) { this.name = name; } }
    const original = new HostTheme(theme.name!);
    let current = original;
    const live = new Proxy({}, { get: (_target, key) => Reflect.get(current, key) });
    let disk = "light/dark";
    const ctx = { mode: "tui", ui: {
      get theme() { return live; },
      getTheme: (name: string) => name === original.name ? original
        : action === "failed-preview" ? undefined : new HostTheme(name),
      setTheme: (value: Theme | string) => {
        applied.push(value);
        if (value instanceof HostTheme) current = value;
        else { disk = String(value); assert.fail("Only host-created instances may preview or restore"); }
        return { success: true };
      },
      notify() {},
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0], options: unknown) => {
        assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "100%", margin: 1 } });
        let result: unknown;
        const component = await factory({ terminal: { rows: 40 }, requestRender() {} } as TUI, theme, keys, value => { result = value; });
        component.handleInput!(down);
        assert.equal(disk, "light/dark", "previews never write settings, including auto-theme pairs");
        if (action !== "failed-preview") assert.equal(Reflect.get(live, "name"), "system", "captured proxy follows preview");
        if (action === "throw") throw new Error("closed");
        component.handleInput!(action === "cancel" ? "\x1b" : action === "ctrl-c" ? "\x03" : "\r");
        return result;
      },
    } } as unknown as ExtensionContext;
    const run = () => selectSlateTheme(ctx, name => {
      if (action === "failed-save") return false;
      saved.push(name); disk = name; return true;
    });
    if (action === "throw") await assert.rejects(run, /closed/); else await run();
    if (action === "save") {
      assert.deepEqual(saved, ["system"]); assert.equal(disk, "system");
    } else {
      assert.deepEqual(saved, []);
      if (action === "failed-preview") assert.deepEqual(applied, []);
      else { assert.equal(applied.at(-1), original); assert.equal(current, original); }
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

test("real Pi UI proxy is not restorable, but host-loaded snapshots restore after exceptions", async () => {
  initTheme("dark");
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const host = {
    themeController: {
      setThemeInstance: (value: Theme) => { setThemeInstance(value); return { success: true }; },
      setThemeName: () => assert.fail("proxy or foreign instances must not reach the name/persistence path"),
    },
  };
  const ui = create.call(host) as ExtensionContext["ui"];
  const live = ui.theme;
  const snapshot = ui.getTheme("dark")!;
  assert.equal(live instanceof snapshot.constructor, false, "Pi exposes a plain-target live proxy");
  ui.custom = async factory => {
    const component = await factory({ terminal: { rows: 40 }, requestRender() {} } as TUI, live, keys, () => {});
    component.handleInput!(down); // external-current dark -> system
    assert.equal(live.name, "system", "even a previously captured name property now follows the preview");
    throw new Error("UI failed after preview");
  };
  await assert.rejects(() => selectSlateTheme({ mode: "tui", ui } as ExtensionContext,
    () => assert.fail("must not save")), /UI failed after preview/);
  assert.equal(ui.theme.name, "dark");
  assert.equal(ui.theme.fg("accent", "restored"), snapshot.fg("accent", "restored"));
});

test("an unavailable original snapshot refuses previews without writing settings", async () => {
  const notices: string[] = [];
  await selectSlateTheme({ mode: "tui", ui: {
    theme, getTheme: () => undefined, notify: (message: string) => notices.push(message),
    custom: () => assert.fail("cannot safely preview without a restoration snapshot"),
    setTheme: () => assert.fail("must not change themes"),
  } } as unknown as ExtensionContext, () => assert.fail("must not save"));
  assert.match(notices[0]!, /Could not snapshot/);
});

test("geometry is fixed across theme, palette, error, and empty states after every resize", () => {
  const terminal = { rows: 40 };
  const choices: ThemeChoice[] = [
    { label: "界🌙é".repeat(40), variants: [] },
    { label: "Single", variants: [{ name: "single", label: "Default" }] },
    { label: "Many", variants: Array.from({ length: 100 }, (_, i) => ({ name: `v${i}`, label: `界🌙é${i}`.repeat(30), color: "#f38ba8" })) },
  ];
  const finished: Array<string | undefined> = [];
  const selector = new ThemeSelector(choices, "single", { terminal: terminal as TUI["terminal"], requestRender() {} }, () => theme, keys,
    name => name.startsWith("v") ? "Could not load 界".repeat(80) : undefined, name => finished.push(name));
  const empty = new ThemeSelector([], undefined, { terminal: terminal as TUI["terminal"], requestRender() {} }, () => theme, keys,
    () => assert.fail("empty cannot preview"), () => assert.fail("empty cannot save"));
  for (const width of [100, 88, 68, 67, 44, 32, 24, 23, 20, 4, 1]) {
    for (const rows of [40, 24, 16, 15, 14, 8, 3, 2, 1]) {
      terminal.rows = rows;
      const height = Math.min(22, Math.max(1, rows - 2));
      const check = (component: ThemeSelector) => {
        const lines = component.render(width);
        assert.equal(lines.length, height, `${width}x${rows} height`);
        assert(lines.every(line => visibleWidth(line) === width), `${width}x${rows} width`);
      };
      check(selector); check(empty);
      for (const input of [down, right, "\r", right, up, up, down]) {
        selector.handleInput(input); check(selector);
      }
      empty.handleInput(down); empty.handleInput(right); empty.handleInput("\r"); check(empty);
    }
  }
  assert.deepEqual(finished, [], "errors and empty palettes cannot confirm");
});

test("preview errors and missing palettes block save, keep their status slot, and allow recovery or cancel", () => {
  const done: Array<string | undefined> = [];
  const selector = new ThemeSelector([
    { label: "Empty", variants: [] },
    { label: "Missing", variants: [{ name: "missing", label: "Unavailable" }] },
    { label: "Good", variants: [{ name: "good", label: "Default" }] },
  ], undefined, { terminal: { rows: 40 } as TUI["terminal"], requestRender() {} }, () => theme, keys,
  name => name === "missing" ? "Could not load missing. Run /reload." : undefined, value => done.push(value));
  assert.match(selector.render(88).join("\n"), /No palettes available/);
  selector.handleInput("\r"); assert.deepEqual(done, []);
  selector.handleInput(down);
  assert.match(selector.render(88).join("\n"), /Could not load missing/);
  selector.handleInput("\r"); assert.deepEqual(done, []);
  selector.handleInput(down);
  assert.doesNotMatch(selector.render(88).join("\n"), /Could not load missing/);
  selector.handleInput("\r"); assert.deepEqual(done, ["good"]);
  const emptyDone: Array<string | undefined> = [];
  const empty = new ThemeSelector([], undefined, { terminal: { rows: 40 } as TUI["terminal"], requestRender() {} },
    () => theme, keys, () => assert.fail("empty cannot preview"), value => emptyDone.push(value));
  assert.match(empty.render(88).join("\n"), /No themes available/);
  empty.handleInput("\r"); assert.deepEqual(emptyDone, []);
  empty.handleInput("\x03"); assert.deepEqual(emptyDone, [undefined]);
});

test("many themes and palettes scroll within independent fixed viewports with position cues", () => {
  const choices = Array.from({ length: 100 }, (_, i) => ({ label: `Theme ${i}`, variants:
    Array.from({ length: 100 }, (_, j) => ({ name: `${i}-${j}`, label: `Palette ${j}`, color: "#f38ba8" })) }));
  const terminal = { rows: 40 } as TUI["terminal"];
  const selector = new ThemeSelector(choices, "0-0", { terminal, requestRender() {} }, () => theme, keys,
    () => undefined, () => {});
  for (const width of [88, 40]) {
    for (let i = 0; i < 100; i++) {
      const text = selector.render(width).join("\n");
      assert.match(text, new RegExp(`› Theme ${i}(?![0-9])`));
      assert.match(text, new RegExp(`Themes ${i + 1}/100`));
      assert.match(text, /↑\d|↓\d/);
      selector.handleInput(down);
    }
    for (let j = 0; j < 100; j++) {
      const text = selector.render(width).join("\n");
      assert.match(text, new RegExp(`› ████ Palette ${j}(?![0-9])`));
      assert.match(text, new RegExp(`Palettes ${j + 1}/100`));
      selector.handleInput(right);
    }
  }
  selector.handleInput(right); selector.handleInput(down); selector.handleInput(up);
  assert.match(selector.render(88).join("\n"), /› ████ Palette 1(?![0-9])/);
});

test("palette swatches retain their concrete colors and selected rows have a full-width background", () => {
  initTheme("dark");
  const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext");
  const ui = create.call({}) as ExtensionContext["ui"];
  const live = ui.getTheme("dark")!;
  const selector = new ThemeSelector(slateThemeChoices(), "catppuccin-mocha-pink", {
    terminal: { rows: 40 } as TUI["terminal"], requestRender() {},
  }, () => live, keys, () => undefined, () => {});
  const text = selector.render(88).join("\n");
  for (const color of ["#f5c2e7", "#f38ba8", "#b4befe"]) {
    assert(text.includes(live.style("████", { fg: parseColor(color) })));
  }
  assert(text.includes(live.style("› catppuccin-mocha".padEnd(38), { fg: "accent", bg: "selectedBg", bold: true })));
});

test("non-terminal modes do not start a selector or change themes", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    let notices = 0;
    await selectSlateTheme({ mode, ui: { notify() { notices++; } } } as unknown as ExtensionContext,
      () => assert.fail("must not save"));
    assert.equal(notices, 1);
  }
});
