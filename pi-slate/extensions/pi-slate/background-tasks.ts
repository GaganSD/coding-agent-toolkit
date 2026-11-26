import { formatCompactTokenCount } from "./layout.ts";
import { record, sidebarText } from "./sidebar-text.ts";

const MAX_SOURCES = 16;
const MAX_SOURCE_LENGTH = 128;
const MAX_SOURCE_TASKS = 64;
const MAX_DISPLAY_TASKS = 64;
const MAX_DETAIL_LINES = 16;
const MAX_DETAIL_LINE = 320;
const MAX_NAME_LENGTH = 160;
const MAX_TASK_LINES = 64;
const MAX_TASK_CHARS = 16384;
const MAX_TASK_LINE = 2000;
export const BACKGROUND_TASK_TRANSCRIPT_MAX_LINES = 256;
export const BACKGROUND_TASK_TRANSCRIPT_MAX_CHARS = 65536;
export const BACKGROUND_TASK_TRANSCRIPT_AGGREGATE_CHARS = 524288;
const MAX_TRANSCRIPT_LINE = 2000;
const LIVE_STATES = new Set(["idle", "starting", "running", "waiting", "cleanup_unknown"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

export type BackgroundTaskUsage = Partial<Record<typeof USAGE_KEYS[number], number>>;
export type BackgroundTask = {
  source: string;
  id: string;
  label: string;
  state: string;
  name?: string;
  task?: string;
  transcript?: string;
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

function boundedMultiline(value: unknown, maxLines: number, maxChars: number, maxLine: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Limit scanning as well as retained output so hostile padding cannot create a large temporary split array.
  const input = value.slice(0, maxChars * 4).replace(/\r\n?/g, "\n");
  const lines: string[] = [];
  let offset = 0; let chars = 0;
  while (lines.length < maxLines && offset <= input.length && chars < maxChars) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const line = sidebarText(input.slice(offset, end), maxLine);
    const separator = lines.length ? 1 : 0;
    const available = maxChars - chars - separator;
    if (available <= 0) break;
    lines.push(line.slice(0, available));
    chars += separator + Math.min(line.length, available);
    if (newline < 0) break;
    offset = newline + 1;
  }
  const result = lines.join("\n").trim();
  return result || undefined;
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

function parseSource(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SOURCE_LENGTH) return undefined;
  return sidebarText(value, MAX_SOURCE_LENGTH) ? value : undefined;
}

function parseTask(value: unknown, source: string): BackgroundTask | undefined {
  const raw = record(value);
  if (!raw || raw.kind !== "subagent" || typeof raw.state !== "string" || !LIVE_STATES.has(raw.state)) return undefined;
  const id = sidebarText(raw.id, 200);
  const label = sidebarText(raw.label, 160);
  if (!id || !label) return undefined;
  const startedAt = optionalNumber(raw.startedAt);
  const pid = optionalNumber(raw.pid);
  const usage = parseUsage(raw.usage);
  const detail = boundedDetail(raw.detail);
  const name = sidebarText(raw.name, MAX_NAME_LENGTH) || undefined;
  const task = boundedMultiline(raw.task, MAX_TASK_LINES, MAX_TASK_CHARS, MAX_TASK_LINE);
  const transcript = boundedMultiline(raw.transcript, BACKGROUND_TASK_TRANSCRIPT_MAX_LINES, BACKGROUND_TASK_TRANSCRIPT_MAX_CHARS, MAX_TRANSCRIPT_LINE);
  return {
    source, id, label, state: raw.state,
    ...(name ? { name } : {}),
    ...(task ? { task } : {}),
    ...(transcript ? { transcript } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(pid === undefined || !Number.isSafeInteger(pid) ? {} : { pid }),
    ...(usage ? { usage } : {}),
    ...(raw.usagePartial === true ? { usagePartial: true as const } : {}),
    ...(detail ? { detail } : {}),
  };
}

export type BackgroundTaskSnapshot = { source: string; tasks: BackgroundTask[] };

/** Parse a public background-tasks v1 display snapshot for the current owning session. */
export function parseBackgroundTaskSnapshot(value: unknown, sessionId: string | undefined): BackgroundTaskSnapshot | undefined {
  const raw = record(value);
  const source = parseSource(raw?.source);
  if (!sessionId || !raw || raw.version !== 1 || !source || raw.sessionId !== sessionId || !Array.isArray(raw.tasks)) return undefined;
  const tasks: BackgroundTask[] = [];
  const ids = new Set<string>();
  for (const value of raw.tasks.slice(0, MAX_SOURCE_TASKS)) {
    const task = parseTask(value, source);
    if (!task || ids.has(task.id)) continue;
    ids.add(task.id); tasks.push(task);
  }
  return { source, tasks };
}

function copyTask(task: BackgroundTask): BackgroundTask {
  return { ...task, ...(task.usage ? { usage: { ...task.usage } } : {}) };
}

function transcriptChars(tasks: readonly BackgroundTask[]): number {
  return tasks.reduce((total, task) => total + (task.transcript?.length ?? 0), 0);
}

function fitTranscripts(tasks: readonly BackgroundTask[], available: number): BackgroundTask[] {
  return tasks.map(task => {
    const copy = copyTask(task);
    if (!copy.transcript) return copy;
    if (available <= 0) { delete copy.transcript; return copy; }
    copy.transcript = copy.transcript.slice(0, available).trimEnd();
    available -= copy.transcript.length;
    if (!copy.transcript) delete copy.transcript;
    return copy;
  });
}

/** Session-scoped publisher state. Invalid and cross-session snapshots leave current state intact. */
export class BackgroundTaskShelf {
  private sessionId?: string;
  private readonly sources = new Map<string, BackgroundTask[]>();
  private readonly changed: (tasks: readonly BackgroundTask[]) => void;
  constructor(changed: (tasks: readonly BackgroundTask[]) => void) { this.changed = changed; }
  switchSession(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.sources.clear();
    this.changed(this.snapshot());
  }
  accept(value: unknown): boolean {
    const snapshot = parseBackgroundTaskSnapshot(value, this.sessionId);
    if (!snapshot) return false;
    if (!snapshot.tasks.length) this.sources.delete(snapshot.source);
    else if (this.sources.has(snapshot.source) || this.sources.size < MAX_SOURCES) {
      const retainedTranscriptChars = [...this.sources.entries()].reduce((total, [source, tasks]) =>
        total + (source === snapshot.source ? 0 : transcriptChars(tasks)), 0);
      this.sources.set(snapshot.source, fitTranscripts(snapshot.tasks,
        Math.max(0, BACKGROUND_TASK_TRANSCRIPT_AGGREGATE_CHARS - retainedTranscriptChars)));
    } else return false;
    this.changed(this.snapshot());
    return true;
  }
  clear(): void { this.switchSession(undefined); }
  snapshot(): BackgroundTask[] {
    const sources = [...this.sources.values()];
    const tasks: BackgroundTask[] = [];
    const keys = new Set<string>();
    for (let row = 0; tasks.length < MAX_DISPLAY_TASKS; row++) {
      let found = false;
      for (const sourceTasks of sources) {
        const task = sourceTasks[row];
        if (!task) continue;
        found = true;
        const key = JSON.stringify([task.source, task.id]);
        if (keys.has(key)) continue;
        keys.add(key); tasks.push(copyTask(task));
        if (tasks.length === MAX_DISPLAY_TASKS) break;
      }
      if (!found) break;
    }
    return tasks;
  }
}

export type BackgroundTaskStatus = "idle" | "active" | "wait";
export function backgroundTaskStatus(state: string): BackgroundTaskStatus {
  if (state === "running") return "active";
  if (state === "idle") return "idle";
  return "wait";
}

export function backgroundTaskTitle(task: BackgroundTask): string {
  return task.name || task.label;
}

export function backgroundTaskDetails(task: BackgroundTask): string {
  const lines = [`Source: ${sidebarText(task.source, MAX_SOURCE_LENGTH)}`, `State: ${backgroundTaskStatus(task.state)}`, `Run: ${task.id}`];
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
  if (task.task) lines.push("", "Task:", task.task);
  if (task.transcript) lines.push("", "Transcript:", task.transcript);
  return lines.join("\n");
}
