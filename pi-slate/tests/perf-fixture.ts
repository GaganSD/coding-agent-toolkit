import type { SidebarPerf } from "../extensions/pi-slate/perf-stats.ts";

/** Realistic mid-session perf facts shared by sidebar tests. `now` is the render clock. */
export function perfFixture(now: number): SidebarPerf {
  return {
    requests: 12,
    rates: [18, 22, 26, 31, 24, 28, 35, 30, 22, 19, 27, 33, 38, 29, 24, 31, 36, 41, 45, 37, 30, 26, 33, 28, 21, 25, 30, 14.6],
    peak: 45, lastRate: 14.6,
    turn: { requests: 3, output: 12_000, durationMs: 449_000, rate: 26.7 },
    cache: { read: 1_310_000, write: 108_000, uncached: 141_000, lastHit: 0.92, sessionHit: 0.84, saved: 1.92,
      lastActivityAt: now - 19_000, ttlMs: 300_000, seen: true },
    live: { streaming: false, rate: null },
  };
}
