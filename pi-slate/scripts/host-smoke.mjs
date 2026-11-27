// Real-host integration probe. Invoked in a fresh, isolated subprocess by host-compat.test.mjs.
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const root = process.env.PI_CODING_AGENT_DIR;
assert(root && process.env.PI_OFFLINE === "1", "host smoke requires an isolated, offline agent directory");
let networkRequests = 0;
const denyNetwork = () => { networkRequests++; throw new Error("Network is forbidden during host execution"); };
globalThis.fetch = async () => denyNetwork();
http.request = http.get = https.request = https.get = denyNetwork;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = denyNetwork;
syncBuiltinESMExports();
const hostEntry = process.env.SLATE_COMPAT_HOST_ENTRY;
assert(hostEntry, "Expected an explicit host entrypoint");
const host = await import(pathToFileURL(hostEntry).href);
const tui = await import(pathToFileURL(createRequire(hostEntry).resolve("@earendil-works/pi-tui")).href);
assert.equal(host.VERSION, process.env.SLATE_COMPAT_VERSION, "the selected host must actually be the one executing Slate");
assert.equal(await realpath(host.getPackageDir()), await realpath(process.env.SLATE_COMPAT_HOST_DIR));
const surfaces = process.env.SLATE_COMPAT_SURFACES;
const selected = surfaces === "fresh" ? ["editor", "sidebar", "tool-cards"] : JSON.parse(surfaces);
const configPath = join(root, "pi-slate.json");
const config = surfaces === "fresh" ? undefined : JSON.stringify({ version: 1, surfaces: selected, focused: false });
if (config !== undefined) await writeFile(configPath, config);
const mcpPath = join(root, "mcp.json");
const initialMcp = '\uFEFF{"mcpServers":{"fixture":{"type":"future-transport","enabled":true}}}';
await writeFile(mcpPath, initialMcp);
const modeName = process.env.SLATE_COMPAT_MODE;
const fault = process.env.SLATE_COMPAT_FAULT;
const thinkingClick = process.env.SLATE_COMPAT_THINKING_CLICK === "1";
const settingsManager = host.SettingsManager.inMemory({
  quietStartup: true, tuiMode: modeName, theme: "dark", hideThinkingBlock: thinkingClick, fullscreenCopyOnSelect: false,
});
const model = { id: "compatibility-only", name: "Compatibility only", provider: "compatibility", api: "compatibility-quiet", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const quietTurn = !fault && selected.includes("editor") && selected.includes("header");
const reply = Promise.withResolvers();
const finishProjectionTurn = Promise.withResolvers();
const chunks = [], errors = [];
const fixturePath = join(root, "thinking-fixture.txt");
if (thinkingClick) await writeFile(fixturePath, "Offline tool result\n");
const insideThought = "Reasoning inside the tool group.";
const outsideThought = "Reasoning outside the tool group.";
function assistantMessage(content, stopReason) {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason,
    timestamp: Date.now(), usage: { ...model.cost, totalTokens: 0, cost: { ...model.cost, total: 0 } } };
}
async function streamThoughtFixture(stream, step) {
  const message = assistantMessage([], step < 2 ? "toolUse" : "stop");
  const push = event => stream.push({ ...event, partial: { ...message, content: message.content.slice() } });
  push({ type: "start" });
  if (step === 3) await finishProjectionTurn.promise;
  const thought = step === 1 ? insideThought : step === 2 ? outsideThought : undefined;
  if (thought) {
    message.content.push({ type: "thinking", thinking: "" });
    push({ type: "thinking_start", contentIndex: 0 });
    await delay(25);
    message.content[0] = { type: "thinking", thinking: thought };
    push({ type: "thinking_delta", contentIndex: 0, delta: thought });
  }
  if (step < 2) {
    for (let i = 0; i < 2; i++) {
      // Exercise actual host tool components and a collapsed group on either side of the thought.
      message.content.push({ type: "toolCall", id: `click-fixture-${step}-${i}`, name: "read", arguments: { path: fixturePath } });
      push({ type: "toolcall_start", contentIndex: message.content.length - 1 });
    }
  } else {
    message.content.push({ type: "text", text: "Offline thinking fixture complete." });
    const contentIndex = message.content.length - 1;
    push({ type: "text_delta", contentIndex, delta: message.content[contentIndex].text });
  }
  // Mirror Chat Completions: the thinking end arrives after text/tool output starts.
  if (thought) push({ type: "thinking_end", contentIndex: 0, content: thought });
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();
}
const fixturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5AAAAABJRU5ErkJggg==", "base64");
function withThemeGetter(hostUi, get, run) {
  const theme = Object.getOwnPropertyDescriptor(hostUi, "theme");
  Object.defineProperty(hostUi, "theme", { configurable: true, get });
  try { return run(); }
  finally { Object.defineProperty(hostUi, "theme", theme); }
}
async function waitForWrite(from, pattern, description, timeout = 2000) {
  const until = performance.now() + timeout;
  do {
    const text = chunks.slice(from).join("");
    if (pattern.test(stripVTControlCharacters(text))) return text;
    await delay(10);
  } while (performance.now() < until);
  assert.fail(description);
}
let mode, runtime, workingUi, input;
const terminal = {
  columns: 140, rows: 40, kittyProtocolActive: false,
  start(onInput) {
    input = onInput;
    if (fault === "transcript") {
      // A foreign render owner must cause a quiet fallback, but must not fool the positive canary.
      const chat = Reflect.get(mode, "chatContainer"), render = chat.render;
      chat.render = width => render.call(chat, width);
    }
  },
  stop() {}, async drainInput() {}, write(text) { chunks.push(text); },
  moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
  setTitle() {}, setProgress() {}, setProgramStatus() {},
};
try {
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const extensionFactories = [];
    if (fault === "quit-shutdown") extensionFactories.push(pi => pi.on("session_shutdown", event => {
      if (event.reason === "quit") throw new Error("Injected quit-only shutdown fault");
    }));
    if (quietTurn) extensionFactories.push(pi => pi.on("session_start", (_event, ctx) => { workingUi = ctx.ui; }));
    const services = await host.createAgentSessionServices({ cwd, agentDir: root, settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: [join(process.env.SLATE_COMPAT_PACKAGE, "extensions/pi-slate/index.ts")], noSkills: true, noPromptTemplates: true,
        extensionFactories,
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    assert(loaded.extensions.some(extension => extension.path.endsWith("extensions/pi-slate/index.ts")), "the probe must actually load Slate, not boot an empty native host");
    assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.warnings ?? [], []);
    if (quietTurn || thinkingClick) {
      let step = 0;
      const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl, apiKey: "offline-fixture", models: [model],
        streamSimple() {
          const stream = createAssistantMessageEventStream();
          if (thinkingClick) void streamThoughtFixture(stream, step++);
          else void reply.promise.then(() => {
            const message = assistantMessage([{ type: "text", text: "Offline reply" }], "stop");
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          });
          return stream;
        },
      });
    }
    const result = await host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
    result.session.extensionRunner.onError(error => errors.push(error));
    return { ...result, services, diagnostics: services.diagnostics };
  };
  runtime = await host.createAgentSessionRuntime(createRuntime, { cwd: root, agentDir: root, sessionManager: host.SessionManager.inMemory(root) });
  mode = new host.InteractiveMode(runtime, { terminal, tuiMode: modeName });
  await mode.init();
  const assertMounted = async phase => {
    // Test-only observation of the genuine host tree; production never imports interactive internals.
    const ui = Reflect.get(mode, "ui");
    const render = () => (ui.layoutRoot ? ui.layoutRoot.render(140) : ui.render(140)).map(stripVTControlCharacters).join("\n");
    const frame = render();
    assert.deepEqual(errors, []); assert.deepEqual(runtime.diagnostics, []);
    assert(runtime.session.extensionRunner.getRegisteredCommands().some(command => command.name === "slate"));
    if (modeName === "fullscreen" && selected.includes("sidebar")) {
      assert.equal(ui.layoutRoot.constructor.name, "SidebarSplit", `${phase}: sidebar lease must actually mount`);
      if (surfaces !== "fresh") assert.match(frame, /MCP · 1 Enabled/);
      const sidebar = Reflect.get(ui.layoutRoot, "pane");
      const chat = Reflect.get(mode, "chatContainer"), originalRender = chat.render;
      let paints = 0;
      chat.render = width => { paints++; return originalRender.call(chat, width); };
      try {
        sidebar.setHidden(false);
        ui.renderNow(true);
        assert(paints > 0, "a content frame must render the chat");
        paints = 0;
        const before = chunks.length;
        sidebar.setSession({ ...Reflect.get(sidebar, "session"), name: `probe-${phase}` });
        await waitForWrite(before, /probe-/, "the scheduled sidebar change did not reach the terminal");
        assert.equal(paints > 0, typeof ui.requestViewRender !== "function", "view-only hosts must reuse the transcript");
      } finally { chat.render = originalRender; }
    }
    const editor = Reflect.get(mode, "editor");
    if (selected.includes("editor")) {
      assert.equal(editor.constructor.name, "ComposerEditor", `${phase}: editor factory must actually mount`);
      editor.setText("draft preserved through rendering"); render();
      assert.equal(editor.getText(), "draft preserved through rendering");
    } else assert.notEqual(editor.constructor.name, "ComposerEditor");
    if (modeName === "fullscreen" && selected.includes("transcript")) {
      const chat = Reflect.get(mode, "chatContainer");
      const markers = Array.from({ length: 105 }, (_, i) => new tui.Text(`${phase}-compatibility-message-${String(i).padStart(3, "0")}`, 0, 0));
      markers.forEach(marker => chat.addChild(marker));
      const painted = chat.render(140).map(stripVTControlCharacters).join("\n");
      assert(!painted.includes(`${phase}-compatibility-message-000`), `${phase}: transcript window did not mount`);
      assert(painted.includes(`${phase}-compatibility-message-104`));
      assert(markers.every(marker => chat.children.includes(marker)), "windowing must preserve all canonical host children");
    }
    assert.doesNotMatch(chunks.join("") + frame, /Slate (?:sidebar|transcript|Claude Code).*unavailable|MCP configuration validation unavailable|1 Warning|Extension error/i);
  };
  const ui = Reflect.get(mode, "ui");
  if (thinkingClick) {
    await runtime.session.prompt("Exercise click-to-toggle thinking");
    const chat = Reflect.get(mode, "chatContainer");
    const lines = () => ui.currentLayout.lines.map(stripVTControlCharacters);
    const pointFor = pattern => {
      const rows = lines(), row = rows.findIndex(line => pattern.test(line));
      assert(row >= 0, `${pattern} must be in the committed Pi frame:\n${rows.join("\n")}`);
      const { index } = rows[row].match(pattern);
      return { x: tui.visibleWidth(rows[row].slice(0, index)) + 1, y: row + 1 };
    };
    const mouse = ({ x, y }, suffix) => input(`\x1b[<0;${x};${y}${suffix}`);
    const click = pattern => {
      const point = pointFor(pattern);
      mouse(point, "M");
      mouse(point, "m");
      ui.renderNow(true);
    };
    const frame = () => lines().join("\n");
    const collapsed = /(?<=^│ +)Thought(?: for \d+s)?\b/;
    const group = /Done \(4 tool calls\)/;
    const assertSplit = () => {
      assert.match(frame(), /Reasoning inside the tool group\./);
      assert.equal(lines().filter(line => /Done \(2 tool calls\)/.test(line)).length, 2,
        `expanding thinking should split, not disable, tool grouping:\n${frame()}`);
    };
    ui.renderNow(true);
    assert.match(frame(), group);
    click(group);
    click(group);
    assert.equal(ui.getActiveSelectionText(), "Done", "double-clicking the group summary must preserve Pi's selection for copy");
    click(collapsed);
    assertSplit();
    click(/Reasoning inside the tool group\./);
    assert.match(frame(), group);

    // Induce a one-frame presentation fault only once the real click opens the run.
    const assistant = chat.children.find(child => child.lastMessage?.content?.[0]?.thinking === insideThought);
    const overrides = assistant.thinkingVisibilityOverrides;
    let faults = 0;
    overrides.values = function () {
      if (this.get(0) === false && faults === 0) {
        faults++;
        throw new Error("Injected transient grouping metadata fault after a thinking click");
      }
      return Map.prototype.values.call(this);
    };
    try {
      click(collapsed);
      assert.equal(faults, 1);
      assert.match(frame(), /Reasoning inside the tool group\./, "the faulting frame must fall back with the click applied");
      assert.doesNotMatch(frame(), /Done \(\d+ tool calls\)/);
      ui.renderNow(true);
      assertSplit();
    } finally { delete overrides.values; }
    click(/Reasoning inside the tool group\./);
    assert.match(frame(), group);
    assert.equal(lines().filter(line => /Thought for \d+s/.test(line)).length, 2,
      "both collapsed runs retain their live durations after interleaved updates and click round trips");
    const standaloneLabel = /(?<=^ )Thought for \d+s/;
    const tools = chat.children.filter(child => child.toolCallId);
    assert.equal(tools.length, 4);
    // Exercise a separate fault after the short failure window has expired.
    await delay(1_050);
    // Press on the fallback frame, but let grouping recover before release.
    overrides.values = () => { throw new Error("Injected grouping fault before press"); };
    try { ui.renderNow(true); }
    finally { delete overrides.values; }
    assert.doesNotMatch(frame(), group);
    const fallbackPoint = pointFor(standaloneLabel);
    fallbackPoint.x += 4; // Click the label itself, beyond the recovered group's tree gutter.
    mouse(fallbackPoint, "M");
    ui.renderNow(true);
    assert.match(frame(), group);
    assert.match(lines()[fallbackPoint.y - 1], /Read|└ 1 line/, "grouping moves a tool under the pressed cell");
    mouse(fallbackPoint, "m");
    ui.renderNow(true);
    assert.deepEqual(tools.map(tool => tool.expanded), [false, false, false, false], "recovery must not expand a tool under a pressed Thought");
    assert.equal(overrides.get(0), true, "the obsolete press must not toggle the thought either");
    assert.match(frame(), group);

    // The standalone (not tree-prefixed) thinking run uses Pi's native mouse region too.
    click(standaloneLabel);
    assert.match(frame(), /Reasoning outside the tool group\./);
    assert.match(frame(), group);
    click(/Reasoning outside the tool group\./);
    assert.doesNotMatch(frame(), /Reasoning outside the tool group\./);
    assert.match(frame(), group);

    const standalone = chat.children.find(child => child.lastMessage?.content?.[0]?.thinking === outsideThought);
    const state = () => [overrides.get(0), standalone.thinkingVisibilityOverrides.get(0), ...tools.map(tool => tool.expanded)];
    assert.deepEqual(state(), [true, true, false, false, false, false]);
    chat.addChild(new tui.Text(Array.from({ length: 54 }, (_, i) => `Transcript tail ${i}`).join("\n"), 0, 0));
    const started = Promise.withResolvers();
    const unsubscribe = runtime.session.subscribe(event => {
      if (event.type === "message_start" && event.message.role === "assistant") started.resolve();
    });
    const turn = runtime.session.prompt("Finish a turn while scrolled up");
    try {
      await Promise.race([started.promise, turn.then(() => assert.fail("the projection fixture did not stream"))]);
      // While busy Slate paints every child. On idle, the completion receipt pushes this
      // two-row first child off the 100-child window, moving a tool under the pressed cell.
      const oldHistory = [new tui.Text("Trimmed history row 1\nTrimmed history row 2", 0, 0)];
      while (chat.children.length + oldHistory.length < 100) oldHistory.push(new tui.Text("Older history", 0, 0));
      chat.children.unshift(...oldHistory);
      ui.renderNow(true);
      const wheelUp = () => { input("\x1b[<64;20;15M"); ui.renderNow(true); };
      for (let i = 0; i < 70 && lines().findIndex(line => group.test(line)) < 4; i++) wheelUp();
      const scroll = ui.currentLayout.primaryScrollView;
      assert(scroll.scrollTop > 0 && !scroll.isFollowingEnd, "the click must occur in a scrolled viewport");
      assert.match(ui.previousScreen.map(stripVTControlCharacters).join("\n"), /Jump to latest message/);
      const point = pointFor(collapsed), scrollTop = scroll.scrollTop;
      mouse(point, "M");
      finishProjectionTurn.resolve();
      await turn;
      ui.renderNow(true);
      assert.equal(scroll.scrollTop, scrollTop, "the projection must move the rows, not scroll the viewport");
      assert.match(lines()[point.y - 1], /└ 1 line/, "the old screen cell now belongs to a tool result");
      mouse(point, "m");
      ui.renderNow(true);
      assert.deepEqual(state(), [true, true, false, false, false, false], "a release across the window change must not toggle another row");
      assert.match(frame(), group);

      click(collapsed);
      assert.deepEqual(state(), [false, true, false, false, false, false]);
      assertSplit();
      click(/Reasoning inside the tool group\./);
      click(standaloneLabel);
      assert.deepEqual(state(), [true, false, false, false, false, false]);
      assert.match(frame(), group);
      click(/Reasoning outside the tool group\./);
      assert.deepEqual(state(), [true, true, false, false, false, false]);
    } finally {
      unsubscribe();
      finishProjectionTurn.resolve();
      await turn;
    }
  }
  await assertMounted("startup");
  if (!fault && modeName === "fullscreen" && selected.includes("header") && selected.includes("sidebar")) {
    const runner = runtime.session.extensionRunner;
    const hostUi = runner.getUIContext();
    const theme = Object.getOwnPropertyDescriptor(hostUi, "theme");
    let themeFaults = 0;
    Object.defineProperty(hostUi, "theme", { configurable: true, get() {
      Object.defineProperty(hostUi, "theme", theme);
      themeFaults++;
      throw new Error("Injected resource refresh theme fault");
    } });
    try {
      await runner.emitResourcesDiscover(root, "reload");
      await delay(0); // Let the deferred refresh run outside the extension event handler.
      assert.equal(themeFaults, 1, "the deferred sidebar refresh must hit the one-shot theme fault");
      assert.deepEqual(errors, []);
      await writeFile(mcpPath, '{"mcpServers":{"recovered":{"type":"future-transport"},"second":{"type":"future-transport"}}}');
      const before = chunks.length;
      await runner.emitResourcesDiscover(root, "reload");
      await waitForWrite(before, /MCP · 2 Enabled/, "the next resource discovery must repaint after the fault");
    } finally {
      Object.defineProperty(hostUi, "theme", theme);
      await writeFile(mcpPath, initialMcp);
      await runner.emitResourcesDiscover(root, "reload");
    }
  }
  if (!fault && modeName === "fullscreen" && selected.includes("header") && selected.includes("editor") && selected.includes("sidebar")) {
    const sidebar = Reflect.get(ui.layoutRoot, "pane");
    const editor = Reflect.get(mode, "editor");
    const hostUi = runtime.session.extensionRunner.getUIContext();
    const image = join(root, "preview-fault.png");
    await writeFile(image, fixturePng);
    const drop = () => { editor.setText(""); editor.handleInput(`"${image}"`); };
    drop();
    const requireTheme = sidebar.requireTheme;
    let themeFaults = 0;
    sidebar.requireTheme = function () {
      return withThemeGetter(hostUi, () => {
        themeFaults++;
        throw new Error("Injected delayed image preview theme fault");
      }, () => requireTheme.call(this));
    };
    try {
      await waitForWrite(chunks.length, /\[image-1\]/, "a failed preview must not stop the rewritten token from painting");
      assert.equal(themeFaults, 1, "the delayed preview must hit the throwing host theme getter");
      assert.equal(editor.getText(), "[image-1]");
      assert.equal(sidebar.currentViewId(), undefined, "a failed preview must not mount a sidebar view");
    } finally { sidebar.requireTheme = requireTheme; }
    const beforeRetry = chunks.length;
    drop();
    await waitForWrite(beforeRetry, /Preview/, "a later image drop must preview after the theme recovers");
    assert.equal(sidebar.currentViewId(), `image:1:${image}`);
  }
  if (!fault && modeName === "fullscreen" && typeof ui.requestViewRender === "function" && selected.includes("header") && selected.includes("editor") && selected.includes("sidebar")) {
    const sidebar = Reflect.get(ui.layoutRoot, "pane");
    const editor = Reflect.get(mode, "editor");
    const image = join(root, "compat-drop.png");
    await writeFile(image, fixturePng);
    for (const hidden of [false, true]) {
      sidebar.setHidden(hidden);
      editor.setText("");
      editor.handleInput(`"${image}"`);
      const rawFrame = chunks.length;
      ui.renderNow(true);
      assert.match(stripVTControlCharacters(chunks.slice(rawFrame).join("")), /compat-drop\.png/);
      await waitForWrite(chunks.length, /\[image-1\]/, "the delayed rewrite must repaint the composer without another keystroke");
      assert.equal(editor.getText(), "[image-1]");
    }

    const runner = runtime.session.extensionRunner;
    const hostUi = runner.getUIContext();
    const tick = sidebar.tick;
    const tickFaulted = Promise.withResolvers();
    sidebar.setHidden(false);
    sidebar.tick = function () {
      return withThemeGetter(hostUi, () => {
        tickFaulted.resolve();
        throw new Error("Injected dashboard tick theme fault");
      }, () => tick.call(this));
    };
    const waitForTick = new AbortController();
    try {
      await Promise.race([
        tickFaulted.promise,
        delay(3500, undefined, { signal: waitForTick.signal }).then(() => assert.fail("the dashboard tick must hit the throwing theme getter")),
      ]);
    } finally {
      waitForTick.abort();
      sidebar.tick = tick;
      sidebar.setHidden(true);
    }

    const before = chunks.length;
    await writeFile(mcpPath, '{"mcpServers":{"fixture":{"type":"future-transport"},"second":{"type":"future-transport"}}}');
    await waitForWrite(before, /2 mcp/, "dashboard polling must refresh the catalog and repaint after a failed tick", 6500);
    const needsContextRepaint = editor.needsContextRepaint;
    let checks = 0;
    editor.needsContextRepaint = function () {
      if (++checks === 1) throw new Error("Injected focused composer border fault");
      return needsContextRepaint.call(this);
    };
    try {
      await writeFile(mcpPath, initialMcp);
      const retryFrame = chunks.length;
      await runner.emitResourcesDiscover(root, "reload");
      assert.equal(checks, 1, "the changed label must hit the one-shot fault");
      await runner.emitResourcesDiscover(root, "reload");
      assert.equal(checks, 2, "an identical label must retry the failed check");
      await waitForWrite(retryFrame, /1 mcp/, "the retried focused metadata must reach the terminal");
      await runner.emitResourcesDiscover(root, "reload");
      assert.equal(checks, 2, "a successful check deduplicates subsequent identical labels");
    } finally { editor.needsContextRepaint = needsContextRepaint; }
  }
  if (!fault && modeName === "fullscreen" && selected.includes("header") && selected.includes("sidebar")) {
    const sidebar = Reflect.get(ui.layoutRoot, "pane");
    const actions = Reflect.get(sidebar, "actions"), resources = Reflect.get(sidebar, "resources"), folds = sidebar.getFolds();
    const inspected = [];
    const catalog = (name, source = "global") => ({ ...resources, mcp: [{ name, enabled: true, source, transport: "stdio" }] });
    const clickServer = name => {
      const frame = ui.currentLayout;
      const row = frame.lines.findIndex(line => line.includes(name));
      assert(row >= 0, `${name} must be in Pi's committed frame`);
      const { x } = frame.root.children[1].rect;
      ui.dispatchMouseToLayout({ type: "click", button: "left", x: x + 3, y: row, screenX: x + 3, screenY: row });
    };
    sidebar.setActions({ ...actions, inspect: (title, detail) => inspected.push({ title, detail }) });
    sidebar.setHidden(false);
    sidebar.setFolds({ ...folds, mcp: true });
    sidebar.setResources(catalog("OLD-server"));
    ui.renderNow(true);
    const requestRender = ui.requestRender, requestViewRender = ui.requestViewRender;
    try {
      let failed = 0;
      const failRender = () => { failed++; throw new Error("Injected sidebar scheduler fault"); };
      ui.requestRender = failRender;
      if (typeof requestViewRender === "function") ui.requestViewRender = failRender;
      sidebar.setResources(catalog("NEW-server"));
      assert(failed > 0);
      clickServer("OLD-server");
      assert.equal(inspected.at(-1)?.title, "OLD-server", "an unpainted candidate must not take over clicks");
    } finally {
      ui.requestRender = requestRender;
      if (typeof requestViewRender === "function") ui.requestViewRender = requestViewRender;
    }
    const before = chunks.length;
    sidebar.tick();
    await waitForWrite(before, /NEW-server/, "the recovered scheduler must paint the replacement sidebar row");
    clickServer("NEW-server");
    assert.equal(inspected.at(-1)?.title, "NEW-server");
    sidebar.setResources(catalog("NEW-server", "project"));
    clickServer("NEW-server");
    assert.match(inspected.at(-1)?.detail, /Source: project/, "identical painted rows can update their details immediately");
    sidebar.setActions(actions);
    sidebar.setResources(resources);
    sidebar.setFolds(folds);
  }
  if (!fault && modeName === "fullscreen" && selected.length === 1 && selected[0] === "editor") {
    const editor = Reflect.get(mode, "editor");
    const image = join(root, "retry-drop.png");
    await writeFile(image, fixturePng);
    // Do not let the host's deferred syntax-language repaint consume the
    // image-path fault that this case is about.
    const syntax = await import(pathToFileURL(join(process.env.SLATE_COMPAT_HOST_DIR, "dist/utils/syntax-highlight.js")).href);
    await syntax.loadAllHighlightLanguages();
    editor.setText("");
    editor.handleInput(`"${image}"`);
    ui.renderNow(true);
    const frame = () => ui.currentLayout.lines.map(stripVTControlCharacters).join("\n");
    assert.match(frame(), /retry-drop\.png/);
    const requestRender = ui.requestRender;
    const attempts = [];
    try {
      ui.requestRender = (force = false) => { attempts.push(force); throw new Error("Injected image scheduler fault"); };
      await delay(100);
      assert.equal(editor.getText(), "[image-1]");
      assert.deepEqual(attempts.slice(0, 2), [false, true], "both content request paths must fail during the rewrite");
      assert.match(frame(), /retry-drop\.png/, "the failed scheduler leaves the raw path painted");
    } finally { ui.requestRender = requestRender; }
    await waitForWrite(chunks.length, /\[image-1\]/, "the pending rewrite must repaint after scheduler recovery without another keystroke");
  }
  if (quietTurn) {
    // Run through Pi's normal turn lifecycle; the offline provider emits nothing until released.
    const before = chunks.length;
    const turn = runtime.session.prompt("Wait for the offline reply");
    void turn.catch(() => {}); // Observe any rejection before waiting for terminal output.
    try {
      const wave = /[▁-█]{7}/;
      const frame = await waitForWrite(before, wave, "the real turn must paint a working wave");
      assert.equal(Reflect.get(mode, "activeStatusIndicator")?.kind, "working", "Pi must install its own indicator");
      const firstWave = stripVTControlCharacters(frame).match(wave)[0];
      await waitForWrite(chunks.length, new RegExp(`(?!${firstWave})[▁-█]{7}`), "the wave must animate while the provider is quiet");
      const editor = Reflect.get(mode, "editor");
      const statusLine = () => stripVTControlCharacters(editor.render(80)[0]);
      workingUi.setWorkingMessage("Offline working");
      workingUi.setWorkingVisible(false);
      assert.doesNotMatch(statusLine(), /Offline working|[▁-█]{7}/, "a hidden indicator must not leave a frozen wave");
      workingUi.setWorkingIndicator({ frames: [] });
      workingUi.setWorkingVisible(true);
      assert.match(statusLine(), /Offline working/, "an empty frame list keeps Pi's static status text");
      assert.doesNotMatch(statusLine(), wave);
      workingUi.setWorkingIndicator({ frames: ["STATIC"] });
      assert.match(statusLine(), /STATIC Offline working/, "a one-frame indicator stays native");
      assert.doesNotMatch(statusLine(), wave);
      workingUi.setWorkingIndicator(undefined);
      assert.match(statusLine(), wave, "restoring Pi's default frames restores the wave");
      assert(runtime.session.isStreaming, "the provider must still be waiting");
    } finally { reply.resolve(); await turn; }
  }
  await runtime.newSession();
  await assertMounted("replacement");
  mode.stop(); mode = undefined;
  await runtime.dispose(); runtime = undefined;
  assert.deepEqual(errors, [], "final shutdown handlers must also complete without extension errors");
  assert.equal(networkRequests, 0);
  const { readFile } = await import("node:fs/promises");
  if (config === undefined) await assert.rejects(readFile(configPath), { code: "ENOENT" });
  else assert.equal(await readFile(configPath, "utf8"), config, "fallbacks and startup must not rewrite preferences");
  console.log(JSON.stringify({ host: host.VERSION, mode: modeName, surfaces, mounted: true, rendered: true, replaced: true, shutdown: true, quietTurn, thinkingClick, networkRequests }));
} finally {
  mode?.stop();
  await runtime?.dispose();
}
