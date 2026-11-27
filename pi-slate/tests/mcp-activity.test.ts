import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionEndEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { McpActivity, MCP_WARN_MS, mcpOutcome, mcpServer } from "../extensions/pi-slate/mcp-activity.ts";

const ended = (extra: Partial<ToolExecutionEndEvent> = {}): ToolExecutionEndEvent => ({
  type: "tool_execution_end", toolCallId: "call", toolName: "mcp__docs__search", result: {}, isError: false, ...extra,
});
const success = { ran: true, result: "success" } as const;

test("concurrent calls keep a server active until the last one ends", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.start("b", "docs");
  assert.equal(activity.anyActive(), true);
  activity.end("a", success, 1_000);
  assert.equal(activity.view("docs", 1_000).active, true);
  assert.equal(activity.view("docs", 1_000).calls, 1);
  activity.end("b", success, 2_000);
  assert.deepEqual(activity.view("docs", 2_000), {
    active: false, warning: false, calls: 2, lastUsed: 2_000, lastError: null,
  });
  assert.equal(activity.anyActive(), false);
});

test("a success clears the warning but keeps the last error details", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end("a", { ran: true, result: "error", error: "lookup failed" }, 1_000);
  assert.equal(activity.view("docs", 1_000).warning, true);
  activity.start("b", "docs");
  activity.end("b", success, 2_000);
  assert.deepEqual(activity.view("docs", 2_000).lastError, { text: "lookup failed", at: 1_000 });
  assert.equal(activity.view("docs", 2_000).warning, false);
  assert.equal(activity.view("docs", 2_000).calls, 2);
});

test("a warning fades 60 seconds after the failure and leaves the error in details", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end("a", { ran: true, result: "error", error: "timeout" }, 5_000);
  assert.equal(activity.view("docs", 5_000 + MCP_WARN_MS - 1).warning, true);
  assert.equal(activity.view("docs", 5_000 + MCP_WARN_MS).warning, false);
  assert.deepEqual(activity.view("docs", 5_000 + MCP_WARN_MS).lastError, { text: "timeout", at: 5_000 });
});

test("an end without durationMs never ran: no call, failure or last-used update", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  const outcome = mcpOutcome(ended({ isError: true }), false);
  assert.deepEqual(outcome, { ran: false });
  activity.end("a", outcome, 1_000);
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, calls: 0, lastUsed: null, lastError: null,
  });
});

test("an aborted call counts and updates last-used but is not a failure", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  const outcome = mcpOutcome(ended({ durationMs: 7, isError: true }), true);
  assert.deepEqual(outcome, { ran: true, result: "aborted" });
  activity.end("a", outcome, 1_000);
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, calls: 1, lastUsed: 1_000, lastError: null,
  });

  activity.start("b", "docs");
  activity.end("b", { ran: true, result: "error", error: "old failure" }, 2_000);
  activity.start("c", "docs");
  activity.end("c", { ran: true, result: "aborted" }, 3_000);
  assert.equal(activity.view("docs", 3_000).warning, true, "an abort does not clear an existing warning");
  assert.deepEqual(activity.view("docs", 3_000).lastError, { text: "old failure", at: 2_000 });
});

test("the first error text block is sanitized to one bounded line", () => {
  const raw = `\x1b[31mBad request\x1b[0m\n${"detail ".repeat(60)}`;
  const outcome = mcpOutcome(ended({
    durationMs: 8,
    isError: true,
    result: { content: [{ type: "image", data: "ignored" }, { type: "text", text: raw }] },
  }), false);
  if (!outcome.ran || outcome.result !== "error") assert.fail("expected a failed, executed outcome");
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end("a", outcome, 1_000);
  const error = activity.view("docs", 1_000).lastError!;
  assert.match(error.text, /^Bad request detail /);
  assert.equal(error.text.length, 200);
  assert.doesNotMatch(error.text, /[\x1b\n]/);
  assert.equal(error.at, 1_000);
});

test("reset clears active calls, counts, warnings and errors", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end("a", { ran: true, result: "error", error: "boom" }, 1_000);
  activity.start("b", "docs");
  activity.reset();
  assert.equal(activity.anyActive(), false);
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, calls: 0, lastUsed: null, lastError: null,
  });
});

test("MCP server lookup only runs for MCP tools and requires a namespace alias", () => {
  let reads = 0;
  const tools = (): ToolInfo[] => {
    reads++;
    return [{
      name: "mcp__docs__search", description: "", parameters: {}, exposure: "direct",
      namespace: { name: "mcp__docs", aliases: ["docs"] },
      sourceInfo: { path: "/host/mcp.ts", source: "fixture", scope: "user", origin: "top-level" },
    }];
  };
  assert.equal(mcpServer("read", tools), undefined);
  assert.equal(reads, 0);
  assert.equal(mcpServer("mcp__docs__search", tools), "docs");
  assert.equal(mcpServer("mcp__docs__missing", tools), undefined);
  assert.equal(mcpServer("mcp__docs__search", () => { throw new Error("catalog unavailable"); }), undefined);
});
