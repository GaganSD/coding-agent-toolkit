import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const PICKER_OVERLAY = { overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "100%", margin: 1 } } as const;

export const fit = (text: string, columns: number) => truncateToWidth(text, Math.max(0, columns), "…", true);

export function pickerGeometry(width: number, rows: number) {
  const height = Math.min(22, Math.max(1, rows - 2));
  return { height, tiny: height < 13 || width < 24, inner: width - 4, bodyHeight: height - 7 };
}

export function compactPicker(lines: string[], width: number, height: number): string[] {
  return Array.from({ length: height }, (_, i) => fit(lines[i] ?? "", width));
}

export const sectionRow = (th: Theme, label: string) => th.fg("muted", `── ${label}`);

/** A list row whose cursor stays visible in both panes: text when focused, dim when not. */
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

export function viewport(th: Theme, title: string, position: number, total: number, selectedRowIndex: number,
  rowCount: number, columns: number, rows: number, row: (index: number) => string): string[] {
  const slots = Math.max(1, rows - 1);
  const start = Math.max(0, Math.min(selectedRowIndex - Math.floor(slots / 2), rowCount - slots));
  const end = Math.min(rowCount, start + slots);
  const overflow = `${start ? ` ↑${start}` : ""}${end < rowCount ? ` ↓${rowCount - end}` : ""}`;
  return [th.fg("muted", fit(`${title} ${total ? position + 1 : 0}/${total}${overflow}`, columns)),
    ...Array.from({ length: rows - 1 }, (_, i) => start + i < end ? fit(row(start + i), columns) : fit("", columns))];
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

type Pane = (columns: number, rows: number) => string[];

export function pickerBody(th: Theme, width: number, inner: number, rows: number, first: Pane, second: Pane): string[] {
  if (width >= 68) {
    const left = Math.floor((inner - 3) * 0.48), right = inner - 3 - left;
    const a = first(left, rows), b = second(right, rows);
    return a.map((line, i) => line + th.fg("border", " │ ") + b[i]!);
  }
  const top = Math.ceil(rows / 2);
  return [...first(inner, top), ...second(inner, rows - top)];
}

export function framedPicker(th: Theme, width: number, title: string, body: string[], footer: string[],
  borderToken: "border" | "borderAccent" = "border"): string[] {
  const border = (text: string) => th.fg(borderToken, text);
  const content = [th.bold(title), "", ...body, ...footer];
  return [border(`╭${"─".repeat(width - 2)}╮`),
    ...content.map(line => border("│ ") + fit(line, width - 4) + border(" │")),
    border(`╰${"─".repeat(width - 2)}╯`)];
}
