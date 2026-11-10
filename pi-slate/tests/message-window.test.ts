import assert from "node:assert/strict";
import test from "node:test";
import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { MESSAGE_LENGTH_DEFAULT } from "../extensions/pi-slate/layout.ts";
import { findChatContainer, MessageWindow } from "../extensions/pi-slate/message-window.ts";

const rows = (chat: Container) => chat.render(80).map(row => row.trimEnd());

test("message window projects display only, never the host's authoritative children or mutation methods", () => {
  const chat = new Container();
  const messages = Array.from({ length: 5 }, (_, i) => new Text(`m${i}`, 0, 0));
  messages.forEach(message => chat.addChild(message));
  const add = chat.addChild, remove = chat.removeChild, clear = chat.clear;
  const window = new MessageWindow(chat, 3);
  assert.deepEqual(chat.children, messages);
  assert.deepEqual(rows(chat), ["m2", "m3", "m4"]);
  assert.equal(chat.addChild, add); assert.equal(chat.removeChild, remove); assert.equal(chat.clear, clear);
  messages[0]!.setText("updated by host while hidden");
  window.setLimit(5);
  assert.match(rows(chat).join("\n"), /updated by host while hidden/);
  chat.addChild(new Text("m5", 0, 0));
  assert.equal(chat.children.length, 6);
  assert.equal(rows(chat).length, 5);
  window.setLimit(Number.POSITIVE_INFINITY);
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
  const window = new MessageWindow(chat, 1, () => active);
  chat.addChild(a); chat.addChild(b);
  assert.deepEqual(rows(chat), ["assistant", "tool a", "tool b"]);
  active = false;
  assert.deepEqual(rows(chat), ["tool b"]);
  assert.deepEqual(chat.children, [assistant, a, b]);
  window.dispose();
  assert.deepEqual(rows(chat), ["assistant", "tool a", "tool b"]);
});

test("default visible length stays synced at 100", () => { assert.equal(MESSAGE_LENGTH_DEFAULT, 100); });

test("disposed display wrappers retained by successors delegate to native rendering", () => {
  const chat = new Container();
  for (let i = 0; i < 4; i++) chat.addChild(new Text(`m${i}`, 0, 0));
  const window = new MessageWindow(chat, 1);
  const render = chat.render;
  const successor = (width: number) => render.call(chat, width);
  chat.render = successor;
  assert.equal(rows(chat).length, 1);
  window.dispose(); window.dispose(); window.setLimit(0);
  assert.equal(chat.render, successor);
  assert.equal(rows(chat).length, 4);
  chat.clear(); assert.deepEqual(rows(chat), []);
});

test("unknown render owners are preserved rather than bypassed", () => {
  const chat = new Container();
  const custom = () => ["native warning or another extension's rendering"];
  chat.render = custom;
  assert.throws(() => new MessageWindow(chat, 1), /native transcript retained/);
  assert.equal(chat.render, custom);
  assert.deepEqual(rows(chat), ["native warning or another extension's rendering"]);
});
