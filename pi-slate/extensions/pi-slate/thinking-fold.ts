import type { AssistantContentBlock } from "./token-rate.ts";
import { thinkingRunText } from "./thinking-label.ts";

export function formatLiveThinking(word: string, elapsedMs: number | null, rate: number | null): string {
  const parts = [word];
  if (elapsedMs !== null && Number.isFinite(elapsedMs) && elapsedMs >= 1000) {
    parts.push(`${Math.floor(elapsedMs / 1000)}s`);
  }
  if (rate !== null && Number.isFinite(rate) && rate >= 0) parts.push(`↑↓${Math.round(rate)}`);
  return parts.join(" · ");
}

type ScheduleTick = (tick: () => void) => () => void;

function scheduleTick(tick: () => void): () => void {
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export type ThinkingCompletion = { elapsedMs: number; thinking: string };

/** Only time observed thinking_start/end pairs; never guess durations from restored content. */
export class ThinkingFoldTracker {
  private disposed = false;
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  private contentIndex: number | null = null;
  private message: object | null = null;
  private runStartedAt: number | null = null;
  private runLastIndex: number | null = null;
  private revisionCount = 0;
  private cancelTick?: () => void;
  private onChange?: () => void;
  private onComplete?: (completion: ThinkingCompletion) => void;
  private readonly now: () => number;
  private readonly schedule: ScheduleTick;

  constructor(options: {
    now?: () => number;
    schedule?: ScheduleTick;
    onChange?: () => void;
    onComplete?: (completion: ThinkingCompletion) => void;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleTick;
    this.onChange = options.onChange;
    this.onComplete = options.onComplete;
  }

  elapsedMs(): number | null {
    return this.startedAt === null || this.pausedAt !== null ? null : Math.max(0, this.now() - this.startedAt);
  }

  /** The message and content index being timed, for matching one hidden run during streaming. */
  active(): { message: object; contentIndex: number } | null {
    return this.startedAt === null || this.pausedAt !== null || this.contentIndex === null || this.message === null
      ? null
      : { message: this.message, contentIndex: this.contentIndex };
  }

  get revision(): number {
    return this.revisionCount;
  }

  observe(event: unknown, message: { content?: readonly AssistantContentBlock[] }): void {
    if (this.disposed) return;
    if (typeof event !== "object" || event === null) {
      this.stop();
      return;
    }
    const { type, contentIndex } = event as { type?: unknown; contentIndex?: unknown };
    if (typeof type !== "string") {
      this.stop();
      return;
    }
    if (type === "thinking_start" || type === "thinking_delta" || type === "thinking_end") {
      if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex)
        || contentIndex < 0 || message.content?.[contentIndex]?.type !== "thinking") {
        this.stop();
        return;
      }
      if (type === "thinking_start") {
        if (this.contentIndex === contentIndex && this.message === message) return;
        const continuesRun = (this.runStartedAt !== null && this.runLastIndex !== null
          && contentIndex === this.runLastIndex + 1)
          || (this.runStartedAt !== null && this.contentIndex !== null
            && contentIndex === this.contentIndex + 1);
        this.stopActive();
        if (!continuesRun) {
          this.runStartedAt = this.now();
          this.runLastIndex = null;
        }
        this.contentIndex = contentIndex;
        this.message = message;
        this.startedAt = this.now();
        this.startTicks();
      } else if (type === "thinking_end") {
        if (this.startedAt !== null && contentIndex === this.contentIndex) {
          const elapsedMs = Math.max(0, (this.pausedAt ?? this.now()) - (this.runStartedAt ?? this.startedAt));
          const thinking = thinkingRunText(message.content, contentIndex);
          if (thinking) {
            try { this.onComplete?.({ elapsedMs, thinking }); }
            catch { /* Presentation-only sink; never let it interrupt host streaming. */ }
          }
          this.runLastIndex = contentIndex;
        }
        // Keep the run clock for an adjacent thinking block; message and non-thinking
        // boundaries call stop() and clear it.
        this.stopActive();
      } else if (contentIndex !== this.contentIndex) {
        this.stop();
      } else {
        this.message = message; // Pi can deliver a fresh partial object on each update.
        if (this.pausedAt !== null && this.startedAt !== null) {
          // Resume both clocks without charging the intervening text or tool output.
          const pausedMs = Math.max(0, this.now() - this.pausedAt);
          this.startedAt += pausedMs;
          if (this.runStartedAt !== null) this.runStartedAt += pausedMs;
          this.pausedAt = null;
          this.startTicks();
        }
      }
    } else if (this.startedAt !== null && /^(?:text|toolcall)_(?:start|delta|end)$/.test(type)) {
      // Some adapters (notably OpenAI Chat Completions) emit thinking_end only
      // after streaming text or a tool call. Stop the live clock but keep the pair.
      if (this.pausedAt === null) {
        this.pausedAt = this.now();
        this.cancelTick?.();
        this.cancelTick = undefined;
        this.revisionCount += 1;
        this.onChange?.();
      }
    } else {
      this.stop();
    }
  }

  private startTicks(): void {
    this.cancelTick = this.schedule(() => this.onChange?.());
    this.revisionCount += 1;
    this.onChange?.();
  }

  private stopActive(): void {
    const wasActive = this.startedAt !== null && this.pausedAt === null;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.startedAt = null;
    this.pausedAt = null;
    this.contentIndex = null;
    this.message = null;
    if (wasActive) {
      this.revisionCount += 1;
      this.onChange?.();
    }
  }

  stop(): void {
    this.stopActive();
    this.runStartedAt = null;
    this.runLastIndex = null;
  }

  dispose(): void {
    this.disposed = true;
    this.onChange = undefined;
    this.onComplete = undefined;
    this.stop();
  }
}
