import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nonnegative, record } from "./sidebar-data.ts";

export type SubagentSpend = { runs: number; measuredRuns: number; cost: number | null };

/** Display-only v1 projection; never retain task text, control handles, or native sessions. */
export function subagentSpend(data: unknown, sessionId: string): SubagentSpend | undefined {
  const value = record(data), totals = record(value?.totals);
  if (value?.version !== 1 || value.source !== "pi-subagents" || value.sessionId !== sessionId || !totals) return undefined;
  const runs = nonnegative(totals.runs), measuredRuns = nonnegative(totals.measuredRuns);
  if (runs === null || measuredRuns === null || !Number.isSafeInteger(runs) || !Number.isSafeInteger(measuredRuns) || measuredRuns > runs) return undefined;
  const cost = measuredRuns > 0 ? nonnegative(record(totals.usage)?.cost) : null;
  return { runs, measuredRuns, cost };
}

export function installSubagentUsage(pi: ExtensionAPI, sessionId: string, update: (spend: SubagentSpend) => void): () => void {
  const unsubscribe = pi.events.on("pi:background-tasks", (data: unknown) => {
    const spend = subagentSpend(data, sessionId);
    if (spend) update(spend);
  });
  // Subscribe before requesting so a synchronous producer reply cannot be missed.
  pi.events.emit?.("pi:background-tasks:request", { version: 1, sessionId });
  return unsubscribe;
}
