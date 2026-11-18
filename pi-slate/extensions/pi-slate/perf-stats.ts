import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { nonnegative, record } from "./sidebar-data.ts";

export const PERF_MIN_OUTPUT_TOKENS = 32;
export const PERF_MIN_DURATION_MS = 300;
export const PERF_MAX_RATES = 256;

export type SidebarCachePerf = {
  lastHit: number | null;
  lastActivityAt: number | null;
  ttlMs: number | null;
};

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
  cache: { lastHit: null, lastActivityAt: null, ttlMs: null },
};

type CacheProducer = { provider: string; model: string };
type CacheActivity = CacheProducer & { at: number | null; writes: number | null; hourWrites: number | null };
type PromptCacheLookup = (provider: string, model: string) => { short?: number; long?: number } | undefined;

function cacheActivity(producer: CacheProducer & { responseModel?: string }, usage: Record<string, unknown> | undefined, at: number | null): CacheActivity | undefined {
  const writes = nonnegative(usage?.cacheWrite);
  if (!(writes || (nonnegative(usage?.cacheRead) ?? 0) > 0)) return;
  return { provider: producer.provider, model: producer.responseModel ?? producer.model, at, writes, hourWrites: nonnegative(usage?.cacheWrite1h) };
}

function cacheLifetime(activity: CacheActivity, lookup: PromptCacheLookup): number | null {
  const { short, long } = lookup(activity.provider, activity.model) ?? {};
  // Neither the current selection nor a zero 1h split proves what a past request used:
  // the Anthropic adapter also reports zero when the split is absent.
  const { writes, hourWrites } = activity;
  const seconds = short === long ? short : writes && hourWrites === writes ? long : undefined;
  const ms = nonnegative((seconds ?? 0) * 1000);
  return ms || null;
}

function reportedHit(usage: Record<string, unknown> | undefined): number | null {
  const read = nonnegative(usage?.cacheRead);
  const write = nonnegative(usage?.cacheWrite);
  const input = nonnegative(usage?.input);
  if (read === null || write === null || input === null) return null;
  const total = read + write + input;
  return total > 0 && Number.isFinite(total) ? read / total : null;
}

/** Completed output does not require timing. Rates use Pi's recorded provider-stream duration. */
export function branchPerf(entries: readonly SessionEntry[], promptCacheFor: PromptCacheLookup = () => undefined): SidebarPerf {
  let timedReplies = 0;
  let rates: number[] = [];
  let peak: number | null = null;
  let turnOutput: number | null = 0;
  let turnRateOut = 0; let turnRateMs = 0;
  let lastHit: number | null = null;
  let latestCache: CacheActivity | undefined;
  const ids = new Set<string>();

  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    if (entry.type === "usage" && entry.kind === "cache_warm") {
      latestCache = cacheActivity(entry, record(entry.usage), nonnegative(Date.parse(entry.timestamp))) ?? latestCache;
    }
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "user") { turnOutput = 0; turnRateOut = 0; turnRateMs = 0; continue; }
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") continue;

    const usage = record(message.usage);
    const duration = nonnegative(message.durationMs);
    const timestamp = nonnegative(message.timestamp);
    const endedAt = timestamp === null || duration === null ? null : nonnegative(timestamp + duration);
    latestCache = cacheActivity(message, usage, endedAt);
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
    cache: { lastHit, lastActivityAt: latestCache?.at ?? null, ttlMs: latestCache ? cacheLifetime(latestCache, promptCacheFor) : null },
  };
}

export type CacheWarmth = { state: "warm" | "cold" | "unknown"; remainingMs: number | null; idleMs: number | null };

export function cacheWarmth(cache: SidebarCachePerf, now: number): CacheWarmth {
  const idleMs = cache.lastActivityAt === null || !Number.isFinite(now) ? null : Math.max(0, now - cache.lastActivityAt);
  if (cache.ttlMs === null || idleMs === null) return { state: "unknown", remainingMs: null, idleMs };
  const remainingMs = Math.max(0, cache.ttlMs - idleMs);
  return { state: remainingMs > 0 ? "warm" : "cold", remainingMs, idleMs };
}
