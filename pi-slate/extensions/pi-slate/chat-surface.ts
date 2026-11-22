import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";
import type { PaintedRow, RowDecorator, ToolGroups } from "./tool-groups.ts";

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
const childHeight = (layout: ChildLayout, index: number, entry: LayoutChild): number | undefined =>
  layout.parts?.[index]?.length ?? ("height" in entry ? entry.height : undefined);
const GROUPING_RETRY_COOLDOWN_MS = 1000;
const windowStart = (length: number, limit = Number.POSITIVE_INFINITY): number =>
  Number.isFinite(limit) ? Math.max(0, length - Math.max(1, Math.floor(limit))) : 0;

function initialActiveStart(children: readonly Component[], start: number): number {
  let lastAssistant = -1;
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child instanceof UserMessageComponent) return Math.min(start, index);
    if (lastAssistant === -1 && child instanceof AssistantMessageComponent) lastAssistant = index;
  }
  return lastAssistant === -1 ? start : Math.min(start, lastAssistant);
}

/** One owner for the display pipeline: project first, then paint grouped or native rows. */
export class ChatSurface {
  readonly container: Container;
  private options: ChatSurfaceOptions;
  private readonly originalRender: Container["render"];
  private readonly originalMouse: Container["handleMouse"];
  private readonly installedRender: Container["render"];
  private readonly installedMouse: Container["handleMouse"];
  private readonly display = new Container();
  private projectedStart: number;
  private projectionHead?: Component;
  private paintedGroups: ToolGroups | undefined;
  private paintedWidth?: number;
  /** null means the press did not hit a child row; undefined means no press was seen. */
  private pressedRow?: PaintedRow | null;
  private groupingFailed = false;
  private groupingLastFaultAt = Number.NEGATIVE_INFINITY;
  private groupingRetryAt?: number;
  private disposed = false;

  get groupingFaulted(): boolean { return this.groupingFailed; }

  private setGroupingFault(faulted: boolean): void {
    if (faulted === this.groupingFailed) return;
    this.groupingFailed = faulted;
    this.options.onGroupingFaultChange?.(faulted);
  }

  private nativeLayout(width: number): ChildLayout | undefined {
    const owner = this.display as unknown as { childLines?: ChildLayout; mouseLayout?: ChildLayout };
    const layout = owner.childLines ?? owner.mouseLayout;
    return layout?.width === width && layout.children.length === this.display.children.length ? layout : undefined;
  }

  private paintedRow(x: number, y: number, width: number): PaintedRow | undefined {
    if (width !== this.paintedWidth || y < 0) return undefined;
    if (this.paintedGroups) {
      const row = this.paintedGroups.rowOwner(y);
      return row && x >= row.inset ? row : undefined;
    }
    const layout = this.nativeLayout(width);
    if (!layout) return undefined;
    for (let index = 0; index < layout.children.length; index++) {
      const entry = layout.children[index]!;
      const height = childHeight(layout, index, entry);
      if (height === undefined) return undefined;
      if (y < height) return { component: "component" in entry ? entry.component : entry, y };
      y -= height;
    }
    return undefined;
  }

  /** Decorate native rows by child while keeping Container's mouse layout intact. */
  private decorateNative(rendered: string[], width: number): string[] {
    const decorate = this.options.decorate;
    if (!decorate) return rendered;
    const layout = this.nativeLayout(width);
    if (!layout) return rendered;
    let changed = false, offset = 0;
    const lines: string[] = [];
    for (let index = 0; index < layout.children.length; index++) {
      const entry = layout.children[index]!;
      const component = "component" in entry ? entry.component : entry;
      const height = childHeight(layout, index, entry);
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
    // Seed the anchor at mount; tools can append before the first paint.
    const start = windowStart(container.children.length, options.limit);
    this.projectedStart = start > 0 && options.active?.() ? initialActiveStart(container.children, start) : start;
    this.projectionHead = container.children[this.projectedStart];
    this.installedRender = width => {
      if (this.disposed) return this.originalRender.call(container, width);
      const children = container.children;
      let start = windowStart(children.length, this.options.limit);
      const projected = this.display.children;
      const head = this.projectionHead;
      if (start > 0 && this.options.active?.()) {
        // Keep the existing window and append live rows. Sliding it would drop
        // the live assistant after enough tool calls and shift a scrolled viewport.
        const previous = !head ? -1 : children[this.projectedStart] === head ? this.projectedStart : children.indexOf(head);
        start = previous === -1 ? initialActiveStart(children, start) : Math.min(start, previous);
      }
      if (projected.length !== children.length - start || !projected.every((child, i) => child === children[start + i])) {
        this.display.children = children.slice(start);
      }
      this.projectedStart = start;
      this.projectionHead = children[start];
      this.paintedGroups = undefined;
      this.paintedWidth = width;
      const groups = this.options.groups;
      if (!groups) {
        this.groupingLastFaultAt = Number.NEGATIVE_INFINITY;
        this.groupingRetryAt = undefined;
        this.setGroupingFault(false);
      } else if (this.groupingRetryAt === undefined || performance.now() >= this.groupingRetryAt) {
        let rows: string[] | undefined;
        try { rows = groups.render(this.display.children, width); }
        catch { /* Paint and route this frame natively. */ }
        if (rows === undefined) {
          const now = performance.now();
          // Retry an isolated fault immediately, but remember recent faults even
          // across a successful paint so alternating failures cannot flicker freely.
          if (this.groupingRetryAt !== undefined || now - this.groupingLastFaultAt < GROUPING_RETRY_COOLDOWN_MS) {
            this.groupingRetryAt = now + GROUPING_RETRY_COOLDOWN_MS;
          }
          this.groupingLastFaultAt = now;
        } else this.groupingRetryAt = undefined;
        this.setGroupingFault(rows === undefined);
        if (rows) {
          this.paintedGroups = groups;
          return rows;
        }
      }
      return this.decorateNative(this.display.render(width), width);
    };
    this.installedMouse = event => {
      if (this.disposed) return this.originalMouse.call(container, event);
      if (event.type === "wheel" && event.width !== this.paintedWidth) return undefined;
      if (event.button === "left") {
        if (event.type === "press") {
          this.pressedRow = this.paintedRow(event.x, event.y, event.width) ?? null;
        } else if (event.type === "click") {
          const pressedRow = this.pressedRow;
          this.pressedRow = undefined;
          // Pi resolves the click on release. Windowing and grouping can both move
          // rows without scrolling; compare the painted owners without re-rendering.
          if (pressedRow !== undefined) {
            const row = this.paintedRow(event.x, event.y, event.width);
            if (!row && !pressedRow) return undefined; // Leave unowned summaries selectable by Pi.
            if (!row || !pressedRow || row.component !== pressedRow.component || row.y !== pressedRow.y) {
              return { handled: true, render: false, target: {
                component: container, originX: event.screenX - event.x, originY: event.screenY - event.y,
                width: event.width, height: event.height,
              } };
            }
          }
        }
      }
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
    this.projectionHead = undefined;
    this.paintedGroups = undefined;
    this.pressedRow = undefined;
    this.options = {};
  }
}
