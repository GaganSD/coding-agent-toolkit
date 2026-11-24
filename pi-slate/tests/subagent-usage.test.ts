import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSubagentUsage, subagentSpend } from "../extensions/pi-slate/subagent-usage.ts";

const snapshot = { version: 1, source: "pi-subagents", sessionId: "owner", tasks: [],
  totals: { runs: 3, measuredRuns: 2, usage: { cost: 0.08 } } };

test("sub-agent accounting accepts additive v1 totals, settled-only spend, unknowns and zero without task rows", () => {
  assert.deepEqual(subagentSpend(snapshot, "owner"), { runs: 3, measuredRuns: 2, cost: 0.08 });
  assert.deepEqual(subagentSpend({ ...snapshot, totals: { runs: 1, measuredRuns: 0 } }, "owner"), { runs: 1, measuredRuns: 0, cost: null });
  assert.deepEqual(subagentSpend({ ...snapshot, totals: { runs: 1, measuredRuns: 1, usage: { cost: 0 } } }, "owner"), { runs: 1, measuredRuns: 1, cost: 0 });
  for (const cost of [NaN, Infinity, -1, "0.08", undefined]) {
    assert.equal(subagentSpend({ ...snapshot, totals: { ...snapshot.totals, usage: { cost } } }, "owner")!.cost, null);
  }
  for (const value of [null, {}, { ...snapshot, totals: undefined }, { ...snapshot, version: 2 }, { ...snapshot, source: "other" },
    { ...snapshot, sessionId: "foreign" }, { ...snapshot, totals: { runs: 1, measuredRuns: 2 } },
    { ...snapshot, totals: { runs: 1.2, measuredRuns: 1 } }]) assert.equal(subagentSpend(value, "owner"), undefined);
});

test("bridge subscribes before requesting current owner and disposes without polling or retaining task payloads", () => {
  let listener: ((data: unknown) => void) | undefined, requests = 0;
  const updates: unknown[] = [];
  const pi = { events: {
    on(name: string, handler: (data: unknown) => void) {
      assert.equal(name, "pi:background-tasks"); listener = handler;
      return () => { listener = undefined; };
    },
    emit(name: string, value: unknown) {
      assert.equal(name, "pi:background-tasks:request");
      assert.deepEqual(value, { version: 1, sessionId: "owner" });
      requests++; listener!(snapshot);
    },
  } } as unknown as ExtensionAPI;
  const dispose = installSubagentUsage(pi, "owner", spend => updates.push(spend));
  assert.equal(requests, 1);
  assert.deepEqual(updates, [{ runs: 3, measuredRuns: 2, cost: 0.08 }]);
  listener!({ ...snapshot, sessionId: "foreign" });
  assert.equal(updates.length, 1);
  listener!({ ...snapshot, totals: { runs: 0, measuredRuns: 0 } });
  assert.deepEqual(updates.at(-1), { runs: 0, measuredRuns: 0, cost: null });
  dispose(); assert.equal(listener, undefined);
});
