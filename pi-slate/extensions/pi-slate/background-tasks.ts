import { formatCompactTokenCount } from "./layout.ts";
import { record, sidebarText } from "./sidebar-text.ts";

const MAX_TASKS = 64;
const MAX_DETAIL_LINES = 16;
const MAX_DETAIL_LINE = 320;
const LIVE_STATES = new Set(["starting", "running", "waiting", "cleanup_unknown"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

export type BackgroundTaskUsage = Partial<Record<typeof USAGE_KEYS[number], number>>;
export type SubagentTask = {
  id: string;
  label: string;
  state: string;
  startedAt?: number;
  pid?: number;
  usage?: BackgroundTaskUsage;
  usagePartial?: true;
  detail?: string;
};

function boundedDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.replace(/\r\n?/g, "\n").split("\n", MAX_DETAIL_LINES)
    .map(line => sidebarText(line, MAX_DETAIL_LINE));
  const detail = lines.join("\n").trim();
  return detail || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseUsage(value: unknown): BackgroundTaskUsage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const usage: BackgroundTaskUsage = {};
  for (const key of USAGE_KEYS) {
    const amount = optionalNumber(raw[key]);
    if (amount !== undefined) usage[key] = amount;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function parseTask(value: unknown): SubagentTask | undefined {
  const raw = record(value);
  if (!raw || raw.kind !== "subagent" || typeof raw.state !== "string" || !LIVE_STATES.has(raw.state)) return undefined;
  const id = sidebarText(raw.id, 200);
  const label = sidebarText(raw.label, 160);
  if (!id || !label) return undefined;
  const startedAt = optionalNumber(raw.startedAt);
  const pid = optionalNumber(raw.pid);
  const usage = parseUsage(raw.usage);
  const detail = boundedDetail(raw.detail);
  return {
    id, label, state: raw.state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(pid === undefined || !Number.isSafeInteger(pid) ? {} : { pid }),
    ...(usage ? { usage } : {}),
    ...(raw.usagePartial === true ? { usagePartial: true as const } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Parse the public pi-subagents v1 display protocol for the current owning session. */
export function parseSubagentSnapshot(value: unknown, sessionId: string | undefined): SubagentTask[] | undefined {
  const raw = record(value);
  if (!sessionId || !raw || raw.version !== 1 || raw.source !== "pi-subagents" || raw.sessionId !== sessionId || !Array.isArray(raw.tasks)) return undefined;
  const tasks: SubagentTask[] = [];
  const ids = new Set<string>();
  for (const value of raw.tasks.slice(0, MAX_TASKS)) {
    const task = parseTask(value);
    if (!task || ids.has(task.id)) continue;
    ids.add(task.id); tasks.push(task);
  }
  return tasks;
}

/** Session-scoped shelf state. Invalid and cross-session snapshots leave current state intact. */
export class SubagentShelf {
  private sessionId?: string;
  private tasks: SubagentTask[] = [];
  private readonly changed: (tasks: readonly SubagentTask[]) => void;
  constructor(changed: (tasks: readonly SubagentTask[]) => void) { this.changed = changed; }
  switchSession(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.tasks = [];
    this.changed(this.snapshot());
  }
  accept(value: unknown): boolean {
    const tasks = parseSubagentSnapshot(value, this.sessionId);
    if (!tasks) return false;
    this.tasks = tasks;
    this.changed(this.snapshot());
    return true;
  }
  clear(): void { this.switchSession(undefined); }
  snapshot(): SubagentTask[] { return this.tasks.map(task => ({ ...task, ...(task.usage ? { usage: { ...task.usage } } : {}) })); }
}

export function subagentTaskDetails(task: SubagentTask): string {
  const lines = [`State: ${task.state}`, `Run: ${task.id}`];
  if (task.startedAt !== undefined) {
    const started = new Date(task.startedAt);
    if (!Number.isNaN(started.getTime())) lines.push(`Started: ${started.toISOString()}`);
  }
  if (task.pid !== undefined) lines.push(`PID: ${task.pid}`);
  if (task.usage) {
    const usage = task.usage;
    const tokens = [`input ${formatCompactTokenCount(usage.input)}`, `output ${formatCompactTokenCount(usage.output)}`,
      `cache read ${formatCompactTokenCount(usage.cacheRead)}`, `cache write ${formatCompactTokenCount(usage.cacheWrite)}`];
    lines.push(`Usage${task.usagePartial ? " (partial)" : ""}: ${tokens.join(" · ")}`);
    if (usage.cost !== undefined) lines.push(`Cost: $${usage.cost.toFixed(2)}`);
  }
  if (task.detail) lines.push("", task.detail);
  return lines.join("\n");
}
