import {
  HStack,
  isViewportTUI,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { requestNecessaryRender } from "./render-request.ts";
import {
  SIDEBAR_MIN_WIDTH,
  dashboardColumnWidth,
} from "./layout.ts";

const SIDEBAR_SPLIT = Symbol.for("pi-slate.sidebar-split");
const SPLIT_OWNER = Symbol.for("pi-slate.sidebar-split-owner");

type SplitHost<T> = {
  layoutRoot?: T;
  setLayoutRoot(component: T | undefined): void;
  [SPLIT_OWNER]?: object;
};

type LayoutLease = (() => void) & { active(): boolean };

/** Root-identity lease, never a setter monkeypatch. Host facades need not preserve method identity. */
export function bindSplitHost<T>(
  host: SplitHost<T>,
  wrap: (component: T | undefined) => T | undefined,
  unwrap: (component: T | undefined) => T | undefined,
  onYield?: () => void,
): LayoutLease {
  const owner = {};
  const mounted = wrap(host.layoutRoot);
  let disposed = false, yielded = false;
  host[SPLIT_OWNER] = owner;
  if (host.layoutRoot !== undefined) host.setLayoutRoot(mounted);
  const active = (): boolean => {
    if (disposed) return false;
    const own = host[SPLIT_OWNER] === owner && host.layoutRoot === mounted;
    if (!own && !yielded) { yielded = true; onYield?.(); }
    return own;
  };
  const dispose = (): void => {
    const own = active();
    disposed = true;
    if (host[SPLIT_OWNER] === owner) delete host[SPLIT_OWNER];
    if (own) host.setLayoutRoot(unwrap(mounted));
  };
  return Object.assign(dispose, { active });
}

type SplitMousePane = Component & {
  handleSplitMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

export class SidebarSplit extends HStack {
  private readonly pane: SplitMousePane;
  private readonly originalChat: Component;
  private chatLease = 0;

  chat(): Component { return this.originalChat; }

  /** Lend only our owned main slot. Keep the original chat/editor objects alive. */
  replaceChat(view: Component): () => void {
    const entry = this.entries[0]!;
    if (entry.component !== this.originalChat) throw new Error("Slate conversation slot is already in use");
    const lease = ++this.chatLease;
    entry.component = view;
    this.children[0] = view;
    return () => {
      if (this.chatLease !== lease || entry.component !== view) return;
      entry.component = this.originalChat;
      this.children[0] = this.originalChat;
    };
  }

  renewPane(): void {
    // Pi reuses view output by component identity. Change only our owned leaf,
    // and keep the original pane as the mouse capture/click target.
    const pane = this.pane;
    const view: Component = {
      render: width => pane.render(width),
      invalidate: () => pane.invalidate?.(),
      handleMouse(event) {
        const result = pane.handleMouse?.(event);
        if (!result || "target" in result) return result;
        if (!result.handled && !result.capture && !result.focus) return undefined;
        return {
          ...result, handled: true, target: {
            component: pane, originX: event.screenX - event.x, originY: event.screenY - event.y,
            width: event.width, height: event.height,
          },
        };
      },
    };
    this.entries[1]!.component = view;
    this.children[1] = view;
  }

  override handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") return undefined;
    const result = this.pane.handleSplitMouse?.(event);
    if (!result?.handled && !result?.capture && !result?.focus) return undefined;
    return {
      ...result,
      handled: true as const,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }

  constructor(chat: Component, pane: Component, preferredWidth?: () => number | undefined, rows?: () => number) {
    super([
      // Skip full-width intrinsic measurement: switching widths thrashes leaf render caches.
      { component: chat, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      {
        component: pane,
        grow: 0,
        shrink: 0,
        minSize: SIDEBAR_MIN_WIDTH,
        basis: SIDEBAR_MIN_WIDTH,
        visible: (viewport) => {
          const width = dashboardColumnWidth(viewport.width, rows?.() ?? viewport.height, preferredWidth?.());
          const entry = this.entries[1];
          if (entry && entry.basis !== width) entry.basis = Math.max(SIDEBAR_MIN_WIDTH, width);
          return width > 0;
        },
      },
    ]);
    this.pane = pane;
    this.originalChat = chat;
    Object.assign(this, { [SIDEBAR_SPLIT]: true });
  }
}

function isSplit(component: Component | undefined): component is SidebarSplit {
  return Boolean(component && (component as { [SIDEBAR_SPLIT]?: boolean })[SIDEBAR_SPLIT]);
}

export function splitChat(component: Component | undefined): Component | undefined {
  if (!component) return undefined;
  if (!isSplit(component)) return component;
  return component.chat();
}

export type SidebarSplitLease = LayoutLease & {
  replaceChat(view: Component): (() => void) | undefined;
  ownsFocus(component: Component): boolean;
  requestPaneRender(): boolean;
};
type ViewRenderHost = { requestViewRender?(): void };

export function installSidebarSplit(
  tui: TUI,
  pane: Component,
  preferredWidth?: () => number | undefined,
  onYield?: () => void,
  onViewRenderFault?: () => void,
): SidebarSplitLease | undefined {
  if (!isViewportTUI(tui) || !(tui as TUI & { layoutRoot?: Component }).layoutRoot) return undefined;

  let split: SidebarSplit | undefined;
  const dispose = bindSplitHost(
    tui,
    (component) => {
      const chat = splitChat(component);
      if (chat) split = new SidebarSplit(chat, pane, preferredWidth, () => tui.terminal.rows);
      return split ?? component;
    },
    splitChat,
    onYield,
  );
  let viewRenderFailed = false;
  return Object.assign(dispose, {
    requestPaneRender() {
      if (!split || !dispose.active()) return false;
      const host = tui as unknown as ViewRenderHost;
      if (!viewRenderFailed) {
        try {
          if (typeof host.requestViewRender === "function") {
            split.renewPane();
            host.requestViewRender();
            return true;
          }
        } catch {
          viewRenderFailed = true;
          onViewRenderFault?.();
        }
      }
      return requestNecessaryRender(tui, viewRenderFailed);
    },
    ownsFocus(component: Component) { return dispose.active() && component === split; },
    replaceChat(view: Component) {
      // A later layout owner wins; never resurrect a stale slot.
      if (!split || !dispose.active()) return undefined;
      return split.replaceChat(view);
    },
  });
}
