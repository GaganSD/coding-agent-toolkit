import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { classifySessionFailure, wrapSession } from "../src/session.ts";
import type { RunContext } from "../src/types.ts";

function session(messages: Array<{ role: string; stopReason?: string; errorMessage?: string }>): AgentSession {
  return { messages } as AgentSession;
}

test("classifySessionFailure is fail-closed except retryable provider errors", () => {
  const live = new AbortController().signal;
  assert.equal(classifySessionFailure(session([]), live), "unknown");
  assert.equal(classifySessionFailure(session([{ role: "user" }]), live), "unknown");
  assert.equal(classifySessionFailure(session([{ role: "assistant", stopReason: "stop" }]), live), "unknown");
  assert.equal(classifySessionFailure(session([{ role: "assistant", stopReason: "aborted" }]), live), "cancelled");
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(classifySessionFailure(session([{
    role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable",
  }]), cancelled.signal), "cancelled");
  assert.equal(classifySessionFailure(session([{
    role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable",
  }]), live), "transient_provider");
  assert.equal(classifySessionFailure(session([{
    role: "assistant", stopReason: "error", errorMessage: "insufficient_quota",
  }]), live), "provider");
  assert.equal(classifySessionFailure(session([
    { role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable" },
    { role: "assistant", stopReason: "stop" },
  ]), live, 1), "unknown");
});

test("settled sub-agents reject steer and followUp instead of acknowledging a disposed session", async () => {
  let listener!: (event: { type: string }) => void;
  const calls: string[] = [];
  const native = {
    messages: [{ role: "assistant", stopReason: "stop" }],
    model: { contextWindow: 100 },
    subscribe(fn: (event: { type: string }) => void) { listener = fn; return () => {}; },
    async prompt() { listener({ type: "agent_settled" }); },
    async steer(message: string) { calls.push(`steer:${message}`); return "queued"; },
    async followUp(message: string) { calls.push(`followUp:${message}`); return "queued"; },
    async abort() {}, dispose() {},
    getLastAssistantText: () => "report",
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
  } as unknown as AgentSession;
  const context: RunContext = {
    signal: new AbortController().signal, directory: "/tmp",
    own() {}, progress() {}, preview() {}, transcript() {}, ask: async () => "",
  };
  const subAgent = wrapSession(native, "task", context);
  await subAgent.steer("during run");
  assert.deepEqual(calls, ["steer:during run"]);
  const result = await subAgent.prompt();
  assert.equal(result.report, "report");
  await assert.rejects(subAgent.followUp("late"), /settled/);
  await assert.rejects(subAgent.steer("late"), /settled/);
  assert.deepEqual(calls, ["steer:during run"], "no message is acknowledged after settlement");
});
