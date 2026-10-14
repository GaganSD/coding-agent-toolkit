import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { classifySessionFailure } from "../src/session.ts";

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
