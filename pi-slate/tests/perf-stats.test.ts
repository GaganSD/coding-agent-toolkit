import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { branchPerf, cacheWarmth, EMPTY_PERF, PERF_MAX_RATES, type SidebarCachePerf } from "../extensions/pi-slate/perf-stats.ts";

let seq = 0;
function entry(fields: Record<string, unknown>): SessionEntry { return { id: `e${seq++}`, parentId: null, timestamp: "0", ...fields } as unknown as SessionEntry; }
function user(): SessionEntry { return entry({ type: "message", message: { role: "user" } }); }
function usageOf(over: Record<string, unknown> = {}, cost: Record<string, number> = {}) {
  return { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...cost }, ...over };
}
function asst(over: Record<string, unknown> = {}, usage: Record<string, unknown> | undefined = usageOf()): SessionEntry {
  const message: Record<string, unknown> = { role: "assistant", timestamp: 1000, durationMs: 1000, stopReason: "stop", ...over };
  if (usage) message.usage = usage;
  return entry({ type: "message", message });
}
const opts = { retentionLong: false };

test("empty branch yields null facts", () => {
  const perf = branchPerf([], opts);
  assert.deepEqual(perf.rates, []);
  assert.equal(perf.requests, 0); assert.equal(perf.peak, null); assert.equal(perf.turn, null);
  assert.deepEqual(perf.cache, EMPTY_PERF.cache);
});

test("legacy messages without durationMs are not timed", () => {
  const perf = branchPerf([user(), asst({ durationMs: undefined })], opts);
  assert.equal(perf.requests, 0); assert.equal(perf.turn, null); assert.deepEqual(perf.rates, []);
  assert.equal(perf.cache.lastHit, 0);
});

test("error, aborted and deferred are excluded from speed and turn", () => {
  const perf = branchPerf([user(), asst({ stopReason: "error" }), asst({ stopReason: "aborted" }), asst({ stopReason: "deferred" })], opts);
  assert.equal(perf.requests, 3); assert.deepEqual(perf.rates, []); assert.equal(perf.peak, null); assert.equal(perf.turn, null);
});

test("tiny outputs count in the turn but not in rates or peak", () => {
  const perf = branchPerf([user(), asst({}, usageOf({ output: 10 })), asst({ durationMs: 100 }, usageOf({ output: 500 })), asst({}, usageOf({ output: 100 }))], opts);
  assert.deepEqual(perf.rates, [100]); assert.equal(perf.peak, 100);
  assert.equal(perf.turn?.output, 610);
  assert.equal(perf.turn?.rate, 100, "turn average uses the same eligibility as rates and peak");
  const onlyTiny = branchPerf([user(), asst({}, usageOf({ output: 10 }))], opts);
  assert.equal(onlyTiny.turn?.output, 10); assert.equal(onlyTiny.turn?.rate, null); assert.equal(onlyTiny.peak, null);
});

test("turn average is token weighted, not a mean of rates", () => {
  const perf = branchPerf([user(), asst({ durationMs: 1000 }, usageOf({ output: 100 })), asst({ durationMs: 9000 }, usageOf({ output: 900 }))], opts);
  assert.equal(perf.turn?.rate, 100); // naive mean of (100, 100) agrees; use skewed case below
  const skew = branchPerf([user(), asst({ durationMs: 1000 }, usageOf({ output: 1000 })), asst({ durationMs: 9000 }, usageOf({ output: 90 }))], opts);
  assert.equal(skew.turn?.rate, 109); // 1090 / 10s, naive mean would be 505
});

test("turn starts after the last user message", () => {
  const perf = branchPerf([user(), asst({}, usageOf({ output: 999 })), user(), asst({}, usageOf({ output: 50 }))], opts);
  assert.equal(perf.turn?.output, 50); assert.equal(perf.requests, 2);
  assert.equal(branchPerf([asst(), user()], opts).turn, null);
});

test("keeps newest PERF_MAX_RATES but peak spans all", () => {
  const entries: SessionEntry[] = [asst({ durationMs: 400 }, usageOf({ output: 4000 }))];
  for (let i = 0; i < PERF_MAX_RATES + 50; i++) entries.push(asst({ durationMs: 1000 }, usageOf({ output: 100 + i })));
  const perf = branchPerf(entries, opts);
  assert.equal(perf.rates.length, PERF_MAX_RATES);
  assert.equal(perf.peak, 10000);
  assert.equal(perf.rates.at(-1), 100 + PERF_MAX_RATES + 49);
  assert.equal(perf.rates[0], 100 + 50);
});

test("5,000 requests process quickly", () => {
  const entries: SessionEntry[] = [];
  for (let i = 0; i < 5000; i++) entries.push(asst({}, usageOf({ cacheRead: 5, cost: { input: 1, cacheRead: 0.1 } })));
  const start = performance.now();
  const perf = branchPerf(entries, opts);
  assert.ok(performance.now() - start < 1000);
  assert.equal(perf.requests, 5000); assert.equal(perf.rates.length, PERF_MAX_RATES);
});

test("cache hit uses the latest assistant's uncached input, cache read and write", () => {
  const tool = entry({ type: "message", message: { role: "toolResult", usage: usageOf({ cacheRead: 99 }) } });
  const perf = branchPerf([
    asst({}, usageOf({ input: 100, cacheRead: 700, cacheWrite: 200 })),
    asst({}, usageOf({ input: 50, cacheRead: 150, cacheWrite: 50 })),
    tool, entry({ type: "compaction" }),
  ], opts);
  assert.equal(perf.cache.lastHit, 0.6);
});

test("saved estimates handle mixed models, skip unpriceable requests and zero prices", () => {
  const a = asst({}, usageOf({ input: 100, cacheRead: 1000 }, { input: 1, cacheRead: 0.1 })); // 0.01/tok vs 0.0001
  const b = asst({}, usageOf({ input: 10, cacheRead: 200 }, { input: 0.5, cacheRead: 0.02 })); // 0.05 vs 0.0001
  const skip = asst({}, usageOf({ input: 0, cacheRead: 500 }, { input: 0, cacheRead: 1 }));
  const perf = branchPerf([a, b, skip], opts);
  assert.ok(Math.abs((perf.cache.saved ?? NaN) - (1000 * (0.01 - 0.0001) + 200 * (0.05 - 0.0001))) < 1e-9);
  assert.equal(branchPerf([skip], opts).cache.saved, null);
  assert.equal(branchPerf([asst({}, usageOf({ input: 10, cacheRead: 100 }))], opts).cache.saved, null);
  // cache read priced above fresh input never yields negative savings
  const inverted = branchPerf([asst({}, usageOf({ input: 10, cacheRead: 100 }, { input: 1, cacheRead: 100 }))], opts);
  assert.equal(inverted.cache.saved, 0);
});

test("ttl selection by retention, cacheWrite1h and unknown lifetimes", () => {
  const pc = { short: 300, long: 3600 };
  const e = [asst({}, usageOf({ cacheWrite: 1 }))];
  assert.equal(branchPerf(e, { promptCache: pc, retentionLong: false }).cache.ttlMs, 300_000);
  assert.equal(branchPerf(e, { promptCache: pc, retentionLong: true }).cache.ttlMs, 3_600_000);
  assert.equal(branchPerf([asst({}, usageOf({ cacheWrite: 1, cacheWrite1h: 1 }))], { promptCache: pc, retentionLong: false }).cache.ttlMs, 3_600_000);
  assert.equal(branchPerf(e, { retentionLong: false }).cache.ttlMs, null);
  assert.equal(branchPerf(e, { promptCache: { short: 0 }, retentionLong: false }).cache.ttlMs, null);
  assert.equal(branchPerf(e, { promptCache: { long: 3600 }, retentionLong: false }).cache.ttlMs, null);
});

test("lastActivityAt is the end of the newest timed request", () => {
  const perf = branchPerf([asst({ timestamp: 5000, durationMs: 2000 }), asst({ timestamp: 9000, durationMs: 500 })], opts);
  assert.equal(perf.cache.lastActivityAt, 9500);
});

test("cacheWarmth warm, cold, unknown and clock skew", () => {
  const base: SidebarCachePerf = { ...EMPTY_PERF.cache, lastActivityAt: 10_000, ttlMs: 300_000 };
  assert.deepEqual(cacheWarmth(base, 70_000), { state: "warm", remainingMs: 240_000, idleMs: 60_000 });
  assert.deepEqual(cacheWarmth(base, 310_000), { state: "cold", remainingMs: 0, idleMs: 300_000 });
  assert.equal(cacheWarmth({ ...base, ttlMs: null }, 20_000).state, "unknown");
  assert.deepEqual(cacheWarmth({ ...base, lastActivityAt: null }, 20_000), { state: "unknown", remainingMs: null, idleMs: null });
  assert.deepEqual(cacheWarmth(base, 5_000), { state: "warm", remainingMs: 300_000, idleMs: 0 });
});

test("NaN, negative and infinite usage never leak", () => {
  const bad = asst({}, usageOf({ input: NaN, output: -5, cacheRead: Infinity, cacheWrite: -1 }, { input: NaN }));
  const perf = branchPerf([user(), bad, asst({ durationMs: NaN }), asst({ timestamp: NaN })], opts);
  assert.equal(perf.cache.saved, null);
  assert.equal(branchPerf([bad], opts).cache.lastHit, null);
  assert.deepEqual(perf.rates, []); assert.equal(perf.turn, null);
  assert.equal(perf.requests, 1);
});
