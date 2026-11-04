import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { MessageWindow } from "../extensions/pi-slate/message-window.ts";
import {
  installNewSessionNoticeFilter,
  isStockNewSessionNotice,
} from "../extensions/pi-slate/stock-notices.ts";

// Core handleClearCommand adds Spacer(1) then ThemedText themed via accent.
function addStockNewSessionBanner(chat: Container): void {
  chat.addChild(new Spacer(1));
  chat.addChild(new Text("\x1b[38;5;1m✓ New session started\x1b[0m", 1, 1));
}

test("matches the stock new-session notice but not ordinary chat", () => {
  assert.equal(isStockNewSessionNotice(new Text("\x1b[38;5;1m✓ New session started\x1b[0m", 1, 1)), true);
  assert.equal(isStockNewSessionNotice(new Text("✓ New session started", 1, 1)), true);
  assert.equal(isStockNewSessionNotice(new Text("✓ New session started", 0, 0)), false);
  assert.equal(isStockNewSessionNotice(new Text("I typed ✓ New session started myself", 0, 0)), false);
  assert.equal(isStockNewSessionNotice(new Text("New session started", 0, 0)), false);
  assert.equal(isStockNewSessionNotice(new Spacer(1)), false);
});

test("filter suppresses the stock new-session banner and its padding spacer", () => {
  const chat = new Container();
  const keep = new Text("hello", 0, 0);
  chat.addChild(keep);
  installNewSessionNoticeFilter(chat);
  addStockNewSessionBanner(chat);
  assert.deepEqual(chat.children, [keep]);
  // A banner without its spacer is rejected without touching neighbors.
  chat.addChild(new Text("✓ New session started", 1, 1));
  assert.deepEqual(chat.children, [keep]);
});

test("filter keeps unrelated text and installs once", () => {
  const chat = new Container();
  installNewSessionNoticeFilter(chat);
  const wrapped = chat.addChild;
  installNewSessionNoticeFilter(chat);
  assert.equal(chat.addChild, wrapped);
  const mention = new Text("notes about ✓ New session started", 0, 0);
  chat.addChild(mention);
  assert.deepEqual(chat.children, [mention]);
});

test("filter composes with the message window in either install order", () => {
  // Filter first, then MessageWindow wraps it.
  const first = new Container();
  installNewSessionNoticeFilter(first);
  const window = new MessageWindow(first, 100);
  addStockNewSessionBanner(first);
  const reply = new Text("answer", 0, 0);
  first.addChild(reply);
  assert.deepEqual(first.children, [reply]);
  window.dispose();
  // The filter survives MessageWindow disposal.
  addStockNewSessionBanner(first);
  assert.deepEqual(first.children, [reply]);

  // MessageWindow first, then the filter wraps it.
  const second = new Container();
  const early = new MessageWindow(second, 100);
  installNewSessionNoticeFilter(second);
  addStockNewSessionBanner(second);
  const other = new Text("user", 0, 0);
  second.addChild(other);
  assert.deepEqual(second.children, [other]);
  early.dispose();
  addStockNewSessionBanner(second);
  assert.deepEqual(second.children, [other]);

  // If addChild is replaced, a later install re-wraps.
  const third = new Container();
  const raw = third.addChild.bind(third);
  installNewSessionNoticeFilter(third);
  third.addChild = raw;
  installNewSessionNoticeFilter(third);
  addStockNewSessionBanner(third);
  assert.deepEqual(third.children, []);

  const fourth = new Container();
  const stop = installNewSessionNoticeFilter(fourth);
  stop();
  addStockNewSessionBanner(fourth);
  assert.equal(fourth.children.length, 2);
});
