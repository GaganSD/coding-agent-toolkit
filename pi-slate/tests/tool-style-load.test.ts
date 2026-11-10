import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createReadToolDefinition, discoverAndLoadExtensions, initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ToolGroups } from "../extensions/pi-slate/tool-groups.ts";
import { ChatSurface } from "../extensions/pi-slate/chat-surface.ts";

test("default style loads locally and host preserves expansion, padding, mouse and restored results", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "slate-tool-host-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, "pi-slate.json"), JSON.stringify({ version: 1, surfaces: ["tool-cards"] }));
  const entry = new URL("../extensions/pi-slate/index.ts", import.meta.url).pathname;
  const loaded = await discoverAndLoadExtensions([entry], dir, dir);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]!;
  t.after(async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, { mode: "print" }); });
  assert.deepEqual([...extension.tools.keys()].sort(), ["edit", "write"]);
  assert.equal(extension.toolRenderers?.length, 1);
  const resolver = extension.toolRenderers![0]!;
  const native = createReadToolDefinition(dir);
  const original = { renderCall: native.renderCall, renderResult: native.renderResult } as ToolRenderers;
  const styled = resolver("read", () => original)!;
  initTheme("dark", false);
  const ui = { requestRender() {} } as TUI;
  const chat = new Container();
  const tools = [0, 1].map((i) => {
    const host = new ToolExecutionComponent("read", `read-${i}`, { path: "demo.txt" }, { outputPad: 0 }, styled, ui, dir);
    host.setArgsComplete(); host.markExecutionStarted();
    host.updateResult(JSON.parse(JSON.stringify({ content: [{ type: "text", text: "unique full body\nsecond row" }], isError: false, durationMs: 0 })));
    chat.addChild(host); return host;
  });
  const surface = new ChatSurface(chat, { groups: new ToolGroups(() => theme) });
  t.after(() => surface.dispose());
  const plain = () => chat.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(plain(), /Done \(2 tool calls\)/);
  assert.match(plain(), /2 lines · 0ms/);
  const row = chat.render(80).findIndex((line) => stripVTControlCharacters(line).includes("Read"));
  assert.equal(chat.handleMouse({ type: "click", button: "left", x: 10, y: row, screenX: 10, screenY: row, width: 80, height: 20 } as TuiMouseEvent)?.handled, true);
  assert.match(plain(), /unique full body/);
  assert.doesNotMatch(plain(), /Done \(/);
  for (let i = 0; i < 3; i++) {
    for (const host of tools) host.setExpanded(false);
    assert.match(plain(), /Done \(/);
    for (const host of tools) host.setExpanded(true);
    assert.match(plain(), /unique full body/);
  }
  for (const width of [10, 30, 80]) for (const row of chat.render(width)) assert.ok(visibleWidth(row) <= width);
  for (const host of tools) { host.setExpanded(false); host.setOutputPad(3); }
  assert.match(plain(), /Done \(/);
});
