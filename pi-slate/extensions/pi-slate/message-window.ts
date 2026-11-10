import { Container, ScrollView, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";
import { chatViewChildren, compatibleChatRenderer, consumesChatView, installChatView, markChatRenderer } from "./chat-view.ts";

export function childComponents(component: Component): Component[] {
  const stack = component as { entries?: Array<{ component?: Component }> };
  if (Array.isArray(stack.entries) && stack.entries.some((entry) => entry?.component)) {
    return stack.entries.flatMap((entry) => (entry.component ? [entry.component] : []));
  }
  const container = component as Container;
  return Array.isArray(container.children) ? container.children : [];
}

export function findPrimaryScrollView(root: Component): ScrollView | undefined {
  const seen = new Set<Component>();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node instanceof ScrollView && node.primary) return node;
    queue.push(...childComponents(node));
  }
  return undefined;
}

export function findChatContainer(root: Component | undefined): Container | undefined {
  if (!root) return undefined;
  const scroll = findPrimaryScrollView(root);
  if (!scroll) return undefined;
  const content = childComponents(scroll)[0];
  if (!content || typeof (content as Container).addChild !== "function") return undefined;
  const nested = childComponents(content).filter((child) => (
    child instanceof Container && !(child instanceof ScrollView)
  ));
  const chat = nested.at(-1) ?? content;
  return typeof (chat as Container).addChild === "function" ? chat as Container : undefined;
}

export function layoutRootOf(tui: TUI | undefined): Component | undefined {
  if (!tui || !isViewportTUI(tui)) return undefined;
  return (tui as TUI & { layoutRoot?: Component }).layoutRoot;
}

export class MessageWindow {
  readonly container: Container;
  private readonly originalRender: Container["render"];
  private readonly originalMouse: Container["handleMouse"];
  private readonly installedRender: Container["render"];
  private readonly installedMouse: Container["handleMouse"];
  private readonly removeView: () => void;
  private readonly display = new Container();
  private limit: number;
  private disposed = false;

  constructor(container: Container, limit: number, active: () => boolean = () => false) {
    if (!compatibleChatRenderer(container.render)) throw new Error("Unrecognized chat renderer; native transcript retained");
    this.container = container;
    this.limit = limit;
    this.originalRender = container.render;
    this.originalMouse = container.handleMouse;
    this.removeView = installChatView(container, () => {
      if (this.disposed || active() || !Number.isFinite(this.limit)) return container.children;
      return container.children.slice(-Math.max(1, Math.floor(this.limit)));
    });
    this.installedRender = markChatRenderer((width) => {
      if (this.disposed) return this.originalRender.call(container, width);
      this.display.children = chatViewChildren(container);
      // Another live Slate adapter may consume the projection. Recheck after rendering:
      // it can fault and retire itself during this very frame.
      if (!consumesChatView(this.originalRender)) return this.display.render(width);
      const rows = this.originalRender.call(container, width);
      return consumesChatView(this.originalRender) ? rows : this.display.render(width);
    }, () => !this.disposed || consumesChatView(this.originalRender));
    this.installedMouse = (event) => this.disposed || consumesChatView(this.originalRender)
      ? this.originalMouse.call(container, event) : this.display.handleMouse(event);
    container.render = this.installedRender;
    container.handleMouse = this.installedMouse;
  }

  setLimit(limit: number): void { if (!this.disposed) this.limit = limit; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeView();
    if (this.container.render === this.installedRender) this.container.render = this.originalRender;
    if (this.container.handleMouse === this.installedMouse) this.container.handleMouse = this.originalMouse;
    this.display.children = [];
  }
}

export function syncMessageWindow(
  current: MessageWindow | undefined,
  tui: TUI | undefined,
  limit: number,
  active?: () => boolean,
): MessageWindow | undefined {
  const chat = findChatContainer(layoutRootOf(tui));
  if (!chat) { current?.dispose(); return undefined; }
  if (current?.container === chat) {
    current.setLimit(limit);
    return current;
  }
  current?.dispose();
  return new MessageWindow(chat, limit, active);
}
