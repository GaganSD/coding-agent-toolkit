// Insights: a native, local-only usage dashboard. No DOM, no shell, no stored cx.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Input, InputState, Editor, EditorState, Popover } from "gpui-base";
import { exec, appHome, home, theme, settings, nextCommand, readTextFile } from "herdr";
import {
  PALETTES,
  clampRefreshSeconds,
  dayLabel,
  formatBytes,
  formatCompact,
  formatDuration,
  formatInt,
  formatTimestamp,
  initials,
  isDay,
  isPresentation,
  normalizeConfig,
  periodRange,
  projectName,
  todayKey,
  weekdayLabels,
} from "./analytics.js";
import {
  G,
  H,
  R,
  T,
  bodyText,
  button,
  card,
  cardHeader,
  controlInput,
  fieldLabel,
  iconButton,
  inset,
  metaLabel,
  mutedText,
  notice,
  pageTitle,
  segmented,
  statCell,
  stateCard,
  toggleSwitch,
  tokens,
} from "./ui.js";

const MIN_CELL = 12;
const MAX_CELL = 20;
const CELL_GAP = 2;
const DAY_LABEL_WIDTH = 30;

/**
 * Heatmap cells stay small on narrow views and grow up to MAX_CELL on wide
 * ones so the grid reads centered instead of pinned to the left edge.
 */
export function heatmapMetrics(width, weekCount) {
  const viewWidth = Number.isFinite(width) ? width : 960;
  const weeks = Math.max(1, weekCount);
  const pagePadding = (viewWidth < 620 ? G.md : viewWidth < 900 ? G.lg : G.xl) * 2;
  const available = Math.max(320, Math.min(1180, viewWidth - pagePadding) - G.lg * 2);
  const fitted = Math.floor((available - DAY_LABEL_WIDTH - (weeks - 1) * CELL_GAP) / weeks);
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, fitted));
  const weekWidth = cell + CELL_GAP;
  const contentWidth = DAY_LABEL_WIDTH + weeks * weekWidth;
  return { cell, weekWidth, contentWidth, centered: contentWidth <= available };
}

/** Categorical chart palette that reads on both dark and light themes. */
const MODEL_CHART_COLORS = ["#5b8def", "#3fb27f", "#e0a23c", "#d96c92", "#8f6fe0", "#41b3ba", "#e2704f"];
const OTHER_CHART_COLOR = "#8a8f98";
const CHART_HEIGHT = 168;

function modelChartColor(name, index) {
  if (name === "Other") return OTHER_CHART_COLOR;
  return MODEL_CHART_COLORS[index % MODEL_CHART_COLORS.length];
}

/** Bundled monochrome brand marks, tinted with the surrounding text color. */
const PROVIDER_LOGO_FILES = {
  openai: "openai.svg",
  anthropic: "anthropic.svg",
  google: "googlegemini.svg",
  gemini: "googlegemini.svg",
  deepseek: "deepseek.svg",
  xai: "x.svg",
  meta: "meta.svg",
  mistral: "mistralai.svg",
  aws: "amazonaws.svg",
  amazon: "amazonaws.svg",
  bedrock: "amazonaws.svg",
  opencode: "opencode.svg",
  ollama: "ollama.svg",
};

export function providerLogo(provider) {
  const key = String(provider ?? "").toLowerCase().trim();
  if (!key || key === "unknown" || key === "unknown provider") return null;
  if (PROVIDER_LOGO_FILES[key]) return PROVIDER_LOGO_FILES[key];
  for (const [prefix, file] of Object.entries(PROVIDER_LOGO_FILES)) {
    if (key.startsWith(prefix)) return file;
  }
  return null;
}
const MAX_FACET_OPTIONS = 250;
const DEFAULT_NODE = "node";
const RUNTIME_FILE = "mods/insights/runtime.json";
const PRESENTER_FILE = "mods/insights/presenter.mjs";
const ACTIVITY_TIMEOUT_MS = 35_000;

const HEAT_COLORS = {
  blue: {
    dark: ["#12324f", "#155e8a", "#1d86c4", "#4fb3f0"],
    light: ["#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"],
  },
  green: {
    dark: ["#12351f", "#166534", "#15803d", "#4ade80"],
    light: ["#dcfce7", "#86efac", "#22c55e", "#15803d"],
  },
  purple: {
    dark: ["#2a1b4d", "#4c1d95", "#6d28d9", "#a78bfa"],
    light: ["#ede9fe", "#c4b5fd", "#8b5cf6", "#6d28d9"],
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function sanitizeError(error) {
  let text;
  if (error && typeof error === "object") text = error.message ?? error.error ?? "";
  else text = String(error ?? "");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) text = "Unknown error";
  return text.length > 420 ? `${text.slice(0, 417)}…` : text;
}

function resultError(result) {
  const stderr = String(result?.stderr ?? "").trim();
  const stdout = String(result?.stdout ?? "").trim();
  const text = stderr || stdout;
  if (!text) return `Collector exited with code ${result?.code ?? "?"}.`;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const message = parsed.error ?? parsed.message;
      if (message) return String(message);
      return `Collector exited with code ${result?.code ?? "?"}.`;
    }
  } catch {
    // Diagnostics are plain text.
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Node startup failures put an internal frame first; prefer the real exception line.
  const errorLine = lines.find((line) => /^(?:[A-Za-z][\w.]*Error|Error|error):/.test(line));
  return sanitizeError(errorLine || lines.find((line) => !/^at\s/.test(line)) || text);
}

function parseRuntimeNode(raw) {
  if (raw === null || raw === undefined) return DEFAULT_NODE;
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`runtime.json is not valid JSON: ${sanitizeError(error)}`, { cause: error });
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("runtime.json must contain one JSON object with a node string.");
  }
  if (typeof config.node !== "string") {
    throw new Error("runtime.json must contain a node string.");
  }
  const node = config.node.trim();
  if (!node) throw new Error("runtime.json node must not be empty.");
  if (/[\u0000-\u001f\u007f]/.test(config.node)) {
    throw new Error("runtime.json node must not contain NUL or control characters.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(node) && !/^[a-z]:[\\/]/i.test(node)) {
    throw new Error("runtime.json node must be a Node executable path, not a URL.");
  }
  return node;
}

function parseSnapshot(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("The presentation helper returned no dashboard.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The presentation helper returned invalid JSON.");
  }
  if (!isPresentation(parsed)) {
    throw new Error("The presentation helper returned an unexpected dashboard payload.");
  }
  return parsed;
}

function presentationKey(snapshot, options = {}) {
  return JSON.stringify({
    generatedAt: snapshot?.generatedAt ?? null,
    lastScanAt: snapshot?.lastScanAt ?? null,
    config: snapshot?.config ?? null,
    filters: options.filters ?? {},
    period: options.period ?? "all",
    year: options.year ?? null,
    heatmapMode: options.heatmapMode ?? "daily",
    selectedDay: options.selectedDay ?? null,
    today: options.today ?? null,
  });
}

function sameOptions(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function sourceKey(source, index) {
  return String(source?.id || source?.adapter || `source-${index}`);
}

function rootsText(source) {
  return Array.isArray(source?.roots) ? source.roots.join(", ") : "";
}

function splitRoots(text) {
  return String(text ?? "").split(/[\n,]+/).map((root) => root.trim()).filter(Boolean);
}

function sourceLabel(value, config) {
  const source = (config.sources ?? []).find((item) => item?.adapter === value || item?.id === value);
  return source?.label || (value === "unknown" ? "Unknown source" : value);
}

function warningText(warning) {
  if (warning === null || warning === undefined) return "";
  if (typeof warning === "string") return warning;
  if (typeof warning === "object") return String(warning.message ?? warning.text ?? warning.error ?? "");
  return String(warning);
}

function sourceStatEntry(snapshot, source) {
  const map = snapshot?.sourceStats;
  if (!map || typeof map !== "object" || Array.isArray(map) || !source?.id) return null;
  const entry = map[source.id];
  if (entry === undefined || entry === null) return null;
  if (typeof entry === "string") return { status: entry, stats: null, error: null };
  if (typeof entry !== "object") return null;
  return {
    status: String(entry.status ?? entry.state ?? ""),
    stats: entry.stats && typeof entry.stats === "object" ? entry.stats : entry,
    error: entry.error ?? entry.message ?? null,
  };
}

function sourceStatusColor(status, c) {
  if (status === "ok") return c.done;
  if (status === "error" || status === "missing") return c.destructive;
  if (status === "empty") return c.accent;
  return c.dim;
}

function sourceStatusLabel(status) {
  if (!status) return "unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statCount(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? formatInt(number) : "—";
}

function statBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? formatBytes(number) : "—";
}

function sourceStatsText(entry) {
  const stats = entry?.stats;
  if (!stats || typeof stats !== "object") return "";
  const parts = [];
  if (stats.files !== undefined) parts.push(`${statCount(stats.files)} files`);
  if (stats.filesRead !== undefined) parts.push(`${statCount(stats.filesRead)} read`);
  if (stats.errors) parts.push(`${statCount(stats.errors)} errors`);
  if (stats.bytesRead) parts.push(statBytes(stats.bytesRead));
  if (entry.error) parts.push(sanitizeError(entry.error));
  return parts.join(" · ");
}

function isDarkTheme(t) {
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(t?.background ?? ""));
  if (!match) return true;
  const number = Number.parseInt(match[1], 16);
  const red = (number >> 16) & 255;
  const green = (number >> 8) & 255;
  const blue = number & 255;
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue) < 128;
}

function heatColor(level, palette, dark) {
  if (level <= 0) return null;
  const set = HEAT_COLORS[palette] ?? HEAT_COLORS.blue;
  return (dark ? set.dark : set.light)[Math.min(3, level - 1)];
}

function changeColor(change, c) {
  if (change?.kind === "up") return c.done;
  if (change?.kind === "down") return c.destructive;
  if (change?.kind === "new") return c.accent;
  return c.dim;
}

function allLabelFor(field) {
  if (field === "source") return "All sources";
  if (field === "provider") return "All providers";
  if (field === "model") return "All models";
  return "All projects";
}

function facetLabel(field, value, config) {
  if (field === "source") return sourceLabel(value, config);
  if (field === "provider") return value === "unknown" ? "Unknown provider" : value;
  if (field === "model") return value === "unknown" ? "Unknown model" : value;
  return value === "unknown" ? "Unknown project" : projectName(value);
}

function buildFacetOptions(field, facet, config) {
  const stats = facet?.stats ?? [];
  const options = stats.map((stat) => ({
    value: stat.value,
    label: facetLabel(field, stat.value, config),
    detail: field === "project" && stat.value !== "unknown" ? stat.value : "",
    meta: stat.meta ?? formatCompact(stat.tokens),
    tokens: stat.tokens,
    tooltip: stat.tooltip ?? `${formatInt(stat.tokens)} tokens · ${formatInt(stat.sessions)} sessions`,
  }));
  const seen = new Set(options.map((option) => option.value));
  if (field === "source") {
    for (const source of config.sources ?? []) {
      const value = String(source?.adapter || source?.id || "");
      if (!value || seen.has(value)) continue;
      options.push({
        value,
        label: source.label || value,
        detail: source.adapter ? `adapter ${source.adapter}` : "",
        meta: "0",
        tokens: 0,
        tooltip: "0 tokens",
      });
      seen.add(value);
    }
  }
  options.sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
  const total = facet?.total ?? 0;
  const truncated = options.length > MAX_FACET_OPTIONS;
  const visible = options.slice(0, MAX_FACET_OPTIONS);
  return {
    truncated,
    total,
    options: [
      { value: "all", label: allLabelFor(field), detail: "", meta: facet?.totalMeta ?? formatCompact(total), tokens: total, tooltip: facet?.totalTooltip ?? `${formatInt(total)} tokens` },
      ...visible,
    ],
  };
}

function selectedFacet(facet, value, field, config) {
  if (value === "all") return { value: "all", label: allLabelFor(field) };
  const found = (facet?.stats ?? []).find((stat) => stat.value === value);
  return { value, label: facetLabel(field, found?.value ?? value, config) };
}



function preferenceRow(label, control, c) {
  return h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
    .child(fieldLabel(label, c))
    .child(control);
}

export default class Insights extends View {
  init(_props, cx) {
    this.snapshot = null;
    this.loading = false;
    this.error = null;
    this.width = 960;
    this.height = 800;
    this.filters = { provider: "all", model: "all" };
    this.period = "all";
    this.year = Number(todayKey().slice(0, 4));
    this.heatmapMode = "daily";
    this.selectedDay = todayKey();
    this.showSettings = false;
    this.openFilter = null;
    this.openOptions = null;
    this.configDraft = null;
    this.configText = "";
    this.configDirty = false;
    this.editorDirty = false;
    this.rootsDirty = false;
    this.refreshDirty = false;
    this.saving = false;
    this.saveError = null;
    this.saveMessage = null;
    this.syncingInputs = false;
    this.syncingEditor = false;
    this.sourceInputs = new Map();
    this.refreshInput = null;
    this.configEditor = null;
    this.settingsTask = null;
    this.settingsQueued = false;
    this.timer = null;
    this.timerSeconds = null;
    this.commandTask = null;
    this.runtimeTask = null;
    this.runtimeReady = false;
    this.runtimeError = null;
    this.nodeBinary = null;
    this.dashboard = null;
    this.dashboardKey = null;
    this.dashboardPending = null;
    this.dashboardError = null;
    this.dashboardTimer = null;
    this.dashboardTask = null;
    this.progressTimer = null;
    this.scanProgress = null;
    this.dashboardQueued = false;
    this.dashboardGeneration = 0;
    this.dashboardWatchdog = null;
    this.refreshWatchdog = null;
    this.saveWatchdog = null;
    this.years = [Number(todayKey().slice(0, 4))];

    this.runtimeTask = cx.spawn(async (runtimeCx) => {
      try {
        const raw = await readTextFile(this.runtimePath());
        this.nodeBinary = parseRuntimeNode(raw);
      } catch (error) {
        this.runtimeError = `Insights runtime configuration failed at ${this.runtimePath()}: ${sanitizeError(error)}`;
        this.error = this.runtimeError;
      } finally {
        this.runtimeReady = true;
        this.loading = false;
      }
      if (this.nodeBinary) {
        this.refresh(runtimeCx);
        this.schedule(runtimeCx);
      }
      runtimeCx.notify();
    });
    this.commandTask = cx.spawn(async (commandCx) => {
      for (;;) {
        let command;
        try {
          command = await nextCommand();
        } catch {
          break;
        }
        const name = String(command).replace(/^insights\./, "");
        if (name === "refresh") this.refresh(commandCx);
        else if (name === "settings") this.openSettings(commandCx);
        else if (name === "dashboard") {
          this.showSettings = false;
          commandCx.notify();
        } else if (name.startsWith("period.")) {
          this.setPeriod(name.slice("period.".length), commandCx);
          commandCx.notify();
        } else if (name === "year.prev" || name === "year.next") {
          this.setYear(name === "year.prev" ? 1 : -1, commandCx);
          commandCx.notify();
        } else if (name.startsWith("heatmap.")) {
          const mode = name.slice("heatmap.".length);
          if (["daily", "weekly", "cumulative"].includes(mode)) {
            this.heatmapMode = mode;
            this.scheduleDashboard(commandCx, { force: true });
            commandCx.notify();
          }
        } else if (name === "filters.clear") {
          this.filters = { provider: "all", model: "all" };
          this.scheduleDashboard(commandCx, { force: true });
          commandCx.notify();
        }
      }
    });
  }

  close() {
    try { this.timer?.cancel(); } catch { /* already gone */ }
    try { this.dashboardTimer?.cancel(); } catch { /* already gone */ }
    try { this.dashboardTask?.cancel(); } catch { /* already gone */ }
    try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
    try { this.refreshWatchdog?.cancel(); } catch { /* already gone */ }
    try { this.progressTimer?.cancel(); } catch { /* already gone */ }
    try { this.saveWatchdog?.cancel(); } catch { /* already gone */ }
    try { this.settingsTask?.cancel(); } catch { /* already gone */ }
    try { this.commandTask?.cancel(); } catch { /* already gone */ }
    try { this.runtimeTask?.cancel(); } catch { /* already gone */ }
    try { this.refreshInput?.release(); } catch { /* already released */ }
    for (const state of this.sourceInputs.values()) {
      try { state.release(); } catch { /* already released */ }
    }
    try { this.configEditor?.release(); } catch { /* already released */ }
    this.refreshInput = null;
    this.configEditor = null;
    this.settingsTask = null;
    this.settingsQueued = false;
    this.sourceInputs = new Map();
  }

  editorOptions() {
    const t = theme();
    const options = {
      language: "json",
      value: this.configText || "{}",
      font_size: 12,
      line_numbers: true,
      folding: false,
      soft_wrap: false,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    };
    if (settings()?.font_family) options.font_family = settings().font_family;
    return options;
  }

  // Native editor and source inputs are only needed while Settings is open.
  // The dashboard never constructs or syncs them during a background snapshot.
  ensureSettingsControls() {
    if (!this.snapshot && !this.configDraft) return null;
    const savedConfig = normalizeConfig(this.snapshot?.config ?? {});
    const config = this.configDirty || this.editorDirty ? this.draftConfig(savedConfig) : savedConfig;
    if (!this.configDraft) this.configDraft = deepClone(config);
    if (!this.configText) this.configText = prettyJson(this.configDraft);

    if (!this.configEditor) {
      this.configEditor = EditorState.new(this.editorOptions());
      this.configEditor.on("change", () => {
        if (this.syncingEditor || !this.configEditor) return;
        const value = this.configEditor.value();
        if (!this.editorDirty && value === this.configText) return;
        this.editorDirty = true;
        this.configDirty = true;
        this.saveMessage = null;
      });
      this.configEditor.on("blur", (_event, notifyCx) => {
        this.applyEditorDraft();
        notifyCx.notify();
      });
    }

    if (!this.refreshInput) {
      this.refreshInput = InputState.new({ value: String(config.refreshSeconds) });
      this.refreshInput.on("change", () => {
        if (this.syncingInputs) return;
        this.refreshDirty = true;
        this.configDirty = true;
        this.saveMessage = null;
      });
      this.refreshInput.on("blur", (_event, notifyCx) => notifyCx.notify());
      this.refreshInput.on("submit", (_event, submitCx) => this.saveConfig(submitCx));
    }
    return config;
  }

  syncSettingsControls() {
    if (!this.showSettings) return;
    const config = this.ensureSettingsControls();
    if (!config) return;
    if (!this.configDirty && !this.editorDirty) this.setEditorText(this.configText || prettyJson(config));
    this.ensureSourceInputs(config);
    if (!this.rootsDirty) this.syncSourceInputs(config);
    if (!this.refreshDirty) this.syncRefreshInput(config);
  }

  scheduleSettingsSync(cx) {
    if (!this.showSettings) return;
    if (this.settingsTask) {
      this.settingsQueued = true;
      return;
    }
    let task = null;
    task = cx.spawn(async (syncCx) => {
      try {
        if (this.showSettings) this.syncSettingsControls();
      } catch (error) {
        this.saveError = sanitizeError(error);
      } finally {
        if (this.settingsTask === task) this.settingsTask = null;
        if (this.showSettings && this.settingsQueued) {
          this.settingsQueued = false;
          this.scheduleSettingsSync(syncCx);
        }
        syncCx.notify();
      }
    });
    this.settingsTask = task;
  }

  busy() {
    return this.loading || this.saving;
  }

  runtimePath() {
    return `${appHome()}/${RUNTIME_FILE}`;
  }

  presenterPath() {
    return `${appHome()}/${PRESENTER_FILE}`;
  }

  storePath() {
    return `${appHome()}/data/insights/insights.json`;
  }

  schedule(cx) {
    const seconds = clampRefreshSeconds(this.snapshot?.config?.refreshSeconds ?? 60);
    if (this.timer && this.timerSeconds === seconds) return;
    try { this.timer?.cancel(); } catch { /* already gone */ }
    this.timerSeconds = seconds;
    this.timer = cx.timer.every(seconds * 1000, (timerCx) => this.refresh(timerCx));
  }

  dashboardOptions() {
    return {
      filters: this.filters,
      period: this.period,
      year: this.year,
      heatmapMode: this.heatmapMode,
      selectedDay: this.selectedDay,
      today: todayKey(),
    };
  }

  // Analytics run in the Node presentation helper. QuickJS only stores the
  // compact result and renders it; no derivation runs in a render frame.
  progressPath() {
    return `${this.storePath()}.progress.json`;
  }

  // The collector writes a small progress file while scanning. Poll it only
  // while a refresh is in flight so the loading card can name the live file.
  armProgress(cx) {
    this.cancelProgress();
    // Self-terminating: if a refresh continuation is interrupted before its
    // finally runs, the poll must not leak into a permanent notify loop.
    let ticks = 0;
    this.progressTimer = cx.timer.every(500, (timerCx) => {
      ticks += 1;
      if (!this.loading || ticks > 240) {
        this.cancelProgress();
        return;
      }
      let next = null;
      try {
        const parsed = JSON.parse(readTextFile(this.progressPath()));
        if (parsed && Number.isFinite(Number(parsed.processed)) && Number.isFinite(Number(parsed.total))) next = parsed;
      } catch { /* the progress file is best-effort */ }
      const changed = (next?.processed ?? null) !== (this.scanProgress?.processed ?? null)
        || (next?.file ?? null) !== (this.scanProgress?.file ?? null);
      this.scanProgress = next;
      if (changed) timerCx.notify();
    });
  }

  cancelProgress() {
    try { this.progressTimer?.cancel(); } catch { /* already gone */ }
    this.progressTimer = null;
    this.scanProgress = null;
  }

  armWatchdog(kind, cx) {
    const field = kind === "refresh" ? "refreshWatchdog" : "saveWatchdog";
    try { this[field]?.cancel(); } catch { /* already gone */ }
    this[field] = cx.timer.after(ACTIVITY_TIMEOUT_MS, (timerCx) => {
      this[field] = null;
      if (kind === "refresh" && this.loading) {
        this.loading = false;
        this.error = "Refresh timed out after 35 seconds. Retry to try again.";
        timerCx.notify();
      }
      if (kind === "save" && this.saving) {
        this.saving = false;
        this.saveError = "Saving timed out after 35 seconds. Retry to try again.";
        timerCx.notify();
      }
    });
  }

  cancelWatchdog(kind) {
    const field = kind === "refresh" ? "refreshWatchdog" : "saveWatchdog";
    try { this[field]?.cancel(); } catch { /* already gone */ }
    this[field] = null;
  }

  cancelDashboardWork() {
    this.dashboardGeneration = (this.dashboardGeneration ?? 0) + 1;
    this.dashboardQueued = false;
    this.dashboardPending = null;
    try { this.dashboardTimer?.cancel(); } catch { /* already gone */ }
    this.dashboardTimer = null;
    try { this.dashboardTask?.cancel(); } catch { /* already gone */ }
    try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
    this.dashboardTask = null;
    this.dashboardWatchdog = null;
  }

  scheduleDashboard(cx, { force = false } = {}) {
    if (!this.snapshot || !this.nodeBinary || this.runtimeError) return;
    const options = this.dashboardOptions();
    const key = presentationKey(this.snapshot, options);
    if (!force && this.dashboard && this.dashboardKey === key) return;
    if (!force && this.dashboardPending === key) return;
    if (this.dashboardTask) {
      // Coalesce every filter/settings change made while a prepare is running.
      this.dashboardQueued = true;
      this.dashboardError = null;
      return;
    }
    try { this.dashboardTimer?.cancel(); } catch { /* already gone */ }
    this.dashboardPending = key;
    this.dashboardError = null;
    this.dashboardTimer = cx.timer.after(0, (timerCx) => {
      this.dashboardTimer = null;
      this.prepareDashboard(timerCx, key);
    });
  }

  prepareDashboard(cx, key) {
    if (!this.snapshot || !this.nodeBinary || this.runtimeError) return;
    const options = this.dashboardOptions();
    if (presentationKey(this.snapshot, options) !== key) {
      // A newer snapshot or filter replaced the request before the timer ran.
      this.scheduleDashboard(cx, { force: true });
      return;
    }
    const generation = (this.dashboardGeneration ?? 0) + 1;
    this.dashboardGeneration = generation;
    try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
    this.dashboardWatchdog = cx.timer.after(ACTIVITY_TIMEOUT_MS, (timerCx) => {
      this.dashboardWatchdog = null;
      if (generation !== this.dashboardGeneration) return;
      this.dashboardGeneration += 1;
      this.dashboardPending = null;
      this.dashboardQueued = false;
      try { this.dashboardTask?.cancel(); } catch { /* already gone */ }
      this.dashboardTask = null;
      this.dashboardError = "Preparing the dashboard timed out. Retry to try again.";
      timerCx.notify();
    });
    let task = null;
    task = cx.spawn(async (prepareCx) => {
      try {
        const result = await exec(this.nodeBinary, [
          this.presenterPath(),
          "prepare",
          "--store",
          this.storePath(),
          "--options",
          JSON.stringify(options),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        const payload = parseSnapshot(result.stdout);
        if (generation !== this.dashboardGeneration) return;
        if (payload.error && !payload.dashboard) throw new Error(payload.error);
        if (!payload.dashboard) throw new Error("The presentation helper returned no dashboard.");
        if (!this.snapshot || presentationKey(this.snapshot, this.dashboardOptions()) !== key) return;
        this.dashboard = payload.dashboard;
        this.dashboardKey = key;
        if (Array.isArray(payload.dashboard.years) && payload.dashboard.years.length) this.years = payload.dashboard.years;
        this.dashboardError = null;
      } catch (error) {
        if (generation === this.dashboardGeneration && this.snapshot
          && presentationKey(this.snapshot, this.dashboardOptions()) === key) {
          this.dashboardError = sanitizeError(error);
        }
      } finally {
        if (generation === this.dashboardGeneration) {
          try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
          this.dashboardWatchdog = null;
          if (this.dashboardPending === key) this.dashboardPending = null;
          if (this.dashboardTask === task) this.dashboardTask = null;
          prepareCx.notify();
          if (this.dashboardQueued) {
            this.dashboardQueued = false;
            this.scheduleDashboard(prepareCx);
          }
        }
      }
    });
    this.dashboardTask = task;
  }

  refresh(cx) {
    if (!this.runtimeReady) return;
    if (this.runtimeError) {
      this.loading = false;
      this.error = this.runtimeError;
      cx.notify();
      return;
    }
    if (this.busy()) return;
    this.loading = true;
    this.error = null;
    cx.notify();
    this.armWatchdog("refresh", cx);
    this.armProgress(cx);
    const presenter = this.presenterPath();
    const store = this.storePath();
    const options = this.dashboardOptions();
    cx.spawn(async (refreshCx) => {
      let payload = null;
      let failure = null;
      try {
        const result = await exec(this.nodeBinary, [
          presenter,
          "snapshot",
          "--store",
          store,
          "--home",
          home(),
          "--options",
          JSON.stringify(options),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        payload = parseSnapshot(result.stdout);
      } catch (error) {
        failure = error;
      } finally {
        this.loading = false;
        this.cancelWatchdog("refresh");
        this.cancelProgress();
        if (failure) {
          this.error = sanitizeError(failure);
          refreshCx.notify();
        }
      }
      if (!payload) return;
      this.error = null;
      try {
        this.applySnapshot(payload, refreshCx);
      } catch (error) {
        this.error = sanitizeError(error);
        refreshCx.notify();
      }
    });
  }

  applySnapshot(payload, cx) {
    if (!isPresentation(payload)) throw new Error("The presentation helper returned an unexpected dashboard payload.");
    const snapshot = payload.snapshot;
    this.cancelDashboardWork();
    this.snapshot = snapshot;
    const savedConfig = normalizeConfig(snapshot.config);
    const today = todayKey();
    const years = Array.isArray(payload.dashboard?.years) && payload.dashboard.years.length
      ? payload.dashboard.years
      : [Number(today.slice(0, 4))];
    this.years = years;
    if (!Number.isInteger(this.year) || !years.includes(this.year)) this.year = years[0] ?? Number(today.slice(0, 4));
    if (!isDay(this.selectedDay)) this.selectedDay = today;

    // Publish the compact dashboard before editor and input host work so an
    // interruption there can never bring back a permanent Preparing screen.
    const optionsNow = this.dashboardOptions();
    const key = presentationKey(snapshot, optionsNow);
    if (payload.dashboard && sameOptions(payload.options, optionsNow)) {
      this.dashboard = payload.dashboard;
      this.dashboardKey = key;
      this.dashboardError = payload.error ? sanitizeError(payload.error) : null;
    } else {
      this.dashboard = null;
      this.dashboardKey = null;
      this.dashboardError = payload.error ? sanitizeError(payload.error) : null;
    }
    this.schedule(cx);
    if (!this.dashboard) this.scheduleDashboard(cx, { force: true });

    if (!this.configDirty && !this.editorDirty) {
      this.configDraft = deepClone(savedConfig);
      this.configText = prettyJson(this.configDraft);
    }

    // Only compact metadata and the prepared dashboard are applied here. The
    // native settings controls are created or synced by a separate Task after
    // this notification, so they can never interrupt the first dashboard frame.
    cx.notify();
    if (this.showSettings) this.scheduleSettingsSync(cx);
  }

  draftConfig(fallback) {
    const base = this.configDraft ?? fallback ?? this.snapshot?.config ?? {};
    if (this.editorDirty && this.configEditor) {
      try {
        const parsed = JSON.parse(this.configEditor.value());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return normalizeConfig(parsed);
      } catch {
        // Invalid JSON keeps the last valid draft alive during background refreshes.
      }
    }
    return normalizeConfig(base);
  }

  setEditorText(text) {
    this.configText = text;
    if (!this.configEditor) return;
    this.syncingEditor = true;
    try {
      this.configEditor.set_value(text);
    } finally {
      this.syncingEditor = false;
    }
  }

  syncRefreshInput(config) {
    if (this.refreshDirty || !this.refreshInput) return;
    this.syncingInputs = true;
    try {
      this.refreshInput.set_value(String(config.refreshSeconds));
    } finally {
      this.syncingInputs = false;
    }
  }

  ensureSourceInputs(config = normalizeConfig(this.snapshot?.config ?? {})) {
    const next = new Map();
    const sources = config.sources ?? [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index] ?? {};
      const key = sourceKey(source, index);
      let state = this.sourceInputs.get(key);
      if (!state) {
        state = InputState.new({ value: rootsText(source), placeholder: "~/.harness/sessions" });
        state.on("change", () => {
          if (this.syncingInputs) return;
          this.rootsDirty = true;
          this.configDirty = true;
          this.saveMessage = null;
        });
        state.on("blur", (_event, notifyCx) => notifyCx.notify());
        state.on("submit", (_event, submitCx) => this.saveConfig(submitCx));
      }
      next.set(key, state);
    }
    for (const [key, state] of this.sourceInputs) {
      if (next.has(key)) continue;
      try { state.release(); } catch { /* already released */ }
    }
    this.sourceInputs = next;
  }

  syncSourceInputs(config) {
    if (this.rootsDirty) return;
    this.syncingInputs = true;
    try {
      const sources = config.sources ?? [];
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index] ?? {};
        const state = this.sourceInputs.get(sourceKey(source, index));
        if (state) state.set_value(rootsText(source));
      }
    } finally {
      this.syncingInputs = false;
    }
  }

  applyEditorDraft() {
    if (!this.editorDirty) return;
    try {
      const parsed = JSON.parse(this.configEditor.value());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      this.configDraft = parsed;
      const config = normalizeConfig(parsed);
      this.ensureSourceInputs(config);
      this.syncSourceInputs(config);
      this.syncRefreshInput(config);
    } catch {
      // Saving reports the parse error; keep the editor text untouched.
    }
  }

  updateDraft(mutator) {
    let base = this.configDraft;
    if (this.editorDirty) {
      try {
        const parsed = JSON.parse(this.configEditor.value());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
      } catch {
        // Keep the last valid draft when the editor is mid-edit or invalid.
      }
    }
    this.configDraft = deepClone(base ?? normalizeConfig(this.snapshot?.config ?? {}));
    mutator(this.configDraft);
    this.configDirty = true;
    this.editorDirty = false;
    this.saveMessage = null;
    this.setEditorText(prettyJson(this.configDraft));
    const config = normalizeConfig(this.configDraft);
    this.ensureSourceInputs(config);
    this.syncSourceInputs(config);
    this.syncRefreshInput(config);
  }

  buildConfigForSave() {
    let config;
    if (this.editorDirty) {
      let parsed;
      try {
        parsed = JSON.parse(this.configEditor.value());
      } catch (error) {
        throw new Error(`Configuration JSON is invalid: ${sanitizeError(error)}`, { cause: error });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Configuration must be a JSON object.");
      }
      config = parsed;
    } else {
      config = deepClone(this.configDraft ?? normalizeConfig(this.snapshot?.config ?? {}));
    }

    if (!Array.isArray(config.sources)) config.sources = [];
    if (this.rootsDirty || !this.editorDirty) {
      for (let index = 0; index < config.sources.length; index += 1) {
        const source = config.sources[index];
        if (!source || typeof source !== "object") continue;
        const state = this.sourceInputs.get(sourceKey(source, index));
        if (state) source.roots = splitRoots(state.value());
      }
    }

    if (this.refreshDirty || !this.editorDirty) {
      const current = this.refreshInput ? Number(this.refreshInput.value()) : Number(config.refreshSeconds);
      if (Number.isFinite(current)) config.refreshSeconds = clampRefreshSeconds(current);
    }
    config.refreshSeconds = clampRefreshSeconds(config.refreshSeconds);
    if (config.includeCache === undefined) config.includeCache = true;
    return config;
  }

  saveConfig(cx) {
    if (!this.runtimeReady) return;
    if (this.runtimeError) {
      this.saveError = this.runtimeError;
      cx.notify();
      return;
    }
    if (this.busy()) return;
    let config;
    try {
      config = this.buildConfigForSave();
    } catch (error) {
      this.saveError = sanitizeError(error);
      this.saveMessage = null;
      cx.notify();
      return;
    }
    this.saving = true;
    this.saveError = null;
    this.saveMessage = null;
    cx.notify();
    this.armWatchdog("save", cx);
    const presenter = this.presenterPath();
    const store = this.storePath();
    const options = this.dashboardOptions();
    cx.spawn(async (saveCx) => {
      let payload = null;
      let failure = null;
      try {
        const result = await exec(this.nodeBinary, [
          presenter,
          "configure",
          "--store",
          store,
          "--home",
          home(),
          "--config",
          JSON.stringify(config),
          "--options",
          JSON.stringify(options),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        payload = parseSnapshot(result.stdout);
      } catch (error) {
        failure = error;
      } finally {
        this.saving = false;
        this.cancelWatchdog("save");
        if (failure) this.saveError = sanitizeError(failure);
        saveCx.notify();
      }
      if (!payload) return;
      this.configDirty = false;
      this.editorDirty = false;
      this.rootsDirty = false;
      this.refreshDirty = false;
      this.error = null;
      this.saveError = null;
      try {
        this.applySnapshot(payload, saveCx);
        this.saveMessage = "Configuration saved.";
      } catch (error) {
        this.saveError = sanitizeError(error);
      }
      saveCx.notify();
    });
  }

  resetConfigDraft(cx) {
    if (!this.snapshot) return;
    const config = normalizeConfig(this.snapshot.config);
    this.configDirty = false;
    this.editorDirty = false;
    this.rootsDirty = false;
    this.refreshDirty = false;
    this.configDraft = deepClone(config);
    this.setEditorText(prettyJson(this.configDraft));
    this.ensureSourceInputs(config);
    this.syncSourceInputs(config);
    this.syncRefreshInput(config);
    this.saveError = null;
    this.saveMessage = "Reset to the saved configuration.";
    cx.notify();
  }

  formatConfigEditor(cx) {
    try {
      const parsed = JSON.parse(this.configEditor.value());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Configuration must be a JSON object.");
      }
      this.configDraft = parsed;
      this.editorDirty = true;
      this.configDirty = true;
      this.setEditorText(prettyJson(parsed));
      this.applyEditorDraft();
      this.saveError = null;
      this.saveMessage = "Formatted.";
    } catch (error) {
      this.saveError = sanitizeError(error);
      this.saveMessage = null;
    }
    cx.notify();
  }

  openSettings(cx) {
    this.showSettings = true;
    this.syncSettingsControls();
    cx.notify();
  }

  setPeriod(period, cx) {
    this.period = period;
    const today = todayKey();
    const config = normalizeConfig(this.snapshot?.config ?? {});
    if (period === "year") {
      const years = this.years?.length ? this.years : [Number(today.slice(0, 4))];
      if (!years.includes(this.year)) this.year = years[0] ?? Number(today.slice(0, 4));
    }
    this.selectedDay = periodRange(period, { today, weekStartsOn: config.weekStartsOn, year: this.year }).end;
    this.scheduleDashboard(cx, { force: true });
  }

  setYear(delta, cx) {
    const today = todayKey();
    const years = this.years?.length ? this.years : [Number(today.slice(0, 4))];
    const current = Math.max(0, years.indexOf(this.year));
    const next = Math.min(years.length - 1, Math.max(0, current + delta));
    this.year = years[next] ?? Number(today.slice(0, 4));
    const config = normalizeConfig(this.snapshot?.config ?? {});
    this.selectedDay = periodRange("year", { today, weekStartsOn: config.weekStartsOn, year: this.year }).end;
    this.scheduleDashboard(cx, { force: true });
  }

  render(_cx) {
    const c = tokens(theme());
    const width = this.width || 960;
    const padding = width < 620 ? G.md : width < 900 ? G.lg : G.xl;
    const content = [this.header(c)];
    if (this.error && this.snapshot) content.push(this.errorBanner(c));
    if (this.dashboardError && this.snapshot) content.push(this.dashboardErrorBanner(c));
    if (!this.snapshot) content.push(this.initialState(c));
    else if (this.showSettings) content.push(this.settingsView(c));
    else content.push(this.dashboardView(c));

    return v_flex().id("insights-root").size_full().min_h(0).bg(c.canvas).text_color(c.text)
      .overflow_y_scrollbar()
      .on_size_change((size, sizeCx) => {
        const changed = Math.abs((this.width || 0) - size.width) >= 1;
        this.width = size.width;
        this.height = size.height;
        if (changed) sizeCx.notify();
      })
      .child(h_flex().w_full().justify_center().p(padding)
        .child(v_flex().w_full().max_w(1180).gap(G.lg).children(content)));
  }

  header(c) {
    const updated = this.snapshot ? formatTimestamp(this.snapshot.lastScanAt || this.snapshot.generatedAt) : "";
    const preparing = !this.dashboard && (this.dashboardPending || this.dashboardQueued);
    const status = this.loading ? "Refreshing…"
      : this.saving ? "Saving…"
        : preparing ? "Preparing…"
          : this.error ? (this.snapshot ? "Showing last snapshot" : "Unavailable")
            : this.dashboardError ? "Could not prepare dashboard"
              : updated ? `Updated ${updated}` : "";
    const statusError = Boolean(this.error || this.dashboardError);
    return h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
      .child(pageTitle(this.showSettings ? "Settings" : "Insights", c))
      .child(h_flex().flex_wrap().gap(G.sm).items_center()
        .when(Boolean(status), (el) => el.child(div().text_size(T.small)
          .text_color(statusError ? c.destructive : c.dim).child(status)))
        .child(button("insights-refresh", "↻ Refresh", (_event, clickCx) => this.refresh(clickCx), c, {
          disabled: this.busy(),
          variant: "outline",
        }))
        .when(Boolean(this.snapshot), (el) => el.child(button(
          "insights-settings",
          this.showSettings ? "Dashboard" : "Settings",
          (_event, clickCx) => {
            if (this.showSettings) {
              this.showSettings = false;
              clickCx.notify();
            } else {
              this.openSettings(clickCx);
            }
          },
          c,
          { variant: "outline" },
        ))));
  }

  errorBanner(c) {
    return notice(c, {
      title: "Could not refresh insights",
      body: this.error,
      action: button("insights-retry", "Retry", (_event, clickCx) => this.refresh(clickCx), c, {
        disabled: this.busy(),
        variant: "outline",
      }),
    });
  }

  initialState(c) {
    const progress = this.scanProgress;
    const total = Number(progress?.total) || 0;
    const processed = Number(progress?.processed) || 0;
    const file = typeof progress?.file === "string" ? progress.file : "";
    return stateCard(c, {
      tone: this.loading ? c.accent : c.destructive,
      title: this.loading ? "Loading local insights" : "Insights needs its collector",
      body: this.loading
        ? (total > 0 ? `Scanning ${formatInt(processed)} of ${formatInt(total)} files` : null)
        : (this.error || "The collector did not return a snapshot yet."),
      detail: this.loading && file ? file : null,
      action: this.busy() ? null : button("insights-initial-retry", "Retry", (_event, clickCx) => this.refresh(clickCx), c, {
        variant: "primary",
      }),
    });
  }

  dashboardErrorBanner(c) {
    return notice(c, {
      title: "Could not prepare the dashboard",
      body: this.dashboardError,
      action: button("insights-dashboard-retry", "Retry", (_event, clickCx) => {
        this.scheduleDashboard(clickCx, { force: true });
        clickCx.notify();
      }, c, { disabled: Boolean(this.dashboardPending), variant: "outline" }),
    });
  }

  dashboardView(c) {
    const derived = this.dashboard;
    if (!derived) {
      const retry = (id, primary) => button(id, "Retry", (_event, clickCx) => {
        this.scheduleDashboard(clickCx, { force: true });
        clickCx.notify();
      }, c, { disabled: Boolean(this.dashboardPending), variant: primary ? "primary" : "outline" });
      if (this.dashboardError) {
        return stateCard(c, {
          tone: c.destructive,
          title: "Could not prepare insights",
          body: this.dashboardError,
          action: retry("insights-prepare-retry", true),
        });
      }
      return stateCard(c, {
        tone: c.accent,
        title: "Preparing insights",
        action: retry("insights-prepare-retry", false),
      });
    }
    const { config, rowCount, range, lifetime, peak, streaks, heatmap, leaders, selectedDay, selectedRowCount, selectedTotals, selectedTop, years } = derived;

    return v_flex().w_full().gap(G.lg)
      .child(this.metricStrip(c, lifetime, peak, streaks))
      .when(rowCount === 0, (el) => el.child(this.emptyNotice(c, config)))
      .child(this.sectionHeader("Token usage", c))
      .child(this.heatmapCard(c, config, heatmap, selectedDay))
      .child(this.tokenDetailCard(c, heatmap, selectedDay, selectedRowCount, selectedTotals, selectedTop, lifetime))
      .child(this.sectionHeader("Model usage", c))
      .child(this.filtersBar(c, config, range, derived.facets, years))
      .when(Boolean(derived.modelSeries?.weeks?.length), (el) => el.child(this.modelChartCard(c, derived.modelSeries)))
      .child(this.leaderboardCard(c, leaders, range));
  }

  sectionHeader(title, c) {
    return h_flex().w_full().items_center().gap(G.md).pt(G.sm)
      .child(div().text_size(T.card).font_semibold().text_color(c.text).child(title))
      .child(div().flex_1().h(1).bg(c.border));
  }

  filtersBar(c, config, _range, facets, years) {
    const active = Object.values(this.filters).some((value) => value !== "all");

    // A plain toolbar row: period first, then facet filters. No card chrome,
    // so it reads as page navigation instead of a floating section.
    return h_flex().w_full().flex_wrap().gap(G.sm).items_center()
      .child(segmented("ins-period", [
        { key: "week", label: "Week" },
        { key: "month", label: "Month" },
        { key: "year", label: "Year" },
        { key: "all", label: "All" },
      ], this.period, (key, changeCx) => this.setPeriod(key, changeCx), c))
      .when(this.period === "year", (el) => el.child(h_flex().gap(G.xs).items_center()
        .child(iconButton("ins-year-older", "‹", "Older year", (_event, clickCx) => { this.setYear(1, clickCx); clickCx.notify(); }, c))
        .child(div().min_w(36).text_center().text_size(T.body).font_medium().text_color(c.text).child(String(this.year)))
        .child(iconButton("ins-year-newer", "›", "Newer year", (_event, clickCx) => { this.setYear(-1, clickCx); clickCx.notify(); }, c, {
          color: this.year >= years[0] ? c.dim : c.mutedForeground,
        }))))
      .child(this.filterMenu("provider", "Provider", this.filters.provider, facets.provider, config, c, (value, pickCx) => { this.filters.provider = value; this.scheduleDashboard(pickCx, { force: true }); }))
      .child(this.filterMenu("model", "Model", this.filters.model, facets.model, config, c, (value, pickCx) => { this.filters.model = value; this.scheduleDashboard(pickCx, { force: true }); }))
      .when(active, (el) => el.child(button("ins-clear-filters", "Clear filters", (_event, clickCx) => {
        this.filters = { provider: "all", model: "all" };
        this.scheduleDashboard(clickCx, { force: true });
        clickCx.notify();
      }, c, { variant: "ghost" })));
  }

  filterMenu(field, label, value, facet, config, c, onPick) {
    const selected = selectedFacet(facet, value, field, config);
    const id = `ins-${field}-filter`;
    const active = value !== "all";
    const trigger = Button.new(`ins-${field}-trigger`).h(H.control).px(8).gap(G.sm).items_center().rounded(R.control)
      .border_1().border_color(active ? c.ring : c.border).bg(c.card).cursor_pointer()
      .hover((style) => style.bg(c.subtle))
      .focus((style) => style.border_color(c.ring))
      .accessibility_label(`${label}: ${selected.label}`)
      .child(div().text_size(T.label).font_medium().text_color(c.dim).child(label))
      .child(div().max_w(132).truncate().text_size(T.body).text_color(c.text).child(selected.label))
      .child(div().text_size(11).text_color(c.dim).child("⌄"));

    const menu = Popover.new(id).trigger(trigger)
      .open(this.openFilter === id)
      .on_open_change((open, changeCx) => {
        this.openFilter = open ? id : null;
        // Menu data is prepared in this event, never in the 50 ms render pass.
        this.openOptions = open ? buildFacetOptions(field, facet, config) : null;
        changeCx.notify();
      });
    // Closed menus build no option elements; only the trigger is rendered.
    if (this.openFilter === id && this.openOptions) {
      menu.content(this.filterMenuContent(field, value, this.openOptions, c, onPick));
    }
    return menu;
  }

  filterMenuContent(field, value, options, c, onPick) {
    return v_flex().w(240).max_h(320).overflow_y_scrollbar().p(G.xs).gap(2).rounded(R.card)
      .bg(c.popover).border_1().border_color(c.border)
      .children(options.options.map((option, index) => {
        const selected = option.value === value;
        return Button.new(`ins-${field}-option-${index}`)
          .h(28).px(8).gap(G.sm).items_center().rounded(R.control)
          .selected(selected)
          .set_position(index + 1, options.options.length)
          .cursor_pointer()
          .when(selected, (el) => el.bg(c.selected))
          .when(!selected, (el) => el.hover((style) => style.bg(c.subtle)))
          .focus((style) => style.bg(c.selected))
          .accessibility_label(option.label)
          .on_click((_event, clickCx) => {
            this.openFilter = null;
            this.openOptions = null;
            onPick(option.value, clickCx);
            clickCx.notify();
          })
          .child(div().w(12).text_size(10).text_color(c.accent).child(selected ? "✓" : ""))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(T.body).text_color(c.text).truncate().tooltip(option.tooltip || option.label).child(option.label))
            .when(Boolean(option.detail), (el) => el.child(div().text_size(T.label).text_color(c.dim).truncate().child(option.detail))))
          .child(div().text_size(T.label).text_color(c.dim).child(option.meta ?? ""));
      }))
      .when(options.truncated, (el) => el.child(div().p(G.sm).text_size(T.label).text_color(c.dim)
        .child(`Showing top ${MAX_FACET_OPTIONS} by tokens.`)));
  }

  emptyNotice(c, config) {
    const roots = [];
    for (const source of config.sources ?? []) {
      if (source?.enabled === false) continue;
      for (const root of source.roots ?? []) roots.push(root);
    }
    return card(c).gap(G.sm)
      .child(h_flex().items_center().gap(G.sm)
        .child(div().size(8).flex_none().rounded_full().bg(c.accent))
        .child(div().text_size(T.card).font_semibold().text_color(c.text).child("No usage found yet")))
      .child(bodyText("Enable a source and check its roots. Insights only reads local harness session files and never stores prompts or code.", c))
      .when(roots.length > 0, (el) => el.child(v_flex().gap(2)
        .children(roots.slice(0, 4).map((root) => mutedText(root, c)))))
      .child(h_flex().pt(G.xs)
        .child(button("ins-empty-settings", "Open settings", (_event, clickCx) => this.openSettings(clickCx), c, { variant: "outline" })));
  }

  metricStrip(c, lifetime, peak, streaks) {
    const stats = [
      {
        label: "Lifetime tokens",
        value: formatCompact(lifetime.total),
        note: `${formatInt(lifetime.sessions)} sessions · all time`,
        tooltip: `${formatInt(lifetime.total)} tokens${lifetime.reasoning ? ` · ${formatInt(lifetime.reasoning)} reasoning inside output` : ""}`,
      },
      {
        label: "Peak day",
        value: peak.day ? formatCompact(peak.tokens) : "—",
        note: peak.day ? dayLabel(peak.day) : "No activity yet",
        tooltip: peak.day ? `${formatInt(peak.tokens)} tokens on ${dayLabel(peak.day)}` : "No activity yet",
      },
      {
        label: "Longest task",
        value: formatDuration(lifetime.longestTaskMs),
        note: lifetime.longestTaskMs > 0 ? "Observed span" : "Not reported",
        tooltip: lifetime.longestTaskMs > 0 ? `${formatInt(lifetime.longestTaskMs)} ms observed` : "Unknown task duration",
      },
      {
        label: "Longest streak",
        value: `${formatInt(streaks.longest)}D`,
        tooltip: `${formatInt(streaks.longest)} consecutive active days`,
      },
      {
        label: "Current streak",
        value: `${formatInt(streaks.current)}D`,
        color: streaks.current > 0 ? c.accent : c.text,
        tooltip: `${formatInt(streaks.current)} current consecutive active days`,
      },
    ];

    // One summary band with hairline dividers instead of five separate boxes.
    const stat = (item, divided) => v_flex().flex_1().min_w(0).gap(2)
      .when(divided, (el) => el.border_l(1).border_color(c.border).pl(G.lg))
      .child(metaLabel(item.label, c))
      .child(div().text_size(T.metric).font_semibold().text_color(item.color ?? c.text).truncate()
        .tooltip(item.tooltip).child(item.value))
      .when(Boolean(item.note), (el) => el.child(mutedText(item.note, c)));
    const row = (items) => h_flex().w_full().items_start()
      .children(items.map((item, index) => stat(item, index > 0)));

    if ((this.width || 960) >= 860) return card(c).child(row(stats));
    const perRow = (this.width || 960) >= 560 ? 3 : 2;
    const band = card(c);
    for (let start = 0; start < stats.length; start += perRow) {
      band.child(row(stats.slice(start, start + perRow)));
    }
    return band;
  }

  heatmapCard(c, config, heatmap, selectedDay) {
    const dark = isDarkTheme(c);
    const palette = PALETTES.includes(config.palette) ? config.palette : "blue";
    const metrics = heatmapMetrics(this.width, heatmap.weeks.length);
    const cell = metrics.cell;
    const weekWidth = metrics.weekWidth;
    const contentWidth = metrics.contentWidth;
    // A one-week leading partial month is narrow, so keep the span but omit text that would wrap.
    const months = heatmap.months.map((month) => div().w(month.span * weekWidth).flex_none()
      .text_size(9.5).text_color(c.dim)
      .when(month.span >= 2, (el) => el.whitespace_nowrap().child(month.label)));
    const weekLabels = weekdayLabels(heatmap.weekStartsOn).map((label) => div().h(cell).text_size(9)
      .text_color(c.dim).child(label));

    const cellElement = (dayCell) => {
      const color = dayCell.future
        ? c.muted
        : dayCell.level > 0 ? heatColor(dayCell.level, palette, dark) : c.muted;
      return div().id(`ins-cell-${dayCell.date}`).size(cell).flex_none().rounded(2).bg(color)
        .opacity(dayCell.future ? 0.3 : 1)
        .when(!dayCell.future, (el) => el.cursor_pointer()
          .hover((style) => style.opacity(0.8))
          .on_click((_event, clickCx) => {
            this.selectedDay = dayCell.date;
            this.scheduleDashboard(clickCx, { force: true });
            clickCx.notify();
          })
          .tooltip(dayCell.tooltip ?? ""))
        .when(dayCell.date === selectedDay, (el) => el.border_1().border_color(c.ring));
    };
    const weekElements = heatmap.weeks.map((week) => v_flex().gap(CELL_GAP).children(week.days.map(cellElement)));
    const grid = v_flex().w(contentWidth).flex_none().gap(G.xs)
      .child(h_flex().h(15).children([
        div().w(DAY_LABEL_WIDTH).flex_none(),
        ...months,
      ]))
      .child(h_flex().gap(CELL_GAP).items_start()
        .child(v_flex().w(DAY_LABEL_WIDTH).flex_none().gap(CELL_GAP).children(weekLabels))
        .child(h_flex().gap(CELL_GAP).children(weekElements)));

    const legend = h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_end()
      .child(mutedText("Less", c))
      .children([0, 1, 2, 3, 4].map((level) => div().size(10).rounded(2)
        .bg(level === 0 ? c.muted : heatColor(level, palette, dark))))
      .child(mutedText("More", c))
      .child(mutedText(`${formatCompact(heatmap.windowTotal)} in window`, c));

    return card(c).gap(G.md)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
        .child(cardHeader(
          "Tokens History",
          `53 weeks · ends ${dayLabel(heatmap.range.dataEnd)} · ${config.includeCache ? "cache included" : "cache excluded"}`,
          c,
        ))
        .child(segmented("ins-heat-mode", [
          { key: "daily", label: "Daily" },
          { key: "weekly", label: "Weekly" },
          { key: "cumulative", label: "Cumulative" },
        ], this.heatmapMode, (key, changeCx) => {
          this.heatmapMode = key;
          this.scheduleDashboard(changeCx, { force: true });
        }, c)))
      .child(v_flex().w_full().overflow_x_scrollbar()
        .child(h_flex().w_full().when(metrics.centered, (el) => el.justify_center()).child(grid)))
      .child(legend);
  }

  tokenDetailCard(c, heatmap, selectedDay, selectedRowCount, selectedTotals, selectedTop, lifetime) {
    const cell = heatmap.weeks.flatMap((week) => week.days).find((item) => item.date === selectedDay);
    const modeLabel = heatmap.mode === "weekly" ? "Week total" : heatmap.mode === "cumulative" ? "Cumulative through day" : "Daily tokens";
    const value = cell ? formatCompact(cell.value) : "0";
    const exact = cell ? formatInt(cell.value) : "0";
    const dayExact = formatInt(selectedTotals.total);
    const cacheNote = heatmap.includeCache ? "included" : "excluded";

    return card(c).gap(G.md)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_start().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(12).font_semibold().text_color(c.text)
            .child(dayLabel(selectedDay, { weekday: true, longWeekday: true })))
          .child(mutedText(`${modeLabel}${heatmap.mode === "daily" ? "" : ` · this day ${formatCompact(selectedTotals.total)} tokens`}`, c, T.label)))
        .child(v_flex().items_end().gap(1)
          .child(div().text_size(18).font_semibold().text_color(c.text).tooltip(`${exact} tokens`).child(value))
          .child(mutedText(`${dayExact} tokens on this day`, c, T.label))))
      .when(selectedRowCount === 0, (el) => el.child(div().text_size(T.body).text_color(c.mutedForeground)
        .child("No usage recorded on this day.")))
      // Stat cells keep optional notes below the value, so top-align the row
      // rather than centering cells against the tallest note-bearing sibling.
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.md).items_start()
        .child(statCell("Input", formatCompact(selectedTotals.input), c, { tooltip: `${formatInt(selectedTotals.input)} input tokens` }))
        .child(statCell("Output", formatCompact(selectedTotals.output), c, {
          note: "includes reasoning",
          tooltip: `${formatInt(selectedTotals.output)} output tokens · reasoning ${formatInt(selectedTotals.reasoning)}`,
        }))
        .child(statCell("Cache read", formatCompact(selectedTotals.cacheRead), c, {
          note: cacheNote,
          tooltip: `${formatInt(selectedTotals.cacheRead)} cache-read tokens`,
        }))
        .child(statCell("Cache write", formatCompact(selectedTotals.cacheWrite), c, {
          note: cacheNote,
          tooltip: `${formatInt(selectedTotals.cacheWrite)} cache-write tokens`,
        })))
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.md).items_start()
        .child(statCell("Sessions", formatInt(selectedTotals.sessions), c, { tooltip: `${formatInt(selectedTotals.sessions)} sessions on this day` }))
        .child(statCell("Usage events", formatInt(selectedTotals.messages), c, { tooltip: `${formatInt(selectedTotals.messages)} nonzero reported usage records` }))
        .child(statCell("Longest task", formatDuration(selectedTotals.longestTaskMs), c, {
          note: selectedTotals.longestTaskMs > 0 ? "observed" : "not reported",
          tooltip: selectedTotals.longestTaskMs > 0 ? `${formatInt(selectedTotals.longestTaskMs)} ms observed` : "Unknown task duration",
        }))
        .when(Boolean(selectedTop), (el) => el.child(statCell("Top model", selectedTop.name, c, {
          note: selectedTop.sublabel,
          tooltip: `${selectedTop.name} · ${selectedTop.sublabel}`,
        }))))
      .child(div().h(1).w_full().bg(c.border))
      .child(metaLabel("All time", c))
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.md).items_start()
        .child(statCell("Input", formatCompact(lifetime.input), c, { tooltip: `${formatInt(lifetime.input)} input tokens` }))
        .child(statCell("Output", formatCompact(lifetime.output), c, {
          note: "includes reasoning",
          tooltip: `${formatInt(lifetime.output)} output tokens · reasoning ${formatInt(lifetime.reasoning)}`,
        }))
        .child(statCell("Cache read", formatCompact(lifetime.cacheRead), c, {
          note: cacheNote,
          tooltip: `${formatInt(lifetime.cacheRead)} cache-read tokens`,
        }))
        .child(statCell("Cache write", formatCompact(lifetime.cacheWrite), c, {
          note: cacheNote,
          tooltip: `${formatInt(lifetime.cacheWrite)} cache-write tokens`,
        })))
      .child(mutedText(`Reasoning ${formatInt(lifetime.reasoning)} is already inside output and is never added twice.`, c));
  }

  modelChartCard(c, series) {
    const weeks = series.weeks;
    const maxTotal = series.maxTotal || 0;
    const colors = new Map(series.models.map((name, index) => [name, modelChartColor(name, index)]));

    const bar = (week) => v_flex().flex_1().min_w(0).h(CHART_HEIGHT).justify_end()
      .tooltip(`Week of ${dayLabel(week.start)} · ${formatCompact(week.total)} tokens`)
      .when(week.total > 0 && maxTotal > 0, (el) => el.child(
        v_flex().w_full().flex_none().h(Math.max(2, Math.round((week.total / maxTotal) * CHART_HEIGHT)))
          .children(week.segments.map((segment) => div().w_full().flex_grow(Math.max(0.001, segment.tokens))
            .bg(colors.get(segment.name) ?? OTHER_CHART_COLOR)
            .tooltip(`${segment.name} · ${formatCompact(segment.tokens)} tokens`))),
      ));

    const axisLabel = (text) => div().text_size(9).text_color(c.dim).child(text);
    const labelStep = Math.ceil(weeks.length / 6);
    const legend = h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.xs).items_center()
      .children(series.models.map((name) => h_flex().items_center().gap(G.xs)
        .child(div().size(8).flex_none().rounded_full().bg(colors.get(name) ?? OTHER_CHART_COLOR))
        .child(div().max_w(180).truncate().text_size(T.label).text_color(c.mutedForeground).tooltip(name).child(name))));

    return card(c).gap(G.md)
      .child(cardHeader(
        "Top models",
        `${weeks.length} weeks · ${formatCompact(series.windowTotal)} tokens · ${series.includeCache ? "cache included" : "cache excluded"}`,
        c,
      ))
      .when(maxTotal === 0, (el) => el.child(div().py(G.lg).text_size(T.body).text_color(c.mutedForeground)
        .child("No model usage in this window.")))
      .when(maxTotal > 0, (el) => el.child(v_flex().w_full().gap(G.sm)
        .child(h_flex().w_full().gap(G.sm).items_end()
          .child(v_flex().w(28).flex_none().h(CHART_HEIGHT).justify_between().children([
            axisLabel(formatCompact(maxTotal)),
            axisLabel(formatCompact(maxTotal / 2)),
            axisLabel("0"),
          ]))
          .child(h_flex().flex_1().min_w(0).gap(CELL_GAP).items_end().children(weeks.map(bar))))
        .child(h_flex().w_full().gap(G.sm)
          .child(div().w(28).flex_none())
          .child(h_flex().flex_1().min_w(0).gap(CELL_GAP).children(weeks.map((week, index) => div()
            .flex_1().min_w(0).text_size(9).text_color(c.dim).whitespace_nowrap()
            .child(index % labelStep === 0 ? dayLabel(week.start, { year: false }) : "")))))
        .child(legend)));
  }

  leaderboardCard(c, leaders, range) {
    const entries = leaders.entries;
    const half = Math.ceil(entries.length / 2);
    const left = entries.slice(0, half);
    const right = entries.slice(half);
    const twoColumns = (this.width || 960) >= 960 && right.length > 0;

    const changeLabel = (entry) => {
      if (entry.change.kind === "none") return "—";
      if (entry.change.kind === "up") return `↑${entry.change.label}`;
      if (entry.change.kind === "down") return `↓${entry.change.label}`;
      return entry.change.label;
    };

    const row = (entry, last) => {
      const logo = providerLogo(entry.provider);
      return h_flex().w_full().items_center().gap(G.sm).py(G.sm)
        .when(!last, (el) => el.border_b(1).border_color(c.border))
        .child(div().w(20).text_size(T.body).text_color(c.dim).child(`${entry.rank}.`))
        .child(h_flex().size(26).flex_none().rounded(R.control).bg(c.secondary).border_1().border_color(c.border)
          .items_center().justify_center()
          .child(logo
            ? svg(`mods/insights/logos/${logo}`).size(14).text_color(c.mutedForeground)
            : div().text_size(9).font_semibold().text_color(c.mutedForeground).child(initials(entry.name, 2))))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(12).font_medium().text_color(c.text).truncate().tooltip(entry.name).child(entry.name))
          .child(div().text_size(10).text_color(c.dim).truncate().child(`by ${entry.sublabel}`)))
        .child(v_flex().items_end().gap(1)
          .child(div().text_size(12).font_semibold().text_color(c.text).tooltip(`${formatInt(entry.tokens)} tokens`)
            .child(`${formatCompact(entry.tokens)} tokens`))
          .child(div().text_size(T.small).text_color(changeColor(entry.change, c))
            .tooltip(entry.change.kind === "none" ? "No previous period" : `Previous ${formatInt(entry.previous ?? 0)} tokens`)
            .child(changeLabel(entry))));
    };

    const empty = v_flex().w_full().items_center().gap(G.sm).p(G.lg)
      .child(div().text_size(12).font_medium().text_color(c.text).child("No usage in this period"))
      .child(bodyText("Try All time, another year, or clear the filters.", c))
      .child(button("ins-leaders-all", "Show all time", (_event, clickCx) => {
        this.setPeriod("all", clickCx);
        clickCx.notify();
      }, c, { variant: "outline" }));

    return card(c).gap(G.md)
      .child(cardHeader(
        "Model Usage",
        `${range.label} · ${formatCompact(leaders.totalTokens)} tokens · ${formatInt(leaders.totalSessions)} sessions`,
        c,
      ))
      .when(entries.length === 0, (el) => el.child(empty))
      .when(entries.length > 0 && twoColumns, (el) => el.child(h_flex().w_full().gap(G.xl).items_start()
        .child(v_flex().flex_1().min_w(0).gap(0).children(left.map((entry, index) => row(entry, index === left.length - 1))))
        .child(v_flex().flex_1().min_w(0).gap(0).children(right.map((entry, index) => row(entry, index === right.length - 1))))))
      .when(entries.length > 0 && !twoColumns, (el) => el.child(v_flex().w_full().gap(0)
        .children(entries.map((entry, index) => row(entry, index === entries.length - 1)))))
      .when(leaders.totalGroups > entries.length, (el) => el.child(mutedText(
        `Showing top ${entries.length} of ${leaders.totalGroups} by tokens.`, c)));
  }

  statusCard(c, snapshot, config) {
    const stats = snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : null;
    const errors = stats && Number.isFinite(Number(stats.errors)) ? Number(stats.errors) : null;
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.map(warningText).filter(Boolean) : [];
    const sources = config.sources ?? [];
    return card(c).gap(G.md)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
        .child(cardHeader(
          "Scan status",
          `Generated ${formatTimestamp(snapshot.generatedAt) || "unknown"} · last scan ${formatTimestamp(snapshot.lastScanAt) || "unknown"}`,
          c,
        ))
        .child(div().text_size(T.small).text_color(errors > 0 ? c.destructive : errors === 0 ? c.done : c.dim)
          .child(errors === null ? "No scan stats" : errors > 0 ? `${formatInt(errors)} errors` : "No scan errors")))
      // Status rows follow the same top-aligned contract if a note is added.
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.md).items_start()
        .child(statCell("Files", statCount(stats?.files), c, { tooltip: stats?.files === undefined ? "No scan stats" : `${formatInt(stats.files)} files indexed` }))
        .child(statCell("Read", statCount(stats?.filesRead), c, { tooltip: stats?.filesRead === undefined ? "No scan stats" : `${formatInt(stats.filesRead)} files read` }))
        .child(statCell("Unchanged", statCount(stats?.unchangedFiles), c, { tooltip: stats?.unchangedFiles === undefined ? "No scan stats" : `${formatInt(stats.unchangedFiles)} unchanged files` }))
        .child(statCell("Bytes", statBytes(stats?.bytesRead), c, { tooltip: stats?.bytesRead === undefined ? "No scan stats" : `${formatInt(stats.bytesRead)} bytes read` })))
      .child(v_flex().w_full().gap(G.xs)
        .children(sources.map((source, index) => {
          const entry = sourceStatEntry(snapshot, source);
          const status = entry?.status || (source?.enabled === false ? "disabled" : "enabled");
          const statsText = sourceStatsText(entry);
          return h_flex().w_full().gap(G.sm).items_center().py(2)
            .opacity(source?.enabled === false ? 0.55 : 1)
            .child(div().size(6).flex_none().rounded_full().bg(sourceStatusColor(status, c)))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(T.body).text_color(c.text).child(source?.label || source?.adapter || `Source ${index + 1}`))
              .child(div().text_size(T.label).text_color(c.dim).truncate()
                .child([(Array.isArray(source?.roots) ? source.roots.join(" · ") : ""), statsText].filter(Boolean).join(" · ") || "No roots configured")))
            .child(v_flex().items_end().gap(1)
              .child(div().text_size(9).text_color(sourceStatusColor(status, c)).child(sourceStatusLabel(status)))
              .child(div().text_size(9).text_color(c.dim).child(source?.adapter || "")));
        })))
      .when(sources.length === 0, (el) => el.child(mutedText("No sources configured.", c)))
      .child(v_flex().w_full().gap(G.xs)
        .child(metaLabel("Warnings", c))
        .when(warnings.length === 0, (el) => el.child(mutedText("No scan warnings.", c)))
        .children(warnings.slice(0, 6).map((warning) => h_flex().w_full().gap(G.sm).items_start()
          .child(div().text_size(10).text_color(c.destructive).child("!"))
          .child(div().flex_1().min_w(0).text_size(T.small).text_color(c.mutedForeground).child(warning))))
        .when(warnings.length > 6, (el) => el.child(mutedText(`+${warnings.length - 6} more warnings`, c))));
  }

  settingsView(c) {
    if (!this.configEditor || !this.refreshInput) {
      return stateCard(c, {
        tone: c.accent,
        title: "Preparing settings",
      });
    }
    const config = normalizeConfig(this.configDraft ?? this.snapshot?.config ?? {});
    const textInput = (state) => controlInput(Input.new(state).w_full(), c);
    const refreshInput = controlInput(Input.new(this.refreshInput).w(110), c);

    const preferences = card(c).gap(G.md)
      .child(cardHeader("Preferences", "", c))
      .child(preferenceRow("Heatmap palette", segmented("ins-palette", [
        { key: "blue", label: "Blue" },
        { key: "green", label: "Green" },
        { key: "purple", label: "Purple" },
      ], config.palette, (key) => this.updateDraft((draft) => { draft.palette = key; }), c), c))
      .child(preferenceRow("Week starts on", segmented("ins-week-start", [
        { key: "0", label: "Sunday" },
        { key: "1", label: "Monday" },
      ], String(config.weekStartsOn), (key) => this.updateDraft((draft) => { draft.weekStartsOn = Number(key); }), c), c))
      .child(preferenceRow(
        "Include cache tokens",
        toggleSwitch("ins-include-cache", config.includeCache, (checked) => this.updateDraft((draft) => { draft.includeCache = checked; }), c, {
          label: "Include cache tokens",
        }),
        c,
      ))
      .child(preferenceRow(
        "Refresh interval",
        h_flex().gap(G.xs).items_center().child(refreshInput).child(mutedText("sec", c)),
        c,
      ));

    const sourceCards = (config.sources ?? []).map((source, index) => {
      const key = sourceKey(source, index);
      const state = this.sourceInputs.get(key);
      return inset(c).gap(G.sm)
        .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center()
          .child(toggleSwitch(`ins-source-${index}`, source?.enabled !== false, (checked) => this.updateDraft((draft) => {
            const target = (draft.sources ?? []).find((item, itemIndex) => sourceKey(item, itemIndex) === key);
            if (target) target.enabled = checked;
          }), c, { label: `${source?.label || source?.adapter || `Source ${index + 1}`} enabled` }))
          .child(fieldLabel(source?.label || source?.adapter || `Source ${index + 1}`, c)))
        .when(state, (el) => el.child(textInput(state)))
        .when(!state, (el) => el.child(mutedText(rootsText(source) || "No roots configured", c)));
    });

    const sources = card(c).gap(G.sm)
      .child(cardHeader("Sources", "", c))
      .when(sourceCards.length === 0, (el) => el.child(mutedText("No sources in this configuration. Add one in the JSON editor.", c)))
      .children(sourceCards);

    const scan = this.statusCard(c, this.snapshot ?? {}, config);

    const json = card(c).gap(G.sm)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
        .child(cardHeader("Configuration JSON", "", c))
        .child(h_flex().flex_wrap().gap(G.xs)
          .child(button("ins-config-format", "Format", (_event, clickCx) => this.formatConfigEditor(clickCx), c, { variant: "outline" }))
          .child(button("ins-config-reset", "Reset", (_event, clickCx) => this.resetConfigDraft(clickCx), c, { variant: "ghost" }))))
      .child(Editor.new(this.configEditor).w_full().h(320).rounded(R.control).border_1().border_color(c.input))
      .child(h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .when(Boolean(this.saveError), (el) => el.child(div().text_size(T.body).text_color(c.destructive).child(this.saveError)))
          .when(Boolean(this.saveMessage), (el) => el.child(div().text_size(T.body).text_color(c.done).child(this.saveMessage))))
        .child(button("ins-config-save", this.saving ? "Saving…" : "Save configuration", (_event, clickCx) => this.saveConfig(clickCx), c, {
          disabled: this.busy(),
          variant: "primary",
        })));

    return v_flex().w_full().gap(G.lg).children([preferences, sources, scan, json]);
  }
}
