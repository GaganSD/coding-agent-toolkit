import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { SessionEntry, SlashCommandInfo, Skill } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type { SidebarPerf } from "./perf-stats.ts";
import type { SidebarMcpResult } from "./sidebar-mcp.ts";
import { record, sidebarText } from "./sidebar-text.ts";
export { record, sidebarText } from "./sidebar-text.ts";
export { parseMcpFile, sidebarMcp, SidebarMcpFiles, type SidebarMcp, type SidebarMcpResult } from "./sidebar-mcp.ts";

export type SidebarUsage = {
  input: number | null; output: number | null; cacheRead: number | null;
  cacheWrite: number | null; uncached: number | null; total: number | null; cost: number | null;
  cacheSeen: boolean;
  /** Branch-wide read savings estimate; unknown unless every cached read is priceable. */
  saved: number | null;
};
export type SidebarSkill = { name: string; path: string; source: string; loaded: boolean };
export type SidebarCommand = { name: string; source: string; description?: string };
export type SidebarPrompt = { name: string; source: string; description?: string };
export type SidebarResources = { skills: SidebarSkill[]; commands: SidebarCommand[]; prompts: SidebarPrompt[] } & SidebarMcpResult;
export type SidebarSession = {
  id: string; name?: string; pid: number; cwd: string; model: string; thinking: string;
  tokens: number | null; percent: number | null; contextWindow: number | null;
  estimated: boolean; rate: number | null; startedAt: number; lastTurnMs: number | null;
  /** Wall-clock start of the running turn; absent or null when idle. */
  turnStartedAt?: number | null;
  working: boolean; turns: number; messages: number; usage: SidebarUsage;
  usingOAuth?: boolean;
  perf: SidebarPerf;
};
export type SidebarFolds = { subagents: boolean; mcp: boolean; skills: boolean; prompts: boolean };
export const DEFAULT_SIDEBAR_FOLDS: SidebarFolds = { subagents: false, mcp: false, skills: false, prompts: false };

export function parseSidebarFolds(value: unknown): SidebarFolds {
  const raw = record(value);
  return { subagents: raw?.subagents === true, mcp: raw?.mcp === true, skills: raw?.skills === true, prompts: raw?.prompts === true };
}
export function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function cacheReadSavings(raw: Record<string, unknown>, cost: Record<string, unknown> | undefined, read: number): number | null {
  const input = nonnegative(raw.input);
  const inputCost = nonnegative(cost?.input);
  const readCost = nonnegative(cost?.cacheRead);
  return input && inputCost && readCost !== null ? nonnegative(Math.max(0, read * (inputCost / input) - readCost)) : null;
}

/** Active-branch usage, including nested tools and summaries, once per owning entry. */
export function sidebarUsage(entries: readonly SessionEntry[]): SidebarUsage {
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const missing = new Set<keyof typeof sums>();
  const seen = new Set<string>();
  let cacheSeen = false;
  let saved: number | null = 0;
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    let usage: unknown;
    let expected: boolean;
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      usage = "usage" in entry.message ? entry.message.usage : undefined;
      expected = entry.message.role === "assistant";
    } else if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      usage = entry.usage;
      expected = true;
    } else continue;
    const raw = record(usage);
    if (!raw) {
      if (expected) for (const key of Object.keys(sums) as Array<keyof typeof sums>) missing.add(key);
      continue;
    }
    const cost = record(raw.cost);
    const read = nonnegative(raw.cacheRead);
    if (read && saved !== null) {
      // Summary and tool ledgers may blend distinct requests and prices.
      const singleRequest = entry.type === "usage" && entry.kind === "cache_warm" || entry.type === "message" && entry.message.role === "assistant";
      const estimate = singleRequest ? cacheReadSavings(raw, cost, read) : null;
      saved = estimate === null ? null : nonnegative(saved + estimate);
    }
    for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
      const value = nonnegative(key === "cost" ? cost?.total : raw[key]);
      if (value === null) missing.add(key);
      else {
        sums[key] += value;
        if (!Number.isFinite(sums[key])) missing.add(key);
        if ((key === "cacheRead" || key === "cacheWrite") && value > 0) cacheSeen = true;
      }
    }
  }
  // Pi's input is uncached input; cacheRead/cacheWrite are separate categories.
  const inbound = missing.has("input") || missing.has("cacheRead") || missing.has("cacheWrite")
    ? null : nonnegative(sums.input + sums.cacheRead + sums.cacheWrite);
  const output = missing.has("output") ? null : sums.output;
  return {
    input: inbound, output, cacheSeen,
    uncached: missing.has("input") ? null : sums.input,
    cacheRead: missing.has("cacheRead") ? null : sums.cacheRead,
    cacheWrite: missing.has("cacheWrite") ? null : sums.cacheWrite,
    total: inbound === null || output === null ? null : nonnegative(inbound + output),
    cost: missing.has("cost") ? null : sums.cost,
    saved: missing.has("cacheRead") || !sums.cacheRead ? null : saved,
  };
}

export function sidebarCacheHit({ input, cacheRead }: SidebarUsage): number | null {
  return input !== null && input > 0 && cacheRead !== null ? cacheRead / input : null;
}

export function sidebarMessageCounts(entries: readonly SessionEntry[]): { turns: number; messages: number } {
  let turns = 0; let messages = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") turns += 1;
    if (entry.message.role === "user" || entry.message.role === "assistant") messages += 1;
  }
  return { turns, messages };
}

export function commandResources(commands: readonly SlashCommandInfo[]): { skills: SidebarSkill[]; commands: SidebarCommand[]; prompts: SidebarPrompt[] } {
  const skills = new Map<string, SidebarSkill>();
  const result = new Map<string, SidebarCommand>();
  const prompts = new Map<string, SidebarPrompt>();
  for (const command of commands) {
    if (command.source === "skill") {
      const path = command.sourceInfo?.path;
      if (path) skills.set(resolve(path), { name: sidebarText(command.name.replace(/^skill:/, "")), path: resolve(path), source: sidebarText(command.sourceInfo.scope), loaded: false });
    } else if (command.source === "prompt") {
      const name = sidebarText(command.name);
      if (name) prompts.set(name, { name, source: command.source, description: sidebarText(command.description) });
    } else {
      const name = sidebarText(command.name);
      if (name) result.set(name, { name, source: command.source, description: sidebarText(command.description) });
    }
  }
  return { skills: [...skills.values()], commands: [...result.values()], prompts: [...prompts.values()] };
}

function skillReadPath(tool: string, args: unknown, cwd: string): string | undefined {
  const path = record(args)?.path;
  if (tool !== "read" || typeof path !== "string") return undefined;
  // Match the builtin reader's @ prefix, Unicode spaces, file URLs and tilde.
  let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  normalized = normalized.replace(/^~(?=\/|$)/, homedir());
  try { if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized); } catch { return undefined; }
  return basename(normalized) === "SKILL.md" ? resolve(cwd, normalized) : undefined;
}

/** Catalog and observed reads are separate; discovery is never proof of loaded instructions. */
export class SidebarSkills {
  private catalog = new Map<string, SidebarSkill>();
  private reads = new Set<string>();
  private pending = new Map<string, string>();
  reset(commands: readonly SlashCommandInfo[]): void {
    this.catalog.clear(); this.reads.clear(); this.pending.clear();
    this.discoverCommands(commands);
  }
  discoverCommands(commands: readonly SlashCommandInfo[]): void {
    for (const skill of commandResources(commands).skills) this.catalog.set(skill.path, skill);
  }
  discover(skills: readonly Skill[]): void {
    // Structured prompt options include skills even when skill commands are disabled.
    this.catalog.clear();
    for (const skill of skills) this.catalog.set(resolve(skill.filePath), {
      name: sidebarText(skill.name), path: resolve(skill.filePath), source: sidebarText(skill.sourceInfo?.scope), loaded: false,
    });
  }
  readStart(id: string, tool: string, args: unknown, cwd: string): void {
    const path = skillReadPath(tool, args, cwd);
    if (path) this.pending.set(id, path);
  }
  readEnd(id: string, isError: boolean): void {
    const path = this.pending.get(id);
    this.pending.delete(id);
    if (path && !isError) this.reads.add(path);
  }
  observeNested(calls: readonly { name: string; arguments?: unknown; status: string }[], cwd: string): void {
    for (const call of calls) if (call.status === "ok") {
      const path = skillReadPath(call.name, call.arguments, cwd);
      if (path) this.reads.add(path);
    }
  }
  restore(entries: readonly SessionEntry[], cwd: string): void {
    this.reads.clear(); this.pending.clear();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") this.readStart(block.id, block.name, block.arguments, cwd);
        }
      } else if (message.role === "toolResult") {
        this.readEnd(message.toolCallId, message.isError);
        this.observeNested(message.nestedCalls?.calls ?? [], cwd);
      } else if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content
          : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        this.observePrompt(text);
      }
    }
    this.pending.clear();
  }
  observePrompt(prompt: string): void {
    // Pi's explicit /skill invocation embeds its canonical path in the user message.
    const match = prompt.match(/^<skill\s+name="[^"]*"\s+(?:location|path)="([^"]+)"/);
    if (match) this.reads.add(resolve(match[1]!));
  }
  snapshot(): SidebarSkill[] {
    const skills = [...this.catalog.values()].map(skill => ({ ...skill, loaded: this.reads.has(skill.path) }));
    // Successfully observed instructions remain evidence even without a catalog
    // entry (disabled skill commands, removed resources, or explicit file loads).
    for (const path of this.reads) if (!this.catalog.has(path)) {
      skills.push({ name: sidebarText(basename(dirname(path))) || "SKILL.md", path, source: "observed", loaded: true });
    }
    return skills.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name));
  }
}
