import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantContentBlock } from "./token-rate.ts";

export const HIDDEN_THINKING_LABEL = "Thought";
export const STREAMING_THINKING_LABEL = "Thinking…";

/** Structural view of Pi's assistant component; no host instance is patched. */
export type ThinkingView = {
  lastMessage?: {
    role?: string;
    stopReason?: string;
    content?: readonly (AssistantContentBlock & { name?: string })[];
  };
  hideThinkingBlock?: boolean;
  thinkingVisibilityOverrides?: Map<number, boolean>;
};

export type ThinkingRun = {
  start: number;
  end: number;
  thinking: string;
  hidden: boolean;
};

export function thinkingRunText(content: readonly AssistantContentBlock[] | undefined, contentIndex: number): string {
  return thinkingRuns({ lastMessage: { content } })
    .find((run) => contentIndex >= run.start && contentIndex <= run.end)?.thinking ?? "";
}

/** Mirror Pi's grouping: consecutive thinking blocks with non-empty text form one click target. */
function thinkingRuns(view: ThinkingView | undefined): ThinkingRun[] {
  const content = view?.lastMessage?.content;
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
      start,
      end,
      thinking: blocks.join("\n\n"),
      hidden: view?.thinkingVisibilityOverrides?.get(index) ?? view?.hideThinkingBlock === true,
    });
  }
  return runs;
}

function hiddenThinkingRuns(view: ThinkingView | undefined): ThinkingRun[] {
  return thinkingRuns(view).filter((run) => run.hidden);
}

function completedSeconds(durationMs: number | null | undefined): number | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return Math.max(1, Math.floor(durationMs / 1000));
}

export function thinkingLabel(options: { streaming: boolean; durationMs?: number | null }): string {
  if (options.streaming) return STREAMING_THINKING_LABEL;
  const seconds = completedSeconds(options.durationMs);
  return seconds === null ? HIDDEN_THINKING_LABEL : `Thought for ${seconds}s`;
}

/** Only durations observed live in this session are stored; restored content falls back to `Thought`. */
export class ThinkingDurations {
  private readonly values = new Map<string, number>();
  private readonly limit: number;
  private revision = 0;

  constructor(limit = 512) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get version(): number {
    return this.revision;
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
    this.revision += 1;
  }

  lookup(thinking: string): number | undefined {
    return this.values.get(thinking.trim());
  }

  clear(): void {
    if (this.values.size === 0) return;
    this.values.clear();
    this.revision += 1;
  }
}

/** Replace Pi's hidden-thinking rows in order, preserving the row's native style, indent, and width. */
export function replaceHiddenThinkingRows(
  rows: readonly string[],
  labels: readonly string[],
  styledLabel: string,
): readonly string[] {
  if (labels.length === 0 || !styledLabel) return rows;
  let next = 0;
  let output: string[] | undefined;
  for (let y = 0; y < rows.length && next < labels.length; y++) {
    const row = rows[y]!;
    if (stripVTControlCharacters(row).trim() !== HIDDEN_THINKING_LABEL) continue;
    const index = row.indexOf(styledLabel);
    if (index < 0) continue;
    const label = labels[next++]!;
    if (label === HIDDEN_THINKING_LABEL) continue;
    const width = visibleWidth(row);
    const leading = /^\s*/u.exec(stripVTControlCharacters(row))?.[0] ?? "";
    const available = Math.max(0, width - visibleWidth(leading));
    const text = truncateToWidth(label, available, "…", false);
    const styled = styledLabel.replace(HIDDEN_THINKING_LABEL, text);
    const suffix = row.slice(index + styledLabel.length).replace(/ +$/u, "");
    let replaced = row.slice(0, index) + styled + suffix;
    const padding = width - visibleWidth(replaced);
    if (padding > 0) replaced += " ".repeat(padding);
    output ??= rows.slice();
    output[y] = replaced;
  }
  return output ?? rows;
}

/** Paint collapsed thinking rows for the run that is streaming and runs timed in this session. */
export function decorateThinkingRows(
  view: ThinkingView | undefined,
  rows: readonly string[],
  options: {
    active: { message: object; contentIndex: number } | null;
    durations: ThinkingDurations;
    styledLabel: string;
  },
): readonly string[] {
  const hidden = hiddenThinkingRuns(view);
  if (hidden.length === 0) return rows;
  const active = options.active;
  const labels = hidden.map((run) => {
    const streaming = active !== null && view?.lastMessage === active.message
      && active.contentIndex >= run.start && active.contentIndex <= run.end;
    return thinkingLabel({
      streaming,
      durationMs: streaming ? null : options.durations.lookup(run.thinking),
    });
  });
  return replaceHiddenThinkingRows(rows, labels, options.styledLabel);
}
