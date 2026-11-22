import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { branchPerf, EMPTY_PERF, PERF_MAX_RATES } from "../extensions/pi-slate/perf-stats.ts";

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

test("a persisted cache refresh does not change the last reply's hit or speed", () => {
  const reply = asst({}, { input: 30, cacheRead: 70, cacheWrite: 0 });
  const warm = entry({ type: "usage", kind: "cache_warm", provider: "fixture", model: "a", usage: { cacheRead: 100 } });
  const perf = branchPerf([reply, warm]);
  assert.deepEqual(perf.cache, { lastHit: 0.7 });
  assert.deepEqual(perf.rates, [100]);
});
