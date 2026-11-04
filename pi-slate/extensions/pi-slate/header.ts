import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi, foregroundAnsi, rgbColor, truncateToWidth, visibleWidth, type Component, type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { paintLogo, type LogoStyle } from "./layout.ts";
import { sidebarText } from "./sidebar-data.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";
const LOGO_CELLS = 4;

type PiMarkColor = "coral" | "blue" | "yellow";

// The stock Pi mark is a 4×4 source grid. Each terminal cell carries two
// source squares as a foreground/background half-block pair.
const PI_MARK_COLORS: readonly (readonly (PiMarkColor | null)[])[] = [
  ["coral", "coral", "coral", null],
  ["blue", null, "coral", null],
  ["blue", "blue", null, "yellow"],
  ["blue", null, null, "yellow"],
];
const PI_MARK_MASK = PI_MARK_COLORS.map((row) => row.map((color) => color !== null));
const MARK_COLORS: Record<PiMarkColor, typeof CORAL> = { coral: CORAL, blue: BLUE, yellow: YELLOW };

export function supportsPiLogo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM !== "Apple_Terminal";
}

function colorMode(theme: Theme): TerminalColorMode {
  return typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
}

function renderPiMark(
  cell: (top: boolean, bottom: boolean, row: number, column: number) => string,
): [string, string] {
  const rows: string[] = [];
  for (let row = 0; row < PI_MARK_MASK.length; row += 2) {
    let line = "";
    for (let column = 0; column < (PI_MARK_MASK[row]?.length ?? 0); column++) {
      line += cell(
        PI_MARK_MASK[row]?.[column] ?? false,
        PI_MARK_MASK[row + 1]?.[column] ?? false,
        row,
        column,
      );
    }
    rows.push(line);
  }
  return [rows[0] ?? "", rows[1] ?? ""];
}

/** Stock Pi mark: the brand-colored 4×2 half-block grid. */
export function piLogoLines(theme: Theme): [string, string] {
  const mode = colorMode(theme);
  return renderPiMark((_top, _bottom, row, column) => {
    const top = PI_MARK_COLORS[row]?.[column] ?? null;
    const bottom = PI_MARK_COLORS[row + 1]?.[column] ?? null;
    if (!top && !bottom) return " ";
    if (top && bottom) {
      return top === bottom
        ? `${foregroundAnsi(MARK_COLORS[top], mode)}█${RESET}`
        : `${foregroundAnsi(MARK_COLORS[top], mode)}${backgroundAnsi(MARK_COLORS[bottom], mode)}▀${RESET}`;
    }
    const color = top ?? bottom!;
    return `${foregroundAnsi(MARK_COLORS[color], mode)}${top ? "▀" : "▄"}${RESET}`;
  });
}

/** Classic Pi mark: the same 4×2 half-block grid, painted white in every theme. */
export function piMinimalLogoLines(theme: Theme): [string, string] {
  const truecolor = colorMode(theme) === "truecolor";
  return renderPiMark((top, bottom) => {
    if (top && bottom) return paintLogo("█", truecolor);
    if (top) return paintLogo("▀", truecolor);
    if (bottom) return paintLogo("▄", truecolor);
    return " ";
  });
}

export function piWordmark(theme: Theme): string {
  const mode = colorMode(theme);
  return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}

function padLine(text: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(gap)}`;
}

function logoRow(mark: string, text: string, width: number, cells: number): string {
  const rest = truncateToWidth(text, Math.max(0, width - cells - 1), "…");
  return padLine(`${mark} ${rest}`, width);
}

function indentedLine(text: string, width: number, cells: number): string {
  return padLine(`${" ".repeat(cells + 1)}${truncateToWidth(text, Math.max(0, width - cells - 1), "…")}`, width);
}

export type HeaderIdentity = { version: string; model?: string; thinking?: string };

/** Official mark + product stack. */
export function renderSlateHeader(input: {
  width: number; path: string; identity?: HeaderIdentity;
  logo?: boolean; logoStyle?: LogoStyle; theme: Theme;
}): string[] {
  const width = Math.max(0, input.width);
  if (!width) return [];
  const version = sidebarText(input.identity?.version) || "0";
  const model = sidebarText(input.identity?.model);
  const thinking = sidebarText(input.identity?.thinking);
  const rawPath = sidebarText(input.path);
  const dir = rawPath.startsWith("/") ? basename(rawPath) : "";
  const path = dir ? `~/${dir}` : rawPath;
  const showLogo = input.logo ?? supportsPiLogo();
  const modelLine = [model, thinking].filter(Boolean).join(" · ");
  const rows: string[] = [];
  if (showLogo && width >= 12) {
    const [top, bottom] = input.logoStyle === "original"
      ? piLogoLines(input.theme)
      : piMinimalLogoLines(input.theme);
    rows.push(
      logoRow(top, input.theme.fg("text", `Pi Agent v${version}`), width, LOGO_CELLS),
      logoRow(bottom, modelLine ? input.theme.fg("muted", modelLine) : "", width, LOGO_CELLS),
      indentedLine(input.theme.fg("dim", path), width, LOGO_CELLS),
    );
  } else {
    const mark = piWordmark(input.theme);
    rows.push(padLine(truncateToWidth(`${mark} ${input.theme.fg("text", `Agent v${version}`)}`, width, "…"), width));
    if (modelLine) rows.push(padLine(truncateToWidth(input.theme.fg("muted", modelLine), width, "…"), width));
    if (path) rows.push(padLine(truncateToWidth(input.theme.fg("dim", path), width, "…"), width));
  }
  return rows;
}

export class SlateHeader implements Component {
  private readonly theme: Theme;
  private readonly getContext: () => ExtensionContext | undefined;
  private readonly columnWidth: (width: number) => number;
  private readonly getIdentity: () => HeaderIdentity;
  private readonly getLogoStyle: () => LogoStyle;
  constructor(theme: Theme, getContext: () => ExtensionContext | undefined,
    columnWidth: (width: number) => number,
    getIdentity: () => HeaderIdentity, getLogoStyle: () => LogoStyle = () => "minimal") {
    this.theme = theme; this.getContext = getContext; this.columnWidth = columnWidth;
    this.getIdentity = getIdentity;
    this.getLogoStyle = getLogoStyle;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const ctx = this.getContext();
    if (!ctx) return [];
    const identity = this.getIdentity();
    return renderSlateHeader({
      width: this.columnWidth(width), path: ctx.cwd, identity,
      theme: ctx.ui.theme ?? this.theme, logoStyle: this.getLogoStyle(),
    });
  }
}
