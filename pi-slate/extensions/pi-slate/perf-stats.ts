import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { nonnegative, record } from "./sidebar-data.ts";

/**
 * Speed and prompt-cache facts for the session rail.
 *
 * Accuracy contract (the rail is for glancing, so every number must be honest):
 * - "Exact" values come only from finished assistant messages on the active branch:
 *   `usage.output`, `usage.cacheRead/cacheWrite/input`, `timestamp` (request start) and
 *   `durationMs` (request start → response end, monotonic).
 * - A request's speed is end-to-end: output tokens ÷ (durationMs / 1000). It includes
 *   time to first token and hidden reasoning, both of which are real waiting time.
 * - Anything unknowable is `null`, never 0. The renderer shows `—` or omits the item.
 */

/** Requests below either bound are latency-dominated; they count toward totals and the turn's
 * output, but never toward the graph, the peak, the turn average, or "last response". */
export const PERF_MIN_OUTPUT_TOKENS = 32;
export const PERF_MIN_DURATION_MS = 300;
/** Bounded history so very long sessions cost constant memory in the rail. */
export const PERF_MAX_RATES = 256;

export type SidebarTurnPerf = {
  /** Exact output tokens since the last user message, including tiny replies. */
  output: number;
  /** Eligible output ÷ eligible seconds for this turn; null if no replies qualify. */
  rate: number | null;
};

export type SidebarCachePerf = {
  /** cacheRead ÷ (input + cacheRead + cacheWrite) of the latest assistant request (0..1). */
  lastHit: number | null;
  /** Counterfactual dollars saved by cache reads; always an estimate. null when prices are unknown. */
  saved: number | null;
  /** Wall-clock ms when the latest request ended (timestamp + durationMs); drives warm/cold. */
  lastActivityAt: number | null;
  /** Cache lifetime that applies to the latest request; null when the provider's lifetime is unknown. */
  ttlMs: number | null;
};

export type SidebarPerf = {
  /** Timed assistant requests on the branch (eligible or not). */
  requests: number;
  /** Exact end-to-end rates of eligible requests, oldest → newest, at most PERF_MAX_RATES. */
  rates: number[];
  /** Max of all eligible rates on the branch (not only the retained window). */
  peak: number | null;
  turn: SidebarTurnPerf | null;
  cache: SidebarCachePerf;
};

export const EMPTY_PERF: SidebarPerf = {
  requests: 0, rates: [], peak: null, turn: null,
  cache: { lastHit: null, saved: null, lastActivityAt: null, ttlMs: null },
};

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

export type PerfPromptCache = { short?: number; long?: number } | undefined;
export type BranchPerfOptions = { promptCache?: PerfPromptCache; retentionLong: boolean };

/**
 * One O(n) pass over the active branch.
 *
 * Turn rule: every timed assistant request after the last user message whose stopReason is not
 * error/aborted/deferred counts toward `turn.output`. The turn rate and speed graph both
 * require output >= PERF_MIN_OUTPUT_TOKENS and duration >= PERF_MIN_DURATION_MS.
 */
export function branchPerf(entries: readonly SessionEntry[], opts: BranchPerfOptions): SidebarPerf {
  let requests = 0;
  let rates: number[] = [];
  let peak: number | null = null;
  let turnOutput: number | null = null;
  let turnRateOut = 0; let turnRateMs = 0;
  let saved = 0; let pricedAny = false;
  let lastUsage: Record<string, unknown> | undefined;
  let lastActivityAt: number | null = null;
  const ids = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "message" || ids.has(entry.id)) continue;
    ids.add(entry.id);
    const message = entry.message;
    if (message.role === "user") { turnOutput = null; turnRateOut = 0; turnRateMs = 0; continue; }
    if (message.role !== "assistant") continue;
    const usage = record(message.usage);
    if (!usage) continue;
    lastUsage = usage;
    const read = nonnegative(usage.cacheRead); const input = nonnegative(usage.input);
    if (read !== null && read > 0 && input !== null && input > 0) {
      const cost = record(usage.cost);
      const inputPrice = (nonnegative(cost?.input) ?? NaN) / input;
      const readPrice = (nonnegative(cost?.cacheRead) ?? NaN) / read;
      if (Number.isFinite(inputPrice) && inputPrice > 0 && Number.isFinite(readPrice)) {
        const term = read * (inputPrice - readPrice);
        if (Number.isFinite(term)) { saved += Math.max(0, term); pricedAny = true; }
      }
    }

    const timestamp = message.timestamp;
    const durationMs = message.durationMs;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)
      || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    requests += 1;
    lastActivityAt = timestamp + durationMs;
    const stop = message.stopReason;
    if (stop === "error" || stop === "aborted" || stop === "deferred") continue;
    const output = nonnegative(usage.output);
    if (output === null) continue;
    turnOutput = (turnOutput ?? 0) + output;
    if (output >= PERF_MIN_OUTPUT_TOKENS && durationMs >= PERF_MIN_DURATION_MS) {
      const rate = output / (durationMs / 1000);
      if (!Number.isFinite(rate)) continue;
      turnRateOut += output; turnRateMs += durationMs;
      rates.push(rate);
      if (rates.length >= PERF_MAX_RATES * 2) rates = rates.slice(-PERF_MAX_RATES);
      if (peak === null || rate > peak) peak = rate;
    }
  }
  if (rates.length > PERF_MAX_RATES) rates = rates.slice(-PERF_MAX_RATES);

  let lastHit: number | null = null;
  let ttlMs: number | null = null;
  if (lastUsage) {
    const input = nonnegative(lastUsage.input); const read = nonnegative(lastUsage.cacheRead); const write = nonnegative(lastUsage.cacheWrite);
    if (input !== null && read !== null && write !== null) {
      const total = input + read + write;
      if (total > 0) lastHit = read / total;
    }
    const long = (nonnegative(lastUsage.cacheWrite1h) ?? 0) > 0;
    const seconds = long || opts.retentionLong ? opts.promptCache?.long : opts.promptCache?.short;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) ttlMs = seconds * 1000;
  }
  return {
    requests, rates, peak,
    turn: turnOutput === null ? null : { output: turnOutput, rate: turnRateMs > 0 ? turnRateOut / (turnRateMs / 1000) : null },
    cache: { lastHit, saved: pricedAny && Number.isFinite(saved) ? saved : null, lastActivityAt, ttlMs },
  };
}

export type CacheWarmth = { state: "warm" | "cold" | "unknown"; remainingMs: number | null; idleMs: number | null };

/** Warm/cold from the provider's cache lifetime; negative gaps (clock skew) clamp to 0. */
export function cacheWarmth(cache: SidebarCachePerf, now: number): CacheWarmth {
  const idleMs = cache.lastActivityAt === null || !Number.isFinite(now) ? null : Math.max(0, now - cache.lastActivityAt);
  if (cache.ttlMs === null || idleMs === null) return { state: "unknown", remainingMs: null, idleMs };
  const remainingMs = Math.max(0, cache.ttlMs - idleMs);
  return { state: remainingMs > 0 ? "warm" : "cold", remainingMs, idleMs };
}
