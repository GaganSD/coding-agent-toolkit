import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { fit, sectionRow, viewport } from "./picker-frame.ts";
import { canonicalKey, keyTaken, sameKeyName, shortcutLabel } from "./shortcuts.ts";

/** Right-align one cell inside a fixed column. */
export function rightAlign(text: string, columns: number): string {
  const clipped = visibleWidth(text) > columns ? fit(text, columns) : text;
  return " ".repeat(Math.max(0, columns - visibleWidth(clipped))) + clipped;
}

/** Join a flexible left cell and a fixed right cell. The right cell keeps its width when space is short. */
export function aligned(left: string, right: string, columns: number, gap: number, rightWidth: number): string {
  const width = Math.max(0, columns);
  const rightCol = Math.min(rightWidth, Math.max(0, width - gap));
  const gapWidth = rightCol ? gap : 0;
  const leftCol = Math.max(0, width - rightCol - gapWidth);
  return fit(left, leftCol) + " ".repeat(gapWidth) + fit(right, rightCol);
}


/** A list row whose cursor stays visible in both panes: text when focused, muted when not. */
export function focusRow(th: Theme, text: string, selected: boolean, focused: boolean, columns: number): string {
  const bodyWidth = Math.max(0, columns - 2);
  if (!selected) return `  ${fit(text, bodyWidth)}`;
  let body = fit(text, bodyWidth);
  // Clipping styled text inserts a full reset, which would punch through selectedBg.
  // Plain text keeps one background wrap across the whole row.
  if (body.includes("\x1b[0m") || body.includes("\x1b[49m")) body = fit(stripVTControlCharacters(text), bodyWidth);
  const marker = th.fg(focused ? "text" : "muted", "›");
  const painted = th.style(body, { fg: "text", bold: focused });
  return th.style(`${marker} ${painted}`, { bg: "selectedBg" });
}

/** Viewport over sectioned rows; callers supply only the item renderer. */
export function sectionedViewport<T extends { section?: string }>(th: Theme, title: string, items: readonly T[],
  selectedIndex: number, columns: number, rowCount: number,
  render: (item: T, index: number) => string): string[] {
  const rows: (string | number)[] = [];
  let current: string | undefined;
  items.forEach((item, index) => {
    const next = item.section;
    if (next && next !== current) rows.push(next);
    current = next;
    rows.push(index);
  });
  const selectedRowIndex = Math.max(0, rows.indexOf(selectedIndex));
  return viewport(th, title, selectedIndex, items.length, selectedRowIndex, rows.length, columns, rowCount, index => {
    const row = rows[index]!;
    return typeof row === "string" ? sectionRow(th, row) : render(items[row]!, row);
  });
}

/** Keep the highest-priority lines that fit, in their original order. */
export function priorityLines(items: { text: string; priority: number }[], height: number): string[] {
  return items.map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, Math.max(0, height))
    .sort((a, b) => a.index - b.index)
    .map(({ text }) => text);
}

export const cycle = (index: number, step: number, total: number) => (index + step + total) % total;
export type PanelAction = { key: string; label: string; matches: (data: string) => boolean; run: (data: string) => void; hint: number; repeatable?: boolean; optional?: boolean };

/** Build footer hints from the same actions that handle input. */
export function footerHints(th: Theme, actions: readonly PanelAction[], columns: number): string {
  const chip = (text: string) => th.style(` ${text} `, { fg: "accent", bg: "userMessageBg" });
  const visible = [...actions].filter(({ key }) => key !== "—").sort((a, b) => a.hint - b.hint);
  const required = visible.filter(action => !action.optional);
  const labeled = (list: PanelAction[]) => list.map(({ key, label }) => `${chip(key)} ${th.fg("muted", label)}`).join("   ");
  const chips = (list: PanelAction[]) => list.map(({ key }) => chip(key)).join(" ");
  const variants = [labeled(visible), ...(required.length < visible.length ? [labeled(required)] : []), chips(visible), ...(required.length < visible.length ? [chips(required)] : [])];
  return variants.find(text => visibleWidth(text) <= columns) ?? (required.length < visible.length ? required : visible).map(({ key }) => key).join(" ");
}

export function panelAction(key: string, label: string, hint: number, matches: PanelAction["matches"], run: PanelAction["run"], repeatable = false): PanelAction {
  return { key, label, hint, matches, run, repeatable };
}

export type PanelKeys = Pick<KeybindingsManager, "matches" | "getKeys" | "getUserBindings">;
const KEY_LABELS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", enter: "Enter", space: "Space", tab: "Tab" };
// Last resort when every standard candidate is shadowed by navigation or cancel. These chords are
// rarely bound; the footer shows them like any other hint, so the panel never loses Save or Open.
const LAST_RESORT_CONFIRM = "ctrl+enter";
const LAST_RESORT_OPEN = "ctrl+right";

function matchesBinding(data: string, key: string): boolean {
  const id = canonicalKey(key);
  return id !== undefined && matchesKey(data, id);
}

/** Host keybindings decoded once for both panels' actions and hints. */
export function selectionKeys(keys: PanelKeys) {
  const bindings = {
    up: keys.getKeys("tui.select.up"), down: keys.getKeys("tui.select.down"),
    confirm: keys.getKeys("tui.select.confirm"), cancel: keys.getKeys("tui.select.cancel").filter(key => key !== "ctrl+c"),
  };
  const label = (id: keyof typeof bindings) => bindings[id].map(key => KEY_LABELS[key] ?? shortcutLabel(key)).join("/");
  const up = label("up"), down = label("down");
  const nav = [...bindings.up, ...bindings.down];
  const back = ["left", "escape", "ctrl+c", ...bindings.cancel];
  const occupied = [...nav, ...back];
  const free = (key: string) => !keyTaken(key, occupied);
  const isNav = (data: string) => keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down");
  const explicitConfirm = keys.getUserBindings()["tui.select.confirm"] !== undefined;
  const explicitKeys = explicitConfirm ? bindings.confirm : [];
  const choose = (preferred: string[], fallback: string[], last: string) => {
    const primary = [...new Set(preferred)].filter(free);
    if (primary.length) return primary;
    const next = fallback.filter(free);
    return next.length ? next : [last].filter(free);
  };
  const confirmKeys = choose([...explicitKeys, "enter", "space"], ["tab"], LAST_RESORT_CONFIRM);
  const openKeys = choose(["right", ...explicitKeys, "enter"], ["space", "tab"], LAST_RESORT_OPEN);
  // Removal keeps its own key even when a nav binding shares a legacy byte (Ctrl+H vs Backspace).
  const named = (key: string, list: readonly string[]) => list.some(binding => sameKeyName(key, binding));
  const removeKeys = ["delete", "backspace"].filter(key => !named(key, occupied) && !named(key, explicitKeys));
  const shown = (key: string | undefined) => key ? (KEY_LABELS[key] ?? shortcutLabel(key)) : "—";
  const leftTaken = nav.some(key => canonicalKey(key) === canonicalKey("left"));
  const cancel = (data: string) => matchesKey(data, "escape") || keys.matches(data, "tui.select.cancel");
  return {
    nav: up === "↑" && down === "↓" ? "↑↓" : `${up || "—"}/${down || "—"}`,
    confirm: shown(confirmKeys[0]),
    backLabel: leftTaken ? (label("cancel") || "Esc") : "←",
    confirmKeys,
    confirmUnavailable: confirmKeys.length === 0,
    openUnavailable: openKeys.length === 0,
    openLabel: shown(openKeys[0]),
    cancel: label("cancel") || "Esc",
    matchesUp: (data: string) => keys.matches(data, "tui.select.up"),
    matchesDown: (data: string) => keys.matches(data, "tui.select.down"),
    matchesCancel: cancel,
    open: (data: string) => !isNav(data) && openKeys.some(key => matchesBinding(data, key)),
    confirms: (data: string) => !isNav(data) && confirmKeys.some(key => matchesBinding(data, key)),
    back: (data: string) => cancel(data) || (!leftTaken && matchesKey(data, "left")),
    remove: removeKeys,
    removeLabel: removeKeys[0] === "delete" ? "Del" : removeKeys[0] === "backspace" ? "Backspace" : undefined,
  };
}

export type SelectionKeys = ReturnType<typeof selectionKeys>;

export function moveAction(controls: SelectionKeys, hint: number, run: (step: number) => void, repeatable = false): PanelAction {
  return panelAction(controls.nav, "Move", hint,
    data => controls.matchesUp(data) || controls.matchesDown(data),
    data => run(controls.matchesUp(data) ? -1 : 1), repeatable);
}
