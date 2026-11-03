import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const names: Record<string, string> = {
  read: "Read", bash: "Bash", grep: "Grep", find: "Find", ls: "Ls",
  write: "Write", edit: "Edit", codemode: "Codemode", recall: "Recall",
};

/** File mutations keep their diff preview instead of collapsing to a line counter. */
const diffNames = new Set(["write", "edit"]);

export const TOOL_STYLE_NAMES: readonly string[] = Object.freeze(Object.keys(names));

// Tool arguments and output are untrusted terminal input, not ANSI markup.
function clean(value: unknown): string {
  return stripVTControlCharacters(typeof value === "string" ? value : String(value ?? ""))
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (char) =>
      char === "\n" || char === "\r" || char === "\t" ? " " : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function argumentsText(name: string, args: Record<string, unknown>): string {
  // A heading cannot show more than a screenful; bound work even for megabyte commands.
  const compact = (value: unknown) => typeof value === "string" && value.length > 2048
    ? clean(value.slice(0, 2048)) + "…" : clean(value);
  const path = args.file_path ?? args.path;
  switch (name) {
    case "read": return compact(path) + (args.offset != null || args.limit != null
      ? `, offset=${compact(args.offset ?? 1)}${args.limit != null ? `, limit=${compact(args.limit)}` : ""}` : "");
    case "bash": return compact(args.command);
    case "grep": case "find": return [args.pattern, path].filter((v) => v != null).map(compact).join(", ");
    case "ls": case "write": case "edit": return compact(path);
    // Keep source in the original expanded call, never in the compact heading.
    case "codemode": return compact(args.title ?? args.description ?? "script");
    case "recall": return compact(args.query ?? args.topic ?? args.input);
    default: return "";
  }
}

/** A shell without backgrounds; applies SDK outputPad on both sides, including narrow terminals. */
class Padded implements Component {
  private child: Component;
  private pad: number;
  constructor(child: Component, pad: number) { this.child = child; this.pad = pad; }
  render(width: number): string[] {
    if (width <= 0) return [];
    const pad = Math.min(Math.max(0, this.pad), Math.floor(width / 2));
    return this.child.render(Math.max(0, width - 2 * pad)).map((line) =>
      truncateToWidth(" ".repeat(pad) + truncateToWidth(line, width - 2 * pad, ""), width, ""));
  }
  invalidate(): void { this.child.invalidate(); }
}

function line(text: () => string): Component {
  return { render: (width) => width > 0 ? [truncateToWidth(text(), width)] : [], invalidate() {} };
}

type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Summary = { lines: number; dataLines: number; images: number; first: string; added: number; removed: number; hasDiff: boolean; limited: boolean; truncated: boolean };

function summarize(result: Result): Summary {
  let lines = 0, dataLines = 0;
  let first = "";
  const details = result.details;
  const limited = Boolean(details?.matchLimitReached || details?.resultLimitReached || details?.entryLimitReached);
  const truncated = details?.truncation?.truncated === true || details?.linesTruncated === true;
  for (const block of result.content) {
    if (block.type !== "text" || !block.text) continue;
    const text = block.text;
    // Search tools append an SDK notice trailer, not another result. Only strip
    // it when structured metadata confirms the notice, never based on a filename.
    const notice = limited || truncated ? text.lastIndexOf("\n\n[") : -1;
    const end = notice >= 0 && text.endsWith("]") ? notice : text.length;
    let count = 0, dataCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) { count++; if (i < end) dataCount++; }
    }
    lines += count + (text.endsWith("\n") ? 0 : 1);
    dataLines += dataCount + (end > 0 && text.charCodeAt(end - 1) !== 10 ? 1 : 0);
    if (!first) first = clean(text.slice(0, Math.min(text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"), 240)));
  }
  const patch = details?.slateDiff?.patch ?? details?.patch ?? details?.diff;
  let added = 0;
  let removed = 0;
  if (typeof patch === "string") {
    // Both Slate's unified patches and the SDK's numbered display diff are supported.
    const unified = /^(?:@@|--- |\+\+\+ )/m.test(patch);
    let oldLeft = 0;
    let newLeft = 0;
    for (const row of patch.split("\n")) {
      if (unified) {
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(row);
        if (hunk) { oldLeft = Number(hunk[1] ?? 1); newLeft = Number(hunk[2] ?? 1); continue; }
        if (oldLeft === 0 && newLeft === 0) continue;
      }
      if (row.startsWith("+")) { added++; newLeft = Math.max(0, newLeft - 1); }
      else if (row.startsWith("-")) { removed++; oldLeft = Math.max(0, oldLeft - 1); }
      else if (row.startsWith(" ")) { oldLeft = Math.max(0, oldLeft - 1); newLeft = Math.max(0, newLeft - 1); }
    }
  }
  return { lines, dataLines, images: result.content.filter((block) => block.type === "image").length, first, added, removed, hasDiff: typeof patch === "string", limited, truncated };
}

/** Presentation only: tool schemas, execution, exposure and registration are untouched. */
export function installToolStyle(pi: ExtensionAPI): void {
  // SDK makes a fresh result envelope on redraw; content/details keep their result identity.
  const summaries = new WeakMap<Result["content"], { details: unknown; summary: Summary }>();
  const summaryFor = (result: Result): Summary => {
    const cached = summaries.get(result.content);
    if (cached && cached.details === result.details) return cached.summary;
    const summary = summarize(result);
    summaries.set(result.content, { details: result.details, summary });
    return summary;
  };
  pi.registerToolRenderer((name, next) => {
    if (!Object.hasOwn(names, name)) return next();
    const original = next();
    // Separate original state and render slots from ours, also across expansion toggles.
    const originals = new WeakMap<object, {
      state: Record<string, unknown>; call?: Component; result?: Component;
      terminalContent?: Result["content"]; terminalDetails?: unknown;
    }>();
    function delegate(slot: "call" | "result", context: ToolRenderContext, render: (ctx: ToolRenderContext) => Component): Component {
      let saved = originals.get(context.state);
      if (!saved) { saved = { state: {} }; originals.set(context.state, saved); }
      const component = render({ ...context, state: saved.state, lastComponent: saved[slot] });
      saved[slot] = component;
      return original?.renderShell === "self" ? component : new Padded(component, context.outputPad);
    }
    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        if (context.expanded && original?.renderCall) {
          return delegate("call", context, (ctx) => original.renderCall!(args, theme, ctx));
        }
        if (context.expanded) {
          const source = (args as Record<string, unknown>)?.code ?? (args as Record<string, unknown>)?.source;
          const text = source == null ? `${names[name]} (${argumentsText(name, (args ?? {}) as Record<string, unknown>)})` : String(source);
          return new Padded(new Text(text.split("\n").map(clean).join("\n"), 0, 0), context.outputPad);
        }
        const status = () => context.isError ? "✗" : context.isPartial
          ? context.executionStarted ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(Date.now() / 100) % 10]! : "·" : "✓";
        const color = context.isError ? "error" : context.isPartial ? "muted" : "success";
        const heading = theme.fg("toolTitle", theme.bold(names[name]!))
          + theme.fg("muted", ` (${argumentsText(name, (args ?? {}) as Record<string, unknown>)})`);
        return new Padded(line(() => theme.fg(color, status()) + " " + heading), context.outputPad);
      },
      renderResult(result, options, theme, context) {
        const saved = originals.get(context.state);
        const summary = summaryFor(result);
        const terminal = !options.isPartial || context.isError;
        // A "+N -M" counter cannot show what an edit changed; the tool's own
        // renderer self-limits its rows, so it can own the collapsed view too.
        const preview = terminal && !context.isError && diffNames.has(name) && summary.hasDiff;
        const needsTerminalUpdate = terminal && saved
          && (saved.terminalContent !== result.content || saved.terminalDetails !== result.details);
        if (original?.renderResult && (options.expanded || needsTerminalUpdate || preview)) {
          // An activated native renderer may own a live clock. Deliver completion
          // even after collapse, once per result, so it can release that resource.
          const component = delegate("result", context, (ctx) => original.renderResult!(result, options, theme, ctx));
          if (terminal) {
            const current = originals.get(context.state)!;
            current.terminalContent = result.content; current.terminalDetails = result.details;
          }
          if (options.expanded || preview) return component;
        }
        if (options.expanded) {
          const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          return new Padded(new Text(text.split("\n").map(clean).join("\n"), 0, 0), context.outputPad);
        }
        let text: string;
        if (context.isError) text = summary.first || "Failed";
        else if (options.isPartial) text = context.executionStarted ? "Running…" : "Pending…";
        else if (summary.hasDiff) text = `+${summary.added} -${summary.removed}`;
        else if (name === "grep") text = /^(No matches|No results)/i.test(summary.first) ? "No matches" : `${summary.dataLines} line${summary.dataLines === 1 ? "" : "s"}`;
        else if (name === "find" || name === "ls") text = /^(No files|No entries)/i.test(summary.first) ? summary.first
          : summary.first === "(empty directory)" ? "0 entries"
          : `${summary.dataLines} ${name === "find" ? summary.dataLines === 1 ? "file" : "files" : summary.dataLines === 1 ? "entry" : "entries"}`;
        else if (diffNames.has(name)) text = summary.first || "Done";
        else text = summary.images && !summary.lines ? `${summary.images === 1 ? "image" : `${summary.images} images`}` : `${summary.lines} line${summary.lines === 1 ? "" : "s"}`;
        let suffix = summary.limited ? " · limited" : "";
        if (summary.truncated) suffix += " · truncated";
        const args = context.args as Record<string, unknown> | undefined;
        if (name === "bash" && args?.timeout != null) suffix += ` · timeout=${clean(args.timeout)}s`;
        if (context.durationMs !== undefined) suffix += ` · ${context.durationMs}ms`;
        return new Padded(line(() => {
          if (summary.hasDiff && !context.isError && !options.isPartial) {
            return theme.fg("muted", "└ ") + theme.fg("success", `+${summary.added}`) + " " + theme.fg("error", `-${summary.removed}`) + theme.fg("muted", suffix);
          }
          return theme.fg(context.isError ? "error" : "muted", `└ ${text}${suffix}`);
        }), context.outputPad);
      },
    };
  });
}
