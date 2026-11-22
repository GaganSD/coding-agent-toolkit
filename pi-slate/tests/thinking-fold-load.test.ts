import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { discoverAndLoadExtensions, type ExtensionContext, type ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, type TUI } from "@earendil-works/pi-tui";
import { WORKING_WORDS } from "../extensions/pi-slate/working-words.ts";
import { HIDDEN_THINKING_LABEL } from "../extensions/pi-slate/thinking-label.ts";
import { HiddenThinkingLabel } from "../extensions/pi-slate/hidden-thinking-label.ts";

test("loaded Slate wires thinking timing only in TUI and never rewrites native thinking labels", { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-slate-thinking-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  t.after(() => t.mock.timers.reset());
  const entry = join(dirname(fileURLToPath(import.meta.url)), "../extensions/pi-slate/index.ts");
  const loaded = await discoverAndLoadExtensions([entry], cwd, join(cwd, "agent"));
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]!;
  const labels: Array<string | undefined> = [];
  let staleUi = false;
  const noop = () => {};
  const ui = {
    theme: { italic: (text: string) => text },
    setWorkingMessage(label?: string) {
      if (staleUi) throw new Error("stale UI context");
      labels.push(label);
    },
    setHiddenThinkingLabel() { assert.fail("must not relabel native historical or streaming thoughts"); },
    setHeader: noop, setFooter: noop, setEditorComponent: noop, setWorkingIndicator: noop,
  };
  const ctx = { cwd, mode: "tui", ui } as unknown as ExtensionContext;
  const emit = async (type: ExtensionEvent["type"], extra: Record<string, unknown> = {}, context = ctx) => {
    for (const handler of extension.handlers.get(type) ?? []) {
      await handler({ type, ...extra } as ExtensionEvent, context);
    }
  };
  t.after(() => emit("session_shutdown", {}, { mode: "print" } as ExtensionContext));
  const message = { role: "assistant", timestamp: 0, content: [{ type: "thinking", thinking: "secret reasoning" }] };
  const update = (type: string) => emit("message_update", { message, assistantMessageEvent: { type, contentIndex: 0 } });
  await emit("agent_start");
  const word = labels.at(-1)!;
  assert.ok(WORKING_WORDS.some((item) => item === word));
  await emit("message_start", { message });
  await update("thinking_start");
  t.mock.timers.tick(7000);
  assert.match(labels.at(-1)!, new RegExp(`^${word} · 7s · ↑↓\\d+$`));
  await update("thinking_end");
  assert.equal(labels.at(-1), word);
  const stopped = labels.length;
  t.mock.timers.tick(3000);
  assert.equal(labels.length, stopped);

  for (const boundary of ["message_end", "agent_end"] as const) {
    await update("thinking_start");
    t.mock.timers.tick(1000);
    assert.match(labels.at(-1)!, / · 1s/);
    await emit(boundary, { message });
    assert.equal(labels.at(-1), word);
    const count = labels.length;
    t.mock.timers.tick(3000);
    assert.equal(labels.length, count);
  }

  for (const mode of ["print", "rpc", "json"] as const) {
    const context = { ...ctx, mode } as unknown as ExtensionContext;
    const count = labels.length;
    await emit("agent_start", {}, context);
    await emit("message_start", { message }, context);
    await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, context);
    t.mock.timers.tick(2000);
    await emit("message_end", { message }, context);
    assert.equal(labels.length, count, `no UI changes in ${mode}`);
  }

  await emit("agent_start", {}, { ...ctx, ui: { ...ui, setWorkingMessage: undefined } } as unknown as ExtensionContext);
  await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
    { ...ctx, ui: { ...ui, setWorkingMessage: undefined } } as unknown as ExtensionContext);
  assert.equal(message.content[0]!.thinking, "secret reasoning");
  await emit("agent_start");
  await update("thinking_start");
  staleUi = true;
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  staleUi = false;
  const staleCount = labels.length;
  t.mock.timers.tick(3000);
  assert.equal(labels.length, staleCount, "stale UI stops its timer");
  await emit("agent_start");
  await update("thinking_start");
  await emit("session_shutdown");
  const shutdownCount = labels.length;
  t.mock.timers.tick(3000);
  assert.equal(labels.length, shutdownCount);
  await emit("session_shutdown");
  await emit("agent_start");
  const nextWord = labels.at(-1)!;
  assert.ok(WORKING_WORDS.some((item) => item === nextWord));
  await emit("message_start", { message });
  await update("thinking_start");
  t.mock.timers.tick(1000);
  assert.match(labels.at(-1)!, new RegExp(`^${nextWord} · 1s`));
});

async function transcriptFixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-slate-transcript-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agent = join(cwd, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "pi-slate.json"), JSON.stringify({ version: 1, surfaces: ["transcript", "tool-cards"] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const entry = join(dirname(fileURLToPath(import.meta.url)), "../extensions/pi-slate/index.ts");
  const loaded = await discoverAndLoadExtensions([entry], cwd, agent);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]!;
  const context = (ui: object) => ({ cwd, mode: "tui", ui, isIdle: () => true }) as unknown as ExtensionContext;
  const emit = async (type: ExtensionEvent["type"], ctx: ExtensionContext, extra: Record<string, unknown> = {}) => {
    for (const handler of extension.handlers.get(type) ?? []) await handler({ type, ...extra } as ExtensionEvent, ctx);
  };
  const host = () => {
    const chat = new Container();
    const tui = {
      [Symbol.for("@earendil-works/pi-tui/viewport")]: true,
      layoutRoot: new ScrollView(chat, { primary: true }),
      requestRender() {},
    } as unknown as TUI;
    const theme = { fg: (_tone: string, text: string) => text, italic: (text: string) => text };
    let widget: ((tui: TUI, theme: unknown) => void) | undefined;
    const mount = () => widget?.(tui, theme);
    const ui = {
      theme,
      setHiddenThinkingLabel: undefined as ((label?: string) => void) | undefined,
      setWidget(_name: string, factory: typeof widget) { widget = factory; mount(); },
    };
    return { chat, ui, mount, ctx: context(ui) };
  };
  t.after(() => emit("session_shutdown", context({})));
  return { host, emit };
}

test("hidden label retries throwing or missing setters and clears the mounted owner across install and shutdown", async (t) => {
  const { emit, host } = await transcriptFixture(t);
  const old = host(), next = host(), unrelated = host();
  const writes: Array<[string, string | undefined]> = [];
  let blockSet = true, blockClear = true;
  old.ui.setHiddenThinkingLabel = (label) => {
    if (label === undefined ? blockClear : blockSet) throw new Error("temporary UI failure");
    writes.push(["old", label]);
  };
  unrelated.ui.setHiddenThinkingLabel = (label) => writes.push(["unrelated", label]);

  await emit("session_start", old.ctx);
  assert.equal(writes.length, 0);
  blockSet = false;
  old.mount();
  await Promise.resolve();
  assert.deepEqual(writes, [["old", HIDDEN_THINKING_LABEL]]);
  old.mount();
  await Promise.resolve();
  assert.equal(writes.length, 1, "a successful write is not repeated");

  await emit("session_start", next.ctx);
  assert.equal(writes.length, 1, "missing new setter and failed old clear are both harmless");
  blockClear = false;
  next.ui.setHiddenThinkingLabel = (label) => writes.push(["next", label]);
  next.mount();
  await Promise.resolve();
  assert.deepEqual(writes.slice(1), [["old", undefined], ["next", HIDDEN_THINKING_LABEL]]);

  let blockReplacementClear = true;
  const replacement = { ...next.ctx, ui: { ...next.ui, setHiddenThinkingLabel(label?: string) {
    if (label === undefined && blockReplacementClear) throw new Error("UI is temporarily unavailable");
    writes.push(["replacement", label]);
  } } } as unknown as ExtensionContext;
  await emit("message_end", replacement, { message: { role: "assistant" } });
  assert.deepEqual(writes.slice(3), [["next", undefined], ["replacement", HIDDEN_THINKING_LABEL]]);
  await emit("session_shutdown", unrelated.ctx);
  assert.equal(writes.length, 5, "shutdown does not write to the unrelated UI");
  blockReplacementClear = false;
  await emit("session_shutdown", unrelated.ctx);
  assert.deepEqual(writes.slice(5), [["replacement", undefined]]);
});

test("hidden label teardown leaves a successor on the same UI in place", () => {
  const writes: Array<string | undefined> = [];
  const ui = { setHiddenThinkingLabel: (label?: string) => writes.push(label) };
  const previous = new HiddenThinkingLabel(), next = new HiddenThinkingLabel();
  previous.sync(ui, HIDDEN_THINKING_LABEL);
  next.sync(ui, HIDDEN_THINKING_LABEL);
  previous.sync(undefined);
  assert.deepEqual(writes, [HIDDEN_THINKING_LABEL, HIDDEN_THINKING_LABEL]);
  next.sync(undefined);
  assert.equal(writes.at(-1), undefined);
});

test("the grouped chat retries collapsed thinking decoration after a missing or throwing theme", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const { emit, host } = await transcriptFixture(t);
  const { chat, ui, ctx } = host();
  await emit("session_start", ctx);
  const message = { role: "assistant", content: [{ type: "thinking", thinking: "first run" }] };
  const thought = { lastMessage: message, hideThinkingBlock: true, invalidate() {}, render: (width: number) => ["Thought".padEnd(width)] };
  chat.addChild(thought);
  const style = ui.theme;
  const complete = async (thinking: string, seconds: number) => {
    message.content = [{ type: "thinking", thinking }];
    const update = (type: string) => emit("message_update", ctx, { message, assistantMessageEvent: { type, contentIndex: 0 } });
    await update("thinking_start");
    t.mock.timers.tick(seconds * 1000);
    await update("thinking_end");
  };
  for (const [thinking, seconds, theme] of [
    ["first run", 4, undefined],
    ["second run", 5, { ...style, italic() { throw new Error("theme unavailable"); } }],
  ] as const) {
    // Use a new message identity, as Pi does for historical components.
    thought.lastMessage = { ...message, content: [{ type: "thinking", thinking }] };
    await complete(thinking, seconds);
    Object.assign(ui, { theme });
    assert.equal(chat.render(60).join("").trim(), "Thought");
    ui.theme = style;
    assert.equal(chat.render(60).join("").trim(), `Thought for ${seconds}s`);
    assert.strictEqual(chat.render(60), chat.render(60), "the recovered group frame is cached");
  }
});
