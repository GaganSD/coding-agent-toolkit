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
const settingsManager = host.SettingsManager.inMemory({ quietStartup: true, tuiMode: modeName, theme: "dark" });
const model = { id: "compatibility-only", name: "Compatibility only", provider: "compatibility", api: "openai-responses", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const chunks = [], errors = [];
async function waitForWrite(from, pattern, description, timeout = 2000) {
  const until = performance.now() + timeout;
  do {
    const text = chunks.slice(from).join("");
    if (pattern.test(stripVTControlCharacters(text))) return text;
    await delay(10);
  } while (performance.now() < until);
  assert.fail(description);
}
let mode, runtime;
const terminal = {
  columns: 140, rows: 40, kittyProtocolActive: false,
  start() {
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
    const services = await host.createAgentSessionServices({ cwd, agentDir: root, settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: [join(process.env.SLATE_COMPAT_PACKAGE, "extensions/pi-slate/index.ts")], noSkills: true, noPromptTemplates: true,
        extensionFactories: fault === "quit-shutdown" ? [pi => pi.on("session_shutdown", event => { if (event.reason === "quit") throw new Error("Injected quit-only shutdown fault"); })] : [],
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    assert(loaded.extensions.some(extension => extension.path.endsWith("extensions/pi-slate/index.ts")), "the probe must actually load Slate, not boot an empty native host");
    assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.warnings ?? [], []);
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
        sidebar.setTasks([{ id: phase, label: `probe-task-${phase}`, source: "compat", kind: "shell", state: "running", startedAt: Date.now() }]);
        await waitForWrite(before, /probe-task/, "the scheduled sidebar change did not reach the terminal");
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
  await assertMounted("startup");
  const ui = Reflect.get(mode, "ui");
  if (!fault && modeName === "fullscreen" && typeof ui.requestViewRender === "function" && selected.includes("header") && selected.includes("editor") && selected.includes("sidebar")) {
    const sidebar = Reflect.get(ui.layoutRoot, "pane");
    const editor = Reflect.get(mode, "editor");
    const image = join(root, "compat-drop.png");
    await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5AAAAABJRU5ErkJggg==", "base64"));
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

    let before = chunks.length;
    await writeFile(mcpPath, '{"mcpServers":{"fixture":{"type":"future-transport"},"second":{"type":"future-transport"}}}');
    await waitForWrite(before, /2 mcp/, "the next resource poll must repaint the focused composer", 6500);
    await writeFile(mcpPath, initialMcp);

    const chat = Reflect.get(mode, "chatContainer"), originalRender = chat.render;
    let paints = 0;
    chat.render = width => { paints++; return originalRender.call(chat, width); };
    try {
      await runtime.session.extensionRunner.emit({ type: "agent_start" });
      ui.renderNow(true);
      paints = 0;
      before = chunks.length;
      await waitForWrite(before, /[▁-█]{7}/, "the quiet composer must be repainted through the scheduler");
      assert(paints > 0, "the quiet fallback uses a public content render");

      const dock = Reflect.get(mode, "editorContainer");
      dock.clear(); dock.addChild(new tui.Text("borrowed composer dock"));
      try {
        ui.renderNow(true);
        paints = 0;
        await delay(520);
        assert.equal(paints, 0, "a dialog borrowing the editor dock must not trigger cosmetic renders");
      } finally { dock.clear(); dock.addChild(editor); }
      await waitForWrite(chunks.length, /[▁-█]{7}/, "the quiet fallback must resume when the composer returns");
      await runtime.session.extensionRunner.emit({ type: "agent_end", messages: [] });
    } finally { chat.render = originalRender; }
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
  console.log(JSON.stringify({ host: host.VERSION, mode: modeName, surfaces, mounted: true, rendered: true, replaced: true, shutdown: true, networkRequests }));
} finally {
  mode?.stop();
  await runtime?.dispose();
}
