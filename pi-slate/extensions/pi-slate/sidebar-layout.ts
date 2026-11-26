export type SidebarSlots = { frame: number; header: number; middle: number; image: number };
export type SidebarTier = "full" | "compact";

// Columns hold one stat per row, so 13 cells fit "99.99% hit" with room to spare.
const PERF_MIN_COLUMN = 13;
const PERF_COLUMN_GAP = "  ";

export function sidebarPerfColumns(inner: number): { speed: number; cache: number; gap: string } | undefined {
  const space = inner - PERF_COLUMN_GAP.length;
  if (space < 2 * PERF_MIN_COLUMN) return undefined;
  const speed = Math.floor(space / 2);
  return { speed, cache: space - speed, gap: PERF_COLUMN_GAP };
}

/** Budget borders, content and hit regions together. Shed header gaps before squeezing a preview. */
export function sessionSidebarSlots(height: number, headerRows: number, hasImage: boolean, gaps = 0): SidebarSlots {
  const rows = Math.max(0, Math.floor(height));
  const frame = rows >= 12 ? 2 : 0;
  const available = rows - frame;
  const previewMin = hasImage ? 4 : 0;
  const middleMin = Math.min(6, available);
  const headerWant = hasImage ? Math.max(headerRows - gaps, Math.min(headerRows, available - middleMin - previewMin)) : headerRows;
  const header = Math.min(headerWant, available);
  const body = available - header;
  const spare = Math.max(0, body - middleMin);
  const imageWant = hasImage ? Math.min(10, Math.max(previewMin, Math.floor(rows / 5))) : 0;
  const image = Math.min(imageWant, spare);
  return { frame, header, middle: body - image, image };
}

export function sidebarListOffset(offset: number, count: number, visible: number): number {
  return Math.max(0, Math.min(Math.floor(offset), Math.max(0, count - Math.max(1, visible))));
}

/** Bound money labels so growing totals cannot steal the label lane. */
export function sidebarCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return "—";
  if (cost < 1_000_000) return `$${cost.toFixed(2)}`;
  if (cost >= 1e15) return `$${cost.toExponential(1)}`;
  const unit = cost >= 1e12 ? 1e12 : cost >= 1e9 ? 1e9 : 1e6;
  const suffix = unit === 1e12 ? "T" : unit === 1e9 ? "B" : "M";
  return `$${(cost / unit).toFixed(1)}${suffix}`;
}

export function sidebarDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
