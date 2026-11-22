import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, SkillInvocationMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, VStack, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { MESSAGE_LENGTH_DEFAULT } from "../extensions/pi-slate/layout.ts";
import { ChatSurface, findChatContainer } from "../extensions/pi-slate/chat-surface.ts";
import { ToolGroups } from "../extensions/pi-slate/tool-groups.ts";

const rows = (chat: Container) => chat.render(80).map(row => row.trimEnd());

test("message window projects display only, never the host's authoritative children or mutation methods", () => {
  const chat = new Container();
  const messages = Array.from({ length: 5 }, (_, i) => new Text(`m${i}`, 0, 0));
  messages.forEach(message => chat.addChild(message));
  const add = chat.addChild, remove = chat.removeChild, clear = chat.clear;
  const window = new ChatSurface(chat, { limit: 3 });
  assert.deepEqual(chat.children, messages);
  assert.deepEqual(rows(chat), ["m2", "m3", "m4"]);
  assert.equal(chat.addChild, add); assert.equal(chat.removeChild, remove); assert.equal(chat.clear, clear);
  messages[0]!.setText("updated by host while hidden");
  window.update({ limit: 5 });
  assert.match(rows(chat).join("\n"), /updated by host while hidden/);
  chat.addChild(new Text("m5", 0, 0));
  assert.equal(chat.children.length, 6);
  assert.equal(rows(chat).length, 5);
  window.update({ limit: Number.POSITIVE_INFINITY });
  assert.equal(rows(chat).length, 6);
  window.dispose();
  assert.equal(chat.render, Container.prototype.render);
});

test("finder uses the last nested container inside the primary scroll view", () => {
  const header = new Container(), chat = new Container(), document = new Container();
  chat.addChild(new Text("hello", 0, 0)); document.addChild(header); document.addChild(chat);
  const root = new VStack([{ component: new ScrollView(document, { primary: true }), grow: 1 }, new Text("editor", 0, 0)]);
  assert.equal(findChatContainer(root), chat);
  assert.equal(findChatContainer(new VStack([new Container(), new Text("footer", 0, 0)])), undefined);
});

test("active work does not hide a live assistant when multiple tools are appended", () => {
  const chat = new Container(); let active = true;
  const assistant = new Text("assistant", 0, 0), a = new Text("tool a", 0, 0), b = new Text("tool b", 0, 0);
  chat.addChild(assistant);
  const window = new ChatSurface(chat, { limit: 1, active: () => active });
  chat.addChild(a); chat.addChild(b);
  assert.deepEqual(rows(chat), ["assistant", "tool a", "tool b"]);
  active = false;
  assert.deepEqual(rows(chat), ["tool b"]);
  assert.deepEqual(chat.children, [assistant, a, b]);
  window.dispose();
  assert.deepEqual(rows(chat), ["assistant", "tool a", "tool b"]);
});

test("mounting mid-turn keeps the current prompt and reply, even when tools already filled the window", (t) => {
  initTheme("dark", false);
  const chat = new Container();
  chat.addChild(new Text("older history", 0, 0));
  chat.addChild(new UserMessageComponent("current prompt"));
  chat.addChild(new Text("live reply", 0, 0));
  chat.addChild(new Text("first tool", 0, 0));
  const window = new ChatSurface(chat, { limit: 1, active: () => true });
  t.after(() => window.dispose());
  chat.addChild(new Text("second tool", 0, 0));
  const painted = rows(chat).join("\n");
  assert.match(painted, /current prompt[\s\S]*live reply\nfirst tool\nsecond tool/);
  assert.doesNotMatch(painted, /older history/);
});

test("a skill-only prompt anchors the live turn on mount and after history replacement", (t) => {
  initTheme("dark", false);
  const chat = new Container();
  const skill = () => new SkillInvocationMessageComponent({
    name: "review", location: "/skills/review", content: "Review the change", userMessage: undefined,
  });
  chat.addChild(skill());
  chat.addChild(new Text("live tool", 0, 0));
  const surface = new ChatSurface(chat, { limit: 1, active: () => true });
  t.after(() => surface.dispose());
  assert.match(rows(chat).join("\n"), /review[\s\S]*live tool/);

  chat.clear();
  chat.addChild(new UserMessageComponent("previous prompt"));
  chat.addChild(skill());
  chat.addChild(new Text("new reply", 0, 0));
  const painted = rows(chat).join("\n");
  assert.match(painted, /review[\s\S]*new reply/);
  assert.doesNotMatch(painted, /previous prompt/);
});

test("the transcript keeps its visible history and the entire live turn as tools append", () => {
  const chat = new Container(); let active = false;
  const old = new Text("old", 0, 0), recent = new Text("recent", 0, 0);
  const assistant = new Text("assistant", 0, 0), a = new Text("tool a", 0, 0), b = new Text("tool b", 0, 0);
  chat.addChild(old); chat.addChild(recent);
  const window = new ChatSurface(chat, { limit: 1, active: () => active });
  assert.deepEqual(rows(chat), ["recent"]);
  active = true;
  chat.addChild(assistant);
  assert.deepEqual(rows(chat), ["recent", "assistant"]);
  chat.addChild(a); chat.addChild(b);
  assert.deepEqual(rows(chat), ["recent", "assistant", "tool a", "tool b"]);
  active = false;
  assert.deepEqual(rows(chat), ["tool b"]);
  assert.deepEqual(chat.children, [old, recent, assistant, a, b]);
  window.dispose();
  assert.deepEqual(rows(chat), ["old", "recent", "assistant", "tool a", "tool b"]);
});

test("an active transcript reanchors when Pi replaces the chat history", () => {
  const chat = new Container();
  chat.addChild(new Text("before", 0, 0));
  const window = new ChatSurface(chat, { limit: 1, active: () => true });
  assert.deepEqual(rows(chat), ["before"]);
  chat.clear();
  chat.addChild(new Text("replaced", 0, 0));
  chat.addChild(new Text("summary", 0, 0));
  assert.deepEqual(rows(chat), ["summary"]);
  chat.addChild(new Text("continuing", 0, 0));
  assert.deepEqual(rows(chat), ["summary", "continuing"]);
  window.dispose();
});

test("default visible length stays synced at 100", () => { assert.equal(MESSAGE_LENGTH_DEFAULT, 100); });

test("disposed display wrappers retained by successors delegate to native rendering", () => {
  const chat = new Container();
  for (let i = 0; i < 4; i++) chat.addChild(new Text(`m${i}`, 0, 0));
  const window = new ChatSurface(chat, { limit: 1 });
  const render = chat.render;
  const successor = (width: number) => render.call(chat, width);
  chat.render = successor;
  assert.equal(rows(chat).length, 1);
  window.dispose(); window.dispose(); window.update({ limit: 0 });
  assert.equal(chat.render, successor);
  assert.equal(rows(chat).length, 4);
  chat.clear(); assert.deepEqual(rows(chat), []);
});

test("unknown render owners are preserved rather than bypassed", () => {
  const chat = new Container();
  const custom = () => ["native warning or another extension's rendering"];
  chat.render = custom;
  assert.throws(() => new ChatSurface(chat, { limit: 1 }), /native transcript retained/);
  assert.equal(chat.render, custom);
  assert.deepEqual(rows(chat), ["native warning or another extension's rendering"]);
});

test("unknown mouse owners are preserved without installing a partial renderer", () => {
  const chat = new Container();
  const mouse = () => undefined;
  chat.handleMouse = mouse;
  assert.throws(() => new ChatSurface(chat, { limit: 1 }), /native transcript retained/);
  assert.equal(chat.render, Container.prototype.render);
  assert.equal(chat.handleMouse, mouse);
});

test("a failed mouse-slot installation rolls back the render slot", () => {
  const chat = new Container();
  Object.defineProperty(chat, "handleMouse", { value: Container.prototype.handleMouse, writable: false });
  assert.throws(() => new ChatSurface(chat, { limit: 1 }), TypeError);
  assert.equal(chat.render, Container.prototype.render);
  assert.equal(chat.handleMouse, Container.prototype.handleMouse);
});

test("a successor retaining both disposed wrappers gets native render and mouse behavior", () => {
  const chat = new Container(); let clicks = 0;
  chat.addChild({ render: () => ["native"], invalidate() {}, handleMouse() { clicks++; return { handled: true }; } });
  const surface = new ChatSurface(chat, { limit: 1 });
  const render = chat.render, mouse = chat.handleMouse;
  const successorRender: typeof render = width => render.call(chat, width);
  const successorMouse: typeof mouse = event => mouse.call(chat, event);
  chat.render = successorRender; chat.handleMouse = successorMouse;
  surface.dispose();
  assert.equal(chat.render, successorRender); assert.equal(chat.handleMouse, successorMouse);
  assert.deepEqual(rows(chat), ["native"]);
  assert.equal(chat.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false })?.handled, true);
  assert.equal(clicks, 1);
});

test("even unbounded and active projections give painters a copy of the host array", () => {
  const chat = new Container(); chat.addChild(new Text("native", 0, 0));
  const groups = new ToolGroups(() => undefined);
  const render = groups.render.bind(groups);
  const projections: Array<Parameters<ToolGroups["render"]>[0]> = [];
  groups.render = (children, width) => {
    assert.notEqual(children, chat.children);
    projections.push(children);
    return render(children, width);
  };
  const surface = new ChatSurface(chat, { groups });
  assert.deepEqual(rows(chat), ["native"]);
  surface.update({ groups, limit: 1, active: () => true });
  assert.deepEqual(rows(chat), ["native"]);
  assert.equal(projections[0], projections[1]);
  chat.children[0] = new Text("updated", 0, 0);
  assert.deepEqual(rows(chat), ["updated"]);
  assert.notEqual(projections[2], projections[1]);
  surface.dispose();
});

test("wheel is offered to the painted message once; an unhandled wheel falls through", () => {
  const chat = new Container();
  let paints = 0, wheels = 0;
  chat.addChild(new Text("ordinary message", 0, 0));
  chat.addChild({
    render() { paints++; return ["custom message"]; }, invalidate() {},
    handleMouse(event: TuiMouseEvent) {
      assert.equal(event.type, "wheel"); assert.equal(event.y, 0);
      wheels++; return { handled: true, render: false };
    },
  });
  const surface = new ChatSurface(chat, {});
  const event = { type: "wheel", button: "none", x: 2, y: 0, width: 80, height: 2 } as TuiMouseEvent;
  assert.equal(chat.handleMouse(event), undefined, "do not paint in order to discover a wheel target");
  for (const groups of [undefined, new ToolGroups(() => undefined)]) {
    surface.update({ groups });
    chat.render(80);
    const before = paints;
    assert.equal(chat.handleMouse(event), undefined);
    const result = chat.handleMouse({ ...event, y: 1 });
    assert.equal(result?.handled, true);
    assert.equal(result?.render, false);
    assert.equal(paints, before);
  }
  assert.equal(wheels, 2);
  surface.dispose();
});
