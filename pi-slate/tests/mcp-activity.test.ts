import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionEndEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { McpActivity, MCP_WARN_MS, mcpServer } from "../extensions/pi-slate/mcp-activity.ts";

const ended = (extra: Partial<ToolExecutionEndEvent> = {}): ToolExecutionEndEvent => ({
  type: "tool_execution_end", toolCallId: "call", toolName: "mcp__docs__search", result: {}, isError: false, ...extra,
});
const success = (id: string) => ended({ toolCallId: id, durationMs: 1 });
const failure = (id: string, text: string) => ended({
  toolCallId: id, durationMs: 1, isError: true, result: { content: [{ type: "text", text }] },
});

test("concurrent calls keep a server active until the last one ends", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.start("b", "docs");
  assert.equal(activity.view("docs", 1_000).active, true);
  activity.end(success("a"), false, 1_000);
  assert.equal(activity.view("docs", 1_000).active, true);
  assert.equal(activity.view("docs", 1_000).calls, 1);
  activity.end(success("b"), false, 2_000);
  assert.deepEqual(activity.view("docs", 2_000), {
    active: false, warning: false, warnUntil: null, calls: 2, lastUsed: 2_000, lastError: null,
  });
});

test("a success clears the warning but keeps the last error details", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(failure("a", "lookup failed"), false, 1_000);
  assert.equal(activity.view("docs", 1_000).warning, true);
  activity.start("b", "docs");
  activity.end(success("b"), false, 2_000);
  assert.deepEqual(activity.view("docs", 2_000).lastError, { text: "lookup failed", at: 1_000 });
  assert.equal(activity.view("docs", 2_000).warning, false);
  assert.equal(activity.view("docs", 2_000).calls, 2);
});

test("a warning fades 60 seconds after the failure and leaves the error in details", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(failure("a", "timeout"), false, 5_000);
  assert.equal(activity.view("docs", 5_000).warnUntil, 5_000 + MCP_WARN_MS);
  assert.equal(activity.view("docs", 5_000 + MCP_WARN_MS - 1).warning, true);
  assert.equal(activity.view("docs", 5_000 + MCP_WARN_MS).warning, false);
  assert.deepEqual(activity.view("docs", 5_000 + MCP_WARN_MS).lastError, { text: "timeout", at: 5_000 });
});

test("a blocked attempt ends without durationMs: no call, failure or last-used update", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(ended({ toolCallId: "a", isError: true }), false, 1_000);
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, warnUntil: null, calls: 0, lastUsed: null, lastError: null,
  });
});

test("an end without a tracked start changes nothing", () => {
  const activity = new McpActivity();
  assert.equal(activity.end(failure("missing", "not tracked"), false, 1_000), false);
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, warnUntil: null, calls: 0, lastUsed: null, lastError: null,
  });
});

test("an aborted call counts and updates last-used but is not a failure", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(ended({ toolCallId: "a", durationMs: 7, isError: true }), true, 1_000);
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, warnUntil: null, calls: 1, lastUsed: 1_000, lastError: null,
  });

  activity.start("b", "docs");
  activity.end(failure("b", "old failure"), false, 2_000);
  activity.start("c", "docs");
  activity.end(ended({ toolCallId: "c", durationMs: 7, isError: true }), true, 3_000);
  assert.equal(activity.view("docs", 3_000).warning, true, "an aborted failure does not clear an existing warning");
  assert.deepEqual(activity.view("docs", 3_000).lastError, { text: "old failure", at: 2_000 });
});

test("a successful end wins over the run-level abort and clears the warning", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(failure("a", "lookup failed"), false, 1_000);
  assert.equal(activity.view("docs", 1_000).warning, true);

  activity.start("b", "docs");
  activity.end(success("b"), true, 2_000);
  const view = activity.view("docs", 2_000);
  assert.equal(view.warning, false);
  assert.equal(view.warnUntil, null);
  assert.equal(view.calls, 2);
  assert.equal(view.lastUsed, 2_000);
  assert.deepEqual(view.lastError, { text: "lookup failed", at: 1_000 });
});

test("the first non-empty error text block is sanitized to one bounded line", () => {
  const raw = `\x1b[31mBad request\x1b[0m\n${"detail ".repeat(60)}`;
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(ended({
    toolCallId: "a",
    durationMs: 8,
    isError: true,
    result: { content: [{ type: "image", data: "ignored" }, { type: "text", text: "" }, { type: "text", text: raw }] },
  }), false, 1_000);
  const error = activity.view("docs", 1_000).lastError!;
  assert.match(error.text, /^Bad request detail /);
  assert.equal(error.text.length, 200);
  assert.doesNotMatch(error.text, /[\x1b\n]/);
  assert.equal(error.at, 1_000);
});

test("a failure without text still has a readable error", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(ended({ toolCallId: "a", durationMs: 8, isError: true, result: { content: [{ type: "image", data: "ignored" }] } }), false, 1_000);
  assert.equal(activity.view("docs", 1_000).lastError?.text, "error");
});

test("reset clears active calls, counts, warnings and errors", () => {
  const activity = new McpActivity();
  activity.start("a", "docs");
  activity.end(failure("a", "boom"), false, 1_000);
  activity.start("b", "docs");
  activity.reset();
  assert.deepEqual(activity.view("docs", 1_000), {
    active: false, warning: false, warnUntil: null, calls: 0, lastUsed: null, lastError: null,
  });
});

test("MCP server lookup is lazy, only runs for MCP tools, and requires a namespace alias", () => {
  const catalog: ToolInfo[] = [{
    name: "mcp__docs__search", description: "", parameters: {}, exposure: "direct",
    namespace: { name: "mcp__docs", aliases: ["docs"] },
    sourceInfo: { path: "/host/mcp.ts", source: "fixture", scope: "user", origin: "top-level" },
  }];
  let reads = 0;
  const tools = () => { reads++; return catalog; };
  assert.equal(mcpServer("read", tools), undefined);
  assert.equal(reads, 0, "non-MCP tools never read the catalog");
  assert.equal(mcpServer("mcp__docs__search", tools), "docs");
  assert.equal(reads, 1);
  assert.equal(mcpServer("mcp__docs__missing", tools), undefined);
  assert.equal(reads, 2);
});
