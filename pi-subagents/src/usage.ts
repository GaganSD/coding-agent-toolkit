import type { RunRecord, Usage } from "./types.ts";

/** Host accounting only. Missing or malformed statistics are not free work. */
export function measuredUsage(value: Usage | undefined): Usage | undefined {
  if (!value || ![value.input, value.output, value.cacheRead, value.cacheWrite, value.cost]
    .every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return undefined;
  return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, cost: value.cost };
}

export function usageTotals(records: readonly RunRecord[]) {
  let usage: Usage | undefined;
  let measuredRuns = 0, partialRuns = 0;
  for (const record of records) {
    const measured = measuredUsage(record.usage);
    if (!measured) continue;
    if (record.usagePartial) partialRuns++;
    else measuredRuns++;
    if (!usage) usage = measured;
    else for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) usage[key] += measured[key];
  }
  return { runs: records.length, measuredRuns, ...(partialRuns ? { partialRuns } : {}), ...(usage ? { usage } : {}) };
}

export function formatUsage(usage: Usage | undefined, partial = false): string {
  const measured = measuredUsage(usage);
  if (!measured) return "Usage unknown";
  const compact = (n: number) => n >= 999_950 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(n);
  const cost = measured.cost > 0 && measured.cost < 0.01 ? "<$0.01" : `$${measured.cost.toFixed(2)}`;
  return `${compact(measured.input)} in · ${compact(measured.output)} out · ${cost}${partial ? " (partial)" : ""}`;
}
