/**
 * Pure drawing + row composition for the SPEED and CACHE sections of the session rail.
 * No state, no timers: every function maps (data, width, now) to bounded strings, so cost is
 * O(width) plus the already-bounded `rates` window.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCompactTokenCount } from "./layout.ts";
import { sidebarCacheHit, type SidebarUsage } from "./sidebar-data.ts";
import { sidebarCost, sidebarPerfColumns, type SidebarTier } from "./sidebar-layout.ts";
import type { SidebarPerf } from "./perf-stats.ts";

export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error" | "mdHeading";
export type PerfPaint = {
  paint(tone: Tone, text: string): string;
  heading(text: string): string;
};

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const nonneg = (n: number | null | undefined): n is number => finite(n) && n >= 0;

/** tok/s: one decimal below 100, otherwise use the session's compact token notation. */
export function formatRate(n: number | null | undefined): string {
  if (!nonneg(n)) return "—";
  const tenth = Math.round(n * 10) / 10;
  return tenth < 100 ? tenth.toFixed(1) : formatCompactTokenCount(n);
}

/** m:ss, or h:mm:ss from one hour. Unknown/negative clamps to 0:00. */
export function formatCountdown(ms: number): string {
  const total = finite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const s = total % 60;
  if (total < 3600) return `${Math.floor(total / 60)}:${String(s).padStart(2, "0")}`;
  return `${Math.floor(total / 3600)}:${String(Math.floor(total % 3600 / 60)).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 3-row block digits; every glyph row of a glyph has the same width.
const FONT: Record<string, readonly [string, string, string]> = {
  "0": ["█▀█", "█ █", "▀▀▀"], "1": ["▀█ ", " █ ", "▀▀▀"], "2": ["▀▀█", "█▀▀", "▀▀▀"], "3": ["▀▀█", " ▀█", "▀▀▀"],
  "4": ["█ █", "▀▀█", "  ▀"], "5": ["█▀▀", "▀▀█", "▀▀▀"], "6": ["█▀▀", "█▀█", "▀▀▀"], "7": ["▀▀█", "  █", "  ▀"],
  "8": ["█▀█", "█▀█", "▀▀▀"], "9": ["█▀█", "▀▀█", "▀▀▀"], ".": [" ", " ", "▀"],
  "k": ["█ ▄", "██ ", "█ ▀"], " ": ["  ", "  ", "  "],
};

/** Three rows of block-drawn text; unknown characters render as blank. Glyphs joined by one space. */
export function bigDigits(text: string): string[] {
  const glyphs = [...text].map(ch => FONT[ch] ?? FONT[" "]!);
  return [0, 1, 2].map(r => glyphs.map(g => g[r]!).join(" "));
}
/** Round proportional boundaries; keep positive segments visible when they fit. */
export function stackedBar(parts: readonly number[], width: number): number[] {
  const w = Math.max(0, Math.floor(width));
  const values = parts.map(v => nonneg(v) ? v : 0);
  const max = Math.max(0, ...values);
  if (!w || !max) return values.map(() => 0);
  const total = values.reduce((sum, v) => sum + v / max, 0);
  let remaining = values.filter(v => v > 0).length;
  const min = w >= remaining ? 1 : 0;
  let cumulative = 0; let boundary = 0;
  return values.map(v => {
    if (!v) return 0;
    remaining--;
    const rounded = Math.round((cumulative += v / max) / total * w);
    const next = Math.max(boundary + min, Math.min(w - remaining * min, rounded));
    const cells = next - boundary;
    boundary = next;
    return cells;
  });
}

// ---- row composition -------------------------------------------------------------------------
// One grammar for CONTEXT, SPEED and CACHE: heading row (label left, key figure right), one
// full-width visual row, then `label value · label value` detail rows. Padding is always spaces.

export type PerfInput = { perf: SidebarPerf; usage: SidebarUsage; now: number; inner: number; tier: SidebarTier } & PerfPaint;
type Seg = readonly [Tone, string];

const paintSegs = (i: PerfPaint, segs: readonly Seg[]): string => segs.map(([t, x]) => i.paint(t, x)).join("");
const segWidth = (segs: readonly Seg[]): number => segs.reduce((n, [, x]) => n + visibleWidth(x), 0);
const DOT: Seg = ["dim", " · "];
const SPACE: Seg = ["dim", "  "];
const baseline = (i: PerfInput): string => i.paint("dim", "─".repeat(Math.max(0, i.inner)));
const DASH: Seg = ["muted", "—"];

/** Greedily wrap indivisible stats. A heading can leave less room on the first line. */
function wrapStats<T>(items: readonly T[], width: number, sep: number, measure: (item: T) => number, first = width): T[][] {
  const rows: T[][] = [[]];
  let row = rows[0]!;
  let room = first;
  for (const item of items) {
    const size = measure(item);
    if (size + (row.length ? sep : 0) > room && (row.length || first < width && rows.length === 1)) {
      row = [];
      rows.push(row);
      room = width;
    }
    room -= size + (row.length ? sep : 0);
    row.push(item);
  }
  return rows;
}

const headingRoom = (width: number, label: string): number => Math.max(0, width - visibleWidth(label) - 1);

function statRows(i: PerfInput, stats: readonly Seg[][], sep: Seg = DOT, label?: string, minRoom = 0): string[] {
  const room = label ? headingRoom(i.inner, label) : i.inner;
  return wrapStats(stats, i.inner, visibleWidth(sep[1]), segWidth, room < minRoom ? 0 : room).map((row, n) => {
    const right = row.map(s => truncateToWidth(paintSegs(i, s), i.inner, "…")).join(i.paint(...sep));
    if (!label) return right;
    const left = n === 0 ? i.heading(label) : "";
    return truncateToWidth(left + (right ? " ".repeat(Math.max(0, i.inner - visibleWidth(left) - visibleWidth(right))) + right : ""), i.inner, "…");
  });
}

const detailStat = (label: string, value: string, tone?: Tone): Seg[] =>
  [["dim", label + " "], [tone ?? (value === "—" ? "muted" : "text"), value]];

/** Lay out ordinary values and placeholders alike; let unusually long values wrap. */
function shapedRows(i: PerfInput, stats: readonly Seg[][], widths: readonly number[]): string[] {
  return wrapStats(stats.map((stat, n) => ({ stat, width: widths[n]! })), i.inner, visibleWidth(DOT[1]), s => s.width)
    .flatMap(row => statRows(i, row.map(s => s.stat)));
}

const rowBudget = (i: PerfInput, widths: readonly number[], sep = DOT, label?: string): number =>
  wrapStats(widths, i.inner, visibleWidth(sep[1]), n => n, label ? headingRoom(i.inner, label) : i.inner).length;
const padRows = (rows: string[], height: number): string[] => {
  while (rows.length < height) rows.push("");
  return rows;
};

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * One-row context bar: solid fill on a light-shaded track. The fill edge advances in
 * eighth-cell steps; any non-zero percent shows at least one eighth so usage never reads as empty.
 */
export function contextBar(width: number, percent: number | null, paint: PerfInput["paint"]): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  const p = percent === null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent));
  let eighths = Math.round(p * w * 8 / 100);
  if (p > 0 && eighths === 0) eighths = 1;
  const full = Math.floor(eighths / 8), part = eighths % 8;
  const fill = "█".repeat(full) + EIGHTHS[part]!;
  const track = "░".repeat(Math.max(0, w - full - (part ? 1 : 0)));
  return (fill ? paint("accent", fill) : "") + (track ? paint("dim", track) : "");
}

/** CONTEXT: heading + a one-row bar. */
export function contextRows(i: PerfInput, c: { percent: number | null; tokens: number | null; window: number | null; estimated: boolean }): string[] {
  const percent = c.percent !== null && Number.isFinite(c.percent) ? Math.max(0, Math.min(100, c.percent)) : null;
  const pctSeg: Seg = percent === null ? DASH : ["text", `${Math.round(percent)}%`];
  const figures: Seg = ["dim", `${c.estimated ? "~" : ""}${formatCompactTokenCount(c.tokens)}/${formatCompactTokenCount(c.window)}`];
  const rows = statRows(i, [[pctSeg], [figures]], SPACE, "CONTEXT");
  rows.push(contextBar(i.inner, percent, i.paint));
  return padRows(rows, rowBudget(i, [4, 12], SPACE, "CONTEXT") + 1);
}

/** Zero-based block bars, `rows` cells tall (top row first); each row adds eight levels. */
function speedSparkline(rates: readonly number[], width: number, rows = 1): string[] {
  if (width <= 0) return Array.from({ length: rows }, () => "");
  const shown = rates.slice(-width);
  const peak = Math.max(...shown);
  const levels = shown.map(rate => peak > 0 ? Math.round(rate / peak * (rows * 8 - 1)) + 1 : 1);
  return Array.from({ length: rows }, (_, r) => {
    const base = (rows - 1 - r) * 8;
    return levels.map(n => n > base ? "▁▂▃▄▅▆▇█"[Math.min(8, n - base) - 1] : " ").join("").padEnd(width);
  });
}

const SPEED_RATE_WIDTH = visibleWidth("99.9 tok/s");
const SPEED_DETAIL_WIDTHS = ["avg 20.9", "peak 27.2"].map(visibleWidth);
const SPEED_CAPTION = "last timed reply";

/** Headline is always the exact last eligible response. */
function speedRows(i: PerfInput): string[] {
  const { perf, inner, paint } = i;
  const digits = formatRate(perf.rates.at(-1));
  const empty = digits === "—";
  const rate: Seg[] = [[empty ? "muted" : "text", digits], [empty ? "muted" : "dim", " tok/s"]];
  const stats = [detailStat("avg", formatRate(perf.turn.rate)), detailStat("peak", formatRate(perf.peak))];
  const detail = shapedRows(i, stats, SPEED_DETAIL_WIDTHS);
  const graph = (height: number): string[] => empty ? [...Array<string>(height - 1).fill(""), baseline(i)]
    : speedSparkline(perf.rates, inner, height).map(g => paint("accent", g));
  if (i.tier !== "full") return [...statRows(i, [rate], SPACE, "SPEED", SPEED_RATE_WIDTH), ...graph(1), ...detail];
  const parts = visibleWidth(SPEED_CAPTION) <= inner ? [SPEED_CAPTION] : SPEED_CAPTION.split(" ");
  const rows = statRows(i, parts.map(text => [["dim", text]]), ["dim", " "], "SPEED");
  const [a, b, c] = bigDigits(digits) as [string, string, string];
  const digitWidth = visibleWidth(a);
  const big = inner >= 19; // Room for a typical block rate (14.6) and its unit.
  if (big && digitWidth + " tok/s".length <= inner && [...digits].every(ch => ch in FONT)) {
    rows.push(paint("text", a), paint("text", b) + " " + paint("dim", "tok/s"), paint("text", c));
  } else {
    const text = truncateToWidth(paintSegs(i, rate), inner, "…");
    rows.push(...(big ? ["", text, ""] : [text]));
  }
  const graphHeight = inner >= 22 ? 2 : 0;
  if (graphHeight) rows.push(...graph(graphHeight));
  return [...rows, ...detail];
}

export function formatCacheHit(rate: number | null): string {
  if (rate === null) return "—";
  if (rate === 1) return "all cached";
  return `${Math.min(99.99, Math.round(rate * 10_000) / 100)}%`;
}

const CACHE_TOKEN_WIDTHS = ["read 87.6k", "new 30.2k"].map(visibleWidth);
const CACHE_SAVED_WIDTH = visibleWidth("saved ~$12.34");
const CACHE_HIT_WIDTH = visibleWidth("99.99% hit");

/** Headline uses the same branch totals as the bar. */
function cacheHit(i: PerfInput): Seg[] {
  const rate = sidebarCacheHit(i.usage);
  return rate === null ? [["muted", "—% hit"]]
    : rate === 1 ? [["text", formatCacheHit(rate)]] : [["text", formatCacheHit(rate)], ["dim", " hit"]];
}

/** Hit share of input; writes still count toward input, so all non-hit input shares one color. */
function cacheBar(i: PerfInput): string {
  const { usage, inner, paint } = i;
  const [r = 0, other = 0] = usage.input === null ? [] : stackedBar([usage.cacheRead ?? 0, (usage.cacheWrite ?? 0) + (usage.uncached ?? 0)], inner);
  return r || other ? paint("accent", "━".repeat(r)) + paint("muted", "━".repeat(other)) : baseline(i);
}

function cacheSection(i: PerfInput): { rows: string[]; footerSlot: boolean } {
  const { usage } = i;
  const tone = usage.total === 0 ? "muted" : undefined;
  const bar = cacheBar(i);
  const tokens = [detailStat("read", formatCompactTokenCount(usage.cacheRead), tone),
    detailStat("new", formatCompactTokenCount(usage.uncached), tone)];
  const heading = statRows(i, [cacheHit(i)], DOT, "CACHE", CACHE_HIT_WIDTH);
  const saved = i.tier === "full" && nonneg(usage.saved) ? detailStat("saved", `~${sidebarCost(usage.saved)}`) : null;
  const splitSaved = i.tier === "full" && rowBudget(i, [...CACHE_TOKEN_WIDTHS, CACHE_SAVED_WIDTH]) > 1;
  const details = shapedRows(i, saved && !splitSaved ? [...tokens, saved] : tokens, [...CACHE_TOKEN_WIDTHS, CACHE_SAVED_WIDTH]);
  // A wrapped savings stat gets a reserved row so its first appearance cannot move the rail.
  const footer = splitSaved ? padRows(saved ? statRows(i, [saved]) : [], 1) : [];
  return { rows: [...heading, bar, ...details, ...footer], footerSlot: splitSaved };
}

/** The narrow-rail layout: SPEED above CACHE, each a full-width section. */
export function stackedPerfRows(i: PerfInput): Array<Array<string | null>> {
  const cache = cacheSection(i);
  return [[...speedRows(i), null], cache.footerSlot ? cache.rows : [...cache.rows, null]];
}

// ---- side-by-side cards -----------------------------------------------------------------------
// A card stacks heading, key figure, chart and one aligned stat per row, so each half stays
// narrow. Both cards have a fixed row structure: empty and populated sessions are the same height.

const cardStat = (i: PerfInput, label: string, pad: number, value: string, tone?: Tone): string =>
  paintSegs(i, [["dim", label.padEnd(pad)], [tone ?? (value === "—" ? "muted" : "text"), value]]);

function speedCard(i: PerfInput): string[] {
  const { perf, inner } = i;
  const digits = formatRate(perf.rates.at(-1));
  const empty = digits === "—";
  return [
    i.heading("SPEED"),
    paintSegs(i, [[empty ? "muted" : "text", digits], [empty ? "muted" : "dim", " tok/s"]]),
    empty ? baseline(i) : i.paint("accent", speedSparkline(perf.rates, inner)[0]!),
    cardStat(i, "avg", 5, formatRate(perf.turn.rate)),
    cardStat(i, "peak", 5, formatRate(perf.peak)),
  ];
}

function cacheCard(i: PerfInput): string[] {
  const { usage } = i;
  const tone = usage.total === 0 ? "muted" : undefined;
  const rows = [i.heading("CACHE"), paintSegs(i, cacheHit(i)), cacheBar(i),
    cardStat(i, "read", 6, formatCompactTokenCount(usage.cacheRead), tone),
    cardStat(i, "new", 6, formatCompactTokenCount(usage.uncached), tone)];
  if (i.tier === "full") rows.push(nonneg(usage.saved) ? cardStat(i, "saved", 6, `~${sidebarCost(usage.saved)}`) : "");
  return rows;
}

/** Null is a droppable separator; empty strings are reserved content rows. */
export function perfRows(i: PerfInput): Array<Array<string | null>> {
  const columns = sidebarPerfColumns(i.inner);
  if (!columns) return stackedPerfRows(i);
  const speed = speedCard({ ...i, inner: columns.speed });
  const cache = cacheCard({ ...i, inner: columns.cache });
  const rows = Array.from({ length: Math.max(speed.length, cache.length) }, (_, row) => {
    const left = truncateToWidth(speed[row] ?? "", columns.speed, "…");
    const right = truncateToWidth(cache[row] ?? "", columns.cache, "…");
    return right ? left + " ".repeat(columns.speed - visibleWidth(left)) + columns.gap + right : left;
  });
  return [[...rows, null]];
}
