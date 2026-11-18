import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { bigDigits, contextBar, brailleBars, cacheRows, contextRows, formatCountdown, formatRate, speedRows, stackedBar, type PerfInput } from "../extensions/pi-slate/perf-graphics.ts";
import { EMPTY_PERF, type SidebarPerf } from "../extensions/pi-slate/perf-stats.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import type { SidebarSession, SidebarUsage } from "../extensions/pi-slate/sidebar-data.ts";
import { perfFixture } from "./perf-fixture.ts";

const strip = (t: string) => t.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plainPaint = { paint: (_t: string, x: string) => x, heading: (x: string) => x };
const usage: SidebarUsage = { input: 1_559_000, output: 12_000, total: 1_571_000, cacheRead: 1_310_000, cacheWrite: 108_000, uncached: 141_000, cacheSeen: true, cost: 0.84, saved: 1.92 };
const noUsage: SidebarUsage = { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, uncached: null, cacheSeen: false, cost: null, saved: null };
const input = (perf: SidebarPerf, inner = 40, tier: PerfInput["tier"] = "full", now = 1000, totals = usage): PerfInput => ({ perf, usage: totals, now, inner, tier, ...plainPaint });

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

const SECTIONS = (perf: SidebarPerf, inner = 40, tier: PerfInput["tier"] = "compact", totals = usage) => {
  const i = input(perf, inner, tier, 1000, totals);
  return { speed: speedRows(i).map(strip), cache: cacheRows(i).map(strip) };
};

test("empty perf: sections keep the grammar, collapse to two rows, and never print NaN or 0%", () => {
  for (const tier of ["full", "compact"] as const) {
    const { speed, cache } = SECTIONS(EMPTY_PERF, 40, tier, noUsage);
    assert.equal(speed.length, 2); assert.equal(cache.length, 2);
    assert.match(speed[0]!, /^SPEED\s+—$/); assert.equal(speed[1], "no timed replies");
    assert.match(cache[0]!, /^CACHE\s+—$/); assert.equal(cache[1], "no cache activity reported");
    assert.doesNotMatch([...speed, ...cache].join("\n"), /NaN|Infinity|-\d|0%|[█▀]/);
  }
});

test("known spend is shown even without cache activity", () => {
  const { cache } = SECTIONS(perfFixture(1000), 40, "compact", { ...noUsage, input: 100, cost: 0.84 });
  assert.deepEqual(cache.slice(1), ["no cache activity reported", "spent $0.84"]);
});

test("compact SPEED: heading, left-aligned sparkline, labelled detail row; padding is spaces", () => {
  const perf: SidebarPerf = { ...perfFixture(1000), rates: [10, 20, 15, 18, 23.5], peak: 23.5, turn: { output: 214, rate: 13.9 } };
  const { speed } = SECTIONS(perf);
  assert.equal(speed.length, 3);
  assert.match(speed[0]!, /^SPEED\s+23\.5 tok\/s$/);
  assert.equal(speed[1], "▄▇▅▆█".padEnd(40));
  assert.equal(SECTIONS(perf, 3).speed[1], "▅▆█", "show the newest sample per column");
  assert.equal(speed[2], "avg 13.9 · peak 23.5 · out 214");
});

test("a single rate renders one block at the left", () => {
  const perf: SidebarPerf = { ...EMPTY_PERF, timedReplies: 1, rates: [30], peak: 30, turn: { output: 300, rate: 30 } };
  assert.match(SECTIONS(perf).speed[1]!, /^█ +$/);
});

test("full SPEED: big digits, two braille rows, then the same detail row", () => {
  const rows = SECTIONS(perfFixture(1000), 40, "full").speed;
  assert.equal(rows.length, 7);
  assert.match(rows[0]!, /^SPEED\s+last timed reply$/);
  assert.equal(rows[2], " █  ▀▀█   █▀█ tok/s");
  assert.match(rows[4]!, /[⠁-⣿]/); assert.match(rows[5]!, /[⠁-⣿]/);
  assert.equal(rows[6], "avg 26.7 · peak 45.0 · out 12k");
  assert(!rows.join("").includes("Turn avg"), "the 3-column table is gone");
});

test("untimed replies don't masquerade as missing responses, and incomplete output stays unknown", () => {
  const legacy: SidebarPerf = { ...EMPTY_PERF, turn: { output: 10, rate: null } };
  assert.equal(SECTIONS(legacy).speed[1], "no timed replies");
  const base = perfFixture(1000);
  const incomplete: SidebarPerf = { ...base, turn: { ...base.turn, output: null } };
  assert.match(SECTIONS(incomplete).speed[2]!, /out —$/);
});

test("huge numbers and tiny widths stay inside the width", () => {
  const base = perfFixture(1000);
  const perf: SidebarPerf = { ...base, peak: 1e9, rates: [12_345, 1e9], turn: { output: 9e12, rate: 1e15 } };
  assert.equal(SECTIONS(perf, 40, "full").speed[1], "1B tok/s", "unsupported big glyphs fall back to text");
  for (const inner of [1, 4, 10, 16, 21, 22, 24, 30, 44, 60]) for (const tier of ["full", "compact"] as const) for (const cost of [1.2e6, 1e308, null]) {
    const i = input(perf, inner, tier, 1000, { ...usage, cacheWrite: 1e12, uncached: 1e15, cost, saved: 1.2e6 });
    for (const r of [...speedRows(i), ...cacheRows(i), ...contextRows(i, { percent: 91, tokens: 1e12, window: 1e15, estimated: true })]) {
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
  assert.match(head({}, 1_000_000), /^CACHE\s+84\.03% hit · ◉ 4:41$/);
  assert.match(head({}, 1_000_000 + 1000), /◉ 4:40$/, "countdown moves with the clock alone");
  assert.match(head({}, 1_000_000 + 400_000), /84\.03% hit · cold$/);
  assert.match(head({ ttlMs: null }, 1_000_000 + 30_000), /^CACHE\s+84\.03% hit$/, "no lifetime and recent: nothing extra");
  assert.match(head({ ttlMs: null, lastActivityAt: 1_000_000 - 62_000 }, 1_000_000, "compact"), /^CACHE\s+84\.03% hit · idle 1m$/);
});

test("CACHE headline and bar use branch totals and distinguish near-perfect from exact hits", () => {
  const base = perfFixture(1000);
  const perf = { ...base, cache: { ...base.cache, lastHit: 0.9956 } };
  for (const [read, label, cells] of [[86_000, "86% hit", 34], [95_200, "95.2% hit", 38], [99_560, "99.56% hit", 39], [99_999, "99.99% hit", 39], [100_000, "all cached", 40]] as const) {
    const totals = { ...usage, input: 100_000, cacheRead: read, cacheWrite: 0, uncached: 100_000 - read };
    const i = input(perf, 40, "compact", 1000, totals);
    const [heading, bar] = cacheRows({ ...i, paint: (t, x) => t === "accent" ? x.replaceAll("━", "█") : x });
    assert(heading?.includes(label));
    assert.equal(bar, "█".repeat(cells) + "━".repeat(40 - cells));
  }
  const unknown = SECTIONS(perf, 40, "full", { ...usage, input: null, uncached: null }).cache;
  assert.match(unknown[0]!, /^CACHE\s+◉ 4:41$/, "unknown totals omit the hit rate");
  assert.equal(unknown[1], "─".repeat(40), "missing input is not treated as all cached");
});

test("CACHE bars use the context glyph in three tones; money rows handle unknowns", () => {
  const themed: string[] = [];
  const paint = { paint: (t: string, x: string) => { themed.push(`${t}:${x}`); return x; }, heading: (x: string) => x };
  const full = cacheRows({ ...input(perfFixture(1000), 40, "full"), ...paint }).map(strip);
  assert.equal(full.length, 4);
  assert.equal(full[1], "━".repeat(40)); assert(!/[█▓░]/.test(full.join("")));
  const bar = themed.filter(t => /^(accent|warning|muted):━/.test(t)).map(t => t.split(":")[0]);
  assert.deepEqual(bar, ["accent", "warning", "muted"]);
  assert.equal(full[2], "read 1.3M · write 108k · new 141k");
  assert.equal(full[3], "spent $0.84 · saved ~$1.92");
  const none = SECTIONS(perfFixture(1000), 40, "full", { ...usage, cost: null, saved: null }).cache;
  assert.equal(none[3], "spent —");
  const compact = SECTIONS(perfFixture(1000), 48).cache;
  assert.equal(compact.length, 3); assert.equal(compact[2], "read 1.3M · write 108k · new 141k · spent $0.84");
  assert.equal(SECTIONS(perfFixture(1000), 40).cache[2], "read 1.3M · write 108k · new 141k", "spent is dropped when it does not fit");
  const zero = SECTIONS(perfFixture(1000), 40, "compact", { ...usage, input: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 }).cache;
  assert.equal(zero[1], "─".repeat(40));
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

test("render recomputes the countdown each second without extra timers", () => {
  const clock = { now: 1_000_000 };
  const s = sidebarWith(60, perfFixture(clock.now), clock);
  const a = s.render(44).map(strip).join("\n");
  assert.equal(s.render(44).map(strip).join("\n"), a);
  clock.now += 1000;
  const b = s.render(44).map(strip).join("\n");
  assert.notEqual(a, b); assert.match(a, /◉ 4:41/); assert.match(b, /◉ 4:40/);
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

test("details distinguish branch and last-request cache rates", () => {
  const clock = { now: 1_000_000 };
  const base = perfFixture(clock.now);
  const s = sidebarWith(30, { ...base, cache: { ...base.cache, lastHit: 0.9956 } }, clock);
  assert.match(s.render(40).map(strip).join("\n"), /CACHE\s+84\.03% hit · ◉ 4:41/);
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
    working: true, turns: 1, messages: 1, usage, perf: perfFixture(clock.now) });
  s.render(44);
  for (const t of tones) assert(["text", "muted", "dim", "accent", "success", "warning", "error", "mdHeading", "border", "borderMuted", "borderAccent"].includes(t) || /^[a-zA-Z]+$/.test(t), t);
  assert(tones.has("success") && tones.has("accent") && tones.has("warning"));
});

test("context bar: one row, exact width, eighth-step fill, visible at tiny percents", () => {
  const paint = (_t: string, x: string) => x;
  for (const width of [0, 1, 2, 3, 10, 41]) for (const pct of [null, 0, 0.01, 2, 50, 99.9, 100, 140, NaN])
    assert.equal(visibleWidth(contextBar(width, pct as number | null, paint, "accent")), width, `width ${width} pct ${pct}`);
  assert.equal(contextBar(10, 0, paint, "accent"), "░".repeat(10));
  assert.equal(contextBar(10, null, paint, "accent"), "░".repeat(10));
  assert.equal(contextBar(10, 0.01, paint, "accent"), "▏" + "░".repeat(9), "any usage is visible");
  assert.equal(contextBar(10, 50, paint, "accent"), "█████" + "░".repeat(5));
  assert.equal(contextBar(10, 100, paint, "accent"), "█".repeat(10));
});
