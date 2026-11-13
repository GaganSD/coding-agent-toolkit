// Real-host integration probe. Invoked in a fresh, isolated subprocess by host-compat.test.mjs.
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
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
await writeFile(join(root, "mcp.json"), '\uFEFF{"mcpServers":{"fixture":{"type":"future-transport","enabled":true}}}');
const modeName = process.env.SLATE_COMPAT_MODE;
const fault = process.env.SLATE_COMPAT_FAULT;
const settingsManager = host.SettingsManager.inMemory({ quietStartup: true, tuiMode: modeName, theme: "dark" });
const model = { id: "compatibility-only", name: "Compatibility only", provider: "compatibility", api: "openai-responses", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
const chunks = [], errors = [];
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
  const assertMounted = phase => {
    // Test-only observation of the genuine host tree; production never imports interactive internals.
    const ui = Reflect.get(mode, "ui");
    const render = () => (ui.layoutRoot ? ui.layoutRoot.render(140) : ui.render(140)).map(stripVTControlCharacters).join("\n");
    const frame = render();
    assert.deepEqual(errors, []); assert.deepEqual(runtime.diagnostics, []);
    assert(runtime.session.extensionRunner.getRegisteredCommands().some(command => command.name === "slate"));
    if (modeName === "fullscreen" && selected.includes("sidebar")) {
      assert.equal(ui.layoutRoot.constructor.name, "SidebarSplit", `${phase}: sidebar lease must actually mount`);
      if (surfaces !== "fresh") assert.match(frame, /MCP · 1 Enabled/);
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
  assertMounted("startup");
  await runtime.newSession();
  assertMounted("replacement");
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
