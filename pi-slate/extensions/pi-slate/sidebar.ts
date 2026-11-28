import type { Theme, ToolExecutionEndEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type OverlayHandle, type OverlayOptions, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { clampSidebarColumns, dashboardColumnWidth, formatCompactTokenCount, isSidebarResizeHandle, parseSidebarPercent, sidebarHandleColumn, sidebarPercentFromColumns, SIDEBAR_HIDDEN } from "./layout.ts";
import { installSidebarSplit, type SidebarSplitLease } from "./sidebar-split.ts";
import { mcpAge, mcpDetails } from "./sidebar-mcp.ts";
import { McpActivity, mcpServer } from "./mcp-activity.ts";
import { WAVE_STEP_MS } from "./working-wave.ts";
import type { WorkspaceView } from "./workspace.ts";
import { chromePaint } from "./composer.ts";
import { DEFAULT_SIDEBAR_FOLDS, sidebarCacheHit, sidebarText, sidebarUsage, type SidebarFolds, type SidebarResources, type SidebarSession } from "./sidebar-data.ts";
import { sessionSidebarSlots, sidebarCost, sidebarDuration, sidebarListOffset, type SidebarTier } from "./sidebar-layout.ts";
import { contextRows, formatCacheHit, formatCountdown, formatRate, perfRows, type PerfInput } from "./perf-graphics.ts";
import { EMPTY_PERF } from "./perf-stats.ts";
import { sameLines } from "./render-lines.ts";

export const DOUBLE_CLICK_MS = 400;
const MCP_HINT_MS = 3_000;
const MCP_SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
type ListName = "mcp" | "skills" | "prompts";
type Row = { divider?: boolean; text: string; action?: () => void; list?: ListName; item?: number; wakeAt?: number; extra?: Array<{ x0: number; x1: number; action: () => void }> };
type Hit = { y: number; x0: number; x1: number; action: () => void };
type PaneFrame = {
  key?: string;
  lines: string[];
  hits: Hit[];
  listRows: Array<{ y: number; list: ListName }>;
  middle: { start: number; height: number; rows: number };
  image: { start: number; height: number; path?: string };
  wakeAt?: number;
};
const HEADER_GAP: Row = { text: "" };
export type SidebarActions = {
  copy(text: string): void;
  openFile(filePath: string): void;
  inspect?(title: string, text: string): void;
  persistWidth?(percent: number | undefined): void;
  persistFold?(section: keyof SidebarFolds, expanded: boolean): SidebarFolds | undefined;
};
const EMPTY_SESSION: SidebarSession = {
  id: "", name: "", pid: process.pid, cwd: "", model: "—", thinking: "—", tokens: null,
  percent: null, contextWindow: null, estimated: false, rate: null, startedAt: 0,
  lastTurnMs: null, working: false, turns: 0, messages: 0,
  usage: sidebarUsage([]),
  perf: EMPTY_PERF,
};
const EMPTY_RESOURCES: SidebarResources = { skills: [], commands: [], prompts: [], mcp: [] };

/** One session rail; plain facts in, theme-aware bounded rows and matching hit regions out. */
export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private themeProvider?: () => Theme | undefined;
  private splitDispose?: SidebarSplitLease;
  private guideHandle?: OverlayHandle;
  private guideOptions?: OverlayOptions;
  private resizing = false;
  private resizeStartScreenX = 0;
  private resizeStartWidth = 0;
  private _preferredWidth?: number;
  hidden = false;
  get splitActive(): boolean { return this.splitDispose?.active() === true; }
  private session: SidebarSession = EMPTY_SESSION;
  private resources: SidebarResources = EMPTY_RESOURCES;
  private folds: SidebarFolds = { ...DEFAULT_SIDEBAR_FOLDS };
  private offsets: Record<ListName, number> = { mcp: 0, skills: 0, prompts: 0 };
  private middleOffset = 0;
  private painted?: PaneFrame;
  private image?: WorkspaceView;
  private lastClick?: { target: string; at: number };
  private cached?: PaneFrame;
  private revision = 0;
  private actions?: SidebarActions;
  private readonly mcpActivity = new McpActivity();
  private mcpWake?: ReturnType<typeof setTimeout>;
  private mcpWakeAt?: number;
  private mcpHint?: { server: string; at: number };

  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  requireTheme(): Theme {
    const theme = this.themeProvider?.() ?? this.theme;
    if (!theme) throw new Error("sidebar is not attached");
    return theme;
  }
  setThemeProvider(provider: () => Theme | undefined): void { this.themeProvider = provider; this.invalidate(); }
  attach(tui: TUI, theme: Theme, onYield?: () => void, onViewRenderFault?: () => void): void {
    this.tui = tui; this.theme = theme;
    if (this.splitActive) return;
    this.splitDispose = installSidebarSplit(tui, this, () => this.hidden ? SIDEBAR_HIDDEN : this._preferredWidth, () => {
      this.splitDispose = undefined;
      this.hideResizeGuide(); this.resizing = false; this.painted = undefined;
      onYield?.();
    }, onViewRenderFault);
    this.invalidate();
  }
  isVisible(columns: number, rows: number): boolean { return this.splitActive && !this.hidden && dashboardColumnWidth(columns, rows, this._preferredWidth) > 0; }
  ownsFocus(component: Component): boolean { return component === this || this.splitDispose?.ownsFocus(component) === true; }
  /** Scoped cooperative conversation surface; sidebar and underlying chat remain intact. */
  replaceChat(view: Component): (() => void) | undefined {
    return this.splitDispose?.replaceChat(view);
  }
  get preferredWidth(): number | undefined { return this._preferredWidth; }
  setPreferredWidth(width: number | undefined): void {
    const next = width === undefined ? undefined : parseSidebarPercent(width);
    if (next === this._preferredWidth) return;
    const previousWidth = this.displayedWidth();
    this._preferredWidth = next;
    if (this.displayedWidth() !== previousWidth) this.splitDispose?.requestRender("layout");
  }
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (hidden) this.stopMcpWake();
    this.splitDispose?.requestRender("forced-layout");
  }
  setActions(actions: SidebarActions): void { this.actions = actions; }
  mcpCallStarted(toolCallId: string, toolName: string, tools: () => readonly ToolInfo[]): void {
    const server = mcpServer(toolName, tools);
    if (server === undefined) return;
    this.mcpActivity.start(toolCallId, server);
    this.revision++;
  }
  mcpCallEnded(event: ToolExecutionEndEvent, aborted: boolean): void {
    if (this.mcpActivity.end(event, aborted, this.now())) this.revision++;
  }
  setSession(session: SidebarSession): void {
    // Keep the full plain-text title for copying/details; truncate only its painted row.
    this.session = { ...session, name: sidebarText(session.name, Infinity), usage: { ...session.usage } };
    this.changed();
  }
  setResources(resources: SidebarResources): void {
    this.resources = { ...resources, mcp: resources.mcp.map(x => ({ ...x })), skills: resources.skills.map(x => ({ ...x })), commands: resources.commands.map(x => ({ ...x })), prompts: resources.prompts.map(x => ({ ...x })) };
    this.changed();
  }
  setFolds(folds: SidebarFolds): void { this.folds = { ...folds }; this.changed(); }
  getFolds(): SidebarFolds { return { ...this.folds }; }
  toggleSection(section: keyof SidebarFolds): void {
    const expanded = !this.folds[section];
    const next = this.actions?.persistFold
      ? this.actions.persistFold(section, expanded) : { ...this.folds, [section]: expanded };
    if (next) this.setFolds(next);
  }
  /** A new session cannot inherit scroll positions, selected images, or old hit targets. */
  reset(): void {
    this.stopMcpWake(); this.mcpActivity.reset();
    this.session = EMPTY_SESSION; this.resources = EMPTY_RESOURCES;
    this.offsets = { mcp: 0, skills: 0, prompts: 0 }; this.middleOffset = 0;
    this.image = undefined; this.mcpHint = undefined;
    this.painted = undefined; this.lastClick = undefined; this.changed();
  }
  /** The image shelf follows the caret: an image token shows it, leaving the token clears it. */
  setView(view: WorkspaceView | undefined): void {
    if (view && !view.id.startsWith("image:")) return;
    this.image = view; this.changed();
  }
  currentViewId(): string | undefined { return this.image?.id; }
  sessionDetails(): string {
    const s = this.session;
    const hit = formatCacheHit(sidebarCacheHit(s.usage));
    return [`Session ${sidebarText(s.id) || "—"} · PID ${s.pid}`, `Title: ${s.name || "—"}`, `Model: ${s.model} · ${s.thinking}`,
      `Context: ${formatCompactTokenCount(s.tokens)} / ${formatCompactTokenCount(s.contextWindow)}${s.estimated ? " (estimated)" : ""}`,
      `Wall time (this runtime): ${sidebarDuration(s.startedAt > 0 ? this.now() - s.startedAt : null)}`,
      `Last turn: ${sidebarDuration(s.lastTurnMs)}`, `Turns: ${s.turns} · Messages: ${s.messages}`,
      `Active-branch usage:`, `Input (uncached + cache read + cache write): ${formatCompactTokenCount(s.usage.input)}`,
      `Output: ${formatCompactTokenCount(s.usage.output)} · Total: ${formatCompactTokenCount(s.usage.total)}`,
      `Cache read: ${formatCompactTokenCount(s.usage.cacheRead)} · Cache write: ${formatCompactTokenCount(s.usage.cacheWrite)}`,
      `Uncached input: ${formatCompactTokenCount(s.usage.uncached)} · Cache-hit share: ${hit}`,
      `Cost: ${s.usage.cost === null ? "—" : `$${s.usage.cost.toFixed(2)}`}`, `Estimated rate: ${s.rate === null ? "—" : `~${Math.round(s.rate)} tokens/sec`}`, s.cwd, ...this.speedCacheDetails()].join("\n");
  }
  private speedCacheDetails(): string[] {
    const perf = this.session.perf;
    const c = perf.cache;
    return ["", "Speed & cache",
      `Speed is output tokens ÷ Pi's recorded provider-stream duration, not total turn time.`,
      `Replies with less than 32 output tokens, less than 300 ms, or missing timing are excluded from speed.`,
      `The composer's live rate is an estimate (visible text ÷ 4) and is marked ~.`,
      `Timed replies: ${perf.timedReplies} · last timed reply: ${formatRate(perf.rates.at(-1))} tok/s · peak: ${formatRate(perf.peak)} tok/s · this turn: ${formatRate(perf.turn.rate)} tok/s`,
      `Cache hit % = cache read ÷ (uncached + cache read + cache write); latest request ${formatCacheHit(c.lastHit)}.`];
  }
  tick(): void { this.refresh(); }
  private stopMcpWake(): void {
    clearTimeout(this.mcpWake);
    this.mcpWake = undefined;
    this.mcpWakeAt = undefined;
  }
  private scheduleMcpWake(wakeAt: number | undefined): void {
    if (wakeAt === this.mcpWakeAt) return;
    this.stopMcpWake();
    if (wakeAt === undefined) return;
    this.mcpWakeAt = wakeAt;
    this.mcpWake = setTimeout(() => {
      this.mcpWake = undefined; this.mcpWakeAt = undefined;
      if (this.splitActive) this.tick();
    }, Math.max(0, wakeAt - this.now()));
    this.mcpWake.unref?.();
  }
  invalidate(): void {
    if (this.cached) this.cached.key = undefined;
    this.image?.invalidate();
  }
  private changed(): void { this.revision++; this.refresh(); }
  private refresh(): void {
    const split = this.splitDispose;
    if (!split?.active()) return;
    const width = this.displayedWidth();
    if (width > 0) {
      const previous = this.cached;
      const next = this.buildFrame(width);
      this.scheduleMcpWake(next.wakeAt);
      if (this.painted && sameLines(this.painted.lines, next.lines)) {
        // Identical rows can take newer details without a host frame.
        this.painted = next;
      } else if (!previous || !sameLines(previous.lines, next.lines)) {
        split.requestRender("pane");
        return;
      }
    } else this.scheduleMcpWake(undefined);
    split.retryRender();
  }

  handleSplitMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const sidebarWidth = this.displayedWidth(event.width);
    if (sidebarWidth <= 0) return undefined;
    const divider = event.width - sidebarWidth;
    return this.handleResizeMouse(event, event.x >= divider - 1 && event.x <= divider + 1);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const resize = this.handleResizeMouse(event, isSidebarResizeHandle(event));
    if (resize) return resize;
    const frame = this.painted;
    if (!frame) return undefined;
    if (event.type === "wheel") {
      const delta = -(event.wheelDelta ?? 0);
      const list = frame.listRows.find(row => row.y === event.y)?.list;
      if (list && this.scrollList(list, delta)) return { handled: true, render: false };
      const { start, height, rows } = frame.middle;
      if (event.y >= start && event.y < start + height) {
        const next = sidebarListOffset(this.middleOffset + delta, rows, height);
        if (next !== this.middleOffset) { this.middleOffset = next; this.changed(); }
        return { handled: true, render: false };
      }
      return undefined;
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const hit = frame.hits.find(hit => hit.y === event.y && event.x >= hit.x0 && event.x < hit.x1);
    if (hit) { hit.action(); return { handled: true, render: false }; }
    const { start, height, path } = frame.image;
    if (event.y > start && event.y < start + height) {
      if (path && this.isDoubleClick(event, `image:${path}`)) {
        this.actions?.openFile(path); return { handled: true, render: false };
      }
    }
    return undefined;
  }

  render(width: number): string[] {
    const height = Math.max(0, this.tui?.terminal.rows ?? 1);
    if (width <= 0) {
      this.painted = undefined;
      this.scheduleMcpWake(undefined);
      return Array.from({ length: height }, () => "");
    }
    const frame = this.buildFrame(width, height);
    this.painted = frame;
    this.scheduleMcpWake(frame.wakeAt);
    return frame.lines;
  }

  private buildFrame(width: number, height = Math.max(0, this.tui?.terminal.rows ?? 1)): PaneFrame {
    const theme = this.themeProvider?.() ?? this.theme;
    if (theme !== this.theme) { this.theme = theme; this.invalidate(); }
    if (theme) this.image?.setTheme?.(theme);
    const now = this.now();
    const key = `${width}:${height}:${this.revision}:${Math.floor(now / 1000)}`;
    if (this.cached?.key === key && (this.cached.wakeAt === undefined || now < this.cached.wakeAt)) return this.cached;
    const hits: Hit[] = [], listRows: PaneFrame["listRows"] = [];
    let wakeAt: number | undefined;
    const inner = Math.max(0, width - 4);
    const header = this.headerRows(inner, height >= 44 ? "full" : "compact");
    const gap = (row: Row): boolean => row === HEADER_GAP || row.divider === true;
    const gaps = header.filter(gap).length;
    const slots = sessionSidebarSlots(height, header.length, Boolean(this.image), gaps);
    let dropGaps = header.length - slots.header;
    const lines: string[] = [];
    const add = (row: Row): void => {
      const y = lines.length;
      lines.push(row.divider ? this.dividerLine(width, "├") : this.decorateLine(row.text, width));
      if (inner > 0) for (const e of row.extra ?? []) hits.push({ y, x0: 2 + e.x0, x1: 2 + e.x1, action: e.action });
      if (row.action && inner > 0) hits.push({ y, x0: 2, x1: width - 2, action: row.action });
      if (row.list) listRows.push({ y, list: row.list });
      if (row.wakeAt !== undefined && (wakeAt === undefined || row.wakeAt < wakeAt)) wakeAt = row.wakeAt;
    };
    if (slots.frame) lines.push(this.dividerLine(width, "┌"));
    for (const row of header.filter(row => !gap(row) || dropGaps-- <= 0).slice(0, slots.header)) add(row);
    const middle = this.middle(inner, now);
    const middleStart = lines.length;
    this.middleOffset = sidebarListOffset(this.middleOffset, middle.length, slots.middle);
    for (let i = 0; i < slots.middle; i++) add(middle[this.middleOffset + i] ?? { text: "" });
    const imageStart = lines.length;
    const image = this.image;
    lines.push(...this.imageLines(width, slots.image, imageStart, hits, image));
    if (slots.frame) lines.push(this.dividerLine(width, "└"));
    return this.cached = {
      key, lines: lines.slice(0, height), hits, listRows, wakeAt,
      middle: { start: middleStart, height: slots.middle, rows: middle.length },
      image: { start: imageStart, height: slots.image, path: image?.filePath },
    };
  }

  private headerRows(width: number, tier: SidebarTier): Row[] {
    const s = this.session;
    const percent = s.percent !== null && Number.isFinite(s.percent) ? s.percent : null;
    const branchUsage = () => this.actions?.inspect?.("Branch usage", this.sessionDetails());
    const name = s.name || "";
    const shortId = sidebarText(s.id).slice(0, 8) || "—";
    const idWidth = visibleWidth(shortId);
    const showId = width >= idWidth + 13;
    const copyName = () => { if (s.name) this.actions?.copy(s.name); };
    const copyId = () => { if (s.id) this.actions?.copy(s.id); };
    const status: Row = (() => {
      const turns = s.turns === 1 ? "1 turn" : `${s.turns} turns`;
      const left = s.working
        ? this.paint("success", "● Working")
        : this.paint("dim", "○ Idle") + (s.turns > 0 ? this.paint("muted", ` · ${turns}`) : "");
      const started = s.turnStartedAt;
      const timing = s.working
        ? typeof started === "number" && Number.isFinite(started) ? this.paint("warning", formatCountdown(Math.max(0, this.now() - started))) : ""
        : s.lastTurnMs !== null ? this.paint("dim", `last ${sidebarDuration(s.lastTurnMs)}`) : "";
      const cost = s.usingOAuth ? "—" : sidebarCost(s.usage.cost);
      const spend = cost === "—" || cost === "$0.00" ? "" : this.paint("text", cost);
      let right = spend || timing;
      if (spend && timing) {
        const both = spend + this.paint("dim", " · ") + timing;
        // Preserve the status label when adding spend, and prioritize the live clock over spend.
        right = visibleWidth(left) + 1 + visibleWidth(both) <= width ? both : s.working ? timing : spend;
      }
      return { text: this.pair(left, right, width) };
    })();
    const identity: Row = {
      text: this.pair(this.heading(name || "Session", name ? "accent" : "mdHeading"), showId ? this.paint("dim", shortId) : "", width),
      action: name ? copyName : undefined,
      extra: showId ? [{ x0: width - idWidth, x1: width, action: copyId }] : undefined,
    };
    const model: Row = { text: this.pair(this.paint("text", sidebarText(s.model)), this.paint("dim", sidebarText(s.thinking)), width) };
    const divider: Row = { text: "", divider: true };
    const input: PerfInput = { perf: s.perf, usage: s.usage, inner: width, tier, paint: (t, x) => this.paint(t, x), heading: x => this.heading(x) };
    const context: Row[] = contextRows(input, { percent, tokens: s.tokens, window: s.contextWindow, estimated: s.estimated })
      .map(text => ({ text, action: branchUsage }));
    const performance = perfRows(input).flat().map(text => text === null ? HEADER_GAP : { text });
    return [status, identity, model, HEADER_GAP, ...context, HEADER_GAP, ...performance, divider];
  }
  private middle(width: number, now: number): Row[] {
    const enabled = this.resources.mcp.filter(x => x.enabled === true).length;
    const unknownCount = this.resources.mcp.filter(x => x.enabled === null).length;
    const errors = this.resources.mcpError ? 1 : 0;
    const allUnknown = unknownCount > 0 && unknownCount === this.resources.mcp.length;
    const loaded = this.resources.skills.filter(x => x.loaded).length;
    const resourceHeading = (label: string, count: string, failed = 0): string =>
      this.heading(label) + this.paint("muted", ` · ${count}`)
      + (failed ? this.paint("error", ` · ${failed} ${failed === 1 ? "Error" : "Errors"}`) : "");
    const rows: Row[] = [{ text: "" }, {
      text: resourceHeading(`${this.folds.mcp ? "⌄" : "›"} MCP`, allUnknown || (!errors && unknownCount > 0) ? "—" : `${enabled} Enabled`, errors),
      action: () => this.toggleSection("mcp"),
    }];
    if (this.folds.mcp) rows.push(...this.mcpRows(width, now));
    rows.push({ text: "" }, { text: resourceHeading(`${this.folds.skills ? "⌄" : "›"} Skills`, `${loaded} Loaded`), action: () => this.toggleSection("skills") });
    if (this.folds.skills) rows.push(...this.resourceRows("skills"));
    rows.push({ text: "" }, { text: resourceHeading(`${this.folds.prompts ? "⌄" : "›"} Prompts`, `${this.resources.prompts.length}`), action: () => this.toggleSection("prompts") });
    if (this.folds.prompts) rows.push(...this.resourceRows("prompts"));
    return rows;
  }
  private mcpRows(width: number, now: number): Row[] {
    const items = this.resources.mcp;
    const visible = 5;
    this.offsets.mcp = sidebarListOffset(this.offsets.mcp, items.length, visible);
    if (!items.length) return [{ text: this.paint("dim", "none"), list: "mcp" }];
    const start = this.offsets.mcp;
    const rows: Row[] = [];
    for (let i = start; i < Math.min(items.length, start + visible); i++) {
      const server = items[i]!;
      const activity = this.mcpActivity.view(server.name, now);
      const hintUntil = this.mcpHint?.server === server.name ? this.mcpHint.at + MCP_HINT_MS : undefined;
      // Activity shares one status column between the config glyph and the name.
      const status = activity.active
        ? `${this.paint("accent", MCP_SPINNER[Math.floor(now / WAVE_STEP_MS) % MCP_SPINNER.length]!)} `
        : activity.warning ? `${this.paint("warning", "!")} ` : "";
      const glyph = server.enabled === null ? "—" : server.enabled ? "●" : "○";
      const fullName = sidebarText(server.name);
      const room = width - visibleWidth(glyph) - 1 - visibleWidth(status);
      // The hint only uses spare columns; it never truncates the server name (details carry it too).
      const usedHint = hintUntil !== undefined && now < hintUntil
        ? activity.lastUsed === null ? "not used yet" : `used ${mcpAge(now - activity.lastUsed)} ago` : "";
      const hint = usedHint && visibleWidth(fullName) + 1 + visibleWidth(usedHint) <= room ? usedHint : "";
      const name = truncateToWidth(fullName, Math.max(0, room), "…");
      const tone = server.enabled === true ? "muted" : "dim";
      const left = `${this.paint(tone, `${glyph} `)}${status}${this.paint(tone, name)}`;
      const wakes: number[] = [];
      if (activity.active) wakes.push((Math.floor(now / WAVE_STEP_MS) + 1) * WAVE_STEP_MS);
      if (activity.warning && activity.warnUntil !== null) wakes.push(activity.warnUntil);
      if (hint && hintUntil !== undefined) wakes.push(hintUntil);
      const wakeAt = wakes.length > 0 ? Math.min(...wakes) : undefined;
      rows.push({ text: hint ? this.pair(left, this.paint("dim", hint), width) : left, list: "mcp", item: i, wakeAt,
        action: () => {
          const current = this.resources.mcp.find(item => item.name === server.name) ?? server;
          const at = this.now();
          this.mcpHint = { server: current.name, at };
          this.changed();
          this.actions?.inspect?.(current.name, mcpDetails(current, this.mcpActivity.view(current.name, at), at));
        } });
    }
    return rows;
  }
  private resourceRows(list: "skills" | "prompts"): Row[] {
    const items = this.resources[list];
    const visible = 3;
    this.offsets[list] = sidebarListOffset(this.offsets[list], items.length, visible);
    if (!items.length) return [{ text: this.paint("dim", list === "skills" ? "No skill catalog available" : "none"), list }];
    const start = this.offsets[list];
    const rows: Row[] = [];
    for (let i = start; i < Math.min(items.length, start + visible); i++) {
      if (list === "skills") {
        const skill = this.resources.skills[i]!;
        rows.push({ text: this.paint(skill.loaded ? "muted" : "dim", `${skill.loaded ? "●" : "○"} ${sidebarText(skill.name)}`), list, item: i,
          action: () => this.actions?.inspect?.(skill.name, `${skill.loaded ? "Instructions observed loaded on this branch" : "Available; instructions not observed loaded"}\nSource: ${skill.source}\n${skill.path}`) });
      } else {
        const prompt = this.resources.prompts[i]!;
        // Name only: the source column repeated "prompt" on every row.
        rows.push({ text: this.paint("muted", sidebarText(prompt.name)), list, item: i,
          action: () => this.actions?.inspect?.(prompt.name, `${prompt.description || "No description"}\nSource: ${prompt.source}\nInvoke as /${prompt.name}`) });
      }
    }
    return rows;
  }
  private imageLines(width: number, height: number, start: number, hits: Hit[], view?: WorkspaceView): string[] {
    if (height <= 0 || !view) return [];
    const inner = Math.max(0, width - 4);
    const lines = [this.decorateLine(this.heading("Preview"), width)];
    if (height === 1) return lines;
    const controls: Array<{ label: string; action: () => void }> = [
      { label: "[open]", action: () => { if (view.filePath) this.actions?.openFile(view.filePath); } },
      { label: "[copy]", action: () => { if (view.filePath) this.actions?.copy(view.filePath); } },
    ];
    while (visibleWidth(controls.map(x => x.label).join(" ")) > inner && controls.length > 1) controls.splice(1, 1);
    const bodyHeight = Math.max(0, height - 2);
    if (bodyHeight && inner) lines.push(...view.render(inner, bodyHeight).slice(0, bodyHeight).map(line => this.decorateLine(line, width)));
    while (lines.length < height - 1) lines.push(this.decorateLine("", width));
    const actions = controls.map(x => x.label).join(" ");
    let x = 2;
    if (inner >= visibleWidth(actions)) for (const control of controls) {
      hits.push({ y: start + height - 1, x0: x, x1: x + visibleWidth(control.label), action: control.action });
      x += visibleWidth(control.label) + 1;
    }
    lines.push(this.decorateLine(this.paint("muted", actions), width));
    return lines.slice(0, height);
  }
  private scrollList(list: ListName, delta: number): boolean {
    const visible = list === "mcp" ? 5 : 3;
    const next = sidebarListOffset(this.offsets[list] + delta, this.resources[list].length, visible);
    if (next === this.offsets[list]) return false;
    this.offsets[list] = next; this.changed(); return true;
  }
  private pair(left: string, right: string, width: number): string {
    const r = truncateToWidth(right, Math.max(0, width - 1), "…");
    const l = truncateToWidth(left, Math.max(0, width - visibleWidth(r) - 1), "…");
    return `${l}${" ".repeat(Math.max(0, width - visibleWidth(l) - visibleWidth(r)))}${r}`;
  }
  private heading(text: string, tone: "mdHeading" | "accent" = "mdHeading"): string { const painted = this.paint(tone, text); return this.theme?.bold?.(painted) ?? painted; }
  private paint(tone: "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error" | "mdHeading", text: string): string { return this.theme?.fg(tone, text) ?? text; }
  private isDoubleClick(event: TuiMouseEvent, target: string): boolean {
    if (event.clickCount !== undefined) return event.clickCount === 2;
    const at = this.now(); const previous = this.lastClick;
    const doubled = Boolean(previous && previous.target === target && at - previous.at <= DOUBLE_CLICK_MS);
    this.lastClick = doubled ? undefined : { target, at }; return doubled;
  }
  dispose(): void {
    this.hideResizeGuide(); this.resizing = false;
    this.splitDispose?.(); this.splitDispose = undefined;
    this.reset(); this.cached = undefined; this.tui = undefined; this.theme = undefined; this.themeProvider = undefined; this.actions = undefined;
  }

  private handleResizeMouse(event: TuiMouseEvent, onHandle: boolean): TuiMouseEventResult | undefined {
    if (this.resizing) {
      if (event.type === "drag" || event.type === "move") return this.moveResizeGuide(event.screenX);
      if (event.type === "release") {
        this.commitResize(event.screenX);
        return { handled: true, render: true };
      }
      if (event.type === "click") return { handled: true };
    }
    if (onHandle && event.type === "press" && event.button === "left") {
      this.beginResize(event.screenX);
      return { handled: true, capture: true, render: true };
    }
    if (onHandle && event.type === "click" && event.button === "left") return { handled: true };
    return undefined;
  }

  private displayedWidth(totalWidth = this.tui?.terminal.columns ?? 0): number {
    return dashboardColumnWidth(totalWidth, this.tui?.terminal.rows ?? 0, this.hidden ? SIDEBAR_HIDDEN : this._preferredWidth);
  }

  private beginResize(screenX: number): void {
    this.resizing = true;
    this.resizeStartScreenX = screenX;
    this.resizeStartWidth = this.displayedWidth();
    this.showResizeGuide(screenX);
  }

  private moveResizeGuide(screenX: number): TuiMouseEventResult {
    if (!this.guideOptions) {
      this.showResizeGuide(screenX);
      return { handled: true, render: true };
    }
    const col = this.guideColumn(screenX);
    if (this.guideOptions.col === col) return { handled: true, render: false };
    this.guideOptions.col = col;
    return { handled: true, render: true };
  }

  private commitResize(screenX: number): void {
    const next = this.widthFromPointer(screenX);
    this.hideResizeGuide();
    this.resizing = false;
    if (next === this.resizeStartWidth || next <= 0) return;
    const percent = sidebarPercentFromColumns(this.tui?.terminal.columns ?? 0, next);
    this.setPreferredWidth(percent);
    this.actions?.persistWidth?.(percent);
  }

  private showResizeGuide(screenX: number): void {
    if (!this.tui) return;
    const col = this.guideColumn(screenX);
    if (this.guideOptions && this.guideHandle) {
      this.guideOptions.col = col;
      return;
    }
    this.guideOptions = {
      nonCapturing: true,
      width: 1,
      minWidth: 1,
      col,
      row: 0,
      maxHeight: "100%",
    };
    this.guideHandle = this.tui.showOverlay(
      new ResizeGuide(() => this.tui?.terminal.rows ?? 1, this.theme),
      this.guideOptions,
    );
  }

  private hideResizeGuide(): void {
    this.guideHandle?.hide();
    this.guideHandle = undefined;
    this.guideOptions = undefined;
  }

  private widthFromPointer(screenX: number): number {
    const total = this.tui?.terminal.columns ?? 0;
    return clampSidebarColumns(
      total,
      this.resizeStartWidth + this.resizeStartScreenX - screenX,
    );
  }

  private guideColumn(screenX: number): number {
    const total = this.tui?.terminal.columns ?? 0;
    return sidebarHandleColumn(total, this.widthFromPointer(screenX));
  }



  private dividerLine(width: number, junction: string): string {
    if (width <= 0) return "";
    const paint = this.theme ? chromePaint(this.theme) : (text: string) => text;
    if (width === 1) return paint(junction);
    const right = junction === "┌" ? "┐" : junction === "└" ? "┘" : "┤";
    return paint(junction + "─".repeat(Math.max(0, width - 2)) + right);
  }

  private decorateLine(line: string, width: number): string {
    if (width <= 0) return "";
    const border = this.theme ? chromePaint(this.theme)("│") : "│";
    if (width === 1) return border;
    const inner = Math.max(0, width - 4);
    const image = line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
    const body = image ? line : truncateToWidth(line, inner, "…");
    // Reserve both rails and matching inner gutters, including tiny viewports.
    return border + (width >= 3 ? " " : "") + body
      + " ".repeat(Math.max(0, inner - visibleWidth(body)))
      + (width >= 4 ? " " : "") + border;
  }
}

class ResizeGuide implements Component {
  private readonly rows: () => number;
  private readonly theme?: Theme;
  constructor(rows: () => number, theme?: Theme) { this.rows = rows; this.theme = theme; }
  invalidate(): void {}
  render(): string[] { return Array.from({ length: Math.max(1, this.rows()) }, () => this.theme?.fg("accent", "│") ?? "│"); }
}
