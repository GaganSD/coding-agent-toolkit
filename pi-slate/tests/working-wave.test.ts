import assert from "node:assert/strict";
import test from "node:test";
import {
  isWaveActive,
  progressFrame,
  setProgressStyle,
  setWaveActive,
  WAVE_PERIOD,
  WAVE_STEP_MS,
  waveFrame,
  waveTick,
} from "../extensions/pi-slate/working-wave.ts";
import { cylonFrame } from "../extensions/pi-slate/working-cylon.ts";
import { helixFrame } from "../extensions/pi-slate/working-helix.ts";
import { snakeFrame } from "../extensions/pi-slate/working-snake.ts";

const BLOCK_ONLY = /^[▁▂▃▄▅▆▇█]{7}$/;

test("wave frame is deterministic for a given tick", () => {
  for (const tick of [0, 1, 7, 8, 42, 1000]) {
    assert.equal(waveFrame(tick), waveFrame(tick));
  }
});

test("wave frame is always seven block columns with no control characters", () => {
  for (let tick = 0; tick < 1000; tick++) {
    const frame = waveFrame(tick);
    assert.match(frame, BLOCK_ONLY, `tick ${tick}`);
    assert.equal([...frame].length, 7);
    assert.ok(!/[\x00-\x1f\x7f]/.test(frame), `tick ${tick}: no control chars`);
  }
});

test("wave loops exactly after WAVE_PERIOD ticks", () => {
  for (let tick = 0; tick < WAVE_PERIOD; tick++) {
    assert.equal(waveFrame(tick), waveFrame(tick + WAVE_PERIOD));
    assert.equal(waveFrame(tick), waveFrame(tick + WAVE_PERIOD * 25));
  }
});

test("every tick animates: consecutive frames differ", () => {
  for (let tick = 0; tick < WAVE_PERIOD; tick++) {
    assert.notEqual(waveFrame(tick), waveFrame(tick + 1), `ticks ${tick}/${tick + 1}`);
  }
});

test("wave uses a range of block heights (it actually rolls)", () => {
  const seen = new Set<string>();
  for (let tick = 0; tick < WAVE_PERIOD; tick++) for (const ch of waveFrame(tick)) seen.add(ch);
  assert.ok(seen.size >= 5, `expected a rolling range of heights, saw ${[...seen].join("")}`);
});

test("degenerate ticks render frame zero", () => {
  assert.equal(waveFrame(Number.NaN), waveFrame(0));
  assert.equal(waveFrame(-3), waveFrame(0));
  assert.equal(waveFrame(2.9), waveFrame(2));
});

test("progress frame dispatches on the selected style", () => {
  setProgressStyle("dna-helix");
  assert.equal(progressFrame(3), helixFrame(3));
  setProgressStyle("snake");
  assert.equal(progressFrame(3, 12), snakeFrame(3, 12));
  setProgressStyle("cylon-scanner");
  assert.equal(progressFrame(3, 8), cylonFrame(3, 8));
  setProgressStyle("waves");
  assert.equal(progressFrame(3), waveFrame(3));
});

test("wave phase uses elapsed time", (t) => {
  t.after(() => setWaveActive(false));
  const start = 1_000;
  setWaveActive(true, start);
  assert.equal(isWaveActive(), true);
  assert.equal(waveTick(start + WAVE_STEP_MS - 1), 0);
  assert.equal(waveTick(start + 2 * WAVE_STEP_MS), 2);
  setWaveActive(true, start + 2 * WAVE_STEP_MS);
  assert.equal(waveTick(start + 3 * WAVE_STEP_MS), 3, "re-activation keeps the original phase");
  setWaveActive(false);
  assert.equal(isWaveActive(), false);
  setWaveActive(true, start + 1000);
  assert.equal(waveTick(start + 1000), 0);
});
