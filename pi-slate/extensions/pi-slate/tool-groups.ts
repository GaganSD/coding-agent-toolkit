import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type Container, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { TOOL_STYLE_NAMES } from "./tool-style.ts";

const names = new Set(TOOL_STYLE_NAMES);
type Tool = Component & {
  toolCallId: string; toolName: string; expanded: boolean; isPartial: boolean;
  result?: { isError?: boolean; content?: Array<{ type: string }> };
  setExpanded(value: boolean): void;
};
type Thought = Component & { hideThinkingBlock?: boolean; thinkingVisibilityOverrides?: Map<number, boolean>; lastMessage?: { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string; thinking?: string; name?: string }> } };
function tool(component: Component): component is Tool {
  const value = component as Partial<Tool>;
  return typeof value.toolCallId === "string" && names.has(value.toolName ?? "")
    && typeof value.setExpanded === "function" && typeof value.expanded === "boolean"
    && !value.result?.content?.some((part) => part.type === "image");
}
function thoughts(component: Component): number | undefined {
  const message = (component as Thought).lastMessage;
  if (message?.role !== "assistant" || !Array.isArray(message.content)
    || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") return undefined;
  let calls = 0, count = 0;
  for (const part of message.content) {
    if (part.type === "text" && part.text?.trim()) return undefined;
    if (part.type === "toolCall") { if (!names.has(part.name ?? "")) return undefined; calls++; }
    if (part.type === "thinking" && part.thinking?.trim()) count++;
  }
  const view = component as Thought;
  if (count && (view.hideThinkingBlock !== true || [...view.thinkingVisibilityOverrides?.values() ?? []].some((hidden) => !hidden))) return undefined;
  return calls ? count : undefined;
}

type RowOwner = { component: Component; y: number; height: number; inset: number };
/** Instance-scoped adapter: children stay intact for host expansion, history and windowing.
 * No prototype mutations, timers, transcript replay, or retained historical output. */
export class ToolGroups {
  private readonly originalRender: Container["render"];
  private readonly originalMouse: Container["handleMouse"];
  private readonly renderWrapper: Container["render"];
  private readonly mouseWrapper: Container["handleMouse"];
  private owners: Array<RowOwner | undefined> = [];
  readonly container: Container;
  constructor(container: Container, theme: () => Theme | undefined, hint = () => keyHint("app.tools.expand", "to expand")) {
    this.container = container;
    this.originalRender = container.render;
    this.originalMouse = container.handleMouse;
    this.renderWrapper = (width) => {
      const lines: string[] = [], owners: Array<RowOwner | undefined> = [];
      const append = (component: Component, rows: string[]): void => {
        for (let y = 0; y < rows.length; y++) { lines.push(rows[y]!); owners.push({ component, y, height: rows.length, inset: 0 }); }
      };
      const children = container.children;
      for (let i = 0; i < children.length;) {
        let end = i, thoughtCount = 0, failed = 0, running = false, expanded = false;
        const tools: Tool[] = [];
        while (end < children.length) {
          const child = children[end]!;
          if (tool(child)) {
            tools.push(child); expanded ||= child.expanded;
            running ||= !child.result || child.isPartial;
            if (child.result?.isError) failed++;
          } else {
            const count = thoughts(child);
            if (count === undefined) break;
            thoughtCount += count;
          }
          end++;
        }
        if (tools.length < 2 || expanded || width < 12) {
          const stop = Math.max(i + 1, end);
          for (; i < stop; i++) append(children[i]!, children[i]!.render(width));
          continue;
        }
        const paint = theme();
        const parts = [`${tools.length} tool calls`];
        if (thoughtCount) parts.push(`${thoughtCount} thought${thoughtCount === 1 ? "" : "s"}`);
        if (failed) parts.push(`${failed} failed`);
        const mark = running ? "◌" : failed ? "✗" : "✓";
        const summary = paint
          ? `${paint.fg(failed ? "error" : running ? "accent" : "success", mark)} ${paint.bold(running ? "Running" : "Done")} ${paint.fg("muted", `(${parts.join(" · ")})`)} ${hint()}`
          : `${mark} ${running ? "Running" : "Done"} (${parts.join(" · ")}) ${hint()}`;
        lines.push("", truncateToWidth(summary, width));
        owners.push(undefined, undefined);
        for (let index = 0; index < tools.length; index++) {
          const member = tools[index]!;
          // Preserve local row coordinates for the host's existing click-to-expand region.
          const rows = member.render(Math.max(1, width - 3));
          const last = index === tools.length - 1;
          let first = true;
          for (let y = 0; y < rows.length; y++) {
            const row = rows[y]!;
            if (!row.trim()) continue;
            const guide = first ? last ? "└─ " : "├─ " : last ? "   " : "│  ";
            first = false;
            lines.push(truncateToWidth((paint ? paint.fg("dim", guide) : guide) + row, width));
            owners.push({ component: member, y, height: rows.length, inset: 3 });
          }
        }
        i = end;
      }
      this.owners = owners;
      return lines;
    };
    this.mouseWrapper = (event: TuiMouseEvent) => {
      const owner = this.owners[event.y];
      if (!owner) return undefined;
      const local = { ...event, x: event.x - owner.inset, y: owner.y, width: Math.max(1, event.width - owner.inset), height: owner.height };
      if (local.x < 0) return undefined;
      const result = owner.component.handleMouse?.(local);
      if (!result || !(result.handled || result.capture || result.focus)) return undefined;
      // Nested host containers already carry exact capture/focus coordinates.
      if ("target" in result) return result as NonNullable<ReturnType<Container["handleMouse"]>>;
      return { ...result, handled: true, target: {
        component: owner.component, originX: event.screenX - local.x,
        originY: event.screenY - local.y, width: local.width, height: local.height,
      }, ...(result.focus ? { focusTarget: owner.component } : {}) };
    };
    container.render = this.renderWrapper;
    container.handleMouse = this.mouseWrapper;
  }
  dispose(): void {
    if (this.container.render === this.renderWrapper) this.container.render = this.originalRender;
    if (this.container.handleMouse === this.mouseWrapper) this.container.handleMouse = this.originalMouse;
    this.owners = [];
  }
}
