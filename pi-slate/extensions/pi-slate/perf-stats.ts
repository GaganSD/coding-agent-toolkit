import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { nonnegative, record } from "./sidebar-data.ts";

export const PERF_MIN_OUTPUT_TOKENS = 32;
export const PERF_MIN_DURATION_MS = 300;
export const PERF_MAX_RATES = 256;

export type SidebarCachePerf = { lastHit: number | null };

export type SidebarPerf = {
  timedReplies: number;
  /** Eligible output rates, oldest first. Peak includes replies outside this window. */
  rates: number[];
  peak: number | null;
  turn: { output: number | null; rate: number | null };
  cache: SidebarCachePerf;
};

export const EMPTY_PERF: SidebarPerf = {
  timedReplies: 0, rates: [], peak: null, turn: { output: 0, rate: null },
  cache: { lastHit: null },
};

function reportedHit(usage: Record<string, unknown> | undefined): number | null {
  const read = nonnegative(usage?.cacheRead);
  const write = nonnegative(usage?.cacheWrite);
  const input = nonnegative(usage?.input);
  if (read === null || write === null || input === null) return null;
  const total = read + write + input;
  return total > 0 && Number.isFinite(total) ? read / total : null;
}

/** Completed output does not require timing. Rates use Pi's recorded provider-stream duration. */
export function branchPerf(entries: readonly SessionEntry[]): SidebarPerf {
  let timedReplies = 0;
  let rates: number[] = [];
  let peak: number | null = null;
  let turnOutput: number | null = 0;
  let turnRateOut = 0; let turnRateMs = 0;
  let lastHit: number | null = null;
  const ids = new Set<string>();

  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "user") { turnOutput = 0; turnRateOut = 0; turnRateMs = 0; continue; }
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") continue;

    const usage = record(message.usage);
    const duration = nonnegative(message.durationMs);
    lastHit = reportedHit(usage);
    const output = nonnegative(usage?.output);
    turnOutput = output === null || turnOutput === null ? null : nonnegative(turnOutput + output);
    if (output === null || output < PERF_MIN_OUTPUT_TOKENS || duration === null || duration < PERF_MIN_DURATION_MS) continue;

    const rate = output / (duration / 1000);
    if (!Number.isFinite(rate)) continue;
    timedReplies += 1;
    turnRateOut += output; turnRateMs += duration;
    rates.push(rate);
    if (rates.length >= PERF_MAX_RATES * 2) rates = rates.slice(-PERF_MAX_RATES);
    if (peak === null || rate > peak) peak = rate;
  }

  return {
    timedReplies, rates: rates.slice(-PERF_MAX_RATES), peak,
    turn: { output: turnOutput, rate: turnRateMs > 0 ? nonnegative(turnRateOut / (turnRateMs / 1000)) : null },
    cache: { lastHit },
  };
}
