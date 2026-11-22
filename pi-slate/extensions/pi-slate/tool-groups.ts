import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { TOOL_STYLE_NAMES } from "./tool-style.ts";
import { sameLines } from "./render-lines.ts";
import type { ThinkingView } from "./thinking-label.ts";

const names = new Set(TOOL_STYLE_NAMES);
type Tool = Component & {
  toolCallId: string; toolName: string; expanded: boolean; isPartial: boolean;
  result?: { isError?: boolean; content?: Array<{ type: string }> };
  setExpanded(value: boolean): void;
};
type Thought = Component & ThinkingView;
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
type Part = { lines: string[]; owners: Array<RowOwner | undefined> };
export type RowDecorator = (component: Component, rows: readonly string[], width: number) => readonly string[];
type Segment =
  | { kind: "native"; component: Component }
  | { kind: "group"; start: number; end: number; toolIndices: number[]; failed: number; running: boolean };
/** Paints an explicit display list and maps its mouse rows. Never patches a host component. */
export class ToolGroups {
  private frame?: Part & { parts: Part[] };
  private readonly bodies = new WeakMap<Component, { width: number; rows: string[]; first?: string; rest?: string; version: string | number; part: Part }>();
  private readonly summaries = new WeakMap<Component, { width: number; text: string; part: Part }>();
  private readonly theme: () => Theme | undefined;
  private readonly hint: () => string;
  private readonly decorate?: RowDecorator;
  private readonly decorateVersion?: () => string | number;
  constructor(
    theme: () => Theme | undefined,
    hint = () => keyHint("app.tools.expand", "to expand"),
    decorate?: RowDecorator,
    decorateVersion?: () => string | number,
  ) {
    this.theme = theme; this.hint = hint; this.decorate = decorate; this.decorateVersion = decorateVersion;
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

  private body(component: Component, width: number, first?: string, rest?: string): Part {
    const inset = first === undefined ? 0 : 3;
    const rows = component.render(inset ? Math.max(1, width - inset) : width);
    const version = this.decorateVersion?.() ?? 0;
    const cached = this.bodies.get(component);
    const sameFrame = Boolean(cached && cached.width === width && cached.first === first && cached.rest === rest
      && sameLines(cached.rows, rows));
    if (sameFrame && cached && cached.version === version) return cached.part;
    const snapshot = sameFrame && cached ? cached.rows : rows.slice();
    const decorated = this.decorate?.(component, rows, width) ?? rows;
    const part: Part = { lines: first === undefined ? (decorated === rows ? snapshot : decorated.slice()) : [], owners: [] };
    for (let y = 0; y < decorated.length; y++) {
      if (first !== undefined) {
        const row = decorated[y]!;
        if (!row.trim()) continue;
        part.lines.push(truncateToWidth((part.lines.length ? rest! : first) + row, width));
      }
      part.owners.push({ component, y, height: decorated.length, inset });
    }
    this.bodies.set(component, { width, rows: snapshot, first, rest, version, part });
    return part;
  }

  render(children: readonly Component[], width: number): string[] {
    const parts: Part[] = [];
    let hint: string | undefined;
    let paint: Theme | undefined;
    let guides: string[] | undefined;
    for (const segment of this.plan(children, width)) {
      if (segment.kind === "native") {
        parts.push(this.body(segment.component, width));
        continue;
      }
      const { start, end, toolIndices, failed, running } = segment;
      if (!guides) {
        paint = this.theme();
        guides = ["├─ ", "└─ ", "│  ", "   "].map(guide => paint ? paint.fg("dim", guide) : guide);
      }
      const counts = `${toolIndices.length} tool calls${failed ? ` · ${failed} failed` : ""}`;
      const mark = running ? "◌" : failed ? "✗" : "✓";
      hint ??= this.hint();
      const summary = paint
        ? `${paint.fg(failed ? "error" : running ? "accent" : "success", mark)} ${paint.bold(running ? "Running" : "Done")} ${paint.fg("muted", `(${counts})`)} ${hint}`
        : `${mark} ${running ? "Running" : "Done"} (${counts}) ${hint}`;
      const head = children[start]!;
      let cached = this.summaries.get(head);
      if (cached?.width !== width || cached.text !== summary) {
        cached = { width, text: summary, part: { lines: ["", truncateToWidth(summary, width)], owners: [undefined, undefined] } };
        this.summaries.set(head, cached);
      }
      parts.push(cached.part);
      let nextTool = 0;
      for (let index = start; index < end; index++) {
        const isTool = index === toolIndices[nextTool];
        if (isTool) nextTool++;
        const more = nextTool < toolIndices.length;
        const rest = guides[more ? 2 : 3]!;
        // Preserve source coordinates when native thinking rows join the tree.
        parts.push(this.body(children[index]!, width, isTool ? guides[more ? 0 : 1]! : rest, rest));
      }
    }
    const frame = this.frame;
    if (frame?.parts.length === parts.length && parts.every((part, i) => part === frame.parts[i])) return frame.lines;
    const lines: string[] = [], owners: Part["owners"] = [];
    for (const part of parts) {
      for (const line of part.lines) lines.push(line);
      for (const owner of part.owners) owners.push(owner);
    }
    this.frame = { parts, lines, owners };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
    const owner = this.frame?.owners[event.y];
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
