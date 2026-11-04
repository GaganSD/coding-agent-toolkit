import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";

const SAMPLE_WIDTH = 80;

function renderedPlain(component: Component, width = SAMPLE_WIDTH): string {
  try {
    return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
  } catch {
    return "";
  }
}

function isBlankSpacer(component: Component): boolean {
  const plain = renderedPlain(component, 10);
  return plain.trim() === "";
}

const STOCK_NEW_SESSION_NOTICE = "✓ New session started";

export function isStockNewSessionNotice(component: Component): boolean {
  let lines: string[];
  try { lines = component.render(SAMPLE_WIDTH).map((line) => stripVTControlCharacters(line)); }
  catch { return false; }
  const body = lines.map((line) => line.trim()).filter(Boolean);
  // Core ThemedText uses padY=1, so the stock banner is more than one painted line.
  return body.length === 1 && body[0] === STOCK_NEW_SESSION_NOTICE && lines.length > 1;
}

export type ChatContainer = {
  children: Component[];
  removeChild(component: Component): void;
  addChild(component: Component): void;
};

const FILTERED = Symbol("pi-slate.new-session-notice-filter");

type FilteredAdd = ChatContainer["addChild"] & { [FILTERED]?: true; dispose?: () => void };

/**
 * Keeps the stock chat copy of "✓ New session started" out of the transcript.
 * Also drops the blank spacer core adds right
 * before the notice. The wrap binds the addChild present at install time, so it
 * composes with MessageWindow in either order. If a later wrap replaces addChild,
 * calling this again re-wraps the current function. dispose() stops filtering
 * even if addChild was wrapped again later.
 */
export function installNewSessionNoticeFilter(container: ChatContainer): () => void {
  const current = container.addChild as FilteredAdd;
  if (current[FILTERED]) return current.dispose ?? (() => {});
  let disposed = false;
  const addChild = container.addChild.bind(container);
  const wrapped: FilteredAdd = (component: Component): void => {
    if (disposed || !isStockNewSessionNotice(component)) {
      addChild(component);
      return;
    }
    const previous = container.children.at(-1);
    if (previous && isBlankSpacer(previous)) container.removeChild(previous);
  };
  const dispose = (): void => {
    disposed = true;
    if (container.addChild === wrapped) container.addChild = addChild;
  };
  wrapped[FILTERED] = true;
  wrapped.dispose = dispose;
  container.addChild = wrapped;
  return dispose;
}
