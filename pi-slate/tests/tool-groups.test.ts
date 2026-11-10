import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { ToolGroups } from "../extensions/pi-slate/tool-groups.ts";
import { ChatSurface } from "../extensions/pi-slate/chat-surface.ts";

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
  const surface = new ChatSurface(chat, { groups: new ToolGroups(() => theme, () => "custom+o to expand") });
  return { chat, first, second, surface };
}

test("groups keep child identity, count failures/thoughts, and show configured hint", () => {
  const { chat, first, second, surface } = setup();
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
  surface.dispose();
});

test("expanded members, images, unknown tools, text and narrow terminals break folding", () => {
  for (const boundary of [text("answer"), mockTool("other"), { ...text("image"), ...mockTool(), result: { isError: false, content: [{ type: "image" }] } }]) {
    const { chat, surface } = setup();
    chat.children.splice(1, 0, boundary);
    assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
    surface.dispose();
  }
  const { chat, first, surface } = setup();
  first.expanded = true;
  assert.match(chat.render(80).join("\n"), /expanded output/);
  assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
  first.expanded = false;
  assert.doesNotMatch(chat.render(10).join("\n"), /Done/);
  assert.ok(chat.render(20).every((line) => visibleWidth(line) <= 20));
  surface.dispose();
});

test("mutations fold like any other tool, diff block included", () => {
  for (const name of ["edit", "write"]) {
    const { chat, surface } = setup();
    chat.children.splice(1, 0, mockTool(name));
    const rows = chat.render(80).join("\n");
    assert.match(rows, /Done \(3 tool calls\)/);
    assert.match(rows, /├─ ✓ Bash \(pwd\)/, "members keep their guides");
    surface.dispose();
  }
});

test("groups retain their summary and guides without a theme", () => {
  const chat = new Container();
  chat.addChild(mockTool()); chat.addChild(mockTool());
  const surface = new ChatSurface(chat, { groups: new ToolGroups(() => undefined, () => "expand") });
  const rows = chat.render(80);
  assert.match(rows.join("\n"), /✓ Done \(2 tool calls\) expand/);
  assert.ok(rows.some(row => row.startsWith("├─ ")));
  assert.ok(rows.some(row => row.startsWith("└─ ")));
  surface.dispose();
});

test("native response-length warnings remain a grouping boundary", () => {
  initTheme("dark", false);
  const { chat, surface } = setup();
  const message = new AssistantMessageComponent({ role: "assistant", stopReason: "length", content: [
    { type: "toolCall", id: "a", name: "bash", arguments: { command: "pwd" } },
  ] } as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0], true);
  chat.children.unshift(message);
  assert.match(chat.render(100).join("\n"), /Response was truncated before completion/);
  surface.dispose();
});

test("mouse routing preserves source row coordinates and expansion", () => {
  const { chat, first, second, surface } = setup();
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
  surface.dispose();
});

test("one chat owner updates grouping and windowing without replacing its host methods again", () => {
  const { chat, surface } = setup();
  const render = chat.render, mouse = chat.handleMouse;
  const painter = new ToolGroups(() => theme);
  for (const groupsFirst of [true, false]) {
    surface.update(groupsFirst ? { groups: painter } : { limit: 1 });
    assert.equal(chat.render, render); assert.equal(chat.handleMouse, mouse);
    surface.update({ groups: painter, limit: 1 });
    assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
    surface.update({ groups: painter, limit: 10 });
    assert.match(chat.render(80).join("\n"), /Done/);
    surface.update({ limit: 1 });
    assert.doesNotMatch(chat.render(80).join("\n"), /Done/);
  }
  surface.dispose(); surface.dispose();
  assert.equal(chat.render, Container.prototype.render);
  assert.equal(chat.handleMouse, Container.prototype.handleMouse);
});

test("a grouping painter never patches the host or mutates its canonical children", () => {
  const chat = new Container();
  chat.addChild(mockTool()); chat.addChild(mockTool());
  const original = [...chat.children];
  const painter = new ToolGroups(() => undefined);
  assert.match(painter.render(chat.children, 80).join("\n"), /Done/);
  assert.equal(chat.render, Container.prototype.render);
  assert.equal(chat.handleMouse, Container.prototype.handleMouse);
  assert.deepEqual(chat.children, original);
});

test("grouping metadata faults retain the window and paint selected native children only once", () => {
  const chat = new Container(), broken = mockTool();
  let paints = 0, faults = 0;
  const render = broken.render.bind(broken);
  broken.render = width => { paints++; return render(width); };
  chat.addChild(new Text("hidden older message", 0, 0)); chat.addChild(broken);
  let groups: ToolGroups | undefined = new ToolGroups(() => undefined);
  const onGroupingFault = () => { faults++; groups = undefined; };
  const surface = new ChatSurface(chat, { limit: 1, groups, onGroupingFault });
  Reflect.set(broken.result, "content", {});
  assert.doesNotMatch(chat.render(80).join("\n"), /hidden older message/);
  assert.equal(paints, 1, "the faulting frame paints the selected native child only once");
  assert.equal(faults, 1);
  surface.update({ limit: 1, groups, onGroupingFault });
  assert.doesNotMatch(chat.render(80).join("\n"), /hidden older message/);
  assert.equal(faults, 1, "synchronization does not retry a quarantined painter");
  assert.equal(chat.children.length, 2);
  surface.dispose();
});
