import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";
import { fit, sectionRow, viewport } from "./picker-frame.ts";
import { keysOverlap, parseShortcut, shortcutLabel } from "./shortcuts.ts";

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
  const marker = selected ? th.fg(focused ? "text" : "muted", "›") : " ";
  const body = fit(text, Math.max(0, columns - 2));
  const painted = selected ? th.style(body, { fg: "text", bold: focused }) : body;
  const row = marker + " " + painted;
  if (!selected) return row;
  const paintedRow = th.style(row, { bg: "selectedBg" });
  const bg = typeof th.getBgAnsi === "function" ? th.getBgAnsi("selectedBg") : "";
  return bg ? paintedRow.replaceAll("\x1b[0m", `\x1b[0m${bg}`) : paintedRow;
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

/** Host keybindings decoded once for both panels' actions and hints. */
export function selectionKeys(keys: PanelKeys) {
  const bindings = {
    up: keys.getKeys("tui.select.up"), down: keys.getKeys("tui.select.down"),
    confirm: keys.getKeys("tui.select.confirm"), cancel: keys.getKeys("tui.select.cancel").filter(key => key !== "ctrl+c"),
  };
  const label = (id: keyof typeof bindings) => bindings[id].map(key => KEY_LABELS[key] ?? shortcutLabel(key)).join("/");
  const up = label("up"), down = label("down");
  const isNav = (data: string) => keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down");
  const overlaps = (key: string, id: keyof typeof bindings) => bindings[id].some(binding => keysOverlap(key, binding));
  const navClash = (key: string) => overlaps(key, "up") || overlaps(key, "down");
  const backClash = (key: string) => key === "left" || key === "escape" || key === "ctrl+c" || overlaps(key, "cancel");
  const aliases: Record<string, string> = { return: "enter", esc: "escape", del: "delete", ins: "insert", pgup: "pageup", pgdn: "pagedown", "ctrl+i": "tab", "ctrl+m": "enter", "ctrl+[": "escape" };
  const normalize = (key: string) => {
    const alias = aliases[key.toLowerCase()] ?? key.toLowerCase();
    const parsed = parseShortcut(alias);
    return typeof parsed === "string" ? parsed : alias;
  };
  const navNames = new Set<string>([...bindings.up, ...bindings.down].map(normalize));
  const backNames = new Set<string>(["left", "escape", ...bindings.cancel, "ctrl+c"].map(normalize));
  const free = (key: string) => !navNames.has(normalize(key)) && !backNames.has(normalize(key)) && !navClash(key) && !backClash(key);
  const freeName = (key: string) => !navNames.has(normalize(key)) && !backNames.has(normalize(key));
  const explicitConfirm = keys.getUserBindings()["tui.select.confirm"] !== undefined;
  const explicitKeys = explicitConfirm ? bindings.confirm : [];
  const preferredConfirm = [...new Set([...explicitKeys, "enter", "space"])].filter(free);
  const fallbackConfirm = ["tab"].filter(free);
  const candidates = preferredConfirm.length ? preferredConfirm : fallbackConfirm.length ? fallbackConfirm : [LAST_RESORT_CONFIRM].filter(free);
  const confirm = (data: string) => !isNav(data) && candidates.some(key => matchesKey(data, key as KeyId));
  const winningConfirm = candidates[0];
  const confirmLabel = winningConfirm ? (KEY_LABELS[winningConfirm] ?? shortcutLabel(winningConfirm)) : "—";
  const removeKeys = ["delete", "backspace"].filter(freeName).filter(key => !explicitKeys.some(explicit => normalize(explicit) === normalize(key)));
  const preferredOpen = [...new Set(["right", ...explicitKeys, "enter"])].filter(free);
  const fallbackOpen = ["space", "tab"].filter(free);
  const openCandidates = preferredOpen.length ? preferredOpen : fallbackOpen.length ? fallbackOpen : [LAST_RESORT_OPEN].filter(free);
  const openKey = openCandidates[0];
  const removeKey = removeKeys[0];
  const cancel = (data: string) => matchesKey(data, "escape") || keys.matches(data, "tui.select.cancel");
  return {
    nav: up === "↑" && down === "↓" ? "↑↓" : `${up || "—"}/${down || "—"}`,
    confirm: confirmLabel,
    backLabel: navNames.has("left") ? (label("cancel") || "Esc") : "←",
    confirmKeys: candidates,
    confirmUnavailable: candidates.length === 0,
    openUnavailable: openCandidates.length === 0,
    openLabel: openKey ? (KEY_LABELS[openKey] ?? shortcutLabel(openKey)) : "—",
    cancel: label("cancel") || "Esc",
    matchesUp: (data: string) => keys.matches(data, "tui.select.up"),
    matchesDown: (data: string) => keys.matches(data, "tui.select.down"),
    matchesCancel: cancel,
    open: (data: string) => !isNav(data) && openCandidates.some(key => matchesKey(data, key as KeyId)),
    confirms: confirm,
    back: (data: string) => cancel(data) || (!navNames.has("left") && matchesKey(data, "left")),
    remove: removeKeys,
    removeLabel: removeKey === "delete" ? "Del" : removeKey === "backspace" ? "Backspace" : undefined,
  };
}

export type SelectionKeys = ReturnType<typeof selectionKeys>;

export function moveAction(controls: SelectionKeys, hint: number, run: (step: number) => void, repeatable = false): PanelAction {
  return panelAction(controls.nav, "Move", hint,
    data => controls.matchesUp(data) || controls.matchesDown(data),
    data => run(controls.matchesUp(data) ? -1 : 1), repeatable);
}
