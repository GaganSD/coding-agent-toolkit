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

export function selectedRow(th: Theme, text: string, selected: boolean, columns: number): string {
  // Accent on selectedBg drops below 3:1 on light flavors.
  const row = fit(`${selected ? "›" : " "} ${text}`, columns);
  return selected ? th.style(row, { fg: "text", bg: "selectedBg", bold: true }) : row;
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
