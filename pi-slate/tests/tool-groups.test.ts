import assert from "node:assert/strict";
import test from "node:test";
import { Container, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { ToolGroups } from "../extensions/pi-slate/tool-groups.ts";
import { MessageWindow } from "../extensions/pi-slate/message-window.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
function mockTool(name = "bash") {
  return {
    toolName: name, toolCallId: String(Math.random()), expanded: false, isPartial: false,
    result: { isError: false, content: [] as Array<{ type: string }> }, clicks: [] as TuiMouseEvent[],
    render(width: number) { return this.expanded ? ["", "expanded output".slice(0, width)] : ["", "✓ Bash (pwd)", "  └ 1 line"]; },
    invalidate() {}, setExpanded(value: boolean) { this.expanded = value; },
    handleMouse(event: TuiMouseEvent) { this.clicks.push(event); this.setExpanded(!this.expanded); return { handled: true as const }; },
  };
}
const text = (value: string): Component => ({ render: () => [value], invalidate() {} });
function setup() {
  const chat = new Container();
  const first = mockTool(), second = mockTool();
  chat.addChild(first); chat.addChild(second);
  const groups = new ToolGroups(chat, () => theme, () => "custom+o to expand");
  return { chat, first, second, groups };
}

test("groups keep child identity, count failures/thoughts, and show configured hint", () => {
  const { chat, first, second, groups } = setup();
  const overrides = new Map<number, boolean>();
  const thought = { ...text("hidden thought"), hideThinkingBlock: true, thinkingVisibilityOverrides: overrides, lastMessage: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "bash" }] } };
  chat.children.splice(1, 0, thought);
  second.result.isError = true;
  const rows = chat.render(80);
  assert.match(rows.join("\n"), /Done \(2 tool calls · 1 thought · 1 failed\) custom\+o/);
  assert.ok(!rows.join("\n").includes("hidden thought"));
  assert.deepEqual(chat.children, [first, thought, second]);
  overrides.set(0, false);
  assert.match(chat.render(80).join("\n"), /hidden thought/, "a revealed per-run thought must break groups");
  assert.doesNotMatch(chat.render(80).join("\n"), /Done|Running/);
  overrides.clear();
  first.isPartial = true;
  assert.match(chat.render(80).join("\n"), /Running/);
  thought.hideThinkingBlock = false;
  assert.match(chat.render(80).join("\n"), /hidden thought/, "Ctrl+T must reveal native thinking");
  assert.doesNotMatch(chat.render(80).join("\n"), /Done|Running/);
  groups.dispose();
});

test("expanded members, images, unknown tools, text and narrow terminals break folding", () => {
  for (const boundary of [text("answer"), mockTool("other"), { ...text("image"), ...mockTool(), result: { isError: false, content: [{ type: "image" }] } }]) {
    const { chat, groups } = setup();
    chat.children.splice(1, 0, boundary);
    assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
    groups.dispose();
  }
  const { chat, first, groups } = setup();
  first.expanded = true;
  assert.match(chat.render(80).join("\n"), /expanded output/);
  assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
  first.expanded = false;
  assert.doesNotMatch(chat.render(10).join("\n"), /Done/);
  assert.ok(chat.render(20).every((line) => visibleWidth(line) <= 20));
  groups.dispose();
});

test("mutations fold like any other tool, diff block included", () => {
  for (const name of ["edit", "write"]) {
    const { chat, groups } = setup();
    chat.children.splice(1, 0, mockTool(name));
    const rows = chat.render(80).join("\n");
    assert.match(rows, /Done \(3 tool calls\)/);
    assert.match(rows, /├─ ✓ Bash \(pwd\)/, "members keep their guides");
    groups.dispose();
  }
});

test("groups retain their summary and guides without a theme", () => {
  const chat = new Container();
  chat.addChild(mockTool()); chat.addChild(mockTool());
  const groups = new ToolGroups(chat, () => undefined, () => "expand");
  const rows = chat.render(80);
  assert.match(rows.join("\n"), /✓ Done \(2 tool calls\) expand/);
  assert.ok(rows.some(row => row.startsWith("├─ ")));
  assert.ok(rows.some(row => row.startsWith("└─ ")));
  groups.dispose();
});

test("native response-length warnings remain a grouping boundary", () => {
  initTheme("dark", false);
  const { chat, groups } = setup();
  const message = new AssistantMessageComponent({ role: "assistant", stopReason: "length", content: [
    { type: "toolCall", id: "a", name: "bash", arguments: { command: "pwd" } },
  ] } as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0], true);
  chat.children.unshift(message);
  assert.match(chat.render(100).join("\n"), /Response was truncated before completion/);
  groups.dispose();
});

test("mouse routing preserves source row coordinates and expansion", () => {
  const { chat, first, second, groups } = setup();
  chat.render(80);
  const event = { type: "click", button: "left", x: 6, y: 2, height: 6, width: 80 } as TuiMouseEvent;
  assert.equal(chat.handleMouse(event)?.handled, true);
  assert.equal(first.clicks[0]!.y, 1);
  assert.equal(first.clicks[0]!.x, 3);
  assert.equal(first.expanded, true);
  assert.equal(second.expanded, false);
  chat.render(80);
  chat.handleMouse({ ...event, y: 1 });
  assert.equal(first.clicks[1]!.x, 6);
  groups.dispose();
});

test("cleanup restores only owned methods, composes with message window, no global patches", () => {
  const { chat, groups } = setup();
  const other = new Container();
  assert.notEqual(chat.render, other.render);
  const window = new MessageWindow(chat, 1);
  assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
  window.setLimit(10);
  assert.match(chat.render(80).join("\n"), /Done/);
  window.dispose();
  groups.dispose(); groups.dispose();
  assert.equal(chat.render, other.render);
  assert.equal(chat.handleMouse, other.handleMouse);
  const next = setup();
  const successor = () => ["successor"];
  next.chat.render = successor;
  next.groups.dispose();
  assert.equal(next.chat.render, successor);
});
