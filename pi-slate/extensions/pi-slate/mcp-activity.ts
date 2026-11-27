import type { AgentToolResult, ToolExecutionEndEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { sidebarText } from "./sidebar-text.ts";

export const MCP_WARN_MS = 60_000;

export type McpActivityView = {
  active: boolean;
  warning: boolean;
  warnUntil: number | null;
  calls: number;
  lastUsed: number | null;
  lastError: { text: string; at: number } | null;
};

type ServerActivity = {
  calls: number;
  lastUsed: number | null;
  warnUntil: number | null;
  lastError: { text: string; at: number } | null;
};

/** Session-scoped call counts and the tiny live state the MCP rows paint. */
export class McpActivity {
  private readonly servers = new Map<string, ServerActivity>();
  private readonly calls = new Map<string, string>();

  /** Pi starts before validation/permission hooks, so the spinner may wait on a prompt; a blocked attempt ends with no durationMs. */
  start(id: string, server: string): void {
    this.calls.set(id, server);
  }

  /** Returns whether this was a tracked MCP call; an untracked id is a no-op. */
  end(event: ToolExecutionEndEvent, aborted: boolean, now: number): boolean {
    const server = this.calls.get(event.toolCallId);
    if (server === undefined) return false;
    this.calls.delete(event.toolCallId);
    if (event.durationMs === undefined) return true;
    let state = this.servers.get(server);
    if (!state) {
      state = { calls: 0, lastUsed: null, warnUntil: null, lastError: null };
      this.servers.set(server, state);
    }
    state.calls++;
    state.lastUsed = now;
    if (event.isError === false) { state.warnUntil = null; return true; }
    if (aborted) return true;
    state.warnUntil = now + MCP_WARN_MS;
    state.lastError = { text: errorText(event.result), at: now };
    return true;
  }

  view(server: string, now: number): McpActivityView {
    const state = this.servers.get(server);
    const warnUntil = state?.warnUntil ?? null;
    return {
      active: this.active(server),
      warning: warnUntil !== null && now < warnUntil,
      warnUntil,
      calls: state?.calls ?? 0,
      lastUsed: state?.lastUsed ?? null,
      lastError: state?.lastError ?? null,
    };
  }

  reset(): void {
    this.servers.clear();
    this.calls.clear();
  }

  private active(server: string): boolean {
    for (const name of this.calls.values()) if (name === server) return true;
    return false;
  }
}

function errorText(result: AgentToolResult): string {
  for (const block of result.content) {
    if (block.type !== "text") continue;
    const text = sidebarText(block.text, 200);
    if (text) return text;
  }
  return "error";
}

export function mcpServer(toolName: string, tools: () => readonly ToolInfo[]): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const namespace = tools().find(tool => tool.name === toolName)?.namespace;
  return namespace?.name.startsWith("mcp__") ? namespace.aliases?.[0] : undefined;
}
