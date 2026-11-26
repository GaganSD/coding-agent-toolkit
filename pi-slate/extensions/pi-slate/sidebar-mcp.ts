import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { record, sidebarText } from "./sidebar-text.ts";

export type McpRuntimeState = "idle" | "active" | "error";
export type SidebarMcp = { name: string; enabled: boolean | null; source: string; runtime: McpRuntimeState };
export type SidebarMcpResult = { mcp: SidebarMcp[]; mcpError?: string };
type McpFile = { servers: Record<string, unknown>; error?: string };
type RuntimeToolInfo = Partial<Pick<ToolInfo, "name" | "namespace">>;

const MAX_RUNTIME_NAME = 512;
const MAX_RUNTIME_CALLS = 4096;
const MAX_CATALOG_TOOLS = 16_384;

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_RUNTIME_NAME ? value : undefined;
}

function unique(values: Iterable<string>): string | undefined {
  let match: string | undefined;
  for (const value of values) {
    if (match !== undefined && match !== value) return undefined;
    match = value;
  }
  return match;
}

function runtimeServer(tools: readonly RuntimeToolInfo[], toolName: string, configured: ReadonlySet<string>): string | undefined {
  const aliases = new Set<string>(), candidates = new Set<string>();
  for (const tool of tools) {
    try {
      if (!tool || boundedString(tool.name) !== toolName || !tool.namespace || typeof tool.namespace !== "object") continue;
      const namespace = boundedString(Reflect.get(tool.namespace, "name"));
      if (namespace?.startsWith("mcp__") && namespace.length > 5) candidates.add(namespace.slice(5));
      const rawAliases = Reflect.get(tool.namespace, "aliases");
      if (Array.isArray(rawAliases)) {
        for (const alias of rawAliases) {
          const bounded = boundedString(alias);
          if (bounded) aliases.add(bounded);
        }
      }
    } catch { /* Ignore malformed catalog entries. */ }
  }
  const alias = unique([...aliases].filter(name => configured.has(name)));
  if (alias) return alias;
  const exact = unique([...candidates].filter(name => configured.has(name)));
  if (exact) return exact;
  const canonical = new Set([...candidates].map(name => name.replace(/-/g, "_")));
  return unique([...configured].filter(name => canonical.has(name.replace(/-/g, "_"))));
}

/** Session-scoped call state. Catalog failures leave tools untracked instead of affecting execution. */
export class McpRuntimeTracker {
  private configured = new Set<string>();
  private readonly calls = new Map<string, string>();
  private readonly active = new Map<string, Set<string>>();
  private readonly failed = new Set<string>();

  setServers(servers: readonly SidebarMcp[]): void {
    this.configured = new Set(servers.map(server => server.name).filter(name => boundedString(name) !== undefined));
    for (const name of this.active.keys()) if (!this.configured.has(name)) this.active.delete(name);
    for (const name of this.failed) if (!this.configured.has(name)) this.failed.delete(name);
    for (const [id, name] of this.calls) if (!this.configured.has(name)) this.calls.delete(id);
  }

  start(toolCallId: unknown, toolName: unknown, catalog: () => readonly RuntimeToolInfo[]): void {
    const id = boundedString(toolCallId), name = boundedString(toolName);
    if (!id || !name || !this.configured.size || (!this.calls.has(id) && this.calls.size >= MAX_RUNTIME_CALLS)) return;
    let tools: readonly RuntimeToolInfo[];
    try { tools = catalog(); } catch { return; }
    if (!Array.isArray(tools)) return;
    const limit = Math.min(tools.length, MAX_CATALOG_TOOLS);
    const server = runtimeServer(tools.slice(0, limit), name, this.configured);
    if (!server) return;
    const previous = this.calls.get(id);
    if (previous && previous !== server) this.active.get(previous)?.delete(id);
    this.calls.set(id, server);
    const calls = this.active.get(server) ?? new Set<string>();
    calls.add(id); this.active.set(server, calls);
  }

  finish(toolCallId: unknown, isError: unknown): void {
    const id = boundedString(toolCallId);
    if (!id || typeof isError !== "boolean") return;
    const server = this.calls.get(id);
    if (!server) return;
    this.calls.delete(id);
    const calls = this.active.get(server);
    calls?.delete(id);
    if (calls?.size === 0) this.active.delete(server);
    if (isError) this.failed.add(server);
    else this.failed.delete(server);
  }

  state(server: string): McpRuntimeState {
    if ((this.active.get(server)?.size ?? 0) > 0) return "active";
    return this.failed.has(server) ? "error" : "idle";
  }

  apply(servers: readonly SidebarMcp[]): SidebarMcp[] {
    this.setServers(servers);
    return servers.map(server => ({ ...server, runtime: this.state(server.name) }));
  }

  reset(): void {
    this.configured.clear(); this.calls.clear(); this.active.clear(); this.failed.clear();
  }
}

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
      rows.set(server.name, { name: sidebarText(server.name), source: "extension", enabled: configuredEnabled(server.config), runtime: "idle" });
    }
  }
  for (const [name, server] of files) rows.set(name, { name: sidebarText(name), source: server.source, enabled: configuredEnabled(server.config), runtime: "idle" });
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function mcpDetails(server: SidebarMcp): string {
  const runtime = server.runtime === "active" ? "active call in flight" : server.runtime === "error" ? "last completed call failed" : "idle";
  return `${server.enabled === null ? "—" : server.enabled ? "enabled" : "disabled"} (configured state)\nRuntime: ${runtime}\nSource: ${server.source}\n`
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
