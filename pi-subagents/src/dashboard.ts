import type { RunRecord } from "./types.ts";

/** Optional display-only snapshot. No native sessions, credentials, or control authority leave the manager. */
export function backgroundTaskSnapshot(sessionId: string, records: readonly RunRecord[]) {
  // Settled completions, cancels, and failures are evidence in the manager, not
  // sidebar occupancy. Old Slate clocks from startedAt; omitting them is the
  // independent fix. cleanup_unknown stays: the slot is still reserved.
  const visible = records.filter(record => !["completed", "cancelled", "failed"].includes(record.state));
  return {
    version: 1 as const, source: "pi-subagents", sessionId,
    tasks: visible.slice(0, 64).map(record => ({
      id: record.id, label: `${record.agent}: ${record.task.replace(/\s+/g, " ").slice(0, 160)}`,
      kind: "subagent" as const, state: record.state === "waiting_for_agent" ? "waiting" : record.state,
      startedAt: Date.parse(record.startedAt),
      ...(record.pid ? { pid: record.pid } : {}),
      detail: `${record.model} · ${record.thinking}\n${record.currentTool ? `Tool: ${record.currentTool}\n` : ""}Native session: ${record.sessionId ?? "—"}\nPID is shared with the owning Pi process.\nInspect/control using /subagents ${record.id}.`,
    })),
  };
}
