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
function canGroupAssistant(component: Component): boolean {
  const view = component as Thought;
  const message = view.lastMessage;
  if (message?.role !== "assistant" || !Array.isArray(message.content)
    || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") return false;
  let hasCalls = false, hasThinking = false;
  for (const part of message.content) {
    if (part.type === "text" && part.text?.trim()) return false;
    if (part.type === "toolCall") { if (!names.has(part.name ?? "")) return false; hasCalls = true; }
    if (part.type === "thinking" && part.thinking?.trim()) hasThinking = true;
  }
  return hasCalls && (!hasThinking || (view.hideThinkingBlock === true
    && ![...view.thinkingVisibilityOverrides?.values() ?? []].includes(false)));
}

type RowOwner = { component: Component; y: number; height: number; inset: number };
type Segment =
  | { kind: "native"; component: Component }
  | { kind: "group"; start: number; end: number; toolIndices: number[]; failed: number; running: boolean };
/** Paints an explicit display list and maps its mouse rows. Never patches a host component. */
export class ToolGroups {
  private owners: Array<RowOwner | undefined> = [];
  private readonly theme: () => Theme | undefined;
  private readonly hint: () => string;
  constructor(theme: () => Theme | undefined, hint = () => keyHint("app.tools.expand", "to expand")) {
    this.theme = theme; this.hint = hint;
  }

  /** Read all grouping metadata before painting so a fault cannot duplicate earlier renders. */
  private plan(children: readonly Component[], width: number): Segment[] {
    const segments: Segment[] = [];
    for (let i = 0; i < children.length;) {
      let end = i, failed = 0, running = false, expanded = false;
      const toolIndices: number[] = [];
      while (end < children.length) {
        const child = children[end]!;
        if (tool(child)) {
          toolIndices.push(end);
          expanded ||= child.expanded;
          running ||= !child.result || child.isPartial;
          if (child.result?.isError) failed++;
        } else if (!canGroupAssistant(child)) break;
        end++;
      }
      if (toolIndices.length < 2 || expanded || width < 12) {
        const stop = Math.max(i + 1, end);
        for (; i < stop; i++) segments.push({ kind: "native", component: children[i]! });
        continue;
      }
      segments.push({ kind: "group", start: i, end, toolIndices, failed, running });
      i = end;
    }
    return segments;
  }

  render(children: readonly Component[], width: number): string[] {
    const lines: string[] = [], owners: Array<RowOwner | undefined> = [];
    const append = (component: Component, rows: string[]): void => {
      for (let y = 0; y < rows.length; y++) { lines.push(rows[y]!); owners.push({ component, y, height: rows.length, inset: 0 }); }
    };
    for (const segment of this.plan(children, width)) {
      if (segment.kind === "native") {
        append(segment.component, segment.component.render(width));
        continue;
      }
      const { start, end, toolIndices, failed, running } = segment;
      const paint = this.theme();
      const parts = [`${toolIndices.length} tool calls`];
      if (failed) parts.push(`${failed} failed`);
      const mark = running ? "◌" : failed ? "✗" : "✓";
      const summary = paint
        ? `${paint.fg(failed ? "error" : running ? "accent" : "success", mark)} ${paint.bold(running ? "Running" : "Done")} ${paint.fg("muted", `(${parts.join(" · ")})`)} ${this.hint()}`
        : `${mark} ${running ? "Running" : "Done"} (${parts.join(" · ")}) ${this.hint()}`;
      lines.push("", truncateToWidth(summary, width));
      owners.push(undefined, undefined);
      let nextTool = 0;
      for (let index = start; index < end; index++) {
        const component = children[index]!;
        const isTool = index === toolIndices[nextTool];
        if (isTool) nextTool++;
        // Native assistant rows (thinking toggles) join the tree; local row coordinates keep their click regions.
        const rows = component.render(Math.max(1, width - 3));
        const more = nextTool < toolIndices.length;
        let first = isTool;
        for (let y = 0; y < rows.length; y++) {
          const row = rows[y]!;
          if (!row.trim()) continue;
          const guide = first ? more ? "├─ " : "└─ " : more ? "│  " : "   ";
          first = false;
          lines.push(truncateToWidth((paint ? paint.fg("dim", guide) : guide) + row, width));
          owners.push({ component, y, height: rows.length, inset: 3 });
        }
      }
    }
    this.owners = owners;
    return lines;
  }

  handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
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
  }
}
