import { Container, ScrollView, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ToolGroups } from "./tool-groups.ts";

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

export type ChatSurfaceOptions = {
  limit?: number;
  groups?: ToolGroups;
  active?: () => boolean;
  onGroupingFault?: () => void;
};

/** One owner for the display pipeline: project first, then paint grouped or native rows. */
export class ChatSurface {
  readonly container: Container;
  private options: ChatSurfaceOptions;
  private readonly originalRender: Container["render"];
  private readonly originalMouse: Container["handleMouse"];
  private readonly installedRender: Container["render"];
  private readonly installedMouse: Container["handleMouse"];
  private readonly display = new Container();
  private paintedGroups: ToolGroups | undefined;
  private disposed = false;

  constructor(container: Container, options: ChatSurfaceOptions) {
    this.container = container; this.options = { ...options };
    if (container.render !== Container.prototype.render || container.handleMouse !== Container.prototype.handleMouse) {
      throw new Error("Unrecognized chat owner; native transcript retained");
    }
    this.originalRender = container.render;
    this.originalMouse = container.handleMouse;
    this.installedRender = width => {
      if (this.disposed) return this.originalRender.call(container, width);
      const limit = this.options.limit ?? Number.POSITIVE_INFINITY;
      const start = !this.options.active?.() && Number.isFinite(limit) ? -Math.max(1, Math.floor(limit)) : 0;
      this.display.children = container.children.slice(start);
      this.paintedGroups = undefined;
      if (this.options.groups) {
        try {
          const rows = this.options.groups.render(this.display.children, width);
          this.paintedGroups = this.options.groups;
          return rows;
        } catch {
          this.options.groups = undefined;
          this.options.onGroupingFault?.();
        }
      }
      return this.display.render(width);
    };
    this.installedMouse = event => {
      if (this.disposed) return this.originalMouse.call(container, event);
      return this.paintedGroups ? this.paintedGroups.handleMouse(event) : this.display.handleMouse(event);
    };
    try {
      container.render = this.installedRender;
      container.handleMouse = this.installedMouse;
    } catch (error) { this.dispose(); throw error; }
  }

  update(options: ChatSurfaceOptions): void { if (!this.disposed) this.options = { ...options }; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.container.render === this.installedRender) this.container.render = this.originalRender;
    if (this.container.handleMouse === this.installedMouse) this.container.handleMouse = this.originalMouse;
    this.display.children = [];
    this.paintedGroups = undefined;
    this.options = {};
  }
}
