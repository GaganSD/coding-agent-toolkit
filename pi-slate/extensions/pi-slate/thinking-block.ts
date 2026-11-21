import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AssistantContentBlock } from "./token-rate.ts";

export const THINKING_GLYPH = "∴";
export const THINKING_COLLAPSED = "›";
export const THINKING_EXPANDED = "⌄";
export const THINKING_RAIL = "│";
export const THINKING_FALLBACK_LABEL = `${THINKING_GLYPH} Thought ${THINKING_COLLAPSED}`;

/** Structural view of Pi's assistant component; no host instance is patched. */
export type ThinkingView = {
  content?: readonly AssistantContentBlock[];
  lastMessage?: { content?: readonly AssistantContentBlock[] };
  hideThinkingBlock?: boolean;
  thinkingVisibilityOverrides?: Map<number, boolean>;
  messageId?: string;
};

export type ThinkingRun = {
  /** Pi's thinking-run index, also the key for `thinkingVisibilityOverrides`. */
  index: number;
  start: number;
  end: number;
  thinking: string;
  hidden: boolean;
};

export function thinkingRunText(content: readonly AssistantContentBlock[] | undefined, contentIndex: number): string {
  if (!content || content[contentIndex]?.type !== "thinking") return "";
  let start = contentIndex;
  while (start > 0 && content[start - 1]?.type === "thinking") start--;
  let end = contentIndex;
  while (end + 1 < content.length && content[end + 1]?.type === "thinking") end++;
  const blocks: string[] = [];
  for (let i = start; i <= end; i++) {
    const part = content[i];
    if (part?.type !== "thinking") continue;
    const thinking = part.thinking?.trim();
    if (thinking) blocks.push(thinking);
  }
  return blocks.join("\n\n");
}

/** Mirror Pi's grouping: consecutive thinking blocks with non-empty text form one click target. */
export function thinkingRuns(view: ThinkingView | undefined): ThinkingRun[] {
  const content = view?.lastMessage?.content ?? view?.content;
  if (!Array.isArray(content)) return [];
  const runs: ThinkingRun[] = [];
  let runIndex = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "thinking") continue;
    const start = i;
    const blocks: string[] = [];
    for (; i < content.length && content[i]?.type === "thinking"; i++) {
      const thinking = content[i]?.thinking?.trim();
      if (thinking) blocks.push(thinking);
    }
    const end = i - 1;
    i--;
    if (blocks.length === 0) continue;
    const index = runIndex++;
    runs.push({
      index,
      start,
      end,
      thinking: blocks.join("\n\n"),
      hidden: view?.thinkingVisibilityOverrides?.get(index) ?? view?.hideThinkingBlock === true,
    });
  }
  return runs;
}

export function hiddenThinkingRuns(view: ThinkingView | undefined): ThinkingRun[] {
  return thinkingRuns(view).filter((run) => run.hidden);
}

export function thinkingWordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export type ThinkingHeaderOptions = {
  streaming?: boolean;
  elapsedMs?: number | null;
  durationMs?: number | null;
  words?: number;
  expanded: boolean;
};

function completedSeconds(durationMs: number | null | undefined): number | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return Math.max(1, Math.floor(durationMs / 1000));
}

export function formatThinkingHeader(options: ThinkingHeaderOptions): string {
  const chevron = options.expanded ? THINKING_EXPANDED : THINKING_COLLAPSED;
  let label: string;
  if (options.streaming) {
    const elapsed = options.elapsedMs;
    label = elapsed !== null && elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 1000
      ? `Thinking ${Math.floor(elapsed / 1000)}s`
      : "Thinking";
  } else {
    const seconds = completedSeconds(options.durationMs);
    if (seconds !== null) {
      label = `Thought for ${seconds}s`;
    } else {
      const words = Math.max(0, Math.round(options.words ?? 0));
      label = words > 0 ? `Thought · ${words} ${words === 1 ? "word" : "words"}` : "Thought";
    }
  }
  return `${THINKING_GLYPH} ${label} ${chevron}`;
}

/** Only durations observed live in this session are stored; restored content falls back to words. */
export class ThinkingDurations {
  private readonly values = new Map<string, number>();
  private readonly limit: number;

  constructor(limit = 512) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  record(thinking: string, elapsedMs: number): void {
    const key = thinking.trim();
    if (!key || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.values.delete(key);
    this.values.set(key, elapsedMs);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  lookup(thinking: string): number | undefined {
    return this.values.get(thinking.trim());
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}

export type ThinkingTheme = {
  fg(color: string, text: string): string;
  italic?(text: string): string;
};

export type ThinkingPalette = {
  /** Quiet non-italic header, including Pi's glyph. */
  header(text: string): string;
  /** Fainter rail; resets the foreground, so body text must reopen the thinking style. */
  rail(text: string): string;
  /** Reopens Pi's thinkingText + italic defaults after the rail reset. */
  thinkingReopen: string;
};

function prefixOf(render: (text: string) => string): string {
  const sentinel = "\u0000";
  const styled = render(sentinel);
  const index = styled.indexOf(sentinel);
  return index >= 0 ? styled.slice(0, index) : "";
}

function safePaint(theme: ThinkingTheme, color: string, fallback: string): (text: string) => string {
  return (text) => {
    try {
      return theme.fg(color, text);
    } catch {
      try {
        return theme.fg(fallback, text);
      } catch {
        return text;
      }
    }
  };
}

export function createThinkingPalette(theme: ThinkingTheme): ThinkingPalette {
  const muted = safePaint(theme, "muted", "dim");
  const dim = safePaint(theme, "dim", "muted");
  const thinking = safePaint(theme, "thinkingText", "muted");
  const italicPrefix = typeof theme.italic === "function" ? prefixOf((text) => theme.italic!(text)) : "";
  const italicOff = italicPrefix ? "\x1b[23m" : "";
  return {
    header: (text) => `${italicOff}${muted(text)}`,
    rail: dim,
    thinkingReopen: `${prefixOf((text) => thinking(text))}${italicPrefix}`,
  };
}

const CODE_SPACE = "\uE000";
const CODE_BREAK = "\uE001";

type InlinePart = { text: string; code: boolean };

/** Split on CommonMark code spans so wrapping cannot strand half a span on a row. */
export function splitInlineCode(line: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let textStart = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\" && line[i + 1] === "`") { i += 2; continue; }
    if (line[i] !== "`") { i++; continue; }
    let run = 0;
    while (line[i + run] === "`") run++;
    let closing = -1;
    let j = i + run;
    while (j < line.length) {
      if (line[j] !== "`") { j++; continue; }
      let closeRun = 0;
      while (line[j + closeRun] === "`") closeRun++;
      if (closeRun === run) { closing = j; break; }
      j += closeRun;
    }
    if (closing < 0) { i += run; continue; }
    if (i > textStart) parts.push({ text: line.slice(textStart, i), code: false });
    parts.push({ text: line.slice(i, closing + run), code: true });
    i = closing + run;
    textStart = i;
  }
  if (textStart < line.length) parts.push({ text: line.slice(textStart), code: false });
  return parts;
}

function protectCodeSpaces(text: string): string {
  return splitInlineCode(text)
    .map((part) => part.code ? part.text.replaceAll(" ", CODE_SPACE) : part.text)
    .join("");
}

function splitLongCodeSpans(text: string, width: number): string {
  return splitInlineCode(text).map((part) => {
    if (!part.code) return part.text;
    const match = /^(`+)([\s\S]*)\1$/.exec(part.text);
    if (!match || visibleWidth(part.text) <= width) return part.text;
    const [, fence, content] = match;
    const contentWidth = Math.max(1, width - fence![0]!.length * 2);
    return wrapTextWithAnsi(content!, contentWidth)
      .map((chunk) => `${fence}${chunk}${fence}`)
      .join(CODE_BREAK);
  }).join("");
}

/** Wrap one logical thinking line to the rail's body budget without losing code-span delimiters. */
export function wrapThinkingLine(line: string, width: number): string[] {
  if (!line) return [""];
  const budget = Math.max(1, Math.floor(width));
  return splitLongCodeSpans(line, budget)
    .split(CODE_BREAK)
    .flatMap((segment) => wrapTextWithAnsi(protectCodeSpaces(segment), budget))
    .map((wrapped) => wrapped.replaceAll(CODE_SPACE, " "));
}

export type ThinkingBlockOptions = {
  palette: ThinkingPalette;
  header: string;
  availableWidth: number;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Rail-prefixed fences cannot open a code block, so render their markers and content literally. */
function escapeBackticks(line: string): string {
  return line.replaceAll("`", "\\`");
}

/**
 * Expanded thinking: a quiet header plus a railed, self-wrapped body. Pi applies its thinking
 * color/italic as the Markdown default style; the rail resets the foreground, so each body row
 * reopens that default explicitly.
 */
export function renderThinkingBlock(markdown: string, options: ThinkingBlockOptions): string {
  const text = markdown.replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const width = Number.isFinite(options.availableWidth) ? Math.max(1, Math.floor(options.availableWidth)) : 80;
  const header = truncateToWidth(options.header, width, "…");
  const bodyWidth = Math.max(1, width - 2);
  const lines = [options.palette.header(header)];
  let fence: { marker: string; length: number } | undefined;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) {
      lines.push(options.palette.rail(THINKING_RAIL));
      continue;
    }
    const fenceMatch = FENCE.exec(raw);
    let body = raw;
    if (fence) {
      body = escapeBackticks(raw);
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length) fence = undefined;
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      body = escapeBackticks(raw);
    }
    for (const wrapped of wrapThinkingLine(body, bodyWidth)) {
      lines.push(`${options.palette.rail(THINKING_RAIL)} ${options.palette.thinkingReopen}${wrapped}`);
    }
  }
  return lines.join("  \n");
}

/** Replace Pi's static hidden label rows with per-run headers, preserving indentation and width. */
export function replaceHiddenThinkingRows(
  rows: readonly string[],
  headers: readonly string[],
  label = THINKING_FALLBACK_LABEL,
): readonly string[] {
  if (headers.length === 0) return rows;
  let next = 0;
  let replaced = false;
  const output = rows.map((row) => {
    if (next >= headers.length) return row;
    const plain = stripVTControlCharacters(row);
    if (plain.trim() !== label.trim()) return row;
    replaced = true;
    const width = visibleWidth(row);
    const leading = /^\s*/.exec(plain)?.[0] ?? "";
    const header = headers[next++]!;
    return width > 0 ? truncateToWidth(leading + header, width, "…", true) : header;
  });
  return replaced ? output : rows;
}
