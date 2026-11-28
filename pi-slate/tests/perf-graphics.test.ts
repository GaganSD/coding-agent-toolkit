import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { bigDigits, contextBar, contextRows, formatCountdown, formatRate, perfRows, stackedBar, stackedPerfRows, type PerfInput } from "../extensions/pi-slate/perf-graphics.ts";
import { branchPerf, EMPTY_PERF, type SidebarPerf } from "../extensions/pi-slate/perf-stats.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import { sidebarPerfColumns } from "../extensions/pi-slate/sidebar-layout.ts";
import { sidebarUsage, type SidebarSession, type SidebarUsage } from "../extensions/pi-slate/sidebar-data.ts";
import { perfFixture } from "./perf-fixture.ts";

const strip = (t: string) => t.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plainPaint = { paint: (_t: string, x: string) => x, heading: (x: string) => x };
const usage: SidebarUsage = { input: 1_559_000, output: 12_000, total: 1_571_000, cacheRead: 1_310_000, cacheWrite: 108_000, uncached: 141_000, cost: 0.84 };
const noUsage: SidebarUsage = { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, uncached: null, cost: null };
const uncachedUsage: SidebarUsage = { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0, uncached: 100, cost: 0.01 };
const input = (perf: SidebarPerf, inner = 40, tier: PerfInput["tier"] = "full", _now = 1000, totals = usage): PerfInput => ({ perf, usage: totals, inner, tier, ...plainPaint });

test("formatRate uses one decimal below 100, integers below 1000, then compact units", () => {
  const cases: Array<[number | null, string]> = [[14.64, "14.6"], [0, "0.0"], [99.96, "100"], [100, "100"], [999.4, "999"], [999.6, "1k"], [1234, "1.2k"],
    [12_345, "12.3k"], [123_456, "123k"], [2_500_000, "2.5M"], [null, "—"], [Number.NaN, "—"], [Infinity, "—"], [-3, "—"]];
  for (const [n, out] of cases) assert.equal(formatRate(n), out, String(n));
});

test("formatCountdown is m:ss and h:mm:ss after an hour, clamped", () => {
  assert.equal(formatCountdown(0), "0:00"); assert.equal(formatCountdown(221_000), "3:41");
  assert.equal(formatCountdown(59_999), "0:59"); assert.equal(formatCountdown(3_600_000), "1:00:00");
  assert.equal(formatCountdown(3_725_000), "1:02:05"); assert.equal(formatCountdown(-5), "0:00"); assert.equal(formatCountdown(Number.NaN), "0:00");
});

test("bigDigits draws three equal-width rows and blanks unknown characters", () => {
  const rows = bigDigits("14.6");
  assert.equal(rows.length, 3);
  assert(rows.every(r => visibleWidth(r) === visibleWidth(rows[0]!)));
  assert.deepEqual(bigDigits("0"), ["█▀█", "█ █", "▀▀▀"]);
  assert.equal(visibleWidth(bigDigits("1.2k")[0]!), 3 + 1 + 1 + 1 + 3 + 1 + 3);
  const unknown = bigDigits("1—1");
  assert.equal(unknown[1]!.slice(4, 6), "  ", "unknown glyph is blank");
  assert.deepEqual(bigDigits(""), ["", "", ""]);
});

test("stackedBar sums exactly to width and keeps non-zero parts visible", () => {
  for (const width of [1, 2, 3, 7, 30, 44, 60]) for (const parts of [[1, 1, 1], [1.31e6, 1.08e5, 1.41e5], [1, 0, 0], [0, 0, 5], [1, 1e9, 1], [3, 2, 1], [0.1, 0.2, 0.7], [1e308, 1e308, 1e308]]) {
    const out = stackedBar(parts, width);
    assert.equal(out.reduce((a, b) => a + b, 0), width, `${width} ${parts}`);
    assert(out.every(n => Number.isInteger(n) && n >= 0));
    if (width >= parts.filter(p => p > 0).length) parts.forEach((p, i) => { if (p > 0) assert(out[i]! >= 1, `part ${i} visible at ${width}`); else assert.equal(out[i], 0); });
  }
  assert.deepEqual(stackedBar([0, 0, 0], 10), [0, 0, 0]);
  assert.deepEqual(stackedBar([1, 2, 3], 0), [0, 0, 0]);
  assert.deepEqual(stackedBar([Number.NaN, -1, Infinity], 5), [0, 0, 0]);
  assert.deepEqual(stackedBar([], 5), []);
});

test("full-layout speed graph is two rows of block bars scaled to the peak; compact keeps one row", () => {
  const perf = { ...EMPTY_PERF, rates: [100, 10, 55, 1], peak: 100 } as SidebarPerf;
  const full = stacked(input(perf, 30, "full")).speed;
  const graph = full.slice(4, 6);
  assert.equal(graph.length, 2);
  for (const row of graph) assert.match(row, /^[ ▁▂▃▄▅▆▇█]+$/);
  const [top, bottom] = graph as [string, string];
  const start = 30 - 4;
  assert.equal(top[start], "█", "peak fills the top row");
  assert.equal(bottom[start], "█", "peak fills the bottom row");
  assert.equal(top[start + 1], " ", "low rate leaves the top row blank");
  assert.notEqual(bottom[start + 1], "█", "low rate is a short bar");
  assert.notEqual(bottom[start + 1], bottom[start + 3], "different low rates differ in height");
  assert(top[start + 2] !== " " && top[start + 2] !== "█", "mid rate partly fills the top row");
  assert.equal(bottom[start + 2], "█", "top row starts only once the bottom row is full");
  const compact = stacked(input(perf, 40, "compact")).speed;
  assert.equal(compact.length, 3);
  assert.match(compact[1]!, /^[▁▂▃▄▅▆▇█ ]+$/);
  assert.equal(compact[1]![40 - 4], "█");
});

function stacked(i: PerfInput) {
  const [speed, cache] = stackedPerfRows(i);
  assert(speed && cache, "expected stacked layout");
  return { speed: speed.filter(row => row !== null), cache: cache.filter(row => row !== null) };
}

test("empty perf keeps the chart and footer shape, with muted placeholders", () => {
  const inner = 40;
  const emptyUsage = sidebarUsage([]);
  const compact = stacked(input(EMPTY_PERF, inner, "compact", 1000, emptyUsage));
  assert.match(compact.speed[0]!, /^SPEED\s+— tok\/s$/);
  assert.deepEqual(compact.speed.slice(1), ["─".repeat(inner), "avg — · peak —"]);
  assert.match(compact.cache[0]!, /^CACHE\s+—% hit$/);
  assert.deepEqual(compact.cache.slice(1), ["─".repeat(inner), "read 0 · new 0"]);

  const full = stacked(input(EMPTY_PERF, inner, "full", 1000, emptyUsage));
  assert.deepEqual(full.speed.slice(1), ["", "— tok/s", "", "", "─".repeat(inner), "avg — · peak —"]);
  assert.deepEqual(full.cache.slice(1), ["─".repeat(inner), "read 0 · new 0"]);

  const paint = (t: string, x: string) => t === "muted" ? `\x1b[90m${x}\x1b[0m` : x;
  const i = { ...input(EMPTY_PERF, inner, "compact", 1000, emptyUsage), paint };
  const text = perfRows(i).flat().join("\n");
  for (const value of ["—", "—% hit", "0"]) assert(text.includes(paint("muted", value)), value);
});

test("empty and ordinary populated sections use the same height", () => {
  for (const tier of ["full", "compact"] as const) for (const width of [20, 22, 24, 26, 27, 30, 36, 37, 38, 40, 46]) {
    const empty = stacked(input(EMPTY_PERF, width, tier, 1000, noUsage));
    const full = stacked(input(perfFixture(1000), width, tier));
    assert.equal(empty.speed.length, full.speed.length, `SPEED at ${width} (${tier})`);
    assert.equal(empty.cache.length, full.cache.length, `CACHE at ${width} (${tier})`);
  }
});

test("CACHE distinguishes a failed first reply with missing usage from an empty branch", () => {
  const failed = { type: "message", id: "failed", parentId: null, timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", stopReason: "error" } } as SessionEntry;
  for (const [entries, details] of [
    [[], "read 0 · new 0"],
    [[failed], "read — · new —"],
  ] as const) {
    const { cache } = stacked(input(branchPerf(entries), 40, "compact", 1000, sidebarUsage(entries)));
    assert.match(cache[0]!, /CACHE\s+—% hit$/);
    assert.equal(cache[2], details);
  }
});

test("an uncached reply shows its actual usage", () => {
  const { cache } = stacked(input(perfFixture(1000), 40, "compact", 1000, uncachedUsage));
  assert.match(cache[0]!, /CACHE\s+0% hit$/);
  assert.deepEqual(cache.slice(1), ["━".repeat(40), "read 0 · new 100"]);
});

test("compact SPEED: heading, right-aligned sparkline, labelled detail row; padding is spaces", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), rates: [10, 20, 15, 18, 23.5], peak: 23.5, turn: { output: 214, rate: 13.9 } };
  const { speed } = stacked(input(perf, 40, "compact"));
  assert.equal(speed.length, 3);
  assert.match(speed[0]!, /^SPEED\s+23\.5 tok\/s$/);
  assert.equal(speed[1], "▄▇▅▆█".padStart(40));
  assert.equal(stacked(input(perf, 3, "compact")).speed[2], "▅▆█", "show the newest sample per column");
  assert.equal(speed[2], "avg 13.9 · peak 23.5");
});

test("a single rate renders one block at the right", () => {
  const perf: SidebarPerf = { ...EMPTY_PERF, timedReplies: 1, rates: [30], peak: 30, turn: { output: 300, rate: 30 } };
  assert.match(stacked(input(perf, 40, "compact")).speed[1]!, /^ +█$/);
});

test("full SPEED: big digits, two block-bar rows, then the same detail row", () => {
  const rows = stacked(input(perfFixture(1000), 40, "full")).speed;
  assert.equal(rows.length, 7);
  assert.match(rows[0]!, /^SPEED\s+last timed reply$/);
  assert.equal(rows[2], " █  ▀▀█   █▀█ tok/s");
  assert.match(rows[4]!, /[▁-█]/); assert.match(rows[5]!, /[▁-█]/);
  assert.equal(rows[6], "avg 26.7 · peak 45.0");
  assert(!rows.join("").includes("Turn avg"), "the 3-column table is gone");
});

test("untimed replies show unknown rates rather than zeros", () => {
  const legacy: SidebarPerf = { ...EMPTY_PERF, turn: { output: 10, rate: null } };
  const { speed } = stacked(input(legacy, 40, "compact"));
  assert.match(speed[0]!, /— tok\/s$/);
  assert.equal(speed[2], "avg — · peak —");
});

test("huge numbers and tiny widths stay inside the width", () => {
  const base = perfFixture(1000);
  const perf: SidebarPerf = { ...base, peak: 1e9, rates: [12_345, 1e9], turn: { output: 9e12, rate: 1e15 } };
  assert.equal(stacked(input(perf, 40, "full")).speed[2], "1B tok/s", "unsupported big glyphs fall back to text");
  for (const inner of [1, 4, 10, 16, 21, 22, 24, 30, 44, 60]) for (const tier of ["full", "compact"] as const) for (const cost of [1.2e6, 1e308, null]) {
    const i = input(perf, inner, tier, 1000, { ...usage, cacheWrite: 1e12, uncached: 1e15, cost });
    for (const r of [...perfRows(i).flat().filter(r => r !== null), ...contextRows(i, { percent: 91, tokens: 1e12, window: 1e15, estimated: true })]) {
      assert(visibleWidth(r) <= inner, `${inner} ${tier}: ${strip(r)}`); assert.doesNotMatch(strip(r), /NaN|Infinity/);
    }
  }
});

test("narrow full-tier SPEED wraps its caption, drops the graph, and keeps the rate", () => {
  const perf = perfFixture(1000);
  const narrow = stacked(input(perf, 12, "full")).speed;
  assert.deepEqual(narrow.slice(0, 2).map(row => row.trim()), ["SPEED   last", "timed reply"]);
  assert.equal(narrow[2]!.trim(), "14.6 tok/s", "big digits need more than 12 columns");
  const tinyRows = stacked(input(perf, 20, "full")).speed;
  assert.deepEqual(tinyRows.slice(0, 2).map(row => row.trim()), ["SPEED", "last timed reply"]);
  assert.equal(tinyRows.length, 6, "two heading, three digit, and one detail row: no graph rows");
  assert.deepEqual(tinyRows.slice(5), ["avg 26.7 · peak 45.0"]);
  assert.match(stacked(input(perf, 40, "full")).speed.join("\n"), /[▁-█]/);
});

test("CACHE headline and bar use branch totals and distinguish near-perfect from exact hits", () => {
  const base = perfFixture(1000);
  const perf = { ...base, cache: { ...base.cache, lastHit: 0.9956 } };
  for (const [read, label, cells] of [[86_000, "86% hit", 34], [95_200, "95.2% hit", 38], [99_560, "99.56% hit", 39], [99_999, "99.99% hit", 39], [100_000, "all cached", 40]] as const) {
    const totals = { ...usage, input: 100_000, cacheRead: read, cacheWrite: 0, uncached: 100_000 - read };
    const i = input(perf, 40, "compact", 1000, totals);
    const [heading, bar] = stacked({ ...i, paint: (t, x) => t === "accent" ? x.replaceAll("━", "█") : x }).cache;
    assert(heading?.includes(label));
    assert.equal(bar, "█".repeat(cells) + "━".repeat(40 - cells));
  }
  const unknown = stacked(input(perf, 40, "full", 1000, { ...usage, input: null, uncached: null })).cache;
  assert.match(unknown[0]!, /^CACHE\s+—% hit$/);
  assert.equal(unknown[1], "─".repeat(40), "missing input is not treated as all cached");
});

test("CACHE uses one track color for non-hits and shows no savings estimate", () => {
  const themed: string[] = [];
  const paint = { paint: (t: string, x: string) => { themed.push(`${t}:${x}`); return x; }, heading: (x: string) => x };
  const full = stacked({ ...input(perfFixture(1000), 40, "full"), ...paint }).cache;
  assert.equal(full[1], "━".repeat(40));
  assert.deepEqual(themed.filter(t => /:━/.test(t)), [`accent:${"━".repeat(34)}`, `muted:${"━".repeat(6)}`]);
  assert.equal(full[2], "read 1.3M · new 141k");
  assert.equal(full.length, 3);
  assert.doesNotMatch(full.join("\n"), /\bsaved\b/);
  assert.equal(stacked(input(perfFixture(1000), 40, "compact")).cache[2], "read 1.3M · new 141k");
  assert.doesNotMatch(full.join("\n"), /\bwrite\b/);
});

test("narrow stats wrap at segment boundaries, including right-aligned heading stats", () => {
  const now = 3_000_000;
  const base = perfFixture(now);
  const perf = base;
  const totals = { ...usage, input: 117_800, cacheRead: 87_600, cacheWrite: 0, uncached: 30_200, cost: 0.09 };
  const i = input(perf, 20, "compact", now, totals);
  const { cache, speed } = stacked(i);
  assert.deepEqual(cache, ["CACHE     74.36% hit", "━".repeat(20), "read 87.6k", "new 30.2k"]);
  assert.deepEqual(speed.slice(2), ["avg 26.7 · peak 45.0"]);
  assert.deepEqual(stacked({ ...i, tier: "full" }).cache.slice(2), ["read 87.6k", "new 30.2k"]);
  const context = contextRows(i, { percent: 11, tokens: 30_200, window: 272_000, estimated: false });
  assert.deepEqual(context.slice(0, 2), ["CONTEXT          11%", "          30.2k/272k"]);
});

test("a segment is ellipsized only when it cannot fit even on its own line", () => {
  const perf = perfFixture(1000);
  assert.deepEqual(stacked(input(perf, 10, "compact")).cache, ["CACHE", "84.03% hit", "━━━━━━━━━━", "read 1.3M", "new 141k"]);
  const paint = (_t: string, x: string) => `\x1b[90m${x}\x1b[0m`;
  const rows = stacked({ ...input(perf, 6, "compact"), paint }).cache;
  assert.deepEqual(rows.map(strip), ["CACHE", "84.03…", "━━━━━━", "read …", "new 1…"]);
  assert(rows.every(row => visibleWidth(row) <= 6));
});

test("two-column height is stable across speed and cache activity", () => {
  const perf = perfFixture(1000);
  for (const inner of [47, 48, 52, 62, 67, 72, 95]) for (const tier of ["compact", "full"] as const) {
    const [empty] = perfRows(input(EMPTY_PERF, inner, tier, 1000, sidebarUsage([])));
    for (const [current, totals] of [[perf, usage], [EMPTY_PERF, uncachedUsage]] as const) {
      const [rows] = perfRows(input(current, inner, tier, 1000, totals));
      assert.equal(rows?.length, empty?.length, `${inner} (${tier})`);
      assert.equal(rows?.at(-1), null);
    }
  }
});

test("cards put SPEED and CACHE side by side with one aligned stat per row", () => {
  assert.equal(perfRows(input(perfFixture(1000), 27, "compact")).length, 1, "27 columns stay side by side");
  const [full] = perfRows(input(perfFixture(1000), 28, "full"));
  assert.deepEqual(full, ["SPEED         CACHE", "14.6 tok/s    84.03% hit", "▆▇▇█▇▆▅▆▅▄▅▆▃ ━━━━━━━━━━━━━",
    "avg  26.7     read  1.3M", "peak 45.0     new   141k", null]);
  const [empty] = perfRows(input(EMPTY_PERF, 28, "compact", 1000, sidebarUsage([])));
  assert.deepEqual(empty, ["SPEED         CACHE", "— tok/s       —% hit", "───────────── ─────────────",
    "avg  —        read  0", "peak —        new   0", null]);
});

test("narrow rails keep SPEED and CACHE equal and side by side", () => {
  for (const inner of [23, 24, 25, 26, 27, 28]) {
    const columns = sidebarPerfColumns(inner)!;
    assert.equal(columns.speed, columns.cache, `${inner} equal halves`);
    assert(columns.speed + columns.gap.length + columns.cache <= inner, `${inner} fits width`);
    const [rows] = perfRows(input(perfFixture(1000), inner, "full"));
    assert.match(rows[0]!, /SPEED +CACHE/, `${inner} side by side`);
  }
  const [stackedRows] = perfRows(input(perfFixture(1000), 22, "full"));
  assert.doesNotMatch(stackedRows[0]!, /CACHE/, "22 columns stack");
  assert.doesNotMatch(stackedRows.join("\n"), /█▀█/, "stacked rail uses text, not huge digits");
});

test("cards keep empty and populated heights equal and stay within width", () => {
  const base = perfFixture(1000);
  for (const inner of [28, 29, 32, 36, 40, 60]) for (const tier of ["compact", "full"] as const) {
    const [empty] = perfRows(input(EMPTY_PERF, inner, tier, 1000, sidebarUsage([])));
    for (const totals of [usage, uncachedUsage]) {
      const [rows] = perfRows(input(base, inner, tier, 1000, totals));
      assert.equal(rows?.length, empty?.length, `${inner} (${tier})`);
      for (const row of rows ?? []) if (row !== null) assert(visibleWidth(row) <= inner, `${inner}: ${row}`);
    }
  }
});

test("CONTEXT uses the same grammar", () => {
  const i = input(EMPTY_PERF, 40);
  const rows = contextRows(i, { percent: 2, tokens: 8100, window: 400_000, estimated: false }).map(strip);
  assert.match(rows[0]!, /^CONTEXT\s+2% {2}8\.1k\/400k$/);
  // 2% of 40 cells = 6.4 eighths → 6 → one ▊ edge, then the track.
  assert.equal(rows.length, 2); assert.equal(rows[1], "▊" + "░".repeat(39));
  assert.match(strip(contextRows(i, { percent: null, tokens: null, window: null, estimated: true })[0]!), /^CONTEXT\s+— {2}~—\/—$/);
});

function sidebarWith(rows: number, perf: SidebarPerf, clock: { now: number }, extra: Partial<SidebarSession> = {}) {
  const sidebar = new Sidebar(() => clock.now);
  sidebar.attach({ terminal: { rows, columns: 140 }, requestRender() {}, showOverlay() { return { hide() {} }; } } as unknown as TUI, undefined as never);
  sidebar.setSession({ id: "01a1cd96-0000", name: "fix auth refresh", pid: 1, cwd: "/p", model: "gpt-6.1-sol (openai)", thinking: "medium", tokens: 152_000, percent: 38,
    contextWindow: 400_000, estimated: false, rate: null, startedAt: 1, lastTurnMs: 39_000, working: false, turns: 7, messages: 14,
    usage, perf, ...extra });
  return sidebar;
}

test("sidebar renders the full tier and the empty session within width", () => {
  const clock = { now: 1_000_000 };
  const s = sidebarWith(60, perfFixture(clock.now), clock);
  const full = s.render(44).map(strip);
  assert(full.every(l => visibleWidth(l) === 44));
  const empty = sidebarWith(60, EMPTY_PERF, clock, { id: "", name: "", turns: 0, lastTurnMs: null, tokens: null, percent: null, contextWindow: null,
    usage: noUsage });
  const text = empty.render(44).map(strip);
  assert(text.every(l => visibleWidth(l) === 44));
  assert.doesNotMatch(text.join("\n"), /NaN|Infinity|\b0%/);
});

test("every tier and width keeps rows bounded, during working turns and long sessions", () => {
  const clock = { now: 1_000_000 };
  const perf: SidebarPerf = { ...perfFixture(clock.now), rates: Array.from({ length: 256 }, (_, i) => 10 + (i % 40)), timedReplies: 5000 };
  for (const rows of [10, 19, 20, 29, 30, 43, 44, 70]) for (const width of [0, 1, 5, 12, 20, 28, 44, 60, 90]) {
    const lines = sidebarWith(rows, perf, clock, { working: true }).render(width);
    assert.equal(lines.length, rows);
    assert(lines.every(l => visibleWidth(l) <= width), `${width}x${rows}`);
  }
});

test("narrow sidebars keep SPEED and CACHE side by side", () => {
  const clock = { now: 1_000_000 };
  const text = sidebarWith(30, perfFixture(clock.now), clock).render(27).map(strip).join("\n");
  assert.match(text, /SPEED +CACHE/);
  assert.doesNotMatch(text, /█▀█/);
});

test("details distinguish branch and last-request cache rates", () => {
  const clock = { now: 1_000_000 };
  const base = perfFixture(clock.now);
  const s = sidebarWith(30, { ...base, cache: { ...base.cache, lastHit: 0.9956 } }, clock);
  const text = s.render(40).map(strip).join("\n");
  assert.match(text, /SPEED +CACHE/); assert.match(text, /84\.03% hit/);
  assert.match(s.sessionDetails(), /Speed & cache/);
  assert.match(s.sessionDetails(), /300 ms/);
  assert.match(s.sessionDetails(), /Cache-hit share: 84\.03%/);
  assert.match(s.sessionDetails(), /latest request 99\.56%\./);
});

test("themed render keeps tones within the theme palette", () => {
  const clock = { now: 1_000_000 };
  const tones = new Set<string>();
  const theme = { fg: (tone: string, text: string) => { tones.add(tone); return text; }, bold: (t: string) => t } as never;
  const s = new Sidebar(() => clock.now);
  s.attach({ terminal: { rows: 60, columns: 140 }, requestRender() {}, showOverlay() { return { hide() {} }; } } as unknown as TUI, theme);
  s.setSession({ id: "a", pid: 1, cwd: "", model: "m", thinking: "low", tokens: 1, percent: 90, contextWindow: 10, estimated: true, rate: null, startedAt: 1, lastTurnMs: null,
    working: true, turnStartedAt: clock.now - 1000, turns: 1, messages: 1, usage, perf: perfFixture(clock.now) });
  s.render(44);
  for (const t of tones) assert(["text", "muted", "dim", "accent", "success", "warning", "error", "mdHeading", "border", "borderMuted", "borderAccent"].includes(t) || /^[a-zA-Z]+$/.test(t), t);
  assert(tones.has("accent") && tones.has("warning"));
});

test("context bar: one row, exact width, eighth-step fill, visible at tiny percents", () => {
  const paint = (_t: string, x: string) => x;
  for (const width of [0, 1, 2, 3, 10, 41]) for (const pct of [null, 0, 0.01, 2, 50, 99.9, 100, 140, NaN])
    assert.equal(visibleWidth(contextBar(width, pct, paint)), width, `width ${width} pct ${pct}`);
  assert.equal(contextBar(10, 0, paint), "░".repeat(10));
  assert.equal(contextBar(10, null, paint), "░".repeat(10));
  assert.equal(contextBar(10, 0.01, paint), "▏" + "░".repeat(9), "any usage is visible");
  assert.equal(contextBar(10, 50, paint), "█████" + "░".repeat(5));
  assert.equal(contextBar(10, 100, paint), "█".repeat(10));
});
