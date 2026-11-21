import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Minimal slice of Pi's theme used to build reply colors. */
export interface AccentTheme {
  fg(color: never, text: string): string;
}

export type Colorize = (text: string) => string;
export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

/** Theme colors used by reply accents and quiet callouts. */
export interface AccentPalette {
  dim: Colorize;
  success: Colorize;
  error: Colorize;
  warning: Colorize;
  accent: Colorize;
  note: Colorize;
  tip: Colorize;
  important: Colorize;
  caution: Colorize;
  /** Restores bold weight after a color reset. */
  boldReopen?: string;
}

export const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

export function createAccentPalette(theme: AccentTheme): AccentPalette {
  const fg = (color: string): Colorize => text => theme.fg(color as never, text);
  return {
    dim: fg("dim"),
    success: fg("success"),
    error: fg("error"),
    warning: fg("warning"),
    accent: fg("accent"),
    note: fg("accent"),
    tip: fg("success"),
    important: fg("mdLink"),
    caution: fg("error"),
    boldReopen: "\x1b[1m",
  };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s/;
const BLOCKQUOTE = /^ {0,3}>/;
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CALLOUT = /^ {0,3}>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;

type AccentTone = Exclude<keyof AccentPalette, "boldReopen">;

interface AccentRule {
  token: string;
  tone: AccentTone;
}

const ACCENT_RULES: AccentRule[] = [
  { token: "├──", tone: "dim" },
  { token: "└──", tone: "dim" },
  { token: "✓", tone: "success" },
  { token: "✔", tone: "success" },
  { token: "✗", tone: "error" },
  { token: "✘", tone: "error" },
  { token: "→", tone: "accent" },
];

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

interface InlinePart {
  text: string;
  code: boolean;
}

/** Split on CommonMark code spans, keeping the delimiters and leaving unmatched backticks as text. */
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

interface BoldState {
  marker?: string;
}

function decorateProse(text: string, palette: AccentPalette, bold: BoldState): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const pair = text[i] === "*" || text[i] === "_" ? text.slice(i, i + 2) : "";
    if ((pair === "**" || pair === "__") && !isEscaped(text, i)) {
      if (bold.marker === undefined) bold.marker = pair;
      else if (bold.marker === pair) bold.marker = undefined;
      out += pair;
      i += 2;
      continue;
    }
    if (!isEscaped(text, i)) {
      const rule = ACCENT_RULES.find(candidate => text.startsWith(candidate.token, i));
      if (rule) {
        const inBold = bold.marker !== undefined;
        out += palette[rule.tone](rule.token);
        if (inBold) out += palette.boldReopen ?? "";
        i += rule.token.length;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function decorateLine(line: string, palette: AccentPalette): string {
  const parts = splitInlineCode(line);
  const bold: BoldState = {};
  let out = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.code) { out += part.text; continue; }
    let text = part.text;
    if (index === 0) {
      text = text.replace(/^(\s*)│(?=\s*(?:├──|└──))/, (_, spaces: string) => {
        const inBold = bold.marker !== undefined;
        return spaces + palette.dim("│") + (inBold ? palette.boldReopen ?? "" : "");
      });
    }
    out += decorateProse(text, palette, bold);
  }
  return out;
}

/** Color quiet reply accents outside fenced blocks, inline code, and headings. */
export function decorateReplyAccents(markdown: string, palette: AccentPalette): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    // Fences and headings can sit inside an ordinary blockquote or a callout body.
    const content = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const match = FENCE.exec(content);
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length) fence = undefined;
      out.push(line);
    } else if (match) {
      fence = { marker: match[1]![0]!, length: match[1]!.length };
      out.push(line);
    } else if (HEADING.test(content)) {
      out.push(line);
    } else {
      out.push(decorateLine(line, palette));
    }
  }
  return out.join("\n");
}

function colorFor(kind: CalloutKind, palette: AccentPalette): Colorize {
  return palette[kind];
}

function hardBreak(lines: string[]): string {
  return lines.join("  \n");
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
export function decorateQuietCallouts(
  markdown: string,
  palette: AccentPalette,
  availableWidth: number,
): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const bodyWidth = Math.max(1, (Number.isFinite(availableWidth) ? Math.floor(availableWidth) : 80) - 2);
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
    const paint = colorFor(kind, palette);
    let end = index + 1;
    const quoted: string[] = [];
    while (end < lines.length && BLOCKQUOTE.test(lines[end]!) && !CALLOUT.test(lines[end]!)) {
      quoted.push(lines[end]!);
      end++;
    }

    const rail = paint("│");
    const rendered = [`${rail} ${paint(`**${CALLOUT_LABELS[kind]}**`)}`];
    for (const body of calloutBodyLines(quoted, bodyWidth)) {
      rendered.push(body ? `${rail} ${body}` : rail);
    }
    out.push(hardBreak(rendered));
    if (end < lines.length && lines[end] !== "") out.push("");
    index = end;
  }
  return out.join("\n");
}

/** Apply both quiet reply accents and quiet callouts. */
export function transformReply(markdown: string, palette: AccentPalette, availableWidth: number): string {
  return decorateQuietCallouts(decorateReplyAccents(markdown, palette), palette, availableWidth);
}

/** Short aliases for callers that use the feature names directly. */
export const decorateReply = decorateReplyAccents;
export const decorateCallouts = decorateQuietCallouts;
