import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { bigDigits, brailleBars, cacheRows, combinedRow, contextRows, formatCountdown, formatRate, sparkBlocks, speedRows, stackedBar, type PerfInput } from "../extensions/pi-slate/perf-graphics.ts";
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

test("brailleBars is zero-based, left-aligned with blank padding, and always draws a positive value", () => {
  assert.deepEqual(brailleBars([], 0, 2), ["", ""]);
  assert.deepEqual(brailleBars([1, 2], 3, 0), []);
  const one = brailleBars([5], 4, 2);
  assert.equal(one.length, 2);
  assert(one.every(r => r.length === 4));
  assert.deepEqual(one, ["⡇   ", "⡇   "].map(x => x), "one value is the left column of the first cell; no baseline dots");
  assert.deepEqual(brailleBars([], 3, 2), ["   ", "   "]);
  const tiny = brailleBars([1000, 0.001], 1, 1);
  assert.notEqual(tiny[0], " ", "tiny but positive value is still drawn");
  assert.deepEqual(brailleBars([7, 7, 7, 7], 2, 1), ["⣿⣿"], "flat series is full height");
  assert.equal(brailleBars([50, 100], 1, 1)[0], "⣼", "zero-based: 50 vs 100 is half height, not min-max");
  const many = brailleBars(Array.from({ length: 500 }, (_, i) => i), 5, 2);
  assert(many.every(r => r.length === 5), "only the newest 2×width values are used");
  assert.equal(many[1]![4], "⣿", "newest value is the right edge once full");
  for (const bad of [[Number.NaN, -3, Infinity], [0, 0]]) assert(brailleBars(bad, 3, 2).every(r => r.length === 3));
});

test("sparkBlocks scales to the max, left-aligns, pads with spaces, and tolerates bad input", () => {
  assert.equal(sparkBlocks([], 0), "");
  assert.equal(sparkBlocks([], 3), "   ");
  assert.equal(sparkBlocks([1, 8], 4), "▂█  ");
  assert.equal(sparkBlocks([4, 8], 2), "▅█");
  assert.equal(sparkBlocks([1, 2, 3, 4], 2), "▆█", "newest values win when there are more than columns");
  assert.equal(sparkBlocks([Number.NaN, -1, 0], 3), "▁▁▁");
  assert.equal(sparkBlocks([5], 1), "█");
});

test("tier thresholds are pure and the header slot follows them", () => {
  assert.deepEqual([60, 44, 43, 30, 29, 20, 19, 0].map(sidebarTier), ["full", "full", "compact", "compact", "mini", "mini", "micro", "micro"]);
  for (let rows = 12; rows <= 100; rows++) {
    const slots = sessionSidebarSlots(rows, 0, false);
    assert.equal(slots.header, SIDEBAR_HEADER_ROWS[sidebarTier(rows)], `header ${rows}`);
    assert(slots.middle >= 6, `middle keeps 6 rows at ${rows}`);
  }
});

const SECTIONS = (perf: SidebarPerf, inner = 40, tier: PerfInput["tier"] = "compact", now = 1000, cost: number | null = 0.84) => {
  const i = input(perf, inner, tier, now, cost);
  return { speed: speedRows(i).map(strip), cache: cacheRows(i).map(strip), combined: strip(combinedRow(i)) };
};

test("empty perf: sections keep the grammar, collapse to two rows, and never print NaN or 0%", () => {
  for (const tier of ["full", "compact"] as const) {
    const { speed, cache } = SECTIONS(EMPTY_PERF, 40, tier);
    assert.equal(speed.length, 2); assert.equal(cache.length, 2);
    assert.match(speed[0]!, /^SPEED\s+—$/); assert.equal(speed[1], "waiting for first response");
    assert.match(cache[0]!, /^CACHE\s+—$/); assert.equal(cache[1], "no requests yet");
    assert.doesNotMatch([...speed, ...cache].join("\n"), /NaN|Infinity|-\d|0%|[█▀]/);
  }
  assert.equal(strip(combinedRow(input(EMPTY_PERF))), "no requests yet");
});

test("provider that never reports cache shows an explicit note and no bar", () => {
  const perf = { ...perfFixture(1000), cache: { ...EMPTY_PERF.cache, seen: false } };
  const { cache } = SECTIONS(perf);
  assert.equal(cache.length, 2); assert.equal(cache[1], "no cache reads reported"); assert.doesNotMatch(cache.join(""), /━/);
});

test("compact SPEED: heading, left-aligned sparkline, labelled detail row; padding is spaces", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), rates: [10, 20, 23.5, 15, 18], lastRate: 23.5, peak: 23.5, turn: { requests: 2, output: 214, durationMs: 15_000, rate: 13.9 } };
  const { speed } = SECTIONS(perf);
  assert.equal(speed.length, 3);
  assert.match(speed[0]!, /^SPEED\s+23\.5 tok\/s$/);
  assert.match(speed[1]!, /^[▁-█]{5} +$/); assert.equal(speed[1]!.length, 40);
  assert.equal(speed[2], "avg 13.9 · peak 23.5 · out 214");
});

test("a single rate renders one sparkline cell at the left; no rates draws a dim baseline", () => {
  const perf: SidebarPerf = { ...EMPTY_PERF, requests: 1, rates: [30], peak: 30, lastRate: 30, turn: { requests: 1, output: 300, durationMs: 10_000, rate: 30 } };
  assert.match(SECTIONS(perf).speed[1]!, /^█ +$/);
  const noRates = { ...perf, rates: [] };
  assert.equal(SECTIONS(noRates).speed[1], "─".repeat(40));
});

test("streaming adds a marker but the headline stays the exact last rate", () => {
  const perf = { ...perfFixture(1000), lastRate: 14.6, live: { streaming: true, rate: 999 } };
  const compact = SECTIONS(perf).speed;
  assert.match(compact[0]!, /^SPEED\s+● streaming {2}14\.6 tok\/s$/);
  assert.doesNotMatch(compact.join("\n"), /~|999/);
  const full = SECTIONS(perf, 40, "full").speed;
  assert.match(full[0]!, /^SPEED\s+● streaming$/);
  assert.match(SECTIONS(perfFixture(1000), 40, "full").speed[0]!, /^SPEED\s+last response$/);
  const first = SECTIONS({ ...EMPTY_PERF, live: { streaming: true, rate: 20 } }).speed;
  assert.match(first[0]!, /^SPEED\s+● streaming {2}—$/); assert.equal(first[1], "waiting for first response");
});

test("full SPEED: big digits, two braille rows, then the same detail row", () => {
  const rows = SECTIONS(perfFixture(1000), 40, "full").speed;
  assert.equal(rows.length, 7);
  assert.equal(rows[2], " █  ▀▀█   █▀█ tok/s");
  assert.match(rows[4]!, /[⠁-⣿]/); assert.match(rows[5]!, /[⠁-⣿]/);
  assert.equal(rows[6], "avg 26.7 · peak 45.0 · out 12k");
  assert(!rows.join("").includes("Turn avg"), "the 3-column table is gone");
});

test("avg, peak and headline are known together", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), peak: null, lastRate: null, rates: [], turn: { requests: 1, output: 10, durationMs: 100, rate: null } };
  const rows = SECTIONS(perf).speed;
  assert.equal(rows.length, 2, "no eligible rates: collapsed waiting state");
  assert.equal(rows[1], "replies too short to time");
});

test("huge numbers and tiny widths stay inside the width", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), lastRate: 12_345, peak: 1e9, rates: [12_345, 1e9],
    turn: { requests: 1, output: 9e12, durationMs: 1, rate: 1e15 },
    cache: { ...perfFixture(1000).cache, read: 1.31e6, write: 1e12, uncached: 1e15, saved: 1.2e6 } };
  for (const inner of [1, 4, 10, 16, 21, 22, 24, 30, 44, 60]) for (const tier of ["full", "compact"] as const) for (const cost of [1.2e6, 1e308, null]) {
    const i = input({ ...perf, live: { streaming: true, rate: 5 } }, inner, tier, 1000, cost);
    for (const r of [...speedRows(i), ...cacheRows(i), combinedRow(i), ...contextRows(i, { percent: 91, tokens: 1e12, window: 1e15, estimated: true })]) {
      assert(visibleWidth(r) <= inner, `${inner} ${tier}: ${strip(r)}`); assert.doesNotMatch(strip(r), /NaN|Infinity/);
    }
  }
});

test("width tiers: digits fall back to text; narrow rails drop the graph", () => {
  const perf = perfFixture(1000);
  assert.equal(SECTIONS(perf, 12, "full").speed[1]!.trim(), "14.6 tok/s", "big digits need more than 12 columns");
  const tiny = SECTIONS(perf, 20, "full").speed.join("\n");
  assert.doesNotMatch(tiny, /[⠁-⣿]/);
  assert.match(tiny, /avg 26\.7 · peak 45\.0/);
  assert.match(SECTIONS(perf, 40, "full").speed.join("\n"), /[⠁-⣿]/);
});

test("CACHE heading: hit, warmth countdown, cold, unknown lifetime and idle hint", () => {
  const base = perfFixture(1_000_000);
  const head = (cache: Partial<SidebarPerf["cache"]>, now: number, tier: PerfInput["tier"] = "full") =>
    strip(cacheRows(input({ ...base, cache: { ...base.cache, ...cache } }, 40, tier, now))[0]!);
  assert.match(head({}, 1_000_000), /^CACHE\s+92% hit · ◉ 4:41$/);
  assert.match(head({}, 1_000_000 + 1000), /◉ 4:40$/, "countdown moves with the clock alone");
  assert.match(head({}, 1_000_000 + 400_000), /92% hit · cold$/);
  assert.match(head({ ttlMs: null }, 1_000_000 + 30_000), /^CACHE\s+92% hit$/, "no lifetime and recent: nothing extra");
  assert.match(head({ ttlMs: null, lastActivityAt: 1_000_000 - 62_000 }, 1_000_000, "compact"), /^CACHE\s+92% hit · idle 1m$/);
  assert.match(head({ lastHit: null }, 1_000_000), /^CACHE\s+◉ 4:41$/, "unknown hit is omitted, never 0%");
});

test("CACHE bars use the context glyph in three tones; money rows handle unknowns", () => {
  const themed: string[] = [];
  const paint = { paint: (t: string, x: string) => { themed.push(`${t}:${x}`); return x; }, heading: (x: string) => x };
  const full = cacheRows({ ...input(perfFixture(1000), 40, "full"), ...paint }).map(strip);
  assert.equal(full.length, 4);
  assert.equal(full[1], "━".repeat(40)); assert(!/[█▓░]/.test(full.join("")));
  const bar = themed.filter(t => /^(success|warning|muted):━/.test(t)).map(t => t.split(":")[0]);
  assert.deepEqual(bar, ["success", "warning", "muted"]);
  assert.equal(themed.find(t => t.startsWith("success:━"))!.length - "success:".length + themed.find(t => t.startsWith("warning:━"))!.length - "warning:".length + themed.find(t => t.startsWith("muted:━"))!.length - "muted:".length, 40, "segments sum to the width");
  assert.equal(full[2], "read 1.3M · write 108k · new 141k");
  assert.equal(full[3], "spent $0.84 · saved ~$1.92");
  const none = SECTIONS({ ...perfFixture(1000), cache: { ...perfFixture(1000).cache, saved: null } }, 40, "full", 1000, null).cache;
  assert.equal(none[3], "spent —");
  const compact = SECTIONS(perfFixture(1000), 48).cache;
  assert.equal(compact.length, 3); assert.equal(compact[2], "read 1.3M · write 108k · new 141k · spent $0.84");
  assert.equal(SECTIONS(perfFixture(1000), 40).cache[2], "read 1.3M · write 108k · new 141k", "spent is dropped when it does not fit");
  const zero = SECTIONS({ ...perfFixture(1000), cache: { ...perfFixture(1000).cache, read: 0, write: 0, uncached: 0 } }).cache;
  assert.equal(zero[1], "─".repeat(40));
});

test("CONTEXT uses the same grammar", () => {
  const i = input(EMPTY_PERF, 40);
  const rows = contextRows(i, { percent: 2, tokens: 8100, window: 400_000, estimated: false }).map(strip);
  assert.match(rows[0]!, /^CONTEXT\s+2% {2}8\.1k\/400k$/); assert.equal(rows[1], "━" + "─".repeat(39));
  assert.match(strip(contextRows(i, { percent: null, tokens: null, window: null, estimated: true })[0]!), /^CONTEXT\s+— {2}~—\/—$/);
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
  assert.notEqual(a, b); assert.match(a, /◉ 4:41/); assert.match(b, /◉ 4:40/);
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
  assert.match(s.render(40).map(strip).join("\n"), /14\.6 tok\/s · 92% hit · warm 4:41/);
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
