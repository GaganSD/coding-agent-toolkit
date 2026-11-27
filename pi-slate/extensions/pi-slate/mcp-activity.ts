import type { ToolExecutionEndEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { record, sidebarText } from "./sidebar-text.ts";

export const MCP_WARN_MS = 60_000;

export type McpActivityView = {
  active: boolean;
  warning: boolean;
  calls: number;
  lastUsed: number | null;
  lastError: { text: string; at: number } | null;
};

/** A blocked, invalid, unknown or pre-aborted call never reaches a tool. */
export type McpCallOutcome =
  | { ran: false }
  | { ran: true; result: "success" }
  | { ran: true; result: "aborted" }
  | { ran: true; result: "error"; error: string };

type ServerActivity = {
  active: Set<string>;
  calls: number;
  lastUsed: number | null;
  warningAt: number | null;
  lastError: { text: string; at: number } | null;
};

/** Session-scoped call counts and the tiny live state the MCP rows paint. */
export class McpActivity {
  private readonly servers = new Map<string, ServerActivity>();
  private readonly calls = new Map<string, string>();

  start(id: string, server: string): void {
    this.calls.set(id, server);
    this.state(server).active.add(id);
  }

  end(id: string, outcome: McpCallOutcome, now: number): void {
    const server = this.calls.get(id);
    if (server === undefined) return;
    this.calls.delete(id);
    const state = this.state(server);
    state.active.delete(id);
    if (!outcome.ran) return;
    state.calls++;
    state.lastUsed = now;
    if (outcome.result === "aborted") return;
    if (outcome.result === "success") { state.warningAt = null; return; }
    state.warningAt = now;
    state.lastError = { text: outcome.error, at: now };
  }

  view(server: string, now: number): McpActivityView {
    const state = this.servers.get(server);
    const warningAt = state?.warningAt;
    return {
      active: (state?.active.size ?? 0) > 0,
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

  private state(server: string): ServerActivity {
    let state = this.servers.get(server);
    if (!state) {
      state = { active: new Set(), calls: 0, lastUsed: null, warningAt: null, lastError: null };
      this.servers.set(server, state);
    }
    return state;
  }
}

export function mcpOutcome(event: ToolExecutionEndEvent, aborted: boolean): McpCallOutcome {
  if (event.durationMs === undefined) return { ran: false };
  if (aborted) return { ran: true, result: "aborted" };
  if (!event.isError) return { ran: true, result: "success" };
  return { ran: true, result: "error", error: errorText(event.result) };
}

function errorText(result: unknown): string {
  const content = record(result)?.content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    const item = record(block);
    if (item?.type === "text" && typeof item.text === "string") return sidebarText(item.text, 200);
  }
  return "";
}

export function mcpServer(toolName: string, catalog: () => readonly ToolInfo[]): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  try {
    const namespace = catalog().find(tool => tool.name === toolName)?.namespace;
    return namespace?.name.startsWith("mcp__") ? namespace.aliases?.[0] : undefined;
  } catch { return undefined; }
}

export function formatMcpAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
