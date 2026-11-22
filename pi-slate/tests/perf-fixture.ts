import type { SidebarPerf } from "../extensions/pi-slate/perf-stats.ts";

/** Realistic mid-session perf facts shared by sidebar tests. */
export function perfFixture(_now?: number): SidebarPerf {
  return {
    timedReplies: 28,
    rates: [18, 22, 26, 31, 24, 28, 35, 30, 22, 19, 27, 33, 38, 29, 24, 31, 36, 41, 45, 37, 30, 26, 33, 28, 21, 25, 30, 14.6],
    peak: 45,
    turn: { output: 12_000, rate: 26.7 },
    cache: { lastHit: 0.92 },
  };
}
