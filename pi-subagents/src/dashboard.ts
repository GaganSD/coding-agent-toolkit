import type { RunRecord } from "./types.ts";
import { measuredUsage, usageTotals } from "./usage.ts";

const MAX_DISPLAY_NAME = 160;
const MAX_DISPLAY_TASK = 8192;

/** Optional display-only snapshot. No native sessions, credentials, or control authority leave the manager. */
export function backgroundTaskSnapshot(sessionId: string, records: readonly RunRecord[]) {
  // Settled runs remain accounting evidence, not display occupancy.
  // cleanup_unknown stays visible: its slot is still reserved.
  const visible = records.filter(record => !["completed", "cancelled", "failed"].includes(record.state));
  return {
    version: 1 as const, source: "pi-subagents", sessionId,
    // Include settled history without restoring settled rows. Coverage discloses unknown runs.
    totals: usageTotals(records),
    tasks: visible.slice(0, 64).map(record => {
      const usage = measuredUsage(record.usage);
      return {
        id: record.id, label: `${record.agent}: ${record.task.replace(/\s+/g, " ")}`.slice(0, 160),
        name: record.agent.slice(0, MAX_DISPLAY_NAME), task: record.task.slice(0, MAX_DISPLAY_TASK),
        kind: "subagent" as const, state: record.state === "waiting_for_agent" ? "waiting" : record.state,
        startedAt: Date.parse(record.startedAt),
        ...(usage ? { usage, ...(record.usagePartial ? { usagePartial: true as const } : {}) } : {}),
        ...(record.pid ? { pid: record.pid } : {}),
        detail: `${record.model} · ${record.thinking}\n${record.currentTool ? `Tool: ${record.currentTool}\n` : ""}Native session: ${record.sessionId ?? "—"}\nPID is shared with the owning Pi process.\nInspect/control using /subagents ${record.id}.`,
      };
    }),
  };
}
