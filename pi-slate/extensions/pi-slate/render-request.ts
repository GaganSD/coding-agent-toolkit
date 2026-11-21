import type { TUI } from "@earendil-works/pi-tui";

/** Normal requests can delegate to the failed view scheduler; forced requests have a separate path. */
export function requestNecessaryRender(tui: Pick<TUI, "requestRender">, force = false): boolean {
  if (!force) {
    try { tui.requestRender(); return true; } catch { /* Try the force path below. */ }
  }
  try { tui.requestRender(true); return true; } catch { return false; }
}
