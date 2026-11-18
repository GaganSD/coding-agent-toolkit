import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { branchPerf, cacheWarmth, EMPTY_PERF, PERF_MAX_RATES } from "../extensions/pi-slate/perf-stats.ts";

let seq = 0;
function entry(fields: Record<string, unknown>): SessionEntry {
  return { id: `e${seq++}`, parentId: null, timestamp: "1970-01-01T00:00:10.000Z", ...fields } as unknown as SessionEntry;
}
const user = () => entry({ type: "message", message: { role: "user" } });
const asst = (fields: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => entry({
  type: "message", message: { role: "assistant", provider: "fixture", model: "a", timestamp: 1000, durationMs: 1000,
    stopReason: "stop", usage: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, ...usage }, ...fields },
});

test("empty and unsuccessful branches have no timed replies", () => {
  assert.deepEqual(branchPerf([]), EMPTY_PERF);
  const failed = ["error", "aborted", "deferred"].map(stopReason => asst({ stopReason }, { cacheRead: 128 }));
  assert.deepEqual(branchPerf(failed), EMPTY_PERF);
});

test("turn output includes tiny and untimed replies, but the weighted rate includes only eligible replies", () => {
  const perf = branchPerf([user(), asst({ durationMs: undefined }, { output: 999 }), asst({}, { output: 10 }),
    asst({ durationMs: 100 }, { output: 500 }), asst({}, { output: 1000 }), asst({ durationMs: 9000 }, { output: 90 })]);
  assert.deepEqual(perf.rates, [1000, 10]);
  assert.equal(perf.peak, 1000);
  assert.equal(perf.timedReplies, 2);
  assert.deepEqual(perf.turn, { output: 2599, rate: 109 });
  assert.deepEqual(branchPerf([asst({ durationMs: undefined })]).turn, { output: 100, rate: null });
});

test("a missing output makes the turn subtotal unknown without invalidating other timed replies", () => {
  const missing = asst({ usage: undefined });
  assert.deepEqual(branchPerf([missing, asst()]).turn, { output: null, rate: 100 });
  assert.deepEqual(branchPerf([missing, user(), asst()]).turn, { output: 100, rate: 100 });
  assert.deepEqual(branchPerf([missing, user()]).turn, EMPTY_PERF.turn);
});

test("retains the newest rates, but peak and reply count cover the entire branch", () => {
  const first = asst({ durationMs: 400 }, { output: 4000 });
  const count = PERF_MAX_RATES * 3;
  const entries = [first, first, ...Array.from({ length: count }, (_, i) => asst({}, { output: 100 + i }))];
  const perf = branchPerf(entries);
  assert.equal(perf.timedReplies, count + 1);
  assert.equal(perf.rates.length, PERF_MAX_RATES);
  assert.equal(perf.peak, 10000);
  assert.equal(perf.rates.at(-1), 99 + count);
  assert.equal(perf.rates[0], 100 + count - PERF_MAX_RATES);
});

test("latest completed reply owns hit rate; tool/summary usage and failed replies don't replace it", () => {
  const reply = asst({}, { input: 50, cacheRead: 150, cacheWrite: 50 });
  const tool = entry({ type: "message", message: { role: "toolResult", usage: { cacheRead: 99 } } });
  const failed = asst({ stopReason: "error" });
  assert.equal(branchPerf([reply, tool, entry({ type: "compaction" }), failed]).cache.lastHit, 0.6);
  assert.equal(branchPerf([reply, asst({}, { cacheRead: Infinity })]).cache.lastHit, null);
});

test("expiry follows the recorded cache producer and timestamp, not an unrelated timed failure or reply", () => {
  const lookup = (provider: string, model: string) => provider === "fixture" && model === "physical-a"
    ? { short: 300, long: 3600 } : { short: 99, long: 99 };
  const reply = asst({ model: "routed", responseModel: "physical-a" }, { cacheWrite: 40, cacheWrite1h: 40 });
  const failed = asst({ model: "b", timestamp: 3000, stopReason: "error" }, { cacheRead: 900 });
  assert.deepEqual(branchPerf([reply, failed], lookup).cache, { lastHit: 0, lastActivityAt: 2000, ttlMs: 3_600_000 });
  const untimed = asst({ model: "b", durationMs: undefined }, { cacheRead: 30 });
  assert.equal(cacheWarmth(branchPerf([reply, untimed], lookup).cache, 4000).state, "unknown");
  assert.equal(cacheWarmth(branchPerf([reply, asst({ model: "b" })], lookup).cache, 4000).state, "unknown");
});

test("a persisted cache refresh advances activity but not the last reply's hit or speed", () => {
  const reply = asst({}, { input: 30, cacheRead: 70, cacheWrite: 0 });
  const warm = entry({ type: "usage", kind: "cache_warm", provider: "fixture", model: "a", usage: { cacheRead: 100 } });
  const perf = branchPerf([reply, warm], () => ({ short: 300, long: 300 }));
  assert.deepEqual(perf.cache, { lastHit: 0.7, lastActivityAt: 10_000, ttlMs: 300_000 });
  assert.deepEqual(perf.rates, [100]);
  assert.equal(cacheWarmth(perf.cache, 11_000).remainingMs, 299_000);
});

test("a cache timer requires evidence of the recorded request's retention tier", () => {
  const lookup = () => ({ short: 300, long: 3600 });
  assert.equal(branchPerf([asst({}, { cacheWrite: 10, cacheWrite1h: 10 })], lookup).cache.ttlMs, 3_600_000);
  for (const usage of [{ cacheRead: 99 }, { cacheWrite: 10 }, { cacheWrite: 10, cacheWrite1h: 0 }, { cacheWrite: 10, cacheWrite1h: 3 }]) {
    assert.equal(branchPerf([asst({}, usage)], lookup).cache.ttlMs, null);
  }
});

test("cache warmth clamps clock skew and expires at TTL", () => {
  const cache = { ...EMPTY_PERF.cache, lastActivityAt: 10_000, ttlMs: 300_000 };
  assert.deepEqual(cacheWarmth(cache, 5000), { state: "warm", remainingMs: 300_000, idleMs: 0 });
  assert.equal(cacheWarmth(cache, 310_000).state, "cold");
  assert.equal(cacheWarmth({ ...cache, ttlMs: null }, 70_000).idleMs, 60_000);
});
