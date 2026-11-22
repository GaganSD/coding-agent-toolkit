import { Container, ScrollView, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RowDecorator, ToolGroups } from "./tool-groups.ts";

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
  onGroupingFaultChange?: (faulted: boolean) => void;
  /** Presentation-only row decoration; returns the same array when nothing changes. */
  decorate?: RowDecorator;
};

type LayoutChild = Component | { component: Component; height: number };
/** Pi 1.4 exposes `mouseLayout`; newer hosts expose `childLines` with per-child parts. */
type ChildLayout = {
  width: number;
  children: readonly LayoutChild[];
  parts?: readonly (readonly string[])[];
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
  private paintedWidth?: number;
  private groupingFailed = false;
  private disposed = false;

  get groupingFaulted(): boolean { return this.groupingFailed; }

  private setGroupingFault(faulted: boolean): void {
    if (faulted === this.groupingFailed) return;
    this.groupingFailed = faulted;
    this.options.onGroupingFaultChange?.(faulted);
  }

  /** Decorate native rows by child while keeping Container's mouse layout intact. */
  private decorateNative(rendered: string[], width: number): string[] {
    const decorate = this.options.decorate;
    if (!decorate) return rendered;
    const owner = this.display as unknown as { childLines?: ChildLayout; mouseLayout?: ChildLayout };
    const layout = owner.childLines ?? owner.mouseLayout;
    if (!layout || layout.width !== width || layout.children.length !== this.display.children.length) return rendered;
    let changed = false, offset = 0;
    const lines: string[] = [];
    for (let index = 0; index < layout.children.length; index++) {
      const entry = layout.children[index]!;
      const component = "component" in entry ? entry.component : entry;
      const height = layout.parts?.[index]?.length ?? ("height" in entry ? entry.height : undefined);
      if (height === undefined) return rendered;
      const rows = rendered.slice(offset, offset + height);
      offset += height;
      const decorated = decorate(component, rows, width);
      if (decorated !== rows) changed = true;
      for (const row of decorated) lines.push(row);
    }
    if (offset !== rendered.length) return rendered;
    return changed ? lines : rendered;
  }

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
      const children = container.children;
      const start = !this.options.active?.() && Number.isFinite(limit) ? Math.max(0, children.length - Math.max(1, Math.floor(limit))) : 0;
      const projected = this.display.children;
      if (projected.length !== children.length - start || !projected.every((child, i) => child === children[start + i])) {
        this.display.children = children.slice(start);
      }
      this.paintedGroups = undefined;
      this.paintedWidth = width;
      const groups = this.options.groups;
      if (groups) {
        let rows: string[] | undefined;
        try { rows = groups.render(this.display.children, width); }
        catch { /* Paint and route this frame natively; retry on the next content render. */ }
        this.setGroupingFault(rows === undefined);
        if (rows) {
          this.paintedGroups = groups;
          return rows;
        }
      } else this.setGroupingFault(false);
      return this.decorateNative(this.display.render(width), width);
    };
    this.installedMouse = event => {
      if (this.disposed) return this.originalMouse.call(container, event);
      if (event.type === "wheel" && event.width !== this.paintedWidth) return undefined;
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
