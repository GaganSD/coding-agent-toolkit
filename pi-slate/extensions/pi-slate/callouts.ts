import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Colorize = (text: string) => string;
export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

/** Theme colors used by quiet callouts. */
export type CalloutPalette = Record<CalloutKind, Colorize>;

export const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

export function createCalloutPalette(theme: Theme): CalloutPalette {
  return {
    note: text => theme.fg("accent", text),
    tip: text => theme.fg("success", text),
    important: text => theme.fg("mdLink", text),
    warning: text => theme.fg("warning", text),
    caution: text => theme.fg("error", text),
  };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CALLOUT = /^ {0,3}>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

interface InlinePart {
  text: string;
  code: boolean;
}

/** Split on CommonMark code spans, keeping the delimiters and leaving unmatched backticks as text. */
function splitInlineCode(line: string): InlinePart[] {
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

// Private-use separators keep code spans atomic while wrapping. They are removed
// before the Markdown reaches Pi, so the body keeps ordinary spaces and line breaks.
const CODE_SPACE = "\uE000";
const CODE_BREAK = "\uE001";

function protectCodeSpaces(text: string): string {
  return splitInlineCode(text)
    .map(part => part.code ? part.text.replaceAll(" ", CODE_SPACE) : part.text)
    .join("");
}

/** Split a code span wider than the rail budget into complete, independently wrapped spans. */
function splitLongCodeSpans(text: string, width: number): string {
  return splitInlineCode(text).map(part => {
    if (!part.code) return part.text;
    const match = /^(`+)([\s\S]*)\1$/.exec(part.text);
    if (!match || visibleWidth(part.text) <= width) return part.text;
    const [, fence, content] = match;
    const contentWidth = Math.max(1, width - fence![0]!.length * 2);
    return wrapTextWithAnsi(content!, contentWidth)
      .map(chunk => `${fence}${chunk}${fence}`)
      .join(CODE_BREAK);
  }).join("");
}

function calloutBodyLines(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const body = raw.replace(QUOTE_PREFIX, "");
    if (!body) { out.push(""); continue; }
    for (const segment of splitLongCodeSpans(body, width).split(CODE_BREAK)) {
      const protectedBody = protectCodeSpaces(segment);
      for (const wrapped of wrapTextWithAnsi(protectedBody, width)) {
        out.push(wrapped.replaceAll(CODE_SPACE, " "));
      }
    }
  }
  return out;
}

/**
 * Replace GitHub alert blockquotes with a colored rail and a short bold title.
 * Body lines stay Markdown, so inline bold and code still render; each line is
 * wrapped here and joined with hard breaks so Pi keeps the rail on every row.
 */
export function decorateCallouts(
  markdown: string,
  palette: CalloutPalette,
  availableWidth: number,
): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const bodyWidth = Math.max(1, Math.floor(availableWidth) - 2);
  let fence: { marker: string; length: number } | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const content = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const fenceMatch = FENCE.exec(content);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length) fence = undefined;
      out.push(line); index++; continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      out.push(line); index++; continue;
    }
    const match = CALLOUT.exec(line);
    if (!match) { out.push(line); index++; continue; }

    const kind = match[1]!.toLowerCase() as CalloutKind;
    const paint = palette[kind];
    let end = index + 1;
    const quoted: string[] = [];
    while (end < lines.length && QUOTE_PREFIX.test(lines[end]!) && !CALLOUT.test(lines[end]!)) {
      quoted.push(lines[end]!);
      end++;
    }

    const rail = paint("│");
    const rendered = [`${rail} ${paint(`**${CALLOUT_LABELS[kind]}**`)}`];
    for (const body of calloutBodyLines(quoted, bodyWidth)) {
      rendered.push(body ? `${rail} ${body}` : rail);
    }
    out.push(rendered.join("  \n"));
    if (end < lines.length && lines[end] !== "") out.push("");
    index = end;
  }
  return out.join("\n");
}
