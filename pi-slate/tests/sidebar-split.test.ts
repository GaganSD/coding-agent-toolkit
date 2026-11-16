import assert from "node:assert/strict";
import test from "node:test";
import { bindSplitHost } from "../extensions/pi-slate/sidebar-split.ts";

type Node = { id: string; child?: Node };

function wrap(pane: string) {
  return (component: Node | undefined): Node | undefined => {
    if (!component) return component;
    const chat = component.child ?? component;
    return { id: pane, child: chat.id === "chat" ? chat : component.child };
  };
}

function unwrap(component: Node | undefined): Node | undefined {
  return component?.child ?? component;
}

function createHost(chat: Node) {
  return {
    layoutRoot: chat as Node | undefined,
    setLayoutRoot(component: Node | undefined) {
      this.layoutRoot = component;
    },
  };
}

test("a new session installer can mount its pane without stale cleanup touching it",  () => {
  const chat = { id: "chat" };
  const host = createHost(chat);

  const staleDispose = bindSplitHost(host, wrap("stale"), unwrap);
  assert.equal(host.layoutRoot?.id, "stale");
  assert.equal(host.layoutRoot?.child, chat);

  const liveDispose = bindSplitHost(host, wrap("live"), unwrap);
  assert.equal(host.layoutRoot?.id, "live");
  assert.equal(host.layoutRoot?.child, chat);

  staleDispose();
  assert.equal(host.layoutRoot?.id, "live");
  assert.equal(host.layoutRoot?.child, chat);

  liveDispose();
  assert.equal(host.layoutRoot, chat);
});

test("disposing the current split unwraps the original chat root", () => {
  const chat = { id: "chat" };
  const host = createHost(chat);
  const dispose = bindSplitHost(host, wrap("pane"), unwrap);
  assert.notEqual(host.layoutRoot, chat);
  dispose();
  assert.equal(host.layoutRoot, chat);
});

test("a later root writer wins once and disposal never restores over it", () => {
  const host = createHost({ id: "chat" });
  let wraps = 0;
  const dispose = bindSplitHost(host, (component) => { wraps++; return wrap("pane")(component); }, unwrap);
  const foreign = { id: "foreign" };
  host.setLayoutRoot(foreign);
  assert.equal(host.layoutRoot, foreign);
  const next = { id: "next" };
  host.setLayoutRoot(next);
  assert.equal(host.layoutRoot, next);
  assert.equal(wraps, 1, "only the initial mount is wrapped");
  dispose();
  assert.equal(host.layoutRoot, next);
});

test("yield does not overwrite a successor's setter wrapper", () => {
  const host = createHost({ id: "chat" });
  const dispose = bindSplitHost(host, wrap("pane"), unwrap);
  const slateSet = host.setLayoutRoot.bind(host);
  const successorSet = (component: Node | undefined) => slateSet(component);
  host.setLayoutRoot = successorSet;
  const foreign = { id: "foreign" };
  host.setLayoutRoot(foreign);
  assert.equal(host.setLayoutRoot, successorSet);
  assert.equal(host.layoutRoot, foreign);
  dispose();
  assert.equal(host.setLayoutRoot, successorSet);
  assert.equal(host.layoutRoot, foreign);
});


test("leases do not patch method slots, including facades returning a fresh forwarding function on every read", () => {
  const raw = createHost({ id: "chat" });
  const setter = raw.setLayoutRoot;
  const host = new Proxy(raw, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
    },
  });
  let yielded = 0;
  for (let i = 0; i < 3; i++) {
    const lease = bindSplitHost(host, wrap("slate"), unwrap, () => { yielded++; });
    assert.equal(raw.setLayoutRoot, setter);
    assert.equal(lease.active(), true);
    lease();
    assert.equal(raw.layoutRoot?.id, "chat");
    assert.equal(raw.setLayoutRoot, setter);
  }
  const lease = bindSplitHost(host, wrap("slate"), unwrap, () => { yielded++; });
  host.setLayoutRoot({ id: "successor" });
  assert.equal(lease.active(), false);
  assert.equal(lease.active(), false);
  assert.equal(yielded, 1);
  lease();
  assert.equal(raw.layoutRoot?.id, "successor");
});
