import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { bigDigits, brailleBars, cacheRows, combinedRow, formatCountdown, formatRate, sparkBlocks, speedRows, stackedBar, type PerfInput } from "../extensions/pi-slate/perf-graphics.ts";
import { EMPTY_PERF, type SidebarPerf } from "../extensions/pi-slate/perf-stats.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import type { SidebarSession } from "../extensions/pi-slate/sidebar-data.ts";
import { sessionSidebarSlots, sidebarTier, SIDEBAR_HEADER_ROWS } from "../extensions/pi-slate/sidebar-layout.ts";
import { perfFixture } from "./perf-fixture.ts";

const strip = (t: string) => t.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plainPaint = { paint: (_t: string, x: string) => x, heading: (x: string) => x };
const input = (perf: SidebarPerf, inner = 40, tier: PerfInput["tier"] = "full", now = 1000, cost: number | null = 0.84): PerfInput => ({ perf, cost, now, inner, tier, ...plainPaint });

test("formatRate uses one decimal below 100, integers below 1000, then compact units", () => {
  const cases: Array<[number | null, string]> = [[14.64, "14.6"], [0, "0.0"], [99.96, "100"], [100, "100"], [999.4, "999"], [999.6, "1.0k"], [1234, "1.2k"],
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
  assert.equal(visibleWidth(bigDigits("~1.2k")[0]!), 3 + 1 + 3 + 1 + 1 + 1 + 3 + 1 + 3);
  const unknown = bigDigits("1—1");
  assert.equal(unknown[1]!.slice(4, 6), "  ", "unknown glyph is blank");
  assert.deepEqual(bigDigits(""), ["", "", ""]);
});

test("stackedBar sums exactly to width and keeps non-zero parts visible", () => {
  for (const width of [1, 2, 3, 7, 30, 44, 60]) for (const parts of [[1, 1, 1], [1.31e6, 1.08e5, 1.41e5], [1, 0, 0], [0, 0, 5], [1, 1e9, 1], [3, 2, 1], [0.1, 0.2, 0.7]]) {
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

test("brailleBars is zero-based, right-aligned, and always draws a positive value", () => {
  assert.deepEqual(brailleBars([], 0, 2), ["", ""]);
  assert.deepEqual(brailleBars([1, 2], 3, 0), []);
  const one = brailleBars([5], 4, 2);
  assert.equal(one.length, 2);
  assert(one.every(r => r.length === 4));
  assert.equal(one[1]!.slice(0, 3), "⣀⣀⣀", "empty columns show baseline dots");
  assert.equal(one[1]![3], "⣸", "the newest rate fills the right column of the last cell");
  assert.equal(one[0]![3], "⢸");
  assert.equal(one[0]!.slice(0, 3), "   ");
  const tiny = brailleBars([1000, 0.001], 1, 1);
  assert.notEqual(tiny[0], "⣀", "tiny but positive value is still drawn");
  // Zero-based: a flat series is full height, not half height.
  assert.deepEqual(brailleBars([7, 7, 7, 7], 2, 1), ["⣿⣿"]);
  // Zero-based: 50 vs 100 gives the left column half height (2 of 4 dots); min-max would give 1.
  assert.equal(brailleBars([50, 100], 1, 1)[0], "⣼");
  const many = brailleBars(Array.from({ length: 500 }, (_, i) => i), 5, 2);
  assert(many.every(r => r.length === 5), "only the newest 2×width values are used");
  for (const bad of [[Number.NaN, -3, Infinity], [0, 0]]) assert(brailleBars(bad, 3, 2).every(r => r.length === 3));
});

test("sparkBlocks scales to the max, right-aligns, and tolerates bad input", () => {
  assert.equal(sparkBlocks([], 0), "");
  assert.equal(sparkBlocks([], 3), "▁▁▁");
  assert.equal(sparkBlocks([1, 8], 4), "▁▁▂█");
  assert.equal(sparkBlocks([4, 8], 2), "▅█");
  assert.equal(sparkBlocks([1, 2, 3, 4], 2).length, 2);
  assert.equal(sparkBlocks([Number.NaN, -1, 0], 3), "▁▁▁");
  assert.equal(sparkBlocks([5], 1), "█");
});

test("tier thresholds are pure and the header slot follows them", () => {
  assert.deepEqual([60, 44, 43, 30, 29, 20, 19, 0].map(sidebarTier), ["full", "full", "compact", "compact", "mini", "mini", "micro", "micro"]);
  for (const rows of [12, 19, 20, 29, 30, 43, 44, 60, 100]) {
    const slots = sessionSidebarSlots(rows, 0, false);
    assert.equal(slots.header, SIDEBAR_HEADER_ROWS[sidebarTier(rows)], `header ${rows}`);
    assert(slots.middle >= 6, `middle keeps 6 rows at ${rows}`);
    assert(sessionSidebarSlots(rows, 4, true).tasks + sessionSidebarSlots(rows, 4, true).image >= 0);
  }
});

test("empty perf: waiting and no-request lines, no NaN or zero percent", () => {
  for (const tier of ["full", "compact"] as const) {
    const lines = [...speedRows(input(EMPTY_PERF, 40, tier), tier === "full" ? 8 : 2), ...cacheRows(input(EMPTY_PERF, 40, tier), tier === "full" ? 4 : 2)].map(strip);
    const text = lines.join("\n");
    assert.match(text, /waiting for first response/); assert.match(text, /no requests yet/);
    assert.doesNotMatch(text, /NaN|Infinity|-\d|0%|[█▀]/);
  }
  assert.equal(combinedRow(input(EMPTY_PERF)), "no requests yet");
  assert.equal(speedRows(input(EMPTY_PERF, 40, "full"), 8).length, 8);
});

test("provider that never reports cache shows an explicit note", () => {
  const perf = { ...perfFixture(1000), cache: { ...EMPTY_PERF.cache, seen: false } };
  assert.match(strip(cacheRows(input(perf), 4).join("\n")), /no cache reads reported/);
  assert.doesNotMatch(strip(cacheRows(input(perf), 4).join("\n")), /[█▓░]/);
});

test("a single rate renders a graph with one column at the right edge", () => {
  const perf: SidebarPerf = { ...EMPTY_PERF, requests: 1, rates: [30], peak: 30, lastRate: 30, turn: { requests: 1, output: 300, durationMs: 10_000, rate: 30 } };
  const rows = speedRows(input(perf, 40), 8).map(strip);
  assert.equal(rows.length, 8);
  const graph = rows.slice(4, 6);
  assert(graph.every(r => visibleWidth(r) === 40));
  assert.match(graph[0]!, /\S$/); assert.match(graph[1]!, /^⣀+/);
});

test("streaming shows ~ live estimate; settled shows exact last rate", () => {
  const live = { ...perfFixture(1000), live: { streaming: true, rate: 51.25 } };
  const liveText = speedRows(input(live), 8).map(strip);
  assert.match(liveText[0]!, /● streaming$/); assert.match(liveText.slice(1, 4).join("\n"), /▄▀▄/, "tilde glyph precedes the digits");
  const settled = speedRows(input(perfFixture(1000)), 8).map(strip);
  assert.match(settled[0]!, /last response$/); assert.doesNotMatch(settled.slice(1, 4).join(""), /▄▀▄/);
  assert.match(strip(speedRows(input(live, 40, "compact"), 2)[0]!), /● ~51\.3 tok\/s|● ~51\.2 tok\/s/);
});

test("stats row: nulls become dashes", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), peak: null, turn: null };
  const rows = speedRows(input(perf), 8).map(strip);
  assert.match(rows[7]!, /^—\s+—\s+—$/);
});

test("huge numbers stay inside the width", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), lastRate: 12_345, peak: 1e9, rates: [12_345, 1e9],
    turn: { requests: 1, output: 9e12, durationMs: 1, rate: 1e15 },
    cache: { ...perfFixture(1000).cache, read: 1.31e6, write: 1e12, uncached: 1e15, saved: 1.2e6 } };
  for (const inner of [10, 16, 21, 22, 24, 30, 44, 60]) for (const tier of ["full", "compact"] as const) for (const cost of [1.2e6, 1e308, null]) {
    const rows = [...speedRows(input(perf, inner, tier, 1000, cost), tier === "full" ? 8 : 2), ...cacheRows(input(perf, inner, tier, 1000, cost), tier === "full" ? 4 : 2), combinedRow(input(perf, inner, tier, 1000, cost))];
    for (const r of rows) { assert(visibleWidth(r) <= inner, `${inner} ${tier}: ${strip(r)}`); assert.doesNotMatch(strip(r), /NaN|Infinity/); }
  }
});

test("width tiers: digits fall back to text, narrow rails drop the graph", () => {
  const perf = perfFixture(1000);
  const narrowDigits = speedRows(input(perf, 12), 8).map(strip);
  assert.equal(narrowDigits[1]!.trim(), "14.6 tok/s", "big digits need more than 12 columns");
  const tiny = speedRows(input(perf, 20), 8).map(strip).join("\n");
  assert.doesNotMatch(tiny, /[⣀-⣿]/); assert.match(tiny, /26\.7 · 45\.0 · 12k/);
  assert.match(speedRows(input(perf, 40), 8).map(strip).join("\n"), /[⣀-⣿]/);
});

test("warmth: countdown, cold, unknown lifetime and idle hint", () => {
  const base = perfFixture(1_000_000);
  const head = (cache: Partial<SidebarPerf["cache"]>, now: number) => strip(cacheRows(input({ ...base, cache: { ...base.cache, ...cache } }, 44, "full", now), 4)[0]!);
  assert.match(head({}, 1_000_000), /92% hit · ◉ warm 4:41$/);
  assert.match(head({}, 1_000_000 + 1000), /warm 4:40$/, "countdown moves with the clock alone");
  assert.match(head({}, 1_000_000 + 400_000), /◌ cold$/);
  assert.match(head({ ttlMs: null }, 1_000_000 + 30_000), /^CACHE\s+92% hit$/, "no lifetime and recent: nothing extra");
  assert.match(head({ ttlMs: null, lastActivityAt: 1_000_000 - 4 * 60_000 }, 1_000_000), /idle 4m$/);
  assert.match(head({ lastHit: null }, 1_000_000), /^CACHE\s+◉ warm/, "unknown hit is omitted, never 0%");
});

test("cache rows: bar spans the width and money lines handle unknowns", () => {
  const rows = cacheRows(input(perfFixture(1000), 44), 4).map(strip);
  assert.equal(rows[1]!.length, 44);
  assert.match(rows[2]!, /read 1\.3M · write 108k · new 141k/);
  assert.equal(rows[3], "spent $0.84 · saved ~$1.92");
  const none = cacheRows(input({ ...perfFixture(1000), cache: { ...perfFixture(1000).cache, saved: null } }, 44, "full", 1000, null), 4).map(strip);
  assert.equal(none[3], "spent —");
});

function sidebarWith(rows: number, perf: SidebarPerf, clock: { now: number }, extra: Partial<SidebarSession> = {}) {
  const sidebar = new Sidebar(() => clock.now);
  sidebar.attach({ terminal: { rows, columns: 140 }, requestRender() {}, showOverlay() { return { hide() {} }; } } as unknown as TUI, undefined as never);
  sidebar.setSession({ id: "01a1cd96-0000", name: "fix auth refresh", pid: 1, cwd: "/p", model: "gpt-6.1-sol (openai)", thinking: "medium", tokens: 152_000, percent: 38,
    contextWindow: 400_000, estimated: false, rate: null, startedAt: 1, lastTurnMs: 39_000, working: false, turns: 7, messages: 14,
    usage: { input: 1_559_000, output: 12_000, total: 1_571_000, cacheRead: 1_310_000, cacheWrite: 108_000, cost: 0.84 }, perf, ...extra });
  return sidebar;
}

test("sidebar renders the full tier and the empty session within width", () => {
  const clock = { now: 1_000_000 };
  const s = sidebarWith(60, perfFixture(clock.now), clock);
  const full = s.render(44).map(strip);
  assert(full.every(l => visibleWidth(l) === 44));
  const empty = sidebarWith(60, EMPTY_PERF, clock, { id: "", name: "", turns: 0, lastTurnMs: null, tokens: null, percent: null, contextWindow: null,
    usage: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, cost: null } });
  const text = empty.render(44).map(strip);
  assert(text.every(l => visibleWidth(l) === 44));
  assert.doesNotMatch(text.join("\n"), /NaN|Infinity|\b0%/);
});

test("render recomputes the countdown each second without extra timers", () => {
  const clock = { now: 1_000_000 };
  const s = sidebarWith(60, perfFixture(clock.now), clock);
  const a = s.render(44).map(strip).join("\n");
  assert.equal(s.render(44).map(strip).join("\n"), a);
  clock.now += 1000;
  const b = s.render(44).map(strip).join("\n");
  assert.notEqual(a, b); assert.match(a, /warm 4:41/); assert.match(b, /warm 4:40/);
});

test("every tier and width keeps rows bounded, including live streaming and long sessions", () => {
  const clock = { now: 1_000_000 };
  const perf: SidebarPerf = { ...perfFixture(clock.now), rates: Array.from({ length: 256 }, (_, i) => 10 + (i % 40)), requests: 5000, live: { streaming: true, rate: 33 } };
  for (const rows of [10, 19, 20, 29, 30, 43, 44, 70]) for (const width of [0, 1, 5, 12, 20, 28, 44, 60, 90]) {
    const lines = sidebarWith(rows, perf, clock, { working: true }).render(width);
    assert.equal(lines.length, rows);
    assert(lines.every(l => visibleWidth(l) <= width), `${width}x${rows}`);
  }
});

test("mini tier shows the combined speed/cache row; details explain the numbers", () => {
  const clock = { now: 1_000_000 };
  const s = sidebarWith(24, perfFixture(clock.now), clock);
  assert.match(s.render(40).map(strip).join("\n"), /↯14\.6 t\/s ◉92% 4:41/);
  assert.match(s.sessionDetails(), /Speed & cache/);
  assert.match(s.sessionDetails(), /300 ms/);
});

test("themed render keeps tones within the theme palette", () => {
  const clock = { now: 1_000_000 };
  const tones = new Set<string>();
  const theme = { fg: (tone: string, text: string) => { tones.add(tone); return text; }, bold: (t: string) => t } as never;
  const s = new Sidebar(() => clock.now);
  s.attach({ terminal: { rows: 60, columns: 140 }, requestRender() {}, showOverlay() { return { hide() {} }; } } as unknown as TUI, theme);
  s.setSession({ id: "a", pid: 1, cwd: "", model: "m", thinking: "low", tokens: 1, percent: 90, contextWindow: 10, estimated: true, rate: null, startedAt: 1, lastTurnMs: null,
    working: true, turns: 1, messages: 1, usage: { input: 1, output: 1, total: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, perf: perfFixture(clock.now) });
  s.render(44);
  for (const t of tones) assert(["text", "muted", "dim", "accent", "success", "warning", "error", "mdHeading", "border", "borderMuted", "borderAccent"].includes(t) || /^[a-zA-Z]+$/.test(t), t);
  assert(tones.has("success") && tones.has("accent") && tones.has("warning"));
});
