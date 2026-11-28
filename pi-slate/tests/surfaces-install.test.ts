import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ExtensionRunner, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ExtensionEvent, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Editor, matchesKey, ScrollView, Text, TuiAltScreen, type Component, type EditorTheme, type KeyId, type Terminal, type TUI } from "@earendil-works/pi-tui";
import piSlate from "../extensions/pi-slate/index.ts";
import { ComposerEditor } from "../extensions/pi-slate/composer.ts";
import { Sidebar, type SidebarActions } from "../extensions/pi-slate/sidebar.ts";
import { GitStatusPoller } from "../extensions/pi-slate/git-status.ts";
import { FRESH_SURFACES, has, SURFACES, type Surface } from "../extensions/pi-slate/surfaces.ts";
import { isWaveActive, WAVE_STEP_MS } from "../extensions/pi-slate/working-wave.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

class NullTerminal implements Terminal {
  columns = 140; rows = 40; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}

const theme = { name: "dark", fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, style: (text: string) => text } as unknown as Theme;
const editorTheme = { borderColor: (text: string) => text } as EditorTheme;

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

async function fixture(t: TestContext, text: string | undefined, mode = "tui", compatible = true, conflict = false, configure?: (pi: ExtensionAPI, ui: ExtensionContext["ui"], agentDir: string) => void | Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "slate-surfaces-"));
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = cwd;
  process.env.PI_OFFLINE = "1";
  t.after(async () => {
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous.offline;
    await rm(cwd, { recursive: true, force: true });
  });
  const imagePath = join(cwd, "image.png");
  await writeFile(imagePath, "test image bytes");
  const path = join(cwd, "pi-slate.json");
  if (text !== undefined) await writeFile(path, text);
  const calls: string[] = [];
  const notices: string[] = [];
  const notifications: Array<{ message: string; kind: string }> = [];
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Handler[]>();
  const choices: string[] = [];
  const inspected: string[] = [];
  const extraCommands: Array<{ name: string; source: string; sourceInfo: { path: string; scope: string } }> = [];
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const eventEmissions: Array<{ name: string; value: unknown }> = [];
  let draft = "existing draft";
  const shortcuts: string[] = [];
  const shortcutHandlers = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>();
  t.mock.method(GitStatusPoller.prototype, "start", () => { calls.push("files-start"); });
  t.mock.method(GitStatusPoller.prototype, "refresh", async () => { calls.push("files-refresh"); });
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    registerCommand(name: string, command: typeof commands extends Map<string, infer V> ? V : never) { commands.set(name, command); },
    registerShortcut(key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) {
      shortcuts.push(key); shortcutHandlers.set(key, options.handler);
    },
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerToolRenderer() { calls.push("tool-renderer"); },
    getCommands: () => extraCommands,
    getAllTools: () => [
      ...tools.map((tool) => ({ ...tool, sourceInfo: { path: conflict ? "/foreign/cards.ts" : new URL("../extensions/pi-slate/index.ts", import.meta.url).pathname } })),
      { name: "mcp__docs__search", description: "test MCP tool", parameters: {}, sourceInfo: { path: "/host/mcp.ts" }, namespace: { name: "mcp__docs", aliases: ["docs"] } },
      // Claude mode deliberately keeps the host's read registration.
      ...tools.some((tool) => tool.name === "read") ? [] : [{ name: "read", sourceInfo: { path: "/host/read.ts" } }],
    ],
    exec: async () => { calls.push("branch-git"); return { code: 0, stdout: "test-branch\n", stderr: "", killed: false }; },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        const prefix = name === "subagent:ui-host-request" ? "navigation" : "async";
        calls.push(`${prefix}-subscribe`);
        const listeners = eventHandlers.get(name) ?? new Set();
        listeners.add(handler); eventHandlers.set(name, listeners);
        return () => { listeners.delete(handler); calls.push(`${prefix}-dispose`); };
      },
      emit(name: string, value: unknown) {
        eventEmissions.push({ name, value });
        for (const handler of eventHandlers.get(name) ?? []) handler(value);
      },
    },
  } as unknown as ExtensionAPI;
  const tui = compatible ? new TuiAltScreen(new NullTerminal()) : {
    requestRender() {}, terminal: { columns: 140, rows: 24 }, showOverlay() { assert.fail("no overlay fallback"); },
  } as unknown as TUI;
  const chat = new Container();
  for (let i = 0; i < 105; i++) chat.addChild(new Text(`message-${i}`, 0, 0));
  const root = new ScrollView(chat, { primary: true });
  if (compatible) (tui as TuiAltScreen).setLayoutRoot(root);
  const originalInsert = Editor.prototype.insertTextAtCursor;
  const originalPaste = Reflect.get(Editor.prototype, "handlePaste");
  const foreign = new Editor(tui, editorTheme);
  const foreignInsert = foreign.insertTextAtCursor;
  let editorFactory: unknown;
  let composer: Editor | undefined;
  let header: Component | undefined;
  const ui = {
    theme,
    getTheme: (name: string) => ({ ...theme, name }),
    notify: (message: string, kind = "info") => { notices.push(message); notifications.push({ message, kind }); },
    setHeader: (factory: ((tui: TUI, theme: Theme) => Component) | undefined) => { assert.ok(factory); calls.push("header"); header = factory(tui, theme); },
    setFooter: (factory: (() => Component) | undefined) => { assert.ok(factory); calls.push("footer"); assert.deepEqual(factory().render(80), []); },
    setEditorComponent: (factory: ((tui: TUI, theme: EditorTheme, keys: KeybindingsManager) => Editor) | undefined) => {
      assert.ok(factory); calls.push("editor"); editorFactory = factory; composer = factory(tui, editorTheme, new KeybindingsManager());
    },
    getEditorComponent: () => editorFactory,
    setWidget: (key: string, content: unknown, options?: { placement: string }) => {
      assert.equal(key, "pi-slate:surface-host"); assert.equal(options?.placement, "belowEditor");
      calls.push("widget"); assert.deepEqual((content as (tui: TUI, theme: Theme) => Component)(tui, theme).render(80), []);
    },
    setTitle() { assert.fail("Slate must not take the title"); },
    setTheme() { assert.fail("no automatic theme changes"); },
    setWorkingIndicator() { assert.fail("no global working-indicator takeover"); },
    setWorkingMessage: () => calls.push("working"),
    pasteToEditor: (text: string) => { draft += text; calls.push("paste-command"); },
    select: async (_title: string, options: string[]) => { const choice = choices.shift(); assert(choice === undefined || options.includes(choice), `unexpected selection ${choice}`); return choice; },
    custom: async (factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value?: string) => void) => Component) => {
      let result: string | undefined;
      const component = factory(tui, theme, new KeybindingsManager(), value => { result = value; });
      const rows = () => component.render(100);
      if (!rows().join("\n").includes("Enter selects")) { inspected.push(rows().join("\n")); return; }
      const labels: string[] = [];
      for (let i = 0; i < 1100; i++) {
        const label = rows().find(row => row.trim().startsWith("› "))!.trim().slice(2);
        if (labels.at(-1) === label) break;
        labels.push(label); component.handleInput?.("\x1b[B");
      }
      const choice = await ui.select("Sidebar picker", labels);
      component.handleInput?.("\x1b[H");
      if (choice === undefined) component.handleInput?.("\x1b");
      else { for (let i = 0; i < labels.indexOf(choice); i++) component.handleInput?.("\x1b[B"); component.handleInput?.("\r"); }
      return result;
    },
  };
  const manager = SessionManager.inMemory(cwd);
  let stale = false;
  const ctx = new Proxy({ cwd, mode, ui, sessionManager: manager, modelRegistry: { find: () => undefined }, getContextUsage: () => undefined, isIdle: () => true, isProjectTrusted: () => false, waitForIdle: async () => { calls.push("waitForIdle"); }, reload: async () => { calls.push("reload"); } } as unknown as ExtensionCommandContext, {
    get(target, key, receiver) {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return Reflect.get(target, key, receiver);
    },
  });
  await configure?.(pi, ui as unknown as ExtensionContext["ui"], cwd);
  piSlate(pi);
  const emit = async (type: string, extra: Record<string, unknown> = {}, context: ExtensionContext = ctx) => {
    let result: unknown;
    for (const handler of handlers.get(type) ?? []) result = await handler({ type, ...extra } as ExtensionEvent, context);
    return result;
  };
  t.after(() => { stale = false; return emit("session_shutdown"); });
  await emit("session_start");
  await Promise.resolve();
  assert.equal(Editor.prototype.insertTextAtCursor, originalInsert);
  assert.equal(Reflect.get(Editor.prototype, "handlePaste"), originalPaste);
  assert.equal(foreign.insertTextAtCursor, foreignInsert);
  return { pi, invalidate: () => { stale = true; }, calls, notices, notifications, commands, tools, shortcuts, shortcutHandlers, emit, ctx, path, imagePath, chat, root, tui, composer, foreign, choices, inspected, extraCommands, manager, eventEmissions,
    publishEvent: (name: string, value: unknown) => (pi.events as { emit(name: string, value: unknown): void }).emit(name, value),
    draft: () => draft, header: () => header, setForeignEditor: () => { editorFactory = () => foreign; } };
}

for (const surfaces of [[], ["editor"], [...FRESH_SURFACES], [...SURFACES], ["header"], ["tool-cards"], ["sidebar"], ["transcript"], ["footer"]] as Surface[][]) {
  test(`selected set controls all installers: ${surfaces.join("+") || "none"}`, async (t) => {
    const f = await fixture(t, JSON.stringify({ version: 1, surfaces, focused: true }));
    for (const slot of ["header", "footer", "editor"] as const) assert.equal(f.calls.includes(slot), has(surfaces, slot), slot);
    assert.equal(f.calls.includes("widget"), has(surfaces, "sidebar") || has(surfaces, "transcript") || has(surfaces, "tool-cards"));
    assert.equal(f.calls.includes("files-start"), false, "retired file dashboard has no git-status watcher");
    assert.equal(f.calls.includes("navigation-subscribe"), has(surfaces, "editor"));
    assert.equal(f.calls.includes("branch-git"), has(surfaces, "editor"));
    assert.deepEqual(f.tools.map((tool) => tool.name).sort(), has(surfaces, "tool-cards") ? ["edit", "write"] : []);
    assert.equal(f.commands.has("exit"), true);
    assert.equal(f.commands.has("prompts"), has(surfaces, "editor"));
    assert.equal(f.chat.children.length, 105, "the host's canonical message collection is never trimmed");
    assert.equal(f.chat.render(80).length, has(surfaces, "transcript") ? 100 : 105);
    const message = { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }] };
    await f.emit("agent_start");
    await f.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    assert.equal(f.calls.includes("working"), false, "the wave does not override the host's working message");
    if (has(surfaces, "editor")) assert.doesNotMatch(f.composer!.render(80)[0]!, /[▁-█]{7}/, "no wave without a host indicator");
    f.foreign.insertTextAtCursor(f.imagePath);
    assert.equal(f.foreign.getText(), f.imagePath, "foreign editor insertion is never rewritten");
    const input = await f.emit("input", { text: f.imagePath });
    if (has(surfaces, "editor")) {
      assert.deepEqual(input, { action: "transform", text: "[image-1]", images: [{ type: "image", data: Buffer.from("test image bytes").toString("base64"), mimeType: "image/png" }] });
      f.composer!.insertTextAtCursor(f.imagePath);
      assert.equal(f.composer!.getText(), "[image-1]", "only the Slate instance rewrites images");
    } else assert.equal(input, undefined, "unselected editor registers no image transform");
    const mounts = f.calls.filter((call) => ["header", "footer", "editor", "widget"].includes(call));
    f.setForeignEditor();
    assert.equal(await f.emit("input", { text: f.imagePath }), undefined, "successor editor input stays native");
    const workingCount = f.calls.filter((call) => call === "working").length;
    await f.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    assert.equal(f.calls.filter((call) => call === "working").length, workingCount, "foreign editor never receives Slate thinking status");
    await f.emit("session_shutdown");
    await f.emit("session_shutdown");
    assert.deepEqual(f.calls.filter((call) => ["header", "footer", "editor", "widget"].includes(call)), mounts, "cleanup does not clear unowned or successor slots");
    assert.equal(f.chat.children.length, 105);
  });
}

test("the wave advances on host paints without scheduling a Slate frame", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"] }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 1000, requests = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(f.tui, "requestRender", () => { requests++; });
  await f.emit("agent_start");
  assert.equal(isWaveActive(), true);
  assert.ok(f.composer instanceof ComposerEditor);
  f.composer.setWorkingStatusIndicator(
    { kind: "working", frames: ["a", "b"], renderInBorder: () => "" } as unknown as Parameters<ComposerEditor["setWorkingStatusIndicator"]>[0],
  );
  const initial = f.composer!.render(80)[0];
  now += 6 * WAVE_STEP_MS;
  t.mock.timers.tick(6 * WAVE_STEP_MS);
  assert.equal(requests, 0, "Slate must not wake a quiet renderer for the wave");
  assert.notEqual(f.composer!.render(80)[0], initial);
  await f.emit("agent_end");
  assert.equal(isWaveActive(), false);
});

test("focused composer shows ctx and resources on top without duplicating them below", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "header"], focused: true }));
  Object.assign(f.ctx, { getContextUsage: () => ({ tokens: 10000, percent: 10, contextWindow: 100000 }) });
  f.manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: .1, output: .2, cacheRead: 0, cacheWrite: .05, total: .35 } } });
  await f.emit("agent_settled");
  await new Promise(resolve => setImmediate(resolve));

  const lines = f.composer!.render(100).map(stripVTControlCharacters);
  const bottom = lines.at(-1)!;
  assert.match(lines[0]!, /ctx 10%/);
  assert.match(bottom, new RegExp(`${basename(f.ctx.cwd)} / test-branch`));
  assert.match(bottom, /no model/);
  assert.doesNotMatch(bottom, /ctx 10%/);
});

test("background task snapshots request current state, stay session scoped, and clear on replacement", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["editor", "sidebar"], focused: true }));
  const owner = f.manager.getSessionId();
  assert(f.eventEmissions.some(event => event.name === "pi:background-tasks:request"
    && (event.value as { version?: number; sessionId?: string }).version === 1
    && (event.value as { sessionId?: string }).sessionId === owner
    && !("source" in (event.value as object))));
  const publication = { version: 1, source: "pi-subagents", sessionId: owner, tasks: [
    { id: "run-a", kind: "subagent", label: "reviewer: inspect parser", state: "running", detail: "public detail" },
  ] };
  f.publishEvent("pi:background-tasks", publication);
  assert.match(f.composer!.render(100)[0]!, /1 subagent/);
  assert.match(railOf(f).render(40).join("\n"), /Subagents.*1 Active/);

  f.publishEvent("pi:background-tasks", { ...publication, source: "compatible-publisher" });
  assert.match(f.composer!.render(100)[0]!, /2 subagents/);
  assert.match(railOf(f).render(40).join("\n"), /Subagents.*2 Active/);

  f.publishEvent("pi:background-tasks", { ...publication, tasks: [] });
  assert.match(f.composer!.render(100)[0]!, /1 subagent/);
  assert.match(railOf(f).render(40).join("\n"), /Subagents.*1 Active/);

  f.publishEvent("pi:background-tasks", { ...publication, sessionId: "foreign", tasks: [] });
  assert.match(railOf(f).render(40).join("\n"), /Subagents.*1 Active/);

  const nextManager = SessionManager.inMemory(f.ctx.cwd);
  const next = { ...f.ctx, sessionManager: nextManager } as ExtensionContext;
  await f.emit("session_start", {}, next);
  assert.doesNotMatch(railOf(f).render(40).join("\n"), /reviewer: inspect parser|Subagents.*1 Active/);
  assert(f.eventEmissions.some(event => event.name === "pi:background-tasks:request"
    && (event.value as { sessionId?: string }).sessionId === nextManager.getSessionId()));
});

test("focused composer retries unchanged metadata on the next poll after both schedulers fail", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "sidebar"], focused: true }));
  const mcp = join(dirname(f.path), "mcp.json");
  const paint = () => stripVTControlCharacters(f.composer!.render(100)[0]!);
  const poll = () => { for (let i = 0; i < 5; i++) t.mock.timers.tick(1000); };
  await writeFile(mcp, '{"mcpServers":{"a":{"command":"a"}}}');
  poll();
  let shown = paint();
  assert.match(shown, /1 mcp/);

  const attempts: boolean[] = [];
  let blocked = true;
  t.mock.method(f.tui, "requestRender", (force = false) => {
    attempts.push(force);
    if (blocked) throw new Error("scheduler unavailable");
    shown = paint();
  });
  await writeFile(mcp, '{"mcpServers":{"a":{"command":"a"},"b":{"command":"b"}}}');
  poll();
  assert.deepEqual(new Set(attempts), new Set([false, true]));
  assert.match(shown, /1 mcp/);

  blocked = false;
  attempts.length = 0;
  poll();
  assert.deepEqual(attempts, [false]);
  assert.match(shown, /2 mcp/);
  poll();
  assert.deepEqual(attempts, [false], "unchanged metadata stays quiet after recovery");
});

test("the branch poll retries a changed label after both schedulers fail", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"] }));
  const paint = () => stripVTControlCharacters(f.composer!.render(100).at(-1)!);
  let shown = paint();
  assert.match(shown, /test-branch/);
  t.mock.method(f.pi, "exec", async () => ({ code: 0, stdout: "new-branch\n", stderr: "", killed: false }));
  const attempts: boolean[] = [];
  let blocked = true;
  t.mock.method(f.tui, "requestRender", (force = false) => {
    attempts.push(force);
    if (blocked) throw new Error("scheduler unavailable");
    shown = paint();
  });
  const poll = async () => { t.mock.timers.tick(5000); await Promise.resolve(); };
  await poll();
  assert.deepEqual(attempts, [false, true]);
  assert.match(shown, /test-branch/);
  blocked = false;
  await poll();
  assert.match(shown, /new-branch/);
  await poll();
  assert.deepEqual(attempts, [false, true, false]);
});

test("Claude tool style is the default for tool-cards and skips legacy read grouping", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["tool-cards"] }));
  assert.deepEqual(f.tools.map((tool) => tool.name).sort(), ["edit", "write"]);
  assert.ok(f.calls.includes("tool-renderer"));
  assert.ok(!f.notices.some((notice) => notice.includes("tool-cards unavailable")), "native read registration is not a conflict");
  assert.ok(f.calls.includes("widget"), "grouping acquires only a zero-row TUI handle, not the composer");
  assert.ok(!f.calls.includes("editor"));
  await f.commands.get("slate")!.handler("focused off", f.ctx);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).toolStyle, undefined);
});

test('toolStyle "default" restores Slate cards and legacy read grouping', async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["tool-cards"], toolStyle: "default" }));
  assert.deepEqual(f.tools.map((tool) => tool.name).sort(), ["edit", "read", "write"]);
  assert.ok(!f.calls.includes("tool-renderer"));
  await f.commands.get("slate")!.handler("focused off", f.ctx);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).toolStyle, "default");
});

test("lost optional styling registrations are diagnostic-only and never blame native read", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["tool-cards"] }), "tui", true, true);
  assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  const report = f.inspected.join("\n");
  assert.match(report, /Host registrations retained for edit, write/);
  assert.doesNotMatch(report, /retained for.*read/);
});

test("the chat painter sets the hidden thinking label once per UI and restores it on shutdown", async (t) => {
  const labels: Array<string | undefined> = [];
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["transcript"] }), "tui", true, false, (_pi, ui) => {
    ui.setHiddenThinkingLabel = (label) => { labels.push(label); };
  });
  const message = { role: "assistant", content: [] };
  for (let i = 0; i < 3; i++) await f.emit("message_end", { message }, { ...f.ctx });
  assert.deepEqual(labels, ["Thought"], "fresh event wrappers share one UI owner");

  const replacementLabels: Array<string | undefined> = [];
  const ui = { ...f.ctx.ui, setHiddenThinkingLabel: (label?: string) => { replacementLabels.push(label); } };
  for (let i = 0; i < 3; i++) await f.emit("message_end", { message }, { ...f.ctx, ui });
  assert.deepEqual(replacementLabels, ["Thought"], "a replacement UI gets its own label");
  assert.deepEqual(labels, ["Thought", undefined], "replacement clears the old label");
  await f.emit("session_shutdown", {}, f.ctx);
  assert.deepEqual(replacementLabels, ["Thought", undefined]);

  await f.emit("session_start", {}, { ...f.ctx, ui });
  await f.emit("message_end", { message }, { ...f.ctx, ui });
  assert.deepEqual(replacementLabels, ["Thought", undefined, "Thought"], "remounting resets the guard");
  await f.emit("session_shutdown", {}, { ...f.ctx, ui });
});

test("unselected cards ignore Claude tool style entirely", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: [] }));
  assert.deepEqual(f.tools, []);
  assert.ok(!f.calls.includes("tool-renderer"));
  assert.ok(!f.calls.includes("widget"));
});

test("surface saves require reload; focus/width never enable an unselected sidebar", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["tool-cards"], focused: true, footer: "minimal" }));
  const command = f.commands.get("slate")!;
  await command.handler("focused off", f.ctx);
  await command.handler("width wide", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, ["tool-cards"]);
  await command.handler("surfaces set header tool-cards", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, ["header", "tool-cards"]);
  assert.ok(f.notices.some((notice) => /reload required/.test(notice)));
  assert.equal(f.calls.includes("header"), false, "no hot swap");
  await command.handler("surfaces full", f.ctx);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(saved.surfaces, SURFACES);
  assert.equal(saved.composerMetadata, "minimal");
  assert.equal(saved.footer, "minimal");
  await command.handler("surfaces none", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, []);
});

for (const effortBorderColor of [undefined, false, true, "true", 1]) {
  test(`effort border config only opts in for literal true: ${String(effortBorderColor)}`, async t => {
    const text = JSON.stringify({ surfaces: ["editor"], effortBorderColor });
    const f = await fixture(t, text);
    const paint = (value: string) => `<effort>${value}</effort>`;
    f.composer!.borderColor = paint;
    assert.equal(f.composer!.borderColor("x"), effortBorderColor === true ? paint("x") : "x");
    assert.equal(f.foreign.borderColor("x"), "x", "foreign editor remains untouched");
    assert.equal(await readFile(f.path, "utf8"), text, "loading does not rewrite settings");
  });
}

test("effort border commands and picker persist and apply live without rebuilding the editor", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"], focused: false, density: "compact", showPid: true }));
  const command = f.commands.get("slate")!;
  const saved = async () => JSON.parse(await readFile(f.path, "utf8"));
  const paint = (text: string) => `<effort>${text}</effort>`;
  f.composer!.borderColor = paint;
  assert.equal(f.composer!.borderColor("x"), "x");
  for (const args of ["effort-border on", "effort-border on"]) {
    await command.handler(args, f.ctx);
    const config = await saved();
    assert.equal(config.effortBorderColor, true);
    assert.deepEqual(config.surfaces, ["editor"]);
    assert.equal(config.focused, false);
    assert.equal(config.density, "compact");
    assert.equal(config.showPid, true);
    assert.equal(f.composer!.borderColor("x"), paint("x"), "saved setting applies immediately");
  }
  assert.equal(f.calls.filter(call => call === "editor").length, 1);
  assert.equal(f.notices.at(-1), "Effort border color on");
  await command.handler("effort-border off", f.ctx);
  assert.equal((await saved()).effortBorderColor, false);
  assert.equal(f.composer!.borderColor("x"), "x");
  await command.handler("effort-border", f.ctx);
  assert.equal((await saved()).effortBorderColor, true, "bare command toggles on");
  assert.equal(f.composer!.borderColor("x"), paint("x"));
  f.choices.push("Effort border color");
  await command.handler("", f.ctx);
  assert.equal((await saved()).effortBorderColor, false, "picker toggles off");
  assert.equal(f.composer!.borderColor("x"), "x");
  const before = await readFile(f.path, "utf8");
  await command.handler("", f.ctx); // Cancel the settings picker.
  await command.handler("effort-border nope", f.ctx);
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("GitHub callouts register one assistant markdown transformer", async t => {
  const registered: Array<{ transformer: (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string; options?: { messageTypes?: readonly string[] } }> = [];
  const calloutTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as unknown as Theme;
  await fixture(t, JSON.stringify({ surfaces: [] }), "tui", true, false, (pi, ui) => {
    Reflect.set(pi, "registerMarkdownTransformer", (transformer: typeof registered[number]["transformer"], options?: typeof registered[number]["options"]) => registered.push({ transformer, options }));
    Reflect.set(ui, "theme", calloutTheme);
  });
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0]!.options, { messageTypes: ["assistant"] });
  const context = { messageType: "assistant", isStreaming: false, availableWidth: 80 };
  const result = registered[0]!.transformer("> [!TIP]\n> hi", context);
  assert.match(result, /<success>│<\/success>/);
});

test("effort border settings never enable an unselected editor", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: [], effortBorderColor: true }));
  await f.commands.get("slate")!.handler("effort-border off", f.ctx);
  await f.commands.get("slate")!.handler("effort-border on", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, []);
  assert.equal(f.calls.includes("editor"), false);
  assert.equal(f.composer, undefined);
});

test("invalid files activate nothing, warn, and survive even a settings command", async (t) => {
  const text = '{"version":999,"surfaces":["editor"]}';
  const f = await fixture(t, text);
  assert.equal(f.calls.length, 0);
  assert.equal(f.tools.length, 0);
  assert.match(f.notices.join("\n"), /preserved/);
  await f.commands.get("slate")!.handler("surfaces full", f.ctx);
  assert.equal(await readFile(f.path, "utf8"), text);
});

test("fresh config stays unwritten until a save and persists the fresh surface set", async (t) => {
  const f = await fixture(t, undefined);
  assert.equal(f.calls.includes("editor"), true);
  assert.equal(f.calls.includes("header"), false);
  assert.equal(f.calls.includes("footer"), false);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
  await f.commands.get("slate")!.handler("pid on", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).surfaces, FRESH_SURFACES);
});

for (const mode of ["print", "rpc", "json"]) {
  test(`${mode} keeps native tools and never installs UI patches`, async (t) => {
    const f = await fixture(t, JSON.stringify({ surfaces: SURFACES }), mode);
    await f.emit("agent_start");
    await f.emit("message_update", { message: { role: "assistant", content: [] } });
    assert.equal(await f.emit("input", { text: f.imagePath }), undefined);
    assert.deepEqual(f.calls, ["tool-renderer"], "only the inert renderer hook is registered outside the TUI");
    assert.equal(f.chat.children.length, 105);
  });
}

test("unsupported optional UI capabilities are quiet, preserve settings and explain fallbacks on demand", async (t) => {
  const text = JSON.stringify({ surfaces: ["sidebar", "transcript"], focused: false });
  const f = await fixture(t, text, "tui", false);
  assert.deepEqual(f.notifications, []);
  assert.equal(f.chat.children.length, 105);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /sidebar: fallback/);
  assert.match(f.inspected.join("\n"), /transcript: fallback/);
  assert.equal(await readFile(f.path, "utf8"), text);
});

test("hidden sidebar stays quiet on an incompatible host", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: true }), "tui", false);
  assert.equal(f.notices.some((notice) => /sidebar unavailable/.test(notice)), false);
});

test("tool ownership diagnostics preserve first-registration wins without repair or startup alarms", async (t) => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["tool-cards"] }), "tui", true, true);
  assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /first registration wins/);
});

test("real host below-editor widget renderer adds no rows for the TUI handle", () => {
  const render = Reflect.get(InteractiveMode.prototype, "renderWidgetContainer") as (container: Container, widgets: Map<string, Component>, empty: boolean, leading: boolean) => void;
  const container = new Container();
  render.call({}, container, new Map(), false, false);
  const before = container.render(80);
  render.call({}, container, new Map([["pi-slate:surface-host", { render: () => [], invalidate() {} }]]), false, false);
  assert.deepEqual(container.render(80), before);
  const other = new Text("another extension's widget", 0, 0);
  render.call({}, container, new Map<string, Component>([["foreign", other], ["pi-slate:surface-host", { render: () => [], invalidate() {} }]]), false, false);
  assert.deepEqual(container.render(80), other.render(80));
});

const unstyled = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("picker choices preserve unrelated native settings", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const settingsPath = join(dirname(f.path), "settings.json");
  await writeFile(settingsPath, JSON.stringify({ theme: "existing-theme", quietStartup: true, packages: ["keep-this-package"] }));
  const themes: string[] = [];
  t.mock.method(f.ctx.ui, "setTheme", (name: string) => { themes.push(name); return { success: true }; });
  t.mock.method(f.ctx.ui, "custom", async () => "system");
  await f.commands.get("slate")!.handler("theme", f.ctx);
  assert.deepEqual(themes, ["system"]);
  let saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(saved.theme, "system"); assert.equal(saved.quietStartup, true);
  assert.deepEqual(saved.packages, ["keep-this-package"]);
  t.mock.method(f.ctx.ui, "custom", async () => "tokyo-night");
  await f.commands.get("slate")!.handler("theme", f.ctx);
  assert.deepEqual(themes, ["system", "tokyo-night"]);
  saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(saved.theme, "tokyo-night"); assert.equal(saved.quietStartup, true);
  assert.deepEqual(saved.packages, ["keep-this-package"]);
});

test("/theme opens directly, retains aliases, and rejects unknown arguments", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: [] }));
  const menus: string[] = [];
  t.mock.method(f.ctx.ui, "custom", async () => { menus.push("Theme"); return undefined; });
  t.mock.method(f.ctx.ui, "setTheme", () => ({ success: true }));
  await f.commands.get("theme")!.handler("", f.ctx);
  await f.commands.get("theme")!.handler("  ", f.ctx);
  await f.commands.get("theme")!.handler("slate", f.ctx);
  await f.commands.get("slate")!.handler("theme", f.ctx);
  assert.deepEqual(menus, ["Theme", "Theme", "Theme", "Theme"]);
  await f.commands.get("theme")!.handler("dark", f.ctx);
  await f.commands.get("theme")!.handler("slate extra", f.ctx);
  assert.deepEqual(menus, ["Theme", "Theme", "Theme", "Theme"], "unrelated arguments never open the Slate picker");
  assert.equal(f.commands.has("settings"), false, "core settings remain untouched");
});

test("/logo toggles without a picker, saves explicit styles, and rejects unknown arguments", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["header"], logo: "minimal" }));
  const command = f.commands.get("logo")!;
  const saved = async () => JSON.parse(await readFile(f.path, "utf8"));
  t.mock.method(f.ctx.ui, "select", async () => { assert.fail("/logo must not open a picker"); });
  await command.handler("", f.ctx);
  assert.equal((await saved()).logo, "original");
  await command.handler("  ", f.ctx);
  assert.equal((await saved()).logo, "minimal");
  await command.handler("original", f.ctx);
  assert.equal((await saved()).logo, "original");
  await command.handler("minimal", f.ctx);
  assert.equal((await saved()).logo, "minimal");
  await command.handler("retro", f.ctx);
  assert.equal((await saved()).logo, "minimal");
  assert.ok(f.notices.includes("Usage: /logo [original|minimal]"));
});

test("a picker choice is persisted as the saved theme", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const settingsPath = join(dirname(f.path), "settings.json");
  const themes: string[] = [];
  t.mock.method(f.ctx.ui, "setTheme", (name: string) => { themes.push(name); return { success: true }; });
  t.mock.method(f.ctx.ui, "custom", async () => "black-metal");
  await f.commands.get("slate")!.handler("theme", f.ctx);
  assert.deepEqual(themes, ["black-metal"]);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).theme, "black-metal");
});

test("prompt shortcut stays unset unless shortcuts.prompts is a valid chord", async t => {
  const unset = await fixture(t, JSON.stringify({ surfaces: ["editor"] }));
  assert.deepEqual(unset.shortcuts, []);
  assert.equal(JSON.parse(await readFile(unset.path, "utf8")).shortcuts, undefined);
  for (const prompts of [false, "none", "", "p", "ctrl+alt+. extra"]) {
    const f = await fixture(t, JSON.stringify({ surfaces: ["editor"], shortcuts: { prompts } }));
    assert.deepEqual(f.shortcuts, [], String(prompts));
  }
  const bound = await fixture(t, JSON.stringify({ surfaces: ["editor"], shortcuts: { prompts: "Ctrl+Alt+." } }));
  assert.deepEqual(bound.shortcuts, ["ctrl+alt+."]);
  await bound.commands.get("slate")!.handler("pid on", bound.ctx);
  const saved = JSON.parse(await readFile(bound.path, "utf8"));
  assert.deepEqual(saved.shortcuts, { prompts: "Ctrl+Alt+." }, "PID saves leave unrelated settings as written");
  assert.equal(saved.showPid, true);
});

test("sidebar shortcut uses the saved focused-mode toggle", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: true, shortcuts: { sidebar: "Ctrl+Shift+B" } }));
  assert.deepEqual(f.shortcuts, ["ctrl+shift+b"]);

  await f.shortcutHandlers.get("ctrl+shift+b")!(f.ctx);
  let saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(saved.focused, false);
  assert.deepEqual(saved.shortcuts, { sidebar: "Ctrl+Shift+B" });
  assert.equal(f.notices.at(-1), "Focused mode off");

  await f.commands.get("slate")!.handler("focused", f.ctx);
  saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(saved.focused, true);
  assert.equal(f.notices.at(-1), "Focused mode on");
});

test("a stale PID shortcut patches only PID and preserves newer settings", async t => {
  const initial = { surfaces: ["editor"], shortcuts: { pid: "f4" } };
  const f = await fixture(t, JSON.stringify(initial));
  const latest = { ...initial, shortcuts: { ...initial.shortcuts, theme: "f3" }, unknown: { nested: "keep" } };
  await writeFile(f.path, JSON.stringify(latest));
  const toggle = f.shortcutHandlers.get("f4")!;
  await toggle(f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { ...latest, showPid: true });
  await writeFile(f.path, "{broken external edit");
  await toggle(f.ctx);
  assert.equal(await readFile(f.path, "utf8"), "{broken external edit");
  assert.match(f.notices.at(-1)!, /Settings file preserved/);
});

test("all bound actions register; density and footer keys toggle immediately", async t => {
  const shortcuts = { sidebar: "f8", prompts: "f2", theme: "f3", pid: "f4", "effort-border": "f5", density: "f6", footer: "f7" };
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "sidebar"], shortcuts }));
  assert.deepEqual([...f.shortcuts].sort(), Object.values(shortcuts).sort());
  const read = async () => JSON.parse(await readFile(f.path, "utf8"));
  for (const [key, field, toggled, command, restored] of [
    ["f8", "focused", false, "focused", true],
    ["f4", "showPid", true, "pid", false],
    ["f5", "effortBorderColor", true, "effort-border", false],
  ] as const) {
    await f.shortcutHandlers.get(key)!(f.ctx);
    assert.equal((await read())[field], toggled);
    await f.commands.get("slate")!.handler(command, f.ctx);
    assert.equal((await read())[field], restored);
  }
  for (const [key, field, toggled, restored] of [
    ["f6", "density", "compact", "comfortable"], ["f7", "composerMetadata", "minimal", "standard"],
  ] as const) {
    const handler = f.shortcutHandlers.get(key)!;
    await handler(f.ctx);
    assert.equal((await read())[field], toggled);
    await handler(f.ctx);
    assert.equal((await read())[field], restored);
  }
  const saved = await read();
  assert.deepEqual(saved.shortcuts, shortcuts);
  assert.equal(saved.footer, saved.composerMetadata, "composer metadata keeps the legacy footer mirror");
});

test("registration skips reserved aliases, Pi remaps, viewport and Slate editor keys", async t => {
  const shortcuts = { sidebar: "ctrl+[", prompts: "ctrl+m", theme: "ctrl+shift+p", pid: "f8", "effort-border": "ctrl+home", density: "ctrl+a", footer: "f2" };
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"], shortcuts }), "tui", true, false, async (_pi, _ui, dir) => {
    await writeFile(join(dir, "keybindings.json"), JSON.stringify({ cycleModelBackward: "shift+ctrl+p", "app.thinking.toggle": ["f8"] }));
  });
  assert.deepEqual(f.shortcuts, ["f2"]);
  for (const raw of ["\r", "\x1b"]) assert(!f.shortcuts.some(key => matchesKey(raw, key as KeyId)), "reserved input must not trigger Slate");
  assert(f.notices.some(notice => notice.includes("prompts (Ctrl+M): Reserved by Pi")));
  assert(f.notices.some(notice => notice.includes("effort-border (Ctrl+Home): Used by Pi's viewport")));
  assert(f.notices.some(notice => notice.includes("density (Ctrl+A): Used by Slate's editor")));
});

test("load-time registration skips editing keys, unsupported chords, global keys and Kitty symbol aliases", async t => {
  const shortcuts = { sidebar: "left", prompts: "ctrl++", theme: "ctrl+escape", pid: "shift+f2", "effort-border": "ctrl+shift+d", footer: "f2" };
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"], shortcuts }), "tui", true, false, async (_pi, _ui, dir) => {
    await writeFile(join(dir, "keybindings.json"), JSON.stringify({ "app.interrupt": "ctrl+shift+=" }));
  });
  assert.deepEqual(f.shortcuts, ["f2"], "Left must stay available to Slate's caret movement adapter");
  assert(!f.shortcuts.some(key => matchesKey("\x1b[D", key as KeyId)));
  for (const message of ["(Left): Used for editing — add ctrl or alt", "(Ctrl++): Reserved by Pi", "(Ctrl+Escape): Not supported by Pi",
    "(Shift+F2): Not supported by Pi", "(Ctrl+Shift+D): Used by Pi"]) {
    assert(f.notices.some(notice => notice.includes(message)), message);
  }
});

test("literal Tab cannot dispatch a hand-edited Ctrl+I shortcut", async t => {
  const text = JSON.stringify({ surfaces: ["editor"], shortcuts: { pid: "ctrl+i" } });
  const f = await fixture(t, text);
  assert(matchesKey("\t", "ctrl+i"), "Pi treats legacy Tab as Ctrl+I");
  for (const [key, handler] of f.shortcutHandlers) if (matchesKey("\t", key as KeyId)) await handler(f.ctx);
  assert.equal(await readFile(f.path, "utf8"), text);
  assert.match(f.notices.at(-1)!, /\(Ctrl\+I\): Used for editing/);
});

test("registration blocks remapped image-token editor actions only when Slate owns the editor", async t => {
  const configure = async (_pi: ExtensionAPI, _ui: ExtensionContext["ui"], dir: string) => {
    await writeFile(join(dir, "keybindings.json"), JSON.stringify({
      "tui.editor.deleteCharBackward": ["backspace", "f8"], deleteCharForward: "f7", cursorLeft: "f6", cursorRight: "f5",
    }));
  };
  const shortcuts = { pid: "f8", footer: "f7", density: "f6", theme: "f5" };
  const owned = await fixture(t, JSON.stringify({ surfaces: ["editor"], shortcuts }), "tui", true, false, configure);
  assert.deepEqual(owned.shortcuts, []);
  assert.equal(owned.notices.filter(notice => notice.endsWith("Used by Slate's editor")).length, 4);
  const native = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], shortcuts }), "tui", true, false, configure);
  assert.deepEqual([...native.shortcuts].sort(), Object.values(shortcuts).sort());
});

test("registration rejects the same xterm shifted-symbol alias as the recorder", async t => {
  const f = await fixture(t, JSON.stringify({ shortcuts: { pid: "ctrl+?" } }), "tui", true, false, async (_pi, _ui, dir) => {
    await writeFile(join(dir, "keybindings.json"), JSON.stringify({ "app.interrupt": "ctrl+shift+?" }));
  });
  assert.deepEqual(f.shortcuts, []);
  assert.match(f.notices.at(-1)!, /\(Ctrl\+\?\): Reserved by Pi/);
});

function driveShortcuts(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, drive: (panel: Component) => void | Promise<void>) {
  t.mock.method(f.ctx.ui, "custom", async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    let result: unknown;
    const panel = await factory(f.tui, theme, new KeybindingsManager(), value => { result = value; });
    await drive(panel);
    return result;
  });
}

const shortcutEsc = "\x1b", shortcutEnter = "\r", shortcutDel = "\x1b[3~", f2Input = "\x1bOQ", f8Input = "\x1b[19~";

function sendShortcut(panel: Component, ...keys: string[]) {
  for (const key of keys) panel.handleInput!(key);
}

test("unbinding a duplicate winner does not resurrect hidden owners on reload", async t => {
  const config = { surfaces: ["editor", "sidebar"], shortcuts: { theme: "f2", prompts: "F2", sidebar: "f2" } };
  const f = await fixture(t, JSON.stringify(config));
  assert.deepEqual(f.shortcuts, ["f2"]);
  driveShortcuts(t, f, async panel => {
    const rows = panel.render(88).join("\n");
    assert.match(rows, /Toggle sidebar\s+F2/);
    for (const label of [/Theme picker\s+—/, /Prompt picker\s+—/]) assert.match(rows, label);
    sendShortcut(panel, shortcutDel);
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), config);
    sendShortcut(panel, shortcutDel);
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).shortcuts, { sidebar: false, prompts: false, theme: false });
    assert(!f.calls.includes("reload"));
    sendShortcut(panel, shortcutEsc);
  });
  await f.commands.get("shortcuts")!.handler("", f.ctx);
  assert(f.calls.includes("reload"));
  const reloaded = await fixture(t, await readFile(f.path, "utf8"));
  assert.deepEqual(reloaded.shortcuts, []);
});

for (const [name, initial, disk, prepare, edit, reason] of [
  ["a newer binding earlier in catalog order", {}, { sidebar: "f2" }, ["\x1b[A", shortcutEnter], f2Input, "F2 is now used by Toggle sidebar"],
  ["a newer binding later in catalog order", {}, { footer: "f2" }, [shortcutEnter], f2Input, "F2 is now used by Composer metadata"],
  ["a divergent edit to the same action", { footer: "f2" }, { footer: "f3" }, ["\x1b[A", shortcutEnter], "\x1bOS", "Composer metadata changed in another session"],
  ["unbinding an action edited since opening", { sidebar: "f8" }, { sidebar: "f3" }, [shortcutDel], shortcutDel, "Toggle sidebar changed in another session"],
] as const) {
  test("shortcuts auto-save refuses " + name, async t => {
    const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], shortcuts: initial }));
    const concurrent = JSON.stringify({ surfaces: ["sidebar"], shortcuts: disk });
    driveShortcuts(t, f, async panel => {
      sendShortcut(panel, ...prepare);
      await writeFile(f.path, concurrent);
      sendShortcut(panel, edit);
      const rows = panel.render(88).join("\n");
      assert(rows.includes("Shortcuts not saved: " + reason), rows);
      assert.match(rows, Object.keys(initial).length ? /Shortcut\s+\[ F[28] \]/ : /Shortcut\s+Not set/);
      sendShortcut(panel, shortcutEsc);
    });
    await f.commands.get("shortcuts")!.handler("", f.ctx);
    assert.equal(await readFile(f.path, "utf8"), concurrent);
    assert(!f.calls.includes("waitForIdle") && !f.calls.includes("reload"));
  });
}

test("a concurrent Kitty physical alias is refused unless the panel intended to move it", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"] }));
  const physical = "\x1b[45:43;6u";
  assert(matchesKey(physical, "ctrl++") && matchesKey(physical, "ctrl+shift+-"));
  const concurrent = JSON.stringify({ surfaces: ["editor"], shortcuts: { prompts: "ctrl+shift+-" } });
  driveShortcuts(t, f, async panel => {
    sendShortcut(panel, shortcutEnter);
    await writeFile(f.path, concurrent);
    sendShortcut(panel, physical);
    const rows = panel.render(88).join("\n");
    assert.match(rows, /Shortcuts not saved: Ctrl\+\+ is now used by Prompt picker/);
    assert.match(rows, /Shortcut\s+Not set/);
    sendShortcut(panel, shortcutEsc);
  });
  const pick = f.commands.get("shortcuts")!.handler;
  await pick("", f.ctx);
  assert.equal(await readFile(f.path, "utf8"), concurrent);
  assert(!f.calls.includes("waitForIdle") && !f.calls.includes("reload"));

  driveShortcuts(t, f, panel => {
    sendShortcut(panel, shortcutEnter, physical);
    assert.match(panel.render(88).join("\n"), /Moved from Prompt picker/);
    sendShortcut(panel, shortcutEsc);
  });
  await pick("", f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).shortcuts, { sidebar: "ctrl++", prompts: false });
  assert(f.calls.includes("reload"));
});

test("/shortcuts merges each auto-save into fresh settings and waits for idle only on close", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], shortcuts: { sidebar: "f8" } }));
  const latest = { version: 1, surfaces: ["editor"], unknown: { future: true }, shortcuts: { sidebar: "f8", footer: "F7", density: "f8", future: 42 } };
  const moved = { ...latest.shortcuts, sidebar: false, pid: "f8", density: false };
  let entered!: () => void, idle!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { idle = resolve; });
  const wait = t.mock.method(f.ctx, "waitForIdle", () => { entered(); return resume; });
  const reload = t.mock.method(f.ctx, "reload", async () => {});
  driveShortcuts(t, f, async panel => {
    await writeFile(f.path, JSON.stringify(latest));
    sendShortcut(panel, "\x1b[B", "\x1b[B", "\x1b[B", shortcutEnter, f8Input);
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { ...latest, shortcuts: moved });
    assert.match(panel.render(88).join("\n"), /✓ Saved — applies when you close/);
    sendShortcut(panel, "\x1b[B", shortcutEnter, "\x1b[15~");
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { ...latest, shortcuts: { ...moved, "effort-border": "f5" } });
    // A later failure still leaves the successful changes eligible for reload.
    await writeFile(f.path, JSON.stringify({ ...latest, shortcuts: { ...moved, "effort-border": "f6" } }));
    sendShortcut(panel, shortcutEnter, f2Input);
    assert.match(panel.render(88).join("\n"), /Shortcuts not saved: Effort border color changed/);
    assert.equal(wait.mock.callCount(), 0);
    assert.equal(reload.mock.callCount(), 0);
    sendShortcut(panel, shortcutEsc);
  });
  const saving = f.commands.get("shortcuts")!.handler("", f.ctx);
  await Promise.race([waiting, saving]);
  assert.equal(wait.mock.callCount(), 1);
  assert.equal(reload.mock.callCount(), 0);
  idle();
  await saving;
  assert.equal(reload.mock.callCount(), 1);
  await f.commands.get("slate")!.handler("surfaces", f.ctx);
  assert.match(f.notices.at(-1)!, /Slate surfaces: editor\. Active: sidebar/);
});

test("two panels closed while Pi is busy share a single wait and reload", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  let idle!: () => void;
  const resume = new Promise<void>(resolve => { idle = resolve; });
  const wait = t.mock.method(f.ctx, "waitForIdle", () => resume);
  const reload = t.mock.method(f.ctx, "reload", async () => {});
  const pick = f.commands.get("shortcuts")!.handler;
  let input = [shortcutEnter, f2Input, shortcutEsc];
  driveShortcuts(t, f, panel => sendShortcut(panel, ...input));
  const first = pick("", f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  input = ["\x1b[A", shortcutEnter, "\x1b[18~", shortcutEsc];
  const second = pick("", f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).shortcuts, { sidebar: "f2", footer: "f7" });
  assert.equal(wait.mock.callCount(), 1);
  assert.equal(reload.mock.callCount(), 0);
  idle();
  await Promise.all([first, second]);
  assert.equal(reload.mock.callCount(), 1);
});

// Model Pi 1.4: only done settles custom(), not a host UI reset.
function mountShortcuts(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const panels: Component[] = [];
  t.mock.method(f.ctx.ui, "custom", (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => new Promise(resolve => {
    const panel = factory(f.tui, theme, new KeybindingsManager(), resolve);
    assert(!(panel instanceof Promise));
    panels.push(panel);
  }));
  return panels;
}

test("idle arriving while a second shortcuts panel is open defers reload until it closes", { timeout: 3000 }, async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const panels = mountShortcuts(t, f);
  let idle!: () => void;
  const resume = new Promise<void>(resolve => { idle = resolve; });
  const wait = t.mock.method(f.ctx, "waitForIdle", () => resume);
  const reload = t.mock.method(f.ctx, "reload", async () => {});
  const pick = f.commands.get("shortcuts")!.handler;
  const first = pick("", f.ctx);
  sendShortcut(panels[0]!, shortcutEnter, f2Input, shortcutEsc);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wait.mock.callCount(), 1);
  const second = pick("", f.ctx);
  idle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reload.mock.callCount(), 0);
  sendShortcut(panels[1]!, "\x1b[A", shortcutEnter, f8Input, shortcutEsc);
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).shortcuts, { sidebar: "f2", footer: "f8" });
  assert.equal(wait.mock.callCount(), 1);
  assert.equal(reload.mock.callCount(), 1);
});

for (const event of ["session_shutdown", "session_start"] as const) {
  test(`an open shortcuts command settles on ${event} and ignores late input`, { timeout: 3000 }, async t => {
    const original = JSON.stringify({ surfaces: ["sidebar"], shortcuts: { sidebar: "f8" } });
    const f = await fixture(t, original);
    const panels = mountShortcuts(t, f);
    const command = f.commands.get("shortcuts")!.handler("", f.ctx);
    const panel = panels[0]!;
    sendShortcut(panel, shortcutEnter);
    await f.emit(event, { reason: "reload" });
    await command;
    sendShortcut(panel, f2Input, shortcutEnter, f2Input, shortcutDel, shortcutDel, shortcutEsc);
    assert.equal(await readFile(f.path, "utf8"), original);
    assert(!f.calls.includes("waitForIdle") && !f.calls.includes("reload"));
  });
}

test("shutdown closes a panel that has already saved without requesting reload", { timeout: 3000 }, async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const panels = mountShortcuts(t, f);
  const command = f.commands.get("shortcuts")!.handler("", f.ctx);
  sendShortcut(panels[0]!, shortcutEnter, f2Input);
  await f.emit("session_shutdown", { reason: "reload" });
  await command;
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).shortcuts, { sidebar: "f2" });
  assert(!f.calls.includes("waitForIdle") && !f.calls.includes("reload"));
});

test("a pending shortcut reload is dropped on session shutdown", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  let idle!: () => void;
  const resume = new Promise<void>(resolve => { idle = resolve; });
  t.mock.method(f.ctx, "waitForIdle", () => resume);
  const pick = f.commands.get("shortcuts")!.handler;
  let data = f2Input;
  driveShortcuts(t, f, panel => sendShortcut(panel, shortcutEnter, data, shortcutEsc));
  const first = pick("", f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  await f.emit("session_shutdown", { reason: "reload" });
  await f.emit("session_start");
  t.mock.method(f.ctx, "waitForIdle", async () => {});
  data = "\x1bOR";
  await pick("", f.ctx);
  idle();
  await first;
  assert.equal(f.calls.filter(call => call === "reload").length, 1);
});

test("panels without successful changes do not write or reload", async t => {
  const text = JSON.stringify({ surfaces: ["sidebar"], shortcuts: { sidebar: "f8" } });
  const f = await fixture(t, text);
  for (const keys of [[shortcutEnter, shortcutEsc], [shortcutEnter, f8Input], [shortcutDel]]) {
    driveShortcuts(t, f, panel => sendShortcut(panel, ...keys, shortcutEsc));
    await f.commands.get("shortcuts")!.handler("", f.ctx);
    assert.equal(await readFile(f.path, "utf8"), text);
    assert(!f.calls.includes("waitForIdle") && !f.calls.includes("reload"));
  }
});

test("a failed shortcut save displays the reason and does not reload", async t => {
  const f = await fixture(t, "invalid JSON");
  driveShortcuts(t, f, panel => {
    sendShortcut(panel, shortcutEnter, f2Input);
    const rows = panel.render(88).join("\n");
    assert.match(rows, /Slate surfaces unavailable: .*invalid JSON/);
    assert.match(rows, /Shortcut\s+Not set/);
    sendShortcut(panel, shortcutEsc);
  });
  await f.commands.get("shortcuts")!.handler("", f.ctx);
  assert.equal(await readFile(f.path, "utf8"), "invalid JSON");
  assert(!f.calls.includes("reload"));
});

test("the Slate menu opens the same shortcuts panel", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  f.choices.push("Shortcuts");
  await f.commands.get("slate")!.handler("", f.ctx);
  assert.match(f.inspected.at(-1)!, /Slate shortcuts/);
  assert(!f.calls.includes("reload"));
});

test("rail omits the command catalog", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  f.extraCommands.push({ name: "hello", source: "extension", sourceInfo: { path: "hello.ts", scope: "user" } });
  await f.emit("agent_settled");
  assert(!railOf(f).render(40).map(unstyled).some(row => row.includes("Commands")));
  assert(!f.calls.includes("branch-git"), "catalog must not execute commands");
});

test("dashboard uses live branch facts", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false, sidebarPercent: 30 }));
  const tui = f.tui; assert(tui instanceof TuiAltScreen);
  (tui.terminal as NullTerminal).rows = 60;
  const rail = () => unstyled((Reflect.get(tui, "layoutRoot") as Component).render(140).join("\n"));
  f.manager.appendSessionInfo("Dashboard test");
  f.manager.appendMessage({ role: "user", content: "hi", timestamp: 0 });
  f.manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, totalTokens: 470, cost: { input: .1, output: .2, cacheRead: .03, cacheWrite: .02, total: .35 } } });
  await f.emit("session_info_changed");
  assert.match(rail(), /Dashboard test/);
  assert.doesNotMatch(rail(), /Unnamed session|Untitled session/);
  assert.ok(rail().includes(f.manager.getSessionId().slice(0, 8)));
  assert.match(railOf(f).sessionDetails(), /Title: Dashboard test/);
  assert.ok(railOf(f).sessionDetails().startsWith(`Session ${f.manager.getSessionId()} · PID ${process.pid}`)); assert.match(rail(), /read +300/); assert.match(rail(), /new +100/);
  assert.doesNotMatch(rail(), /\bsaved\b/i);
  const details = railOf(f).sessionDetails();
  assert.match(details, /Cost: \$0\.35/);
  assert.doesNotMatch(details, /\bsaved\b/i);
  assert(!/Summary|Activity Preview|Context\s*\n/.test(rail()));
  f.extraCommands.push({ name: "skill:review", source: "skill", sourceInfo: { path: "/skills/review/SKILL.md", scope: "user" } });
  await f.emit("message_end", { message: { role: "toolResult", toolName: "codemode", toolCallId: "outer", content: [], isError: false, nestedCalls: { calls: [{ id: "nested-read", name: "read", arguments: { path: "/skills/review/SKILL.md" }, status: "ok" }], complete: true } } });
  assert.match(rail(), /Skills · 1 Loaded/, "nested successful reads update the live rail, not only restoration");
});

test("session titles restore, repaint on rename/clear events, and clear when switching sessions", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  const sidebar = railOf(f);
  const rows = () => sidebar.render(40).map(unstyled);
  t.mock.method(f.tui, "requestRender", () => f.calls.push("title-render"));
  f.manager.appendSessionInfo("自动生成的会话标题");
  await f.emit("session_info_changed", { name: "自动生成的会话标题" });
  assert(rows().some(row => row.includes("自动生成的会话标题")));
  assert.ok(f.calls.includes("title-render"), "rename schedules a repaint without waiting for another turn");
  f.manager.appendSessionInfo("手动固定的标题");
  await f.emit("session_info_changed", { name: "手动固定的标题" });
  assert(rows().some(row => row.includes("手动固定的标题")));
  assert(!rows().some(row => row.includes("自动生成的会话标题")));
  assert.match(sidebar.sessionDetails(), /Title: 手动固定的标题/);

  await f.emit("session_start"); // Reload/resume keeps the stored title.
  assert(rows().some(row => row.includes("手动固定的标题")));
  f.manager.appendSessionInfo("");
  await f.emit("session_info_changed", { name: "" });
  assert.match(rows()[2]!, /^│ Session/, "clearing the stored name restores the Session heading");
  assert.match(sidebar.sessionDetails(), /Title: —/);
  const restored = SessionManager.inMemory(f.ctx.cwd);
  restored.appendSessionInfo("已恢复的标题");
  await f.emit("session_start", {}, { ...f.ctx, sessionManager: restored });
  assert(rows().some(row => row.includes("已恢复的标题")));
  assert(!rows().some(row => row.includes("手动固定的标题")));
  await f.emit("session_start", {}, { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) });
  assert(!rows().some(row => row.includes("已恢复的标题")));
  assert.match(sidebar.sessionDetails(), /Title: —/);
});

test("fold saves merge current preferences and preserve externally corrupted settings", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  await writeFile(f.path, JSON.stringify({ version: 1, surfaces: ["sidebar", "editor"], focused: false, showPid: true, customPreference: "keep" }));
  railOf(f).toggleSection("mcp");
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(saved.surfaces, ["sidebar", "editor"]); assert.equal(saved.focused, false); assert.equal(saved.showPid, true); assert.equal(saved.customPreference, "keep");
  assert.deepEqual(saved.sidebarSections, { mcp: true });
  await writeFile(f.path, "{broken external edit");
  for (let i = 0; i < 2; i++) railOf(f).toggleSection("mcp");
  assert.equal(await readFile(f.path, "utf8"), "{broken external edit"); assert.match(f.notices.join("\n"), /Settings file preserved/);
});

test("a disposed dashboard clock cannot repaint after session replacement", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 }); t.after(() => t.mock.timers.reset());
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  t.mock.method(f.tui, "requestRender", () => f.calls.push("render-request"));
  const next = { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) };
  await f.emit("session_start", {}, next);
  await f.emit("session_shutdown", {}, next);
  const before = f.calls.length; t.mock.timers.tick(10000); assert.equal(f.calls.length, before);
});

test("the prompts fold persists", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  f.extraCommands.push({ name: "retro", source: "prompt", sourceInfo: { path: "retro.md", scope: "user" } });
  await f.emit("agent_settled");
  railOf(f).toggleSection("prompts");
  assert.equal(railOf(f).getFolds().prompts, true);
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(saved.sidebarSections.prompts, true);
});

function railOf(f: Awaited<ReturnType<typeof fixture>>): Sidebar {
  return (Reflect.get(Reflect.get(f.tui, "layoutRoot"), "entries") as Array<{ component: Sidebar }>)[1]!.component;
}

function sidebarReply(): Extract<Parameters<SessionManager["appendMessage"]>[0], { role: "assistant" }> {
  return { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "producer",
    timestamp: Date.now() - 1000, durationMs: 1000, stopReason: "toolUse", content: [{ type: "text", text: "fixture response" }],
    usage: { input: 200, output: 70, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 100, totalTokens: 370,
      cost: { input: .01, output: 0, cacheRead: 0, cacheWrite: 0, total: .01 } } };
}

test("the status hides branch spend when the selected model uses OAuth", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  const model = { id: "fixture", provider: "fixture" };
  const registry = { find: () => undefined, isUsingOAuth: (selected: typeof model) => selected === model };
  f.manager.appendMessage(sidebarReply());
  Object.assign(f.ctx, { model, modelRegistry: registry });
  await f.emit("model_select");
  const sidebar = railOf(f);
  const status = () => unstyled(sidebar.render(44)[1]!);
  assert.doesNotMatch(status(), /\$/);
  assert.match(sidebar.sessionDetails(), /Cost: \$0\.01/);

  Object.assign(f.ctx, { model: { ...model, id: "api-key" } });
  await f.emit("model_select");
  assert.match(status(), /\$0\.01/);
  Object.assign(f.ctx, { model, modelRegistry: { find: registry.find } });
  await f.emit("model_select");
  assert.match(status(), /\$0\.01/, "hosts without the auth type keep reported spend");
});

test("SPEED follows persistence, not token deltas or an unrelated model selection", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] })), reply = sidebarReply();
  const capture = () => unstyled(railOf(f).render(44).join("\n"));
  Object.assign(f.ctx, { isIdle: () => false, modelRegistry: { find: (_: string, id: string) =>
    id === "producer" ? { promptCache: { short: 300, long: 3600 } } : undefined } });
  f.manager.appendMessage(reply);
  await f.emit("agent_start");
  assert.match(capture(), /● Working/); assert.doesNotMatch(capture(), /Working · turn/);
  Object.assign(f.ctx, { model: { id: "virtual", provider: "fixture", promptCache: { short: 30 } } });
  const scans = t.mock.method(f.manager, "getBranch");
  await f.emit("model_select");
  const next = { ...reply, usage: { ...reply.usage, output: 120 } };
  await f.emit("message_start", { message: next });
  const contextReads = t.mock.method(f.ctx, "getContextUsage"); await f.emit("message_update", { message: next });
  assert.equal(scans.mock.callCount() + contextReads.mock.callCount(), 0, "token updates do not rescan context or persisted facts");
  await f.emit("message_end", { message: next });
  assert.match(capture(), /70\.0 tok\/s/);
  f.manager.appendMessage(next);
  await f.emit("tool_execution_start", { toolCallId: "call", toolName: "read", args: {} });
  assert.match(capture(), /│ 120 tok\/s/);
});

test("live MCP activity drives the sidebar spinner and warning, then stops its timer", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  t.after(() => t.mock.timers.reset());
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }), "tui", true, false, async (_pi, _ui, agentDir) => {
    await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{"docs":{"command":"docs"}}}');
  });
  const sidebar = railOf(f);
  sidebar.setFolds({ subagents: false, mcp: true, skills: false, prompts: false });
  const rows = () => sidebar.render(40).map(unstyled).join("\n");
  const ticks = t.mock.method(sidebar, "tick");
  const start = (id: string, context = f.ctx) => f.emit("tool_execution_start", { toolCallId: id, toolName: "mcp__docs__search", args: {} }, context);
  const end = (id: string, extra: Record<string, unknown> = {}, context = f.ctx) => f.emit("tool_execution_end", {
    toolCallId: id, toolName: "mcp__docs__search", result: {}, isError: false, ...extra,
  }, context);

  await start("a");
  assert.match(rows(), /● [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] docs/);
  let count = ticks.mock.callCount();
  t.mock.timers.tick(WAVE_STEP_MS);
  assert.equal(ticks.mock.callCount(), count + 1, "the active MCP timer ticks the sidebar");
  sidebar.setFolds({ subagents: false, mcp: false, skills: false, prompts: false });
  count = ticks.mock.callCount();
  t.mock.timers.tick(WAVE_STEP_MS);
  assert.equal(ticks.mock.callCount(), count, "a folded MCP section stops the timer");
  sidebar.setFolds({ subagents: false, mcp: true, skills: false, prompts: false });
  count = ticks.mock.callCount();
  t.mock.timers.tick(WAVE_STEP_MS);
  assert.equal(ticks.mock.callCount(), count + 1, "expanding restarts the timer while the call is active");
  await end("a", { durationMs: 5 });
  assert.doesNotMatch(rows(), /● (?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|!) docs/, "a success leaves the config row");
  count = ticks.mock.callCount();
  t.mock.timers.tick(WAVE_STEP_MS);
  assert.equal(ticks.mock.callCount(), count, "the timer stops when no calls are active");

  const aborted = { ...f.ctx, signal: AbortSignal.abort() };
  await start("b", aborted);
  await end("b", { durationMs: 5, isError: true }, aborted);
  assert.doesNotMatch(rows(), /● ! docs/, "an abort is not a failure");

  await start("c");
  await end("c", { durationMs: 5, isError: true, result: { content: [{ type: "text", text: "server failed" }] } });
  assert.match(rows(), /● ! docs/, "a real failure warns");
  await start("d");
  await end("d", { durationMs: 5 });
  assert.doesNotMatch(rows(), /● ! docs/, "the next success clears the warning");

  await start("f");
  await f.emit("session_shutdown");
  count = ticks.mock.callCount();
  t.mock.timers.tick(WAVE_STEP_MS);
  assert.equal(ticks.mock.callCount(), count, "session shutdown stops the timer");
});

test("mounted rail keeps the preview and open target", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
  f.manager.appendMessage(sidebarReply()); await f.emit("agent_settled");
  const sidebar = railOf(f), opened: string[] = [];
  const root = Reflect.get(f.tui, "layoutRoot") as Component;
  sidebar.setActions({ copy() {}, openFile: path => opened.push(path) });
  sidebar.setView({ id: "image:fixture", filePath: f.imagePath, title: "Fixture", invalidate() {}, render: () => ["preview-image-body"] });
  for (const rows of [29, 30, 32, 44]) {
    (f.tui.terminal as NullTerminal).rows = rows;
    const frame = root.render(140).join("\n");
    assert.equal(frame.includes("preview-image-body"), rows >= 30, `${rows} rows`);
    if (rows < 30) continue;
    const y = sidebar.render(28).findIndex(line => line.includes("[open]"));
    assert(y >= 0);
    sidebar.handleMouse({ type: "click", button: "left", x: 2, y, width: 28, height: rows, screenX: 114, screenY: y, shift: false, alt: false, ctrl: false });
  }
  assert.deepEqual(opened, Array(3).fill(f.imagePath));
});
test("fold save preserves external sibling state, unknown section keys and unknown nested settings", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"] }));
  await writeFile(f.path, JSON.stringify({ surfaces: ["sidebar"], sidebarSections: { skills: true, future: "keep" }, modelDisplay: { providerSuffix: true, future: "keep" }, unrelated: { nested: true } }));
  railOf(f).toggleSection("mcp");
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(saved.sidebarSections, { skills: true, future: "keep", mcp: true });
  assert.deepEqual(saved.modelDisplay, { providerSuffix: true, future: "keep" }); assert.deepEqual(saved.unrelated, { nested: true });
  assert.deepEqual(railOf(f).getFolds(), { subagents: false, skills: true, mcp: true, prompts: false });
});

test("root yield stops dashboard clock/subscriptions and retained panes cannot repaint", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 }); t.after(() => t.mock.timers.reset());
  const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false })); const sidebar = railOf(f);
  t.mock.method(f.tui, "requestRender", () => f.calls.push("render-request"));
  const successor = new Text("successor", 0, 0); (f.tui as TuiAltScreen).setLayoutRoot(successor);
  assert.equal(sidebar.splitActive, false);
  const before = f.calls.length;
  t.mock.timers.tick(10000);
  sidebar.tick(); sidebar.setHidden(true);
  await f.emit("agent_settled"); assert.equal(f.calls.length, before);
  await f.emit("session_shutdown"); assert.equal(Reflect.get(f.tui, "layoutRoot"), successor);
});

test("retained header and composer remain render-safe while later shutdown handlers await", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["header", "editor", "sidebar"], focused: false }));
  const retained = f.composer!, header = f.header()!;
  await f.emit("session_shutdown");
  assert.doesNotThrow(() => retained.render(100)); assert.deepEqual(header.render(100), []);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.doesNotThrow(() => retained.render(100)); assert.deepEqual(header.render(100), []);
  const next = { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) }; await f.emit("session_start", {}, next);
  assert.doesNotThrow(() => retained.render(100));
});

test("completed turn appends one UI receipt without adding session messages", async (t) => {
  const f = await fixture(t, JSON.stringify({ version: 1, surfaces: ["editor"], focused: true }));
  const start = new Date(2026, 9, 19, 9, 36, 6).getTime();
  let now = start;
  t.mock.method(Date, "now", () => now);
  const count = f.manager.getBranch().length;
  await f.emit("agent_start");
  now += 54000;
  await f.emit("agent_end");
  const receipts = () => f.chat.children.flatMap(child => child.render(100)).filter(line => line.includes("Worked for"));
  assert.deepEqual(receipts(), ["Worked for 54s • 09:37"]);
  assert.equal(f.manager.getBranch().length, count);
  await f.emit("agent_end");
  assert.equal(receipts().length, 1, "duplicate end events do not add receipts");
  await f.emit("agent_start");
  now += 65000;
  await f.emit("agent_end");
  assert.deepEqual(receipts(), ["Worked for 54s • 09:37", "Worked for 1m 5s • 09:38"]);
});

test("retained surfaces and timer callbacks tolerate invalidation before shutdown", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const f = await fixture(t, JSON.stringify({ surfaces: ["header", "editor", "sidebar", "transcript"], focused: false }));
  await f.emit("agent_start");
  t.mock.timers.tick(1000);
  await f.emit("agent_end");
  await f.emit("agent_start");
  const actions = Reflect.get(railOf(f), "actions") as SidebarActions;
  const saved = await readFile(f.path, "utf8"), notices = f.notices.length;
  f.invalidate();
  assert.throws(() => f.ctx.mode, /stale/);
  assert.doesNotThrow(() => {
    f.header()!.render(100);
    f.composer!.render(100);
    f.chat.render(100);
    railOf(f).render(40);
    actions.inspect!("Session", "details");
    actions.copy("text");
    actions.openFile("file.ts");
    actions.persistFold!("mcp", true);
    actions.persistWidth!(30);
    t.mock.timers.tick(10000);
  });
  await f.emit("resources_discover");
  await Promise.resolve();
  assert.equal(f.notices.length, notices);
  assert.equal(await readFile(f.path, "utf8"), saved);
});

test("painted receipts survive real host context invalidation and a fresh session", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "header", "sidebar"], focused: false }));
  const runtime = { getThinkingLevel: () => "off", invalidate() {} } as ConstructorParameters<typeof ExtensionRunner>[1];
  const runner = new ExtensionRunner([], runtime, f.ctx.cwd, f.manager, undefined as never);
  runner.setUIContext(f.ctx.ui, "tui");
  const outgoing = runner.createContext();
  await f.emit("session_start", {}, outgoing);
  await f.emit("agent_start", {}, outgoing);
  await f.emit("agent_end", {}, outgoing);
  const receipt = f.chat.children.at(-1)!;
  assert.match(receipt.render(100).join("\n"), /Worked for/);
  const entries = f.manager.getBranch();

  await f.emit("session_shutdown", { reason: "new" }, outgoing);
  runner.invalidate();
  assert.throws(() => outgoing.ui, /This extension ctx is stale/);
  // Pi may repaint the outgoing chat while the replacement runtime is loading.
  assert.doesNotThrow(() => f.chat.render(100));
  assert.match(receipt.render(100).join("\n"), /Worked for/);

  const incoming = { ...f.ctx, sessionManager: SessionManager.inMemory(f.ctx.cwd) };
  await f.emit("session_start", { reason: "new" }, incoming);
  await f.emit("agent_start", {}, incoming);
  await f.emit("agent_end", {}, incoming);
  assert.doesNotThrow(() => f.chat.render(100));
  assert.deepEqual(f.manager.getBranch(), entries, "receipts are UI objects, not persisted callbacks");
  assert.deepEqual(incoming.sessionManager.getBranch(), [], "a new session has no inherited receipt entries");
});

test("receipt keeps its theme when its first paint occurs after shutdown", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"] }));
  const paint = t.mock.method(theme, "fg", (_color: string, text: string) => text);
  await f.emit("agent_start");
  await f.emit("agent_end");
  const receipt = f.chat.children.at(-1)!;
  await f.emit("session_shutdown");
  f.invalidate();
  const before = paint.mock.callCount();
  assert.match(receipt.render(100).join("\n"), /Worked for/);
  assert.equal(paint.mock.callCount(), before + 1);
});

for (const state of ["live", "invalidated", "replaced"] as const) {
  for (const code of [0, 1]) {
    test(`a failed issue-page open only notifies its live owner: ${state}, code=${code}`, async t => {
      const f = await fixture(t, JSON.stringify({ surfaces: [] }));
      let finish!: (result: { code: number; stdout: string; stderr: string; killed: boolean }) => void;
      t.mock.method(f.pi, "exec", () => new Promise(resolve => { finish = resolve; }));
      const pending = f.commands.get("slate")!.handler("bug", f.ctx);
      if (state === "invalidated") f.invalidate();
      if (state === "replaced") { await f.emit("session_shutdown", { reason: "reload" }); await f.emit("session_start"); }
      const before = f.notices.length;
      finish({ code, stdout: "", stderr: "", killed: false });
      await pending;
      assert.equal(f.notices.length - before, state === "live" && code !== 0 ? 1 : 0);
    });
  }
}

for (const closeHiddenFirst of [false, true]) {
  test(`Pi 1.4 stacked native dialogs restore the Slate composer (hidden first: ${closeHiddenFirst})`, async t => {
    const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "sidebar"], focused: false }));
    const composer = f.composer!, editorContainer = new Container(); editorContainer.addChild(composer);
    composer.setText("draft before dialogs");
    const root = Reflect.get(f.tui, "layoutRoot");
    const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
      ui: f.tui, editor: composer, editorContainer, extensionDialogs: [],
      keybindings: new KeybindingsManager(), programStatus: { setBlocked() {} }, disposeActiveSelector() {},
    });
    const custom = Reflect.get(host, "showExtensionCustom") as ExtensionContext["ui"]["custom"];
    const dialogs = [new Text("first dialog", 0, 0), new Text("second dialog", 0, 0)];
    const close: Array<(value: string) => void> = [];
    const pending = dialogs.map(dialog => custom.call(host, (_tui, _theme, _keys, done) => {
      close.push(done); return dialog;
    }));
    await Promise.resolve();
    assert.deepEqual(editorContainer.children, [dialogs[1]]);
    assert.equal((f.tui as TuiAltScreen).getFocusedComponent(), dialogs[1]);
    const first = closeHiddenFirst ? 0 : 1, remaining = 1 - first;
    close[first]!("first result"); await pending[first];
    assert.deepEqual(editorContainer.children, [dialogs[remaining]]);
    assert.equal((f.tui as TuiAltScreen).getFocusedComponent(), dialogs[remaining]);
    close[remaining]!("second result"); await pending[remaining];
    assert.deepEqual(editorContainer.children, [composer]);
    assert.equal((f.tui as TuiAltScreen).getFocusedComponent(), composer);
    assert.equal(composer.getText(), "draft before dialogs");
    assert.equal(Reflect.get(f.tui, "layoutRoot"), root); assert.equal(railOf(f).splitActive, true);
    assert.doesNotThrow(() => composer.render(100));
  });
}

for (const state of ["live", "invalidated", "replaced"] as const) {
  test(`pending file-open failure only notifies its live owner: ${state}`, async t => {
    const f = await fixture(t, JSON.stringify({ surfaces: ["sidebar"], focused: false }));
    let reject!: (error: Error) => void;
    t.mock.method(f.pi, "exec", () => new Promise((_resolve, fail) => { reject = fail; }));
    const actions = Reflect.get(railOf(f), "actions") as SidebarActions;
    actions.openFile("file.ts");
    if (state === "invalidated") f.invalidate();
    if (state === "replaced") await f.emit("session_start");
    const notices = f.notices.length;
    reject(new Error("open failed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.notices.slice(notices), state === "live" ? ["Could not open file"] : []);
  });
}


test("a missing optional renderer hook uses default cards without startup alarms", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["tool-cards"] }), "tui", true, false, pi => {
    Reflect.set(pi, "registerToolRenderer", undefined);
  });
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(f.tools.map(tool => tool.name).sort(), ["edit", "read", "write"]);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /tool-style: fallback/);
});

test("a throwing sidebar adapter cannot prevent the editor, header or transcript from installing", async t => {
  t.mock.method(Sidebar.prototype, "attach", () => { throw new Error("SECRET private adapter error"); });
  const f = await fixture(t, JSON.stringify({ surfaces: ["header", "editor", "sidebar", "transcript"], focused: false }));
  assert(f.calls.includes("header")); assert(f.calls.includes("editor"));
  assert.equal(f.chat.render(80).length, 100);
  assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  const report = f.inspected.join("\n");
  assert.match(report, /sidebar: fallback.*adapter failed/);
  assert.doesNotMatch(report, /SECRET|private adapter error/);
});

test("a failing optional widget mount preserves the native root and unrelated editor/header surfaces", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["header", "editor", "sidebar"] }), "tui", true, false, (_pi, ui) => {
    ui.setWidget = () => { throw new Error("SECRET widget implementation"); };
  });
  assert(f.calls.includes("editor")); assert(f.calls.includes("header"));
  assert.equal(Reflect.get(f.tui, "layoutRoot"), f.root);
  assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /surface-host: fallback/);
  assert.doesNotMatch(f.inspected.join("\n"), /SECRET/);
});

test("a throwing host catalog does not interrupt setup or leak exception details", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "sidebar"] }), "tui", true, false, pi => {
    pi.getCommands = () => { throw new Error("SECRET command catalog"); };
  });
  assert(f.composer); assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /command-catalog: fallback/);
  assert.doesNotMatch(f.inspected.join("\n"), /SECRET/);
});

test("real MCP file failures remain visible and have actionable on-demand details", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "sidebar"], focused: false }));
  await writeFile(join(dirname(f.path), "mcp.json"), "{broken SECRET");
  await f.emit("message_end", { message: { role: "user", content: "refresh" } });
  assert.match(railOf(f).render(80).join("\n"), /1 Error/);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  const report = f.inspected.join("\n");
  assert.match(report, /MCP config unreadable.*Check global mcp.json/);
  assert.doesNotMatch(report, /SECRET/);
});

test("a Slate header never classifies or deletes host conversation content by its painted text", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["header"] }));
  const exact = new Text("✓ New session started", 1, 1);
  const blank = new Text("", 0, 1);
  f.chat.addChild(blank); f.chat.addChild(exact);
  assert(f.chat.children.includes(exact)); assert(f.chat.children.includes(blank));
});

test("production editor teardown unwinds selection before image adapters", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor"] }));
  const editor = f.composer!;
  editor.insertTextAtCursor(f.imagePath);
  assert.equal(editor.getText(), "[image-1]");
  editor.setText("");
  await f.emit("session_shutdown");
  editor.insertTextAtCursor(f.imagePath);
  assert.equal(editor.getText(), f.imagePath, "a retained disposed editor must not retain image rewrite wrappers");
});

test("a production grouping fault keeps windowing mounted and diagnostics recover", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t, JSON.stringify({ surfaces: ["transcript", "tool-cards"] }));
  let paints = 0;
  const broken = {
    toolCallId: "fault", toolName: "bash", expanded: false, isPartial: false,
    result: { content: {} }, setExpanded() {},
    render() { paints++; return ["native card"]; }, invalidate() {},
  };
  f.chat.addChild(broken);
  assert.equal(f.chat.render(80).length, 100);
  assert.equal(paints, 1);
  assert.equal(f.chat.children.length, 106);
  const installedRender = f.chat.render, installedMouse = f.chat.handleMouse;
  await f.emit("message_end", { message: { role: "user", content: "synchronize" } });
  assert.equal(f.chat.render, installedRender); assert.equal(f.chat.handleMouse, installedMouse);
  assert.equal(f.chat.render(80).length, 100);
  assert.equal(paints, 2);
  assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /tool-groups: fallback/);
  assert.match(f.inspected.join("\n"), /transcript: active/);
  Reflect.set(broken.result, "content", []);
  now += 1_000;
  assert.equal(f.chat.render(80).length, 100);
  await new Promise<void>(resolve => setImmediate(resolve)); // Let the first inspector close.
  f.inspected.length = 0;
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /tool-groups: active/);
});

test("a changed optional command-catalog shape cannot abort unrelated surface setup", async t => {
  const f = await fixture(t, JSON.stringify({ surfaces: ["editor", "sidebar"] }), "tui", true, false, pi => {
    Reflect.set(pi, "getCommands", () => ({ commands: [] }));
  });
  assert(f.composer); assert.deepEqual(f.notifications, []);
  await f.commands.get("slate")!.handler("diagnostics", f.ctx);
  assert.match(f.inspected.join("\n"), /command-catalog: fallback/);
});
