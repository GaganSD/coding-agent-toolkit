import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
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

test("groups count failures and running tools, and show the configured hint", (t) => {
  const { chat, first, second, surface } = setup();
  t.after(() => surface.dispose());
  second.result.isError = true;
  assert.match(chat.render(80).join("\n"), /Done \(2 tool calls · 1 failed\) custom\+o/);
  first.isPartial = true;
  assert.match(chat.render(80).join("\n"), /Running \(2 tool calls · 1 failed\)/);
});

const bashCall = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command: "pwd" } });
const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });
initTheme("dark", false);
type AssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
const assistant = (content: AssistantMessage["content"], label?: string) =>
  new AssistantMessageComponent({ role: "assistant", stopReason: "toolUse", content } as AssistantMessage, true, undefined, label);

function thoughtFrame(chat: Container) {
  const width = 80, rows = chat.render(width).map(stripVTControlCharacters);
  return {
    text: rows.join("\n"),
    click(label: string, occurrence = 0) {
      const y = rows.map((row, i) => row.includes(label) ? i : -1).filter(i => i >= 0)[occurrence];
      assert.notEqual(y, undefined, `missing click target: ${label}`);
      assert.equal(chat.handleMouse({ type: "click", button: "left", x: 5, y, screenX: 17, screenY: y + 4, width, height: rows.length, shift: false, alt: false, ctrl: false })?.handled, true);
    },
  };
}

test("grouped native thinking rows stay in order and toggle independently", (t) => {
  const { chat, first, second, surface } = setup();
  t.after(() => surface.dispose());
  const beforeFirst = assistant([thinking("first thought body"), thinking("same run"), bashCall(first.toolCallId)]);
  const beforeSecond = assistant([thinking("second thought body"), bashCall(second.toolCallId)], "Custom thinking label");
  chat.children.splice(0, 2, beforeFirst, first, beforeSecond, second);
  const paint = () => thoughtFrame(chat);
  const grouped = paint().text;
  assert.match(grouped, /Done \(2 tool calls\)/);
  assert.match(grouped, /Thinking\.\.\.[\s\S]*├─ ✓ Bash[\s\S]*Custom thinking label[\s\S]*└─ ✓ Bash/);
  assert.equal(grouped.match(/Thinking\.\.\./g)?.length, 1, "adjacent thinking blocks share one native run");
  assert.doesNotMatch(grouped, /thought body|same run/);
  assert.equal(grouped.replace(/ +$/gm, ""), [
    "", "✓ Done (2 tool calls) custom+o to expand",
    "│   Thinking...", "├─ ✓ Bash (pwd)", "│    └ 1 line",
    "│   Custom thinking label", "└─ ✓ Bash (pwd)", "     └ 1 line",
  ].join("\n"));

  paint().click("Thinking...");
  assert.match(paint().text, /first thought body[\s\S]*same run[\s\S]*Done \(2 tool calls\)[\s\S]*Custom thinking label/);
  assert.doesNotMatch(paint().text, /second thought body/);
  paint().click("first thought body");
  assert.equal(paint().text, grouped);

  paint().click("Custom thinking label");
  assert.match(paint().text, /Thinking\.\.\.[\s\S]*second thought body/);
  assert.doesNotMatch(paint().text, /first thought body|Done \(/);
  paint().click("second thought body");
  assert.equal(paint().text, grouped);
  assert.deepEqual(chat.children, [beforeFirst, first, beforeSecond, second]);
  assert.equal(first.clicks.length + second.clicks.length, 0);

  paint().click("└─ ✓ Bash");
  assert.equal(first.expanded, false);
  assert.equal(second.expanded, true);
  const { x, y, width } = second.clicks[0]!;
  assert.deepEqual({ x, y, width }, { x: 2, y: 1, width: 77 });
  second.setExpanded(false);
  assert.equal(paint().text, grouped);

  beforeFirst.setHideThinkingBlock(false);
  beforeSecond.setHideThinkingBlock(false);
  assert.match(paint().text, /first thought body[\s\S]*second thought body/);
  assert.doesNotMatch(paint().text, /Done \(/);
});

test("separate thinking runs in one grouped assistant message have separate native toggles", (t) => {
  const { chat, first, second, surface } = setup();
  t.after(() => surface.dispose());
  chat.children.unshift(assistant([
    thinking("first run"), bashCall(first.toolCallId), thinking("second run"), bashCall(second.toolCallId),
  ]));
  const grouped = thoughtFrame(chat).text;
  assert.match(grouped, /Done \(2 tool calls\)[\s\S]*Thinking\.\.\.[\s\S]*Thinking\.\.\./);
  for (const [index, revealed, hidden] of [[0, "first run", "second run"], [1, "second run", "first run"]] as const) {
    thoughtFrame(chat).click("Thinking...", index);
    const opened = thoughtFrame(chat);
    assert.ok(opened.text.includes(revealed));
    assert.ok(!opened.text.includes(hidden));
    assert.equal(opened.text.match(/Thinking\.\.\./g)?.length, 1);
    opened.click(revealed);
    assert.equal(thoughtFrame(chat).text, grouped);
  }
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
  const { chat, surface } = setup();
  const message = new AssistantMessageComponent({ role: "assistant", stopReason: "length", content: [bashCall("a")] } as unknown as AssistantMessage, true);
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

test("group paint reuses output but rebuilds row owners on width, content and identity changes", () => {
  const first = mockTool(), second = mockTool(), replacement = mockTool();
  const painter = new ToolGroups(() => undefined, () => "expand");
  const firstFrame = painter.render([first, second], 80);
  assert.equal(painter.render([first, second], 80), firstFrame);
  const narrow = painter.render([first, second], 18);
  assert.notEqual(narrow, firstFrame);
  assert.ok(narrow.every(line => visibleWidth(line) <= 18));
  first.render = () => ["", "", "new", "extra"];
  const changed = painter.render([first, second], 18);
  assert.deepEqual(changed.slice(2, 4), ["├─ new", "│  extra"]);
  assert.equal(painter.render([first, second], 18), changed);
  assert.deepEqual(painter.render([first, replacement], 18), changed);
  const event = { type: "click", button: "left", x: 4, y: 4, width: 18, height: changed.length } as TuiMouseEvent;
  assert.equal(painter.handleMouse(event)?.handled, true);
  assert.equal(second.clicks.length, 0);
  assert.equal(replacement.clicks[0]?.y, 1);
  assert.equal(replacement.clicks[0]?.width, 15);
});

test("mutable grouped and native rows update the paint and shift hit ownership", () => {
  for (const grouped of [true, false]) {
    const first = mockTool(), second = mockTool();
    first.expanded = !grouped;
    const rows = ["first"];
    first.render = () => rows;
    const painter = new ToolGroups(() => undefined, () => "expand");
    const render = () => painter.render([first, second], 80);
    const initial = render();
    rows[0] = "changed";
    assert.match(render().join("\n"), /changed/);
    rows.push("more");
    const grown = render();
    const grownY = grown.findIndex(row => row.includes("Bash"));
    assert.match(grown[grownY - (grouped ? 1 : 2)]!, /more/);
    rows.length = 1;
    const shrunk = render();
    const shrunkY = shrunk.findIndex(row => row.includes("Bash"));
    assert.equal(shrunkY, grownY - 1);
    assert.doesNotMatch(shrunk.join("\n"), /more/);
    assert.match(initial.join("\n"), /first/);
    const event = { type: "click", button: "left", x: 5, y: shrunkY, width: 80, height: shrunk.length } as TuiMouseEvent;
    assert.equal(painter.handleMouse(event)?.handled, true);
    assert.equal(first.clicks.length, 0);
    assert.equal(second.clicks[0]?.y, 1);
  }
});

test("wheel reaches a grouped tool at its local coordinates", () => {
  const { chat, first, surface } = setup();
  chat.render(80);
  first.handleMouse = event => {
    first.clicks.push(event);
    return { handled: true };
  };
  const event = { type: "wheel", button: "none", wheelDelta: 1, x: 8, screenX: 8, y: 2, screenY: 2, width: 80, height: 6 } as TuiMouseEvent;
  assert.equal(chat.handleMouse(event)?.target.component, first);
  assert.deepEqual([first.clicks[0]?.x, first.clicks[0]?.y, first.clicks[0]?.width], [5, 1, 77]);
  surface.dispose();
});

test("a zero-row window shift preserves a click on the same painted thinking row", (t) => {
  const chat = new Container();
  const first = mockTool(), second = mockTool();
  const thought = assistant([thinking("same painted owner"), bashCall(second.toolCallId)]);
  chat.children = [new Container(), first, thought, second];
  let active = true;
  const surface = new ChatSurface(chat, { limit: 3, active: () => active,
    groups: new ToolGroups(() => theme, () => "expand") });
  t.after(() => surface.dispose());
  const rows = chat.render(80);
  const y = rows.findIndex(row => row.includes("Thinking..."));
  assert(y >= 0);
  const event = { type: "press", button: "left", x: 6, y, screenX: 6, screenY: y,
    width: 80, height: rows.length, shift: false, alt: false, ctrl: false } as const;
  chat.handleMouse(event);
  active = false;
  assert.deepEqual(chat.render(80), rows);
  assert.equal(chat.handleMouse({ ...event, type: "click" })?.handled, true);
  assert.match(chat.render(80).join("\n"), /same painted owner/);
  assert.equal(first.expanded || second.expanded, false);
});

test("a click cannot move to another local row of the same native component", (t) => {
  const chat = new Container();
  let prefixVisible = true, renders = 0;
  const clicks: number[] = [];
  chat.addChild({ render: () => prefixVisible ? ["prefix"] : [], invalidate() {} });
  chat.addChild({
    render() { renders++; return ["first target", "second target"]; }, invalidate() {},
    handleMouse(event) { if (event.type === "click") clicks.push(event.y); },
  });
  const surface = new ChatSurface(chat, {});
  t.after(() => surface.dispose());
  assert.deepEqual(chat.render(80), ["prefix", "first target", "second target"]);
  const event = { type: "press", button: "left", x: 6, y: 1, screenX: 6, screenY: 1,
    width: 80, height: 3, shift: false, alt: false, ctrl: false } as const;
  chat.handleMouse(event);
  prefixVisible = false;
  assert.deepEqual(chat.render(80), ["first target", "second target"]);
  chat.handleMouse({ ...event, type: "click", height: 2 });
  assert.deepEqual(clicks, [], "a different source row of the same child must not be activated");
  assert.equal(renders, 2, "hit testing reuses the painted layout");
});

test("a persistent late grouping fault backs off, then recovers on a content render", (t) => {
  let now = 0, attempts = 0, ordinaryRenders = 0;
  t.mock.method(performance, "now", () => now);
  const chat = new Container(), states: boolean[] = [];
  chat.children = Array.from({ length: 999 }, () => ({
    render() { ordinaryRenders++; return ["ordinary row"]; }, invalidate() {},
  }));
  chat.children.push(mockTool(), mockTool());
  let broken = true;
  const groups = new ToolGroups(() => theme, () => {
    attempts++;
    if (broken) throw new Error("Late group hint failure");
    return "expand";
  });
  const surface = new ChatSurface(chat, { groups, onGroupingFaultChange: faulted => states.push(faulted) });
  t.after(() => surface.dispose());
  assert.doesNotMatch(chat.render(80).join("\n"), /Done \(/);
  assert.doesNotMatch(chat.render(80).join("\n"), /Done \(/);
  assert.equal(attempts, 2, "a transient fault still gets an immediate retry");
  ordinaryRenders = 0;
  assert.doesNotMatch(chat.render(80).join("\n"), /Done \(/);
  assert.equal(ordinaryRenders, 999, "during cooldown only the native frame paints");
  assert.equal(attempts, 2);
  assert.deepEqual(states, [true]);
  now += 1_000;
  assert.doesNotMatch(chat.render(80).join("\n"), /Done \(/);
  assert.equal(attempts, 3);
  broken = false;
  now += 1_000;
  assert.match(chat.render(80).join("\n"), /Done \(2 tool calls\)/);
  assert.deepEqual(states, [true, false]);
});

test("one successful frame does not reset the grouping fault window", (t) => {
  let now = 0, attempts = 0;
  t.mock.method(performance, "now", () => now);
  const chat = new Container();
  chat.children = [mockTool(), mockTool()];
  const groups = new ToolGroups(() => theme, () => {
    if (++attempts % 2 === 1) throw new Error("Intermittent group hint failure");
    return "expand";
  });
  const surface = new ChatSurface(chat, { groups });
  t.after(() => surface.dispose());
  const grouped = () => chat.render(80).some(row => row.includes("Done (2 tool calls)"));
  assert.equal(grouped(), false);
  now += 2;
  assert.equal(grouped(), true, "the first fault is retried immediately");
  now += 2;
  assert.equal(grouped(), false);
  for (let i = 0; i < 5; i++) {
    now += 2;
    assert.equal(grouped(), false, "a second recent fault holds the native frame during cooldown");
  }
  assert.equal(attempts, 3);
  now += 1_001;
  assert.equal(grouped(), true, "a natural content render retries after cooldown");
  assert.equal(grouped(), false);
  assert.equal(grouped(), true, "a fault outside the old window again gets an immediate retry");
});

test("grouping metadata faults retain the window and paint selected native children only once", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const chat = new Container(), broken = mockTool(), normal = new Text("visible normal message", 0, 0);
  let paints = 0, normalPaints = 0;
  const states: boolean[] = [];
  const render = broken.render.bind(broken);
  broken.render = width => { paints++; return render(width); };
  const renderNormal = normal.render.bind(normal);
  normal.render = width => { normalPaints++; return renderNormal(width); };
  chat.addChild(new Text("hidden older message", 0, 0)); chat.addChild(normal); chat.addChild(broken);
  const surface = new ChatSurface(chat, { limit: 2, groups: new ToolGroups(() => undefined),
    onGroupingFaultChange: faulted => states.push(faulted) });
  Reflect.set(broken.result, "content", {});
  assert.doesNotMatch(chat.render(80).join("\n"), /hidden older message/);
  assert.equal(normalPaints, 1, "metadata is checked before any selected native child paints");
  assert.equal(paints, 1, "the faulting frame paints the selected native child only once");
  assert.deepEqual(states, [true]);
  assert.doesNotMatch(chat.render(80).join("\n"), /hidden older message/);
  assert.equal(normalPaints, 2, "each later native frame paints once");
  assert.equal(paints, 2);
  assert.deepEqual(states, [true], "persistent failures do not repeat the diagnostic");
  Reflect.set(broken.result, "content", []);
  now += 1_000;
  assert.doesNotMatch(chat.render(80).join("\n"), /hidden older message/);
  assert.deepEqual(states, [true, false], "valid metadata restores grouping on the next eligible render");
  assert.equal(chat.children.length, 3);
  surface.dispose();
});
