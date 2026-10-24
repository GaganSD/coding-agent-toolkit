/** Blend `fg` over `bg` at `alpha` for build-time theme and diff tints. */
export function mixHex(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, start: number) => parseInt(hex.slice(start, start + 2), 16);
  const out = [1, 3, 5].map((start) => Math.round(channel(bg, start) + (channel(fg, start) - channel(bg, start)) * alpha));
  return `#${out.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Native Pi effort roles: restrained intensity within each theme's border family. */
export function effortPalette(border: string, borderAccent: string): { vars: Record<string, string>; colors: Record<string, string> } {
  const stops = {
    thinkingOff: 0,
    thinkingMinimal: 0.10,
    thinkingLow: 0.20,
    thinkingMedium: 0.32,
    thinkingHigh: 0.44,
    thinkingXhigh: 0.57,
    thinkingMax: 0.70,
  };
  const vars = Object.fromEntries(Object.entries(stops).map(([role, alpha]) => [role, mixHex(borderAccent, border, alpha)]));
  return { vars, colors: Object.fromEntries(Object.keys(stops).map(role => [role, role])) };
}
