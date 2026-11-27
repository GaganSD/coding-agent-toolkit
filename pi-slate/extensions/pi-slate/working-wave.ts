/**
 * Tiny sine wave that sits in the composer top border's working-status slot
 * while the model runs — the same slot the italic working word used to fill.
 * Pure and deterministic: the tick alone picks the frame. The wave animates
 * in place (block heights travel across seven columns); it never moves.
 */

import { helixFrame } from "./working-helix.ts";
import { cylonFrame } from "./working-cylon.ts";
import { snakeFrame } from "./working-snake.ts";

const BLOCKS = "▁▂▃▄▅▆▇█";
const COLUMNS = 7;

/** Ticks after which the animation repeats exactly. */
export const WAVE_PERIOD = 8;

/**
 * One fixed-width wave frame (7 visible columns, word-sized).
 * Never throws; degenerate ticks render frame zero.
 */
export function waveFrame(tick: number): string {
  const safe = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0;
  const step = safe % WAVE_PERIOD;
  let frame = "";
  for (let x = 0; x < COLUMNS; x++) {
    frame += BLOCKS[Math.round(3.5 + 3.5 * Math.sin(((x - step) * Math.PI) / 4))];
  }
  return frame;
}

/** The selectable progress indicators, in picker order. */
export const PROGRESS_STYLES = ["waves", "dna-helix", "snake", "cylon-scanner"] as const;

export type ProgressStyle = (typeof PROGRESS_STYLES)[number];

export function isProgressStyle(value: unknown): value is ProgressStyle {
  return typeof value === "string" && (PROGRESS_STYLES as readonly string[]).includes(value);
}

let style: ProgressStyle = "waves";

export function setProgressStyle(next: ProgressStyle): void {
  style = next;
}

/**
 * Frame for the active progress indicator. The wave and helix hold their
 * word-sized seven columns; the snake and cylon grow to the width the
 * composer border offers, capped at their natural size.
 */
export function progressFrame(tick: number, width?: number): string {
  if (style === "dna-helix") return helixFrame(tick);
  if (style === "snake") return snakeFrame(tick, width);
  if (style === "cylon-scanner") return cylonFrame(tick, width);
  return waveFrame(tick);
}

/** The same style in the three columns a sidebar row can spare. */
export function compactProgressFrame(tick: number): string {
  // The cylon's brackets are its widest part; drop them and keep the inner eye.
  if (style === "cylon-scanner") return cylonFrame(tick, 5).slice(1, -1);
  return progressFrame(tick, 3).slice(0, 3);
}

export const WAVE_STEP_MS = 120;
let startedAt: number | undefined;

export function setWaveActive(on: boolean, now = performance.now()): void {
  startedAt = on ? startedAt ?? now : undefined;
}

export function isWaveActive(): boolean { return startedAt !== undefined; }

export function waveTick(now = performance.now()): number {
  return startedAt === undefined ? 0 : Math.floor(Math.max(0, now - startedAt) / WAVE_STEP_MS);
}
