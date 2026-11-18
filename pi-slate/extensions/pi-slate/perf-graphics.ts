/**
 * Pure drawing + row composition for the SPEED and CACHE sections of the session rail.
 * No state, no timers: every function maps (data, width, now) to bounded strings, so cost is
 * O(width) plus the already-bounded `rates` window.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCompactTokenCount } from "./layout.ts";
import { sidebarCacheHit, type SidebarUsage } from "./sidebar-data.ts";
import { sidebarCost, type SidebarTier } from "./sidebar-layout.ts";
import { cacheWarmth, type SidebarPerf } from "./perf-stats.ts";

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
const DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const;

/**
 * Zero-based braille bar graph, `rows` cells tall and `width` cells wide (2 columns per cell).
 * Left-aligned: history fills in from the left; once there are more values than columns the
 * newest `2 × width` are shown. Unused columns are blank. A positive value draws at least one dot.
 */
export function brailleBars(values: readonly number[], width: number, rows: number): string[] {
  const w = Math.max(0, Math.floor(width));
  const r = Math.max(0, Math.floor(rows));
  if (r === 0) return [];
  if (w === 0) return Array.from({ length: r }, () => "");
  const columns = w * 2;
  const shown = values.slice(-columns).map(v => nonneg(v) ? v : 0);
  const max = shown.reduce((a, b) => Math.max(a, b), 0);
  const total = r * 4;
  const heights = Array.from({ length: columns }, (_, c) => {
    const v = c < shown.length ? shown[c]! : 0;
    return v > 0 && max > 0 ? Math.max(1, Math.min(total, Math.round(v / max * total))) : 0;
  });
  const lines: string[] = [];
  for (let row = 0; row < r; row++) {
    let s = "";
    for (let cell = 0; cell < w; cell++) {
      let code = 0;
      for (let k = 0; k < 2; k++) for (let d = 0; d < 4; d++) {
        if ((r - row) * 4 - d <= heights[cell * 2 + k]!) code |= DOT[d]![k]!;
      }
      s += code === 0 ? " " : String.fromCharCode(0x2800 + code);
    }
    lines.push(s);
  }
  return lines;
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

export function formatIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ---- row composition -------------------------------------------------------------------------
// One grammar for CONTEXT, SPEED and CACHE: heading row (label left, key figure right), one
// full-width visual row, then `label value · label value` detail rows. Padding is always spaces.

export type PerfInput = { perf: SidebarPerf; usage: SidebarUsage; streaming: boolean; now: number; inner: number; tier: SidebarTier } & PerfPaint;
type Seg = readonly [Tone, string];

const fit = (lines: string[], width: number): string[] => lines.map(l => truncateToWidth(l, width, "…"));
const paintSegs = (i: PerfPaint, segs: readonly Seg[]): string => segs.map(([t, x]) => i.paint(t, x)).join("");
const segWidth = (segs: readonly Seg[]): number => segs.reduce((n, [, x]) => n + visibleWidth(x), 0);

/** Heading row: bold label left, longest right-hand variant that still leaves the label room. */
function headingRow(i: PerfInput, label: string, variants: ReadonlyArray<readonly Seg[]>): string {
  const left = i.heading(label);
  const room = i.inner - visibleWidth(label) - 1;
  const right = variants.find(v => segWidth(v) <= room) ?? [];
  const gap = Math.max(1, i.inner - visibleWidth(label) - segWidth(right));
  return truncateToWidth(left + (right.length ? " ".repeat(gap) + paintSegs(i, right) : ""), i.inner, "…");
}

/** Detail row: `label value · label value`, dropping trailing pairs until it fits. */
function detailRow(i: PerfInput, pairs: ReadonlyArray<readonly [string, string]>): string {
  const render = (n: number): string => pairs.slice(0, n).map(([l, v]) => i.paint("dim", l + " ") + i.paint("text", v)).join(i.paint("dim", " · "));
  for (let n = pairs.length; n >= 1; n--) {
    const text = render(n);
    if (visibleWidth(text) <= i.inner) return text;
  }
  return truncateToWidth(render(1), i.inner, "…");
}
const noteRow = (i: PerfInput, text: string): string => truncateToWidth(i.paint("dim", text), i.inner, "…");
const baseline = (i: PerfInput): string => i.paint("dim", "─".repeat(Math.max(0, i.inner)));
const DASH: Seg = ["dim", "—"];

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * One-row context bar: solid fill on a light-shaded track. The fill edge advances in
 * eighth-cell steps; any non-zero percent shows at least one eighth so usage never reads as empty.
 */
export function contextBar(width: number, percent: number | null, paint: PerfInput["paint"], tone: Tone): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  const p = percent === null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent));
  let eighths = Math.round(p * w * 8 / 100);
  if (p > 0 && eighths === 0) eighths = 1;
  const full = Math.floor(eighths / 8), part = eighths % 8;
  const fill = "█".repeat(full) + EIGHTHS[part]!;
  const track = "░".repeat(Math.max(0, w - full - (part ? 1 : 0)));
  return (fill ? paint(tone, fill) : "") + (track ? paint("dim", track) : "");
}

/** CONTEXT: heading + a one-row bar. */
export function contextRows(i: PerfInput, c: { percent: number | null; tokens: number | null; window: number | null; estimated: boolean }): string[] {
  const percent = c.percent !== null && Number.isFinite(c.percent) ? Math.max(0, Math.min(100, c.percent)) : null;
  const tone: Tone = percent !== null && percent >= 80 ? "warning" : "accent";
  const pctSeg: Seg = percent === null ? DASH : [percent >= 80 ? "warning" : "text", `${Math.round(percent)}%`];
  const figures: Seg = ["dim", `${c.estimated ? "~" : ""}${formatCompactTokenCount(c.tokens)}/${formatCompactTokenCount(c.window)}`];
  return [
    headingRow(i, "CONTEXT", [[pctSeg, ["dim", "  "], figures], [pctSeg]]),
    contextBar(i.inner, percent, i.paint, tone),
  ];
}

/** Headline is always the exact last eligible response. */
export function speedRows(i: PerfInput): string[] {
  const { perf, inner, paint } = i;
  const streaming: readonly Seg[] = i.streaming ? [["warning", "● streaming"]] : [];
  const rate = perf.rates.at(-1);
  if (rate === undefined) {
    return [headingRow(i, "SPEED", [[...streaming, ...(streaming.length ? [["text", "  "] as Seg] : []), DASH], [DASH]]),
      noteRow(i, perf.requests > 0 ? "replies too short to time" : "waiting for first response")];
  }
  const digits = formatRate(rate);
  const value: Seg = ["text", digits];
  const unit: Seg = ["dim", " tok/s"];
  const out = perf.turn && perf.turn.output > 0 ? formatCompactTokenCount(perf.turn.output) : "—";
  const detail = detailRow(i, [["avg", formatRate(perf.turn?.rate)], ["peak", formatRate(perf.peak)], ["out", out]]);
  const gap: Seg = ["text", "  "];
  if (i.tier !== "full") {
    const lead = streaming.length ? [...streaming, gap] : [];
    const visual = paint("accent", brailleBars(perf.rates, inner, 1)[0]!);
    return [headingRow(i, "SPEED", [[...lead, value, unit], [...lead, value], [value, unit], [value]]), visual, detail];
  }
  const right: Seg[][] = [streaming.length ? [...streaming] : [["dim", "last response"]], streaming.length ? [["warning", "●"]] : []];
  const rows = [headingRow(i, "SPEED", right)];
  const [a, b, c] = bigDigits(digits) as [string, string, string];
  const digitWidth = visibleWidth(a);
  if (digitWidth <= inner && [...digits].every(ch => ch in FONT)) {
    const withUnit = digitWidth + 1 + "tok/s".length <= inner;
    rows.push(paint("text", a), paint("text", b) + (withUnit ? " " + paint("dim", "tok/s") : ""), paint("text", c));
  } else rows.push(paintSegs(i, [value, unit]));
  if (inner >= 22) rows.push(...brailleBars(perf.rates, inner, 2).map(g => paint("accent", g)));
  rows.push(detail);
  return fit(rows, inner);
}

export function formatCacheHit(rate: number | null): string {
  if (rate === null) return "—";
  const rounded = Math.round(rate * 100);
  return rounded === 100 && rate < 1 ? ">99%" : `${rounded}%`;
}

/** Headline uses the same branch totals as the bar; warmth is based on the latest request. */
function cacheSegs(i: PerfInput, full: boolean): Seg[][] {
  const { cache: c } = i.perf;
  const rate = sidebarCacheHit(i.usage);
  const hit = rate === null ? null : formatCacheHit(rate);
  const w = cacheWarmth(c, i.now);
  const warm: Seg | null = w.state === "warm" ? ["success", full ? `◉ ${formatCountdown(w.remainingMs ?? 0)}` : `warm ${formatCountdown(w.remainingMs ?? 0)}`]
    : w.state === "cold" ? ["warning", "cold"]
    : w.idleMs !== null && w.idleMs >= 60_000 ? ["dim", `idle ${formatIdle(w.idleMs)}`] : null;
  const sep: Seg = ["dim", " · "];
  const hitSegs = (long: boolean): Seg[] => hit === null ? [] : long ? [["text", hit], ["dim", " hit"]] : [["text", hit]];
  const join = (a: Seg[], b: Seg | null): Seg[] => b ? (a.length ? [...a, sep, b] : [b]) : a;
  return [join(hitSegs(true), warm), join(hitSegs(false), warm), hitSegs(true), hitSegs(false)];
}

export function cacheRows(i: PerfInput): string[] {
  const { perf, usage, inner, paint } = i;
  if (!usage.cacheSeen) return [headingRow(i, "CACHE", [[DASH]]), noteRow(i, perf.requests === 0 ? "no requests yet" : "no cache reads reported")];
  const [r = 0, w = 0, u = 0] = usage.input === null ? [] : stackedBar([usage.cacheRead ?? 0, usage.cacheWrite ?? 0, usage.uncached ?? 0], inner);
  const bar = r || w || u ? paint("success", "━".repeat(r)) + paint("warning", "━".repeat(w)) + paint("muted", "━".repeat(u)) : baseline(i);
  const f = formatCompactTokenCount;
  const spent: [string, string] = ["spent", sidebarCost(usage.cost)];
  const tokens: Array<[string, string]> = [["read", f(usage.cacheRead)], ["write", f(usage.cacheWrite)], ["new", f(usage.uncached)]];
  const rows = [headingRow(i, "CACHE", cacheSegs(i, true)), bar];
  if (i.tier === "full") {
    const saved = perf.cache.saved;
    rows.push(detailRow(i, tokens), detailRow(i, nonneg(saved) ? [spent, ["saved", `~${sidebarCost(saved)}`]] : [spent]));
  } else rows.push(detailRow(i, [...tokens, spent]));
  return fit(rows, inner);
}

/** One row for short terminals: `23.5 tok/s · 62% hit · idle 1m`, shedding trailing parts to fit. */
export function combinedRow(i: PerfInput): string {
  const { perf } = i;
  if (perf.requests === 0 && !i.usage.cacheSeen) return noteRow(i, "no requests yet");
  const rate = perf.rates.at(-1);
  const speed: Seg[] = rate === undefined ? [DASH] : [["text", formatRate(rate)], ["dim", " tok/s"]];
  const cache = i.usage.cacheSeen ? cacheSegs(i, false) : [[]];
  const sep: Seg = ["dim", " · "];
  const variants = cache.map(c => c.length ? [...speed, sep, ...c] : speed);
  variants.push(speed);
  const pick = variants.find(v => segWidth(v) <= i.inner) ?? speed;
  return truncateToWidth(paintSegs(i, pick), i.inner, "…");
}
