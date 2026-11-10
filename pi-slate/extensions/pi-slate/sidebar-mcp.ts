import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { record, sidebarText } from "./sidebar-text.ts";

export type SidebarMcp = { name: string; enabled: boolean | null; source: string };
export type SidebarMcpResult = { mcp: SidebarMcp[]; mcpError?: string };
type McpFile = { servers: Record<string, unknown>; error?: string };

/** Read declarations, not Pi's server schema. Never import a client/validator or evaluate credentials. */
export function parseMcpFile(text: string | undefined): McpFile {
  if (text === undefined) return { servers: {} };
  try {
    const raw = record(JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text));
    const servers = record(raw?.mcpServers);
    if (!raw || (raw.mcpServers !== undefined && !servers)) return { servers: {}, error: "MCP config invalid" };
    return { servers: servers ?? {} };
  } catch { return { servers: {}, error: "MCP config unreadable" }; }
}

function configuredEnabled(value: unknown): boolean | null {
  const config = record(value);
  if (!config || (config.enabled !== undefined && typeof config.enabled !== "boolean")) return null;
  return config.enabled !== false;
}
const namespace = (name: string): string => name.replace(/-/g, "_");

/** Desired configuration only. Pi owns schema validation, rejection, authentication and live health. */
export function sidebarMcp(
  registered: readonly { name: string; config: unknown }[], global: McpFile, project?: McpFile,
): SidebarMcp[] {
  const files = new Map<string, { config: unknown; source: string }>();
  for (const [source, entries] of [["global", global.servers], ["project", project?.servers ?? {}]] as const) {
    for (const [name, raw] of Object.entries(entries)) {
      const entry = record(raw);
      const base = record(files.get(name)?.config);
      // A flag-only project declaration inherits the exact-name global declaration.
      // Do not validate other fields or decide which entries Pi will accept.
      const config = source === "project" && base && entry
        && entry.command === undefined && entry.url === undefined && entry.type === undefined
        ? { ...base, ...entry } : raw;
      files.set(name, { config, source });
    }
  }
  const rows = new Map<string, SidebarMcp>();
  const fileNamespaces = new Set([...files.keys()].map(namespace));
  for (const server of registered) {
    if (!fileNamespaces.has(namespace(server.name))) {
      rows.set(server.name, { name: sidebarText(server.name), source: "extension", enabled: configuredEnabled(server.config) });
    }
  }
  for (const [name, server] of files) rows.set(name, { name: sidebarText(name), source: server.source, enabled: configuredEnabled(server.config) });
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function mcpDetails(server: SidebarMcp): string {
  return `${server.enabled === null ? "—" : server.enabled ? "enabled" : "disabled"} (configuration, not connection status)\nSource: ${server.source}\n`
    + (server.enabled === null ? "Enabled state could not be read from this declaration.\n" : "")
    + "Slate does not validate MCP server configurations. Use /mcp for validation and live status.";
}

/** Bounded, cached file reads outside render. No host versions, private imports, connections or commands. */
export class SidebarMcpFiles {
  private readonly cached = new Map<string, { key: string; value: McpFile }>();
  read(path: string): McpFile {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) return { servers: {}, error: "MCP config unreadable" };
      const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const old = this.cached.get(path);
      if (old?.key === key) return old.value;
      const value = parseMcpFile(readFileSync(path, "utf8"));
      this.cached.set(path, { key, value });
      return value;
    } catch (error) {
      this.cached.delete(path);
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { servers: {} } : { servers: {}, error: "MCP config unreadable" };
    }
  }
  snapshot(agentDir: string, cwd: string, trusted: boolean, registered: readonly { name: string; config: unknown }[]): SidebarMcpResult {
    const global = this.read(join(agentDir, "mcp.json"));
    const project = trusted ? this.read(join(cwd, ".pi", "mcp.json")) : undefined;
    const mcpError = project?.error ?? global.error;
    return { mcp: sidebarMcp(registered, global, project), ...(mcpError ? { mcpError } : {}) };
  }
  clear(): void { this.cached.clear(); }
}
