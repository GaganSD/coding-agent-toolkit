import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Speed and prompt-cache facts for the session rail.
 *
 * Accuracy contract (the rail is for glancing, so every number must be honest):
 * - "Exact" values come only from finished assistant messages on the active branch:
 *   `usage.output`, `usage.cacheRead/cacheWrite/input`, `timestamp` (request start) and
 *   `durationMs` (request start → response end, monotonic).
 * - A request's speed is end-to-end: output tokens ÷ (durationMs / 1000). It includes
 *   time to first token and hidden reasoning, both of which are real waiting time.
 * - The live streaming rate is an estimate (visible chars ÷ 4) and must be labelled `~`; the rail no
 *   longer shows it (the composer's working message does).
 * - Anything unknowable is `null`, never 0. The renderer shows `—` or omits the item.
 */

/** Requests below either bound are latency-dominated; they count toward totals and the turn's
 * output, but never toward the graph, the peak, the turn average, or "last response". */
export const PERF_MIN_OUTPUT_TOKENS = 32;
export const PERF_MIN_DURATION_MS = 300;
/** Bounded history so very long sessions cost constant memory in the rail. */
export const PERF_MAX_RATES = 256;

export type SidebarTurnPerf = {
  /** Assistant requests since the last user message on the branch (the current or last turn). */
  requests: number;
  /** Exact output tokens of all those requests (including tiny ones). */
  output: number;
  /** Sum of all their durationMs. */
  durationMs: number;
  /** Token-weighted exact rate over the ELIGIBLE requests of the turn only (same rule as rates/peak):
   * eligible output ÷ eligible seconds; null when none are eligible, so avg/peak/headline are known together. */
  rate: number | null;
};

export type SidebarCachePerf = {
  /** Branch totals in tokens (same scope as SidebarUsage); null when any contributing usage is missing. */
  read: number | null;
  write: number | null;
  uncached: number | null;
  /** cacheRead ÷ (input + cacheRead + cacheWrite) of the latest assistant request (0..1). */
  lastHit: number | null;
  /** read ÷ (read + write + uncached) over the branch (0..1). */
  sessionHit: number | null;
  /** Counterfactual dollars saved by cache reads; always an estimate. null when prices are unknown. */
  saved: number | null;
  /** Wall-clock ms when the latest request ended (timestamp + durationMs); drives warm/cold. */
  lastActivityAt: number | null;
  /** Cache lifetime that applies to the latest request; null when the provider's lifetime is unknown. */
  ttlMs: number | null;
  /** True once any request on the branch read or wrote cache. */
  seen: boolean;
};

export type SidebarPerf = {
  /** Timed assistant requests on the branch (eligible or not). */
  requests: number;
  /** Exact end-to-end rates of eligible requests, oldest → newest, at most PERF_MAX_RATES. */
  rates: number[];
  /** Max of all eligible rates on the branch (not only the retained window). */
  peak: number | null;
  /** Exact rate of the newest eligible request. */
  lastRate: number | null;
  turn: SidebarTurnPerf | null;
  cache: SidebarCachePerf;
  /** Live estimate while an assistant message streams; rate is null when not streaming or no sample yet. */
  live: { streaming: boolean; rate: number | null };
};

export const EMPTY_PERF: SidebarPerf = {
  requests: 0, rates: [], peak: null, lastRate: null, turn: null,
  cache: { read: null, write: null, uncached: null, lastHit: null, sessionHit: null, saved: null, lastActivityAt: null, ttlMs: null, seen: false },
  live: { streaming: false, rate: null },
};

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

export type PerfPromptCache = { short?: number; long?: number } | undefined;
export type BranchPerfOptions = { promptCache?: PerfPromptCache; retentionLong: boolean };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function ratio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/**
 * One O(n) pass over the active branch.
 *
 * Turn rule: every timed assistant request after the last user message whose stopReason is not
 * error/aborted/deferred counts toward `turn.requests/output/durationMs`. `turn.rate` and the speed
 * rows (rates/peak/lastRate) share one eligibility rule: output >= PERF_MIN_OUTPUT_TOKENS and
 * duration >= PERF_MIN_DURATION_MS.
 */
export function branchPerf(entries: readonly SessionEntry[], opts: BranchPerfOptions): SidebarPerf {
  let requests = 0;
  let rates: number[] = [];
  let peak: number | null = null;
  let lastRate: number | null = null;
  let turnRequests = 0; let turnOutput = 0; let turnMs = 0; let turnRateOut = 0; let turnRateMs = 0;

  const sums = { read: 0, write: 0, uncached: 0 };
  const missing = { read: false, write: false, uncached: false };
  let seen = false;
  let saved = 0; let pricedAny = false;
  let lastUsage: Record<string, unknown> | null = null;
  let lastActivityAt: number | null = null;
  const ids = new Set<string>();

  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    let usage: Record<string, unknown> | null;
    let expected: boolean;
    let assistant: Record<string, unknown> | null = null;
    if (entry.type === "message") {
      const message = obj(entry.message);
      const role = message?.role;
      if (role === "user") { turnRequests = 0; turnOutput = 0; turnMs = 0; turnRateOut = 0; turnRateMs = 0; continue; }
      if (role === "assistant" || role === "toolResult") {
        usage = obj(message?.usage);
        expected = role === "assistant";
        if (role === "assistant") assistant = message;
      } else continue;
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      usage = obj((entry as { usage?: unknown }).usage);
      expected = true;
    } else continue;

    if (!usage) {
      if (expected) { missing.read = true; missing.write = true; missing.uncached = true; }
      continue;
    }
    const read = num(usage.cacheRead); const write = num(usage.cacheWrite); const input = num(usage.input);
    if (read === null) missing.read = true; else { sums.read += read; if (read > 0) seen = true; }
    if (write === null) missing.write = true; else { sums.write += write; if (write > 0) seen = true; }
    if (input === null) missing.uncached = true; else sums.uncached += input;

    if (!assistant) continue;
    lastUsage = usage;
    const cost = obj(usage.cost);

    if (read !== null && read > 0 && input !== null && input > 0) {
      const inputPrice = (num(cost?.input) ?? NaN) / input;
      const readPrice = (num(cost?.cacheRead) ?? NaN) / read;
      if (Number.isFinite(inputPrice) && inputPrice > 0 && Number.isFinite(readPrice)) {
        const term = read * (inputPrice - readPrice);
        if (Number.isFinite(term)) { saved += Math.max(0, term); pricedAny = true; }
      }
    }

    const timestamp = assistant.timestamp;
    const durationMs = assistant.durationMs;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)
      || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    requests += 1;
    lastActivityAt = timestamp + durationMs;
    const stop = assistant.stopReason;
    if (stop === "error" || stop === "aborted" || stop === "deferred") continue;
    const output = num(usage.output);
    if (output === null) continue;
    turnRequests += 1; turnOutput += output; turnMs += durationMs;
    if (output >= PERF_MIN_OUTPUT_TOKENS && durationMs >= PERF_MIN_DURATION_MS) {
      const rate = output / (durationMs / 1000);
      if (!Number.isFinite(rate)) continue;
      turnRateOut += output; turnRateMs += durationMs;
      rates.push(rate);
      if (rates.length >= PERF_MAX_RATES * 2) rates = rates.slice(-PERF_MAX_RATES);
      if (peak === null || rate > peak) peak = rate;
      lastRate = rate;
    }
  }
  if (rates.length > PERF_MAX_RATES) rates = rates.slice(-PERF_MAX_RATES);

  let lastHit: number | null = null;
  let ttlMs: number | null = null;
  if (lastUsage) {
    const input = num(lastUsage.input); const read = num(lastUsage.cacheRead); const write = num(lastUsage.cacheWrite);
    if (input !== null && read !== null && write !== null) lastHit = ratio(read, input + read + write);
    const long = num(lastUsage.cacheWrite1h) !== null && (num(lastUsage.cacheWrite1h) as number) > 0;
    const seconds = long || opts.retentionLong ? opts.promptCache?.long : opts.promptCache?.short;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) ttlMs = seconds * 1000;
  }
  const read = missing.read ? null : sums.read;
  const write = missing.write ? null : sums.write;
  const uncached = missing.uncached ? null : sums.uncached;
  const sessionHit = read === null || write === null || uncached === null ? null : ratio(read, read + write + uncached);

  return {
    requests, rates, peak, lastRate,
    turn: turnRequests > 0
      ? { requests: turnRequests, output: turnOutput, durationMs: turnMs, rate: turnRateMs > 0 ? turnRateOut / (turnRateMs / 1000) : null }
      : null,
    cache: {
      read, write, uncached, lastHit, sessionHit,
      saved: pricedAny && Number.isFinite(saved) ? saved : null,
      lastActivityAt, ttlMs, seen,
    },
    live: { streaming: false, rate: null },
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
