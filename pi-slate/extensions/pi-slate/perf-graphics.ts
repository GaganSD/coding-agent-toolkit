/**
 * Pure drawing + row composition for the SPEED and CACHE sections of the session rail.
 * No state, no timers: every function maps (data, width, now) to bounded strings, so cost is
 * O(width) plus the already-bounded `rates` window.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCompactTokenCount } from "./layout.ts";
import { sidebarCost, type SidebarTier } from "./sidebar-layout.ts";
import { cacheWarmth, type SidebarPerf } from "./perf-stats.ts";

export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error" | "mdHeading";
export type PerfPaint = {
  paint(tone: Tone, text: string): string;
  heading(text: string): string;
};

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const nonneg = (n: number | null | undefined): n is number => finite(n) && n >= 0;

/** tok/s: <100 one decimal, <1000 integer, then compact (1.2k, 12.3k, 123k, 1.2M). */
export function formatRate(n: number | null | undefined): string {
  if (!nonneg(n)) return "—";
  const tenth = Math.round(n * 10) / 10;
  if (tenth < 100) return tenth.toFixed(1);
  const whole = Math.round(n);
  if (whole < 1000) return `${whole}`;
  if (whole < 999_500) {
    const k = whole / 1000;
    return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toFixed(1)}k`;
  }
  if (whole < 1e15) {
    const unit = whole >= 1e12 ? 1e12 : whole >= 1e9 ? 1e9 : 1e6;
    const suffix = unit === 1e12 ? "T" : unit === 1e9 ? "B" : "M";
    const v = whole / unit;
    return `${v >= 100 ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)}${suffix}`;
  }
  return whole.toExponential(1);
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
  "k": ["█ ▄", "██ ", "█ ▀"], "~": ["   ", "▄▀▄", "   "], " ": ["  ", "  ", "  "],
};

/** Three rows of block-drawn text; unknown characters render as blank. Glyphs joined by one space. */
export function bigDigits(text: string): string[] {
  const glyphs = [...text].map(ch => FONT[ch] ?? FONT[" "]!);
  return [0, 1, 2].map(r => glyphs.map(g => g[r]!).join(" "));
}
export function bigDigitsWidth(text: string): number {
  return visibleWidth(bigDigits(text)[0]!);
}

const DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const;

/**
 * Zero-based braille bar graph, `rows` cells tall and `width` cells wide (2 columns per cell).
 * Right-aligned: the newest value is the right-most column. Columns without data show baseline dots.
 * A positive value always draws at least the bottom dot.
 */
export function brailleBars(values: readonly number[], width: number, rows: number): string[] {
  const w = Math.max(0, Math.floor(width));
  const r = Math.max(0, Math.floor(rows));
  if (r === 0) return [];
  if (w === 0) return Array.from({ length: r }, () => "");
  const columns = w * 2;
  const shown = values.slice(-columns);
  const offset = columns - shown.length;
  const clean = shown.map(v => nonneg(v) ? v : 0);
  const max = clean.reduce((a, b) => Math.max(a, b), 0);
  const total = r * 4;
  const heights = Array.from({ length: columns }, (_, c) => {
    const v = c < offset ? 0 : clean[c - offset]!;
    return v > 0 && max > 0 ? Math.max(1, Math.min(total, Math.round(v / max * total))) : 0;
  });
  const lines: string[] = [];
  for (let row = 0; row < r; row++) {
    let s = "";
    for (let cell = 0; cell < w; cell++) {
      let code = 0;
      for (let k = 0; k < 2; k++) for (let d = 0; d < 4; d++) {
        const level = (r - row) * 4 - d;
        const h = heights[cell * 2 + k]!;
        if (level <= h || (level === 1 && h === 0)) code |= DOT[d]![k]!;
      }
      s += code === 0 ? " " : String.fromCharCode(0x2800 + code);
    }
    lines.push(s);
  }
  return lines;
}

const BLOCKS = "▁▂▃▄▅▆▇█";
/** One-row zero-based sparkline of the newest `width` values, right-aligned; gaps show the baseline. */
export function sparkBlocks(values: readonly number[], width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  const shown = values.slice(-w).map(v => nonneg(v) ? v : 0);
  const max = shown.reduce((a, b) => Math.max(a, b), 0);
  const body = shown.map(v => v > 0 && max > 0 ? BLOCKS[Math.max(0, Math.min(7, Math.round(v / max * 7)))]! : BLOCKS[0]!).join("");
  return BLOCKS[0]!.repeat(w - shown.length) + body;
}

/**
 * Split `width` cells among `parts` by largest remainder: counts sum exactly to `width` (when any part is
 * positive) and every positive part gets at least one cell when the width allows.
 */
export function stackedBar(parts: readonly number[], width: number): number[] {
  const w = Math.max(0, Math.floor(width));
  const p = parts.map(v => nonneg(v) ? v : 0);
  const sum = p.reduce((a, b) => a + b, 0);
  const out = p.map(() => 0);
  if (w === 0 || sum <= 0) return out;
  const exact = p.map(v => v / sum * w);
  exact.forEach((v, i) => { out[i] = Math.floor(v); });
  let left = w - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length) { out[order[k]!.i]! += 1; left -= 1; }
  const positive = p.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
  if (w >= positive.length) for (const i of positive) {
    if (out[i]! > 0) continue;
    let donor = -1;
    for (let j = 0; j < out.length; j++) if (out[j]! > 1 && (donor < 0 || out[j]! > out[donor]!)) donor = j;
    if (donor >= 0) { out[donor]! -= 1; out[i] = 1; }
  }
  return out;
}

export function formatIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ---- row composition -------------------------------------------------------------------------

export type PerfInput = { perf: SidebarPerf; cost: number | null; now: number; inner: number; tier: SidebarTier } & PerfPaint;

/** Left text wins: headings never get squeezed out by a long right-hand status. */
function pairLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const l = truncateToWidth(left, width, "…");
  const r = truncateToWidth(right, Math.max(0, width - visibleWidth(l) - 1), "…");
  return `${l}${" ".repeat(Math.max(0, width - visibleWidth(l) - visibleWidth(r)))}${r}`;
}
const fit = (lines: string[], count: number, width: number): string[] => {
  const out = lines.slice(0, count).map(l => truncateToWidth(l, width, "…"));
  while (out.length < count) out.push("");
  return out;
};

type Headline = { value: number; estimate: boolean } | null;
function headlineOf(perf: SidebarPerf): Headline {
  if (perf.live.streaming && nonneg(perf.live.rate)) return { value: perf.live.rate, estimate: true };
  if (nonneg(perf.lastRate)) return { value: perf.lastRate, estimate: false };
  return null;
}
export const hasSpeed = (perf: SidebarPerf): boolean => headlineOf(perf) !== null || perf.rates.length > 0 || nonneg(perf.turn?.rate) || nonneg(perf.peak);
const headlineText = (h: Headline): string => h ? `${h.estimate ? "~" : ""}${formatRate(h.value)}` : "—";

/** Graph tone is steady; only the headline and streaming marker change while live. */
export function speedRows(i: PerfInput, count: number): string[] {
  const { perf, inner, paint, heading } = i;
  const h = headlineOf(perf);
  const streaming = perf.live.streaming;
  const label = heading("SPEED");
  if (!hasSpeed(perf)) {
    return fit(i.tier === "full" ? [label, paint("dim", perf.requests > 0 ? "no eligible response yet" : "waiting for first response")]
      : [label + " " + paint("dim", "waiting for first response")], count, inner);
  }
  const turnRate = perf.turn?.rate ?? null;
  const out = perf.turn && nonneg(perf.turn.output) && perf.turn.output > 0 ? formatCompactTokenCount(perf.turn.output) : "—";
  if (i.tier === "compact") {
    const head = label + " " + paint("text", `${streaming && h?.estimate ? "● " : ""}${headlineText(h)} tok/s`);
    const room = inner - visibleWidth(head) - 1;
    const line = room >= 6 ? `${head} ${paint("accent", sparkBlocks(perf.rates, Math.min(room, 20)))}` : head;
    return fit([line, paint("muted", statsLine(turnRate, perf.peak, out, inner))], count, inner);
  }
  const right = streaming && h?.estimate ? paint("warning", "● streaming") : h ? paint("dim", "last response") : "";
  const rows: string[] = [pairLine(label, right, inner)];
  const digits = `${h?.estimate ? "~" : ""}${formatRate(h?.value)}`;
  const unit = " tok/s";
  if (h && bigDigitsWidth(digits) <= inner) {
    const [a, b, c] = bigDigits(digits) as [string, string, string];
    const withUnit = bigDigitsWidth(digits) + 1 + unit.length <= inner;
    rows.push(paint("text", a), paint("text", b) + (withUnit ? " " + paint("dim", unit.trim()) : ""), paint("text", c));
  } else {
    rows.push(paint("text", `${digits}`) + paint("dim", unit));
  }
  if (inner >= 22) {
    for (const g of brailleBars(perf.rates, inner, 2)) rows.push(paint("accent", g));
    const colW = Math.floor(inner / 3);
    const cell = (t: string, w: number): string => { const x = truncateToWidth(t, w, "…"); return x + " ".repeat(Math.max(0, w - visibleWidth(x))); };
    const cols = (cells: string[]): string => cells.map((t, k) => k < 2 ? cell(t, colW) : truncateToWidth(t, inner - colW * 2, "…")).join("");
    rows.push(cols(["Turn avg", "Output", "Peak"].map(t => paint("dim", t))));
    rows.push(cols([formatRate(turnRate), out, formatRate(perf.peak)].map(t => paint("text", t))));
  } else {
    rows.push(paint("muted", statsLine(turnRate, perf.peak, out, inner)));
  }
  return fit(rows, count, inner);
}

function statsLine(avg: number | null, peak: number | null, out: string, inner: number): string {
  const long = `avg ${formatRate(avg)} · peak ${formatRate(peak)} · out ${out}`;
  return visibleWidth(long) <= inner ? long : `${formatRate(avg)} · ${formatRate(peak)} · ${out}`;
}

const pct = (n: number): string => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;

/** Longest variant that still leaves the CACHE label room; degrades hit label, then countdown. */
function cacheRight(i: PerfInput): string {
  const { perf, paint } = i;
  const c = perf.cache;
  const sep = paint("dim", " · ");
  const hit = nonneg(c.lastHit) ? pct(c.lastHit) : null;
  const w = cacheWarmth(c, i.now);
  const warm = w.state === "warm" ? { tone: "success" as const, long: `◉ warm ${formatCountdown(w.remainingMs ?? 0)}`, short: `◉ ${formatCountdown(w.remainingMs ?? 0)}` }
    : w.state === "cold" ? { tone: "warning" as const, long: "◌ cold", short: "◌ cold" }
    : w.idleMs !== null && w.idleMs >= 60_000 ? { tone: "dim" as const, long: `idle ${formatIdle(w.idleMs)}`, short: `idle ${formatIdle(w.idleMs)}` }
    : null;
  const make = (hitText: string | null, warmText: string | null): string => [hitText && paint("text", hitText), warmText && warm && paint(warm.tone, warmText)].filter(Boolean).join(sep);
  const variants = [make(hit && `${hit} hit`, warm?.long ?? null), make(hit, warm?.short ?? null), make(hit && `${hit} hit`, null), make(hit, null)];
  const room = i.inner - visibleWidth("CACHE") - 1;
  return variants.find(v => visibleWidth(v) <= room) ?? variants[variants.length - 1]!;
}

function tokenSummary(c: SidebarPerf["cache"], inner: number): string {
  const f = formatCompactTokenCount;
  const long = `read ${f(c.read)} · write ${f(c.write)} · new ${f(c.uncached)}`;
  return visibleWidth(long) <= inner ? long : `r ${f(c.read)} · w ${f(c.write)} · n ${f(c.uncached)}`;
}

export function cacheRows(i: PerfInput, count: number): string[] {
  const { perf, inner, paint, heading } = i;
  const c = perf.cache;
  const label = heading("CACHE");
  if (!c.seen && perf.requests === 0) return fit([label, paint("dim", "no requests yet")], count, inner);
  if (!c.seen) return fit([label, paint("dim", "no cache reads reported")], count, inner);
  const head = pairLine(label, cacheRight(i), inner);
  const spent = `spent ${sidebarCost(i.cost)}`;
  const saved = nonneg(c.saved) ? ` · saved ~${sidebarCost(c.saved)}` : "";
  if (i.tier === "compact") {
    const candidates = [`${tokenSummary(c, inner)} · ${sidebarCost(i.cost)}`, tokenSummary(c, inner), spent + saved, spent];
    const detail = candidates.find(t => visibleWidth(t) <= inner) ?? candidates[candidates.length - 1]!;
    return fit([head, paint("muted", detail)], count, inner);
  }
  const parts = [c.read, c.write, c.uncached];
  const total = parts.reduce<number>((a, b) => a + (nonneg(b) ? b : 0), 0);
  const bar = total > 0 ? (() => {
    const [r, w, u] = stackedBar(parts.map(p => p ?? 0), inner) as [number, number, number];
    return paint("success", "█".repeat(r)) + paint("warning", "▓".repeat(w)) + paint("dim", "░".repeat(u));
  })() : paint("dim", "—");
  return fit([head, bar, paint("muted", tokenSummary(c, inner)), paint("muted", spent) + (saved ? paint("muted", saved) : "")], count, inner);
}

/** One row for short terminals: speed, hit rate, and cache countdown. */
export function combinedRow(i: PerfInput): string {
  const { perf, paint, inner } = i;
  if (perf.requests === 0 && !perf.cache.seen) return truncateToWidth(paint("dim", "no requests yet"), inner, "…");
  const h = headlineOf(perf);
  const parts = [paint("text", `↯${headlineText(h)} t/s`)];
  const c = perf.cache;
  if (c.seen && nonneg(c.lastHit)) {
    const w = cacheWarmth(c, i.now);
    const text = `${w.state === "warm" ? "◉" : "◌"}${pct(c.lastHit)}${w.state === "warm" ? ` ${formatCountdown(w.remainingMs ?? 0)}` : w.state === "cold" ? " cold" : ""}`;
    parts.push(paint(w.state === "warm" ? "success" : w.state === "cold" ? "warning" : "dim", text));
  }
  return truncateToWidth(parts.join(" "), inner, "…");
}
