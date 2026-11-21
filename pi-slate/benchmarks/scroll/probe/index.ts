import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi 1.6's private fullscreen renderer and layout frame, as seen by widget factories.
interface ComponentNode {
  children?: ComponentNode[];
  entries?: { component: ComponentNode }[];
  child?: ComponentNode; // Slate's padded tool result
  ready?: Promise<void>; // Slate's DiffView highlighting completion
}
interface PrimaryScrollView { primary: boolean; scrollTop: number; contentHeight: number; viewportHeight: number }
interface LayoutBox {
  component: ComponentNode;
  children: LayoutBox[];
  rect: { width: number; height: number };
  scrollView?: PrimaryScrollView;
}
interface FullscreenTui {
  doRender(): void;
  invalidate(): void;
  requestRender(force?: boolean): void;
  requestImmediateRender(): void;
  contentChanged: boolean;
  altScreenActive: boolean;
  stopped: boolean;
  layoutRoot?: ComponentNode;
  currentLayout?: { root: LayoutBox; lines: string[]; primaryScrollView?: PrimaryScrollView };
}

type Sample = ["frame", number, boolean, number] | ["request", number, string?];
const SPLIT = Symbol.for("pi-slate.sidebar-split");
const HEADING = "Synthetic scroll benchmark ready";

function* components(root: ComponentNode | undefined, skip?: ComponentNode): Generator<ComponentNode> {
  if (!root) return;
  yield root;
  if (root === skip) return;
  for (const child of root.entries?.map((entry) => entry.component) ?? root.children ?? []) {
    yield* components(child, skip);
  }
}

function primaryBox(box: LayoutBox | undefined, view: PrimaryScrollView): LayoutBox | undefined {
  if (box?.scrollView === view) return box;
  for (const child of box?.children ?? []) {
    const match = primaryBox(child, view);
    if (match) return match;
  }
}

function inspect(tui: FullscreenTui, diffViews: number) {
  const frame = tui.currentLayout;
  const view = frame?.primaryScrollView;
  const split = Boolean(tui.layoutRoot && Reflect.get(tui.layoutRoot, SPLIT));
  const sidebar = split && frame?.root.component === tui.layoutRoot && Boolean(frame?.root.children.slice(1)
    .some((box) => box.rect.width > 0 && box.rect.height > 0));
  const document = view && primaryBox(frame?.root, view)?.children[0]?.component;
  // Mirrors Slate's findChatContainer. ChatSurface owns both methods on this instance.
  const chat = document && (document.children?.filter((child) => child.constructor.name === "Container").at(-1) ?? document);
  const transcript = chat !== undefined && Object.hasOwn(chat, "render") && Object.hasOwn(chat, "handleMouse");
  const names = new Set([...components(tui.layoutRoot, chat), ...components(document, chat)].map((node) => node.constructor.name));
  return {
    scrollTop: view?.primary && Number.isFinite(view.scrollTop) ? view.scrollTop : null,
    maxScrollTop: view?.primary && Number.isFinite(view.contentHeight) && Number.isFinite(view.viewportHeight)
      ? Math.max(0, view.contentHeight - view.viewportHeight) : null,
    surfaces: { header: names.has("SlateHeader"), footer: names.has("SlateFooter"), editor: names.has("ComposerEditor"),
      sidebar, "tool-cards": diffViews > 0, transcript },
  };
}

export default function (pi: ExtensionAPI) {
  const out = process.env.PI_SCROLL_PROBE;
  const status = process.env.PI_SCROLL_STATUS;
  if (!out || !status) throw new Error("PI_SCROLL_PROBE and PI_SCROLL_STATUS are required");
  const stacks = process.env.PI_SCROLL_STACKS === "1";
  const quietMs = Number(process.env.PI_SCROLL_QUIET_MS);
  type Status = ReturnType<typeof inspect> & { ready: boolean; diffViews: number; pendingDiffs: number; hostHighlightSettled: boolean };
  let sequence = 0;
  function publish(sample: Status | { error: string }) {
    writeFileSync(`${status}.tmp`, JSON.stringify({ seq: ++sequence, ...sample }));
    renameSync(`${status}.tmp`, status!);
  }

  let lastStartupActivity = Date.now();
  let ready = false, sawHeading = false, hostHighlightSettled = false;
  let diffViews = 0, pendingDiffs = 0;
  const seenDiffs = new WeakSet<Promise<void>>();
  // This public resolver wraps the actual renderer, not a second import of Slate/Shiki.
  // Non-diff tools are unchanged. DiffView.ready covers grammar loading and tokenization.
  pi.registerToolRenderer((name, next) => {
    const original = next();
    if ((name !== "edit" && name !== "write") || !original?.renderResult) return original;
    return { ...original, renderResult(...args) {
      const component = original.renderResult!(...args);
      const node = component as ComponentNode | undefined;
      const diff = node?.constructor.name === "DiffView" ? node : node?.child;
      const promise = diff?.constructor.name === "DiffView" ? diff.ready : undefined;
      if (promise && !seenDiffs.has(promise)) {
        seenDiffs.add(promise);
        diffViews++;
        pendingDiffs++;
        lastStartupActivity = Date.now();
        const settled = () => { pendingDiffs--; lastStartupActivity = Date.now(); };
        void promise.then(settled, settled);
      }
      return component;
    } };
  });

  let pending: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let readinessTimer: ReturnType<typeof setInterval> | undefined;
  let snapshot: (() => void) | undefined;
  let restore: (() => void) | undefined;
  const flush = () => {
    if (!pending.length) return;
    appendFileSync(out, pending.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    pending = [];
  };

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("scroll-benchmark-probe", (host) => {
      const tui = host as unknown as FullscreenTui;
      const widget = { render: () => [], invalidate() {} };
      if (restore) return widget;
      if (typeof tui.doRender !== "function" || typeof tui.invalidate !== "function" ||
          typeof tui.requestRender !== "function" || typeof tui.requestImmediateRender !== "function" ||
          typeof tui.contentChanged !== "boolean" || typeof tui.altScreenActive !== "boolean" || typeof tui.stopped !== "boolean") {
        publish({ error: "Pi fullscreen TUI does not expose the expected render hooks" });
        return widget;
      }

      const { doRender, invalidate, requestRender, requestImmediateRender } = tui;
      let requesting = false;
      function noteRequest(hook: string) {
        const at = Date.now();
        if (!stacks) { pending.push(["request", at]); return; }
        const stack = (new Error().stack ?? "").split("\n").slice(3, 7).map((line) => line.trim()
          .replace(/^at /, "")
          .replace(/(?:file:\/\/)?[^ ()]*\/(pi-slate\/extensions\/|dist\/bundle\/chunks\/)/g, "$1"));
        pending.push(["request", at, `${hook}: ${stack.join(" < ")}`]);
      }
      tui.requestRender = function (force) {
        noteRequest("requestRender");
        requesting = true;
        try { requestRender.call(this, force); }
        finally { requesting = false; }
      };
      tui.requestImmediateRender = function () {
        // requestRender(true) delegates here; count the original request once.
        if (!requesting) noteRequest("requestImmediateRender");
        if (!ready) lastStartupActivity = Date.now();
        requestImmediateRender.call(this);
      };
      tui.invalidate = function () {
        // Pi 1.6's offline init finishes its all-language preload by invalidating
        // the live TUI after the initial transcript render. Sidebar ticks only requestRender().
        if (!ready) {
          if (sawHeading) hostHighlightSettled = true;
          lastStartupActivity = Date.now();
        }
        invalidate.call(this);
      };
      tui.doRender = function () {
        if (this.stopped || !this.altScreenActive) { doRender.call(this); return; }
        const content = this.contentChanged;
        const started = performance.now();
        doRender.call(this);
        const elapsed = performance.now() - started;
        pending.push(["frame", Date.now(), content, elapsed]);
        if (!sawHeading && this.currentLayout?.lines.some((line) => line.includes(HEADING))) {
          sawHeading = true;
          lastStartupActivity = Date.now();
        }
      };
      snapshot = () => publish({ ...inspect(tui, diffViews), ready, diffViews, pendingDiffs, hostHighlightSettled });
      process.on("SIGUSR2", snapshot);
      readinessTimer = setInterval(() => {
        ready = sawHeading && hostHighlightSettled && pendingDiffs === 0 && Date.now() - lastStartupActivity >= quietMs;
        snapshot?.();
        if (ready) clearInterval(readinessTimer);
      }, 100);
      readinessTimer.unref();
      restore = () => { Object.assign(tui, { doRender, invalidate, requestRender, requestImmediateRender }); };
      timer = setInterval(flush, 250);
      timer.unref();
      return widget;
    }, { placement: "belowEditor" });
  });

  pi.on("session_shutdown", () => {
    clearInterval(timer);
    clearInterval(readinessTimer);
    if (snapshot) process.off("SIGUSR2", snapshot);
    restore?.();
    restore = undefined;
    flush();
  });
}
