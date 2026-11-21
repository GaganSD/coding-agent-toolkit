import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  ContextUsageCache,
  estimateContextTokensFromEntries,
  resolveContextTokens,
  sessionSpend,
} from "../extensions/pi-slate/context-usage.ts";

function user(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "0",
    message: { role: "user", content: text },
  } as SessionEntry;
}

function assistant(id: string, text: string, cost: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "0",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { cost: { total: cost } },
    },
  } as SessionEntry;
}

function compaction(id: string, summary: string, cost = 0): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "0",
    summary,
    firstKeptEntryId: "kept",
    tokensBefore: 239_671,
    usage: { cost: { total: cost } },
  } as SessionEntry;
}

test("estimates remaining context from compaction summary plus kept messages", () => {
  const summary = "a".repeat(40);
  const kept = "b".repeat(20);
  assert.equal(
    estimateContextTokensFromEntries([compaction("c1", summary), user("kept", kept)]),
    Math.ceil(summary.length / 4) + Math.ceil(kept.length / 4),
  );
});

test("after compact, null provider usage falls back to the remaining-context estimate", () => {
  const entries = [compaction("c1", "a".repeat(40)), user("kept", "b".repeat(20))];
  assert.deepEqual(
    resolveContextTokens({ tokens: null, percent: null, contextWindow: 200 }, entries),
    { tokens: 15, percent: 7.5 },
  );
  assert.deepEqual(
    resolveContextTokens({ tokens: 3485, percent: 2.4, contextWindow: 200_000 }, entries),
    { tokens: 3485, percent: 2.4 },
  );
});

test("context usage reuses the leaf, session and model limits, but retries transient failures", () => {
  const cache = new ContextUsageCache();
  let leaf: string | null | undefined = null, sessionId = "one", calls = 0, projections = 0, fail = false, unavailable = false;
  const model = { provider: "fixture", id: "model", api: "fixture-api", contextWindow: 1000 };
  const ctx = {
    model,
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => leaf, buildContextEntries() { projections++; return [user("x", "test")]; } },
    getContextUsage() {
      calls++;
      if (fail) throw new Error("temporarily unavailable");
      if (unavailable) return undefined;
      return { tokens: null, percent: null, contextWindow: model.contextWindow };
    },
  } as unknown as ExtensionContext;
  assert.equal(cache.get(ctx).tokens, 1);
  assert.equal(cache.get(ctx).percent, 0.1);
  assert.deepEqual([calls, projections], [1, 1]);
  leaf = "next";
  cache.get(ctx);
  sessionId = "two";
  cache.get(ctx);
  model.contextWindow = 2000;
  assert.equal(cache.get(ctx).percent, 0.05);
  assert.deepEqual([calls, projections], [4, 4]);
  cache.reset();
  fail = true;
  assert.equal(cache.get(ctx).tokens, null);
  fail = false;
  assert.equal(cache.get(ctx).tokens, 1);
  assert.deepEqual([calls, projections], [6, 5]);
  model.api = "pi-virtual";
  cache.get(ctx); cache.get(ctx);
  model.api = "fixture-api"; leaf = undefined;
  cache.get(ctx); cache.get(ctx);
  assert.deepEqual([calls, projections], [10, 9], "unknown leaf and opaque routed limits are not cached");
  leaf = "unavailable"; unavailable = true;
  cache.get(ctx);
  unavailable = false;
  cache.get(ctx); cache.get(ctx);
  assert.deepEqual([calls, projections], [12, 11], "a missing usage snapshot with valid model limits is retried");
});

test("session spend includes compacted history and the compact call", () => {
  assert.equal(
    sessionSpend([
      assistant("old", "pre", 1.2),
      compaction("c1", "summary", 0.05),
      assistant("new", "post", 0.3),
    ]),
    1.55,
  );
});
