/**
 * Double helix for the composer working-status slot: the same word-sized,
 * single-row footprint as the wave. A side-on B-DNA turn squeezed into seven
 * columns — the near backbone rides the crests (▔ ▁), its descending stretches
 * lean (\, always the same way: the molecule turns one way), and where the two
 * backbones swap front and back they knot into ╳.
 * Pure and deterministic: the tick alone picks the frame. The helix turns in
 * place; it never moves.
 */

const COLUMNS = 7; // the wave's width: same slot, same size
const PITCH = 6; // columns a turn, so the slot shows a little over one turn
const K = (2 * Math.PI) / PITCH;
const GROOVE = 0.64 * Math.PI; // the second backbone trails by this, as in B-DNA
const CROSS = 0.75; // backbones this close in height are crossing
const CREST = 0.45; // height past which a backbone sits flat on a crest

/** Ticks after which the animation repeats exactly. */
export const HELIX_PERIOD = 8;

/**
 * One fixed-width helix frame (7 visible columns, word-sized).
 * Never throws; degenerate ticks render frame zero.
 */
export function helixFrame(tick: number): string {
  const safe = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0;
  const a = (safe % HELIX_PERIOD) * ((2 * Math.PI) / HELIX_PERIOD);
  let frame = "";
  for (let col = 0; col < COLUMNS; col++) {
    const lead = K * (col + 0.5) - a; // first backbone's phase at this column
    const trail = lead - GROOVE;
    const leadHeight = Math.cos(lead);
    const leadDepth = -Math.sin(lead); // -1 behind the axis, 1 in front
    const trailHeight = Math.cos(trail);
    const trailDepth = -Math.sin(trail);
    if (Math.abs(leadHeight - trailHeight) < CROSS) {
      frame += "╳";
      continue;
    }
    const height = leadDepth >= trailDepth ? leadHeight : trailHeight;
    if (height > CREST) frame += "▔";
    else if (height < -CREST) frame += "▁";
    else frame += "\\"; // mid-turn: the near face always descends left to right
  }
  return frame;
}
