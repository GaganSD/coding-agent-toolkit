import type { AgentToolResult, ToolExecutionEndEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { sidebarText } from "./sidebar-text.ts";

export const MCP_WARN_MS = 60_000;

export type McpActivityView = {
  active: boolean;
  warning: boolean;
  calls: number;
  lastUsed: number | null;
  lastError: { text: string; at: number } | null;
};

type ServerActivity = {
  calls: number;
  lastUsed: number | null;
  warningAt: number | null;
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

  end(event: ToolExecutionEndEvent, aborted: boolean, now: number): void {
    const server = this.calls.get(event.toolCallId);
    if (server === undefined) return;
    this.calls.delete(event.toolCallId);
    if (event.durationMs === undefined) return;
    const state = this.state(server);
    state.calls++;
    state.lastUsed = now;
    if (aborted) return;
    if (!event.isError) { state.warningAt = null; return; }
    state.warningAt = now;
    state.lastError = { text: errorText(event.result), at: now };
  }

  view(server: string, now: number): McpActivityView {
    const state = this.servers.get(server);
    const warningAt = state?.warningAt;
    return {
      active: this.active(server),
      warning: warningAt !== null && warningAt !== undefined && now - warningAt < MCP_WARN_MS,
      calls: state?.calls ?? 0,
      lastUsed: state?.lastUsed ?? null,
      lastError: state?.lastError ?? null,
    };
  }

  anyActive(): boolean { return this.calls.size > 0; }

  reset(): void {
    this.servers.clear();
    this.calls.clear();
  }

  private active(server: string): boolean {
    for (const name of this.calls.values()) if (name === server) return true;
    return false;
  }

  private state(server: string): ServerActivity {
    let state = this.servers.get(server);
    if (!state) {
      state = { calls: 0, lastUsed: null, warningAt: null, lastError: null };
      this.servers.set(server, state);
    }
    return state;
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

export function mcpServer(toolName: string, tools: readonly ToolInfo[]): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const namespace = tools.find(tool => tool.name === toolName)?.namespace;
  return namespace?.name.startsWith("mcp__") ? namespace.aliases?.[0] : undefined;
}
