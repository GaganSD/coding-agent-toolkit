// Insights: a native, local-only usage dashboard. No DOM, no shell, no stored cx.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState, Popover, Avatar, AvatarImage, AvatarFallback } from "gpui-base";
import { exec, appHome, home, theme, settings, nextCommand, readTextFile } from "herdr";
import {
  PALETTES,
  availableYears,
  clampRefreshSeconds,
  createDashboardCache,
  dayLabel,
  formatBytes,
  formatCompact,
  formatDuration,
  formatInt,
  formatTimestamp,
  heatmapTooltip,
  initials,
  isDay,
  isSnapshot,
  normalizeConfig,
  periodRange,
  projectName,
  safeAvatarPath,
  todayKey,
  weekdayLabels,
} from "./analytics.js";

const CELL = 12;
const CELL_GAP = 2;
const WEEK_WIDTH = CELL + CELL_GAP;
const DAY_LABEL_WIDTH = 30;
const MAX_FACET_OPTIONS = 250;
const DEFAULT_NODE = "node";
const RUNTIME_FILE = "mods/insights/runtime.json";

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

const TILE_COLORS = [
  "#2563eb", "#7c3aed", "#0f766e", "#b45309", "#be185d",
  "#0e7490", "#4d7c0f", "#c2410c", "#4338ca", "#047857",
];

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
  if (!text) throw new Error("The collector returned no snapshot.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The collector returned invalid JSON.");
  }
}

function sourceKey(source, index) {
  return String(source?.id || source?.adapter || `source-${index}`);
}

function rootsText(source) {
  return Array.isArray(source?.roots) ? source.roots.join("\n") : "";
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

function sourceStatusColor(status, t) {
  if (status === "ok") return t.done ?? t.ansi2;
  if (status === "error" || status === "missing") return t.blocked ?? t.ansi1;
  if (status === "empty") return t.accent;
  return t.dim;
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

function hashString(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 31) + text.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

function tileColor(name) {
  return TILE_COLORS[hashString(name) % TILE_COLORS.length];
}

function tileInitials(name) {
  const text = String(name ?? "").trim();
  if (!text) return "?";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) return initials(text, 2);
  const compact = text.replace(/[^a-z0-9]/gi, "");
  return (compact.slice(0, 2) || text.slice(0, 2)).toUpperCase();
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

function changeColor(change, t) {
  if (change?.kind === "up") return t.done ?? t.ansi2;
  if (change?.kind === "down") return t.blocked ?? t.ansi1;
  if (change?.kind === "new") return t.accent;
  return t.dim;
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
    meta: formatCompact(stat.tokens),
    tokens: stat.tokens,
    tooltip: `${formatInt(stat.tokens)} tokens · ${formatInt(stat.sessions)} sessions`,
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
      { value: "all", label: allLabelFor(field), detail: "", meta: formatCompact(total), tokens: total, tooltip: `${formatInt(total)} tokens` },
      ...visible,
    ],
  };
}

function selectedFacet(options, value, field, config) {
  const found = options.find((option) => option.value === value);
  if (found) return found;
  if (value === "all") return { value: "all", label: allLabelFor(field), meta: "", tooltip: "" };
  return { value, label: facetLabel(field, value, config), meta: "", tooltip: "" };
}

function smallButton(id, label, onClick, t, options = {}) {
  return h_flex().id(id).h(30).px(10).items_center().justify_center().rounded(8)
    .border_1().border_color(options.primary ? t.solid : t.border)
    .bg(options.primary ? t.solid : t.raised)
    .opacity(options.disabled ? 0.55 : 1)
    .cursor_pointer().hover((s) => s.opacity(options.disabled ? 0.55 : 0.86))
    .on_click((event, cx) => { if (!options.disabled) onClick(event, cx); })
    .child(div().text_size(11.5).font_medium().text_color(options.primary ? t.solid_foreground : t.foreground).child(label));
}

function iconButton(id, glyph, label, onClick, t, options = {}) {
  return h_flex().id(id).size(30).items_center().justify_center().rounded(8)
    .border_1().border_color(t.border).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
    .accessibility_label(label).tooltip(label).on_click(onClick)
    .child(div().text_size(14).text_color(options.color ?? t.muted).child(glyph));
}

function segmented(id, items, value, onChange, t) {
  return h_flex().id(id).flex_wrap().gap(2).p(2).rounded(9).bg(t.raised).border_1().border_color(t.border)
    .children(items.map((item) => h_flex().id(`${id}-${item.key}`).h(25).px(8).items_center().justify_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .when(value === item.key, (el) => el.bg(t.surface).border_1().border_color(t.border))
      .on_click((_event, cx) => { if (value !== item.key) { onChange(item.key); cx.notify(); } })
      .child(div().text_size(11).font_medium().text_color(value === item.key ? t.foreground : t.muted).child(item.label))));
}

function togglePill(id, checked, onChange, t) {
  return h_flex().id(id).w(38).h(22).p(2).items_center().rounded_full()
    .bg(checked ? t.accent : t.raised).border_1().border_color(checked ? t.accent : t.input)
    .cursor_pointer().on_click((_event, cx) => { onChange(!checked); cx.notify(); })
    .child(div().size(16).rounded_full().bg(checked ? t.accent_foreground : t.muted).when(checked, (el) => el.ml(16)));
}

function card(t, padding = 16) {
  return v_flex().w_full().min_w(0).p(padding).gap(12).rounded(14).bg(t.surface).border_1().border_color(t.border);
}

function field(label, input, t, hint) {
  return v_flex().w_full().gap(5)
    .child(div().text_size(10.5).font_medium().text_color(t.dim).child(label))
    .child(input)
    .when(Boolean(hint), (el) => el.child(div().text_size(10).text_color(t.dim).child(hint)));
}

function detailStat(label, display, t, options = {}) {
  return v_flex().min_w(82).gap(3)
    .child(div().text_size(9.5).font_medium().text_color(t.dim).child(label.toUpperCase()))
    .child(div().text_size(13).font_medium().text_color(options.color ?? t.foreground).truncate()
      .tooltip(options.tooltip ?? String(display)).child(display))
    .when(Boolean(options.note), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(options.note)));
}

function metricCard(label, value, sub, t, options = {}) {
  return v_flex().flex_1().min_w(0).p(12).gap(5).rounded(12).bg(t.surface).border_1().border_color(t.border)
    .child(div().text_size(9.5).font_medium().text_color(t.dim).child(label.toUpperCase()))
    .child(div().text_size(22).font_semibold().text_color(options.color ?? t.foreground).truncate()
      .tooltip(options.tooltip ?? String(value)).child(value))
    .child(div().text_size(10.5).text_color(t.muted).truncate().child(sub));
}

function metricRow(cards) {
  return h_flex().w_full().gap(10).items_stretch().children(cards);
}

export default class Insights extends View {
  init(_props, cx) {
    this.snapshot = null;
    this.loading = false;
    this.error = null;
    this.width = 960;
    this.height = 800;
    this.filters = { source: "all", provider: "all", model: "all", project: "all" };
    this.period = "all";
    this.year = Number(todayKey().slice(0, 4));
    this.heatmapMode = "daily";
    this.leaderboardGroup = "model";
    this.selectedDay = todayKey();
    this.showSettings = false;
    this.openFilter = null;
    this.configDraft = null;
    this.configText = "";
    this.configDirty = false;
    this.editorDirty = false;
    this.profileDirty = false;
    this.rootsDirty = false;
    this.refreshDirty = false;
    this.saving = false;
    this.saveError = null;
    this.saveMessage = null;
    this.syncingInputs = false;
    this.syncingEditor = false;
    this.sourceInputs = new Map();
    this.timer = null;
    this.timerSeconds = null;
    this.commandTask = null;
    this.runtimeTask = null;
    this.runtimeReady = false;
    this.runtimeError = null;
    this.nodeBinary = null;
    this.dashboardCache = createDashboardCache();

    const t = theme();
    const editorOptions = {
      language: "json",
      value: "{}",
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
    if (settings()?.font_family) editorOptions.font_family = settings().font_family;

    this.nameInput = InputState.new({ placeholder: "Your name" });
    this.handleInput = InputState.new({ placeholder: "handle" });
    this.avatarInput = InputState.new({ placeholder: "mods/insights/avatar.png" });
    this.refreshInput = InputState.new({ value: "60" });
    this.configEditor = EditorState.new(editorOptions);

    const markProfile = () => {
      if (this.syncingInputs) return;
      this.profileDirty = true;
      this.configDirty = true;
      this.saveMessage = null;
    };
    for (const state of [this.nameInput, this.handleInput, this.avatarInput]) {
      state.on("change", markProfile);
      state.on("blur", (_event, notifyCx) => notifyCx.notify());
      state.on("submit", (_event, submitCx) => this.saveConfig(submitCx));
    }
    this.refreshInput.on("change", () => {
      if (this.syncingInputs) return;
      this.refreshDirty = true;
      this.configDirty = true;
      this.saveMessage = null;
    });
    this.refreshInput.on("blur", (_event, notifyCx) => notifyCx.notify());
    this.refreshInput.on("submit", (_event, submitCx) => this.saveConfig(submitCx));

    this.configEditor.on("change", () => {
      if (this.syncingEditor) return;
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
        }
      }
    });
  }

  close() {
    try { this.timer?.cancel(); } catch { /* already gone */ }
    try { this.commandTask?.cancel(); } catch { /* already gone */ }
    try { this.runtimeTask?.cancel(); } catch { /* already gone */ }
    for (const state of [this.nameInput, this.handleInput, this.avatarInput, this.refreshInput]) {
      try { state?.release(); } catch { /* already released */ }
    }
    for (const state of this.sourceInputs.values()) {
      try { state.release(); } catch { /* already released */ }
    }
    try { this.configEditor?.release(); } catch { /* already released */ }
  }

  busy() {
    return this.loading || this.saving;
  }

  collectorPath() {
    return `${appHome()}/mods/insights/collector.mjs`;
  }

  runtimePath() {
    return `${appHome()}/${RUNTIME_FILE}`;
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
    const collector = this.collectorPath();
    const store = this.storePath();
    cx.spawn(async (refreshCx) => {
      try {
        const result = await exec(this.nodeBinary, [collector, "snapshot", "--store", store, "--home", home()]);
        if (result.code !== 0) throw new Error(resultError(result));
        const snapshot = parseSnapshot(result.stdout);
        if (!isSnapshot(snapshot)) throw new Error("The collector returned an unexpected snapshot.");
        this.applySnapshot(snapshot, refreshCx);
      } catch (error) {
        this.error = sanitizeError(error);
      } finally {
        this.loading = false;
        refreshCx.notify();
      }
    });
  }

  applySnapshot(snapshot, cx) {
    this.snapshot = snapshot;
    const savedConfig = normalizeConfig(snapshot.config);
    const config = this.configDirty || this.editorDirty ? this.draftConfig(savedConfig) : savedConfig;
    const today = todayKey();
    const years = availableYears(snapshot.rows, today);
    if (!Number.isInteger(this.year) || !years.includes(this.year)) this.year = years[0] ?? Number(today.slice(0, 4));
    if (!isDay(this.selectedDay)) this.selectedDay = today;

    if (!this.configDirty && !this.editorDirty) {
      this.configDraft = deepClone(savedConfig);
      this.setEditorText(prettyJson(this.configDraft));
    }
    // A poll must never release source inputs that only exist in an unsaved draft.
    this.ensureSourceInputs(config);
    if (!this.profileDirty) this.syncProfileInputs(config);
    if (!this.rootsDirty) this.syncSourceInputs(config);
    if (!this.refreshDirty) this.syncRefreshInput(config);
    this.schedule(cx);
  }

  draftConfig(fallback) {
    const base = this.configDraft ?? fallback ?? this.snapshot?.config ?? {};
    if (this.editorDirty) {
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

  syncProfileInputs(config) {
    if (this.profileDirty) return;
    this.syncingInputs = true;
    try {
      this.nameInput.set_value(config.profile.name ?? "");
      this.handleInput.set_value(config.profile.handle ?? "");
      this.avatarInput.set_value(config.profile.avatar ?? "");
    } finally {
      this.syncingInputs = false;
    }
  }

  syncRefreshInput(config) {
    if (this.refreshDirty) return;
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
      this.syncProfileInputs(config);
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
    this.syncProfileInputs(config);
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

    if (!config.profile || typeof config.profile !== "object" || Array.isArray(config.profile)) config.profile = {};
    if (this.profileDirty || !this.editorDirty) {
      config.profile.name = this.nameInput.value().trim();
      config.profile.handle = this.handleInput.value().trim().replace(/^@+/, "");
      config.profile.avatar = this.avatarInput.value().trim();
    }
    config.profile.avatar = safeAvatarPath(config.profile.avatar);

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
      const seconds = Number(this.refreshInput.value());
      if (Number.isFinite(seconds)) config.refreshSeconds = clampRefreshSeconds(seconds);
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
    const collector = this.collectorPath();
    const store = this.storePath();
    cx.spawn(async (saveCx) => {
      try {
        const result = await exec(this.nodeBinary, [
          collector,
          "configure",
          "--store",
          store,
          "--home",
          home(),
          "--config",
          JSON.stringify(config),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        const snapshot = parseSnapshot(result.stdout);
        if (!isSnapshot(snapshot)) throw new Error("The collector returned an unexpected snapshot.");
        this.configDirty = false;
        this.editorDirty = false;
        this.profileDirty = false;
        this.rootsDirty = false;
        this.refreshDirty = false;
        this.error = null;
        this.applySnapshot(snapshot, saveCx);
        this.saveMessage = "Configuration saved.";
      } catch (error) {
        this.saveError = sanitizeError(error);
      } finally {
        this.saving = false;
        saveCx.notify();
      }
    });
  }

  resetConfigDraft(cx) {
    if (!this.snapshot) return;
    const config = normalizeConfig(this.snapshot.config);
    this.configDirty = false;
    this.editorDirty = false;
    this.profileDirty = false;
    this.rootsDirty = false;
    this.refreshDirty = false;
    this.configDraft = deepClone(config);
    this.setEditorText(prettyJson(this.configDraft));
    this.syncProfileInputs(config);
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
    if (this.snapshot) this.ensureSourceInputs(this.draftConfig(normalizeConfig(this.snapshot.config)));
    cx.notify();
  }

  setPeriod(period) {
    this.period = period;
    const today = todayKey();
    const config = normalizeConfig(this.snapshot?.config ?? {});
    if (period === "year") {
      const years = availableYears(this.snapshot?.rows ?? [], today);
      if (!years.includes(this.year)) this.year = years[0] ?? Number(today.slice(0, 4));
    }
    this.selectedDay = periodRange(period, { today, weekStartsOn: config.weekStartsOn, year: this.year }).end;
  }

  setYear(delta) {
    const today = todayKey();
    const years = availableYears(this.snapshot?.rows ?? [], today);
    const current = Math.max(0, years.indexOf(this.year));
    const next = Math.min(years.length - 1, Math.max(0, current + delta));
    this.year = years[next] ?? Number(today.slice(0, 4));
    const config = normalizeConfig(this.snapshot?.config ?? {});
    this.selectedDay = periodRange("year", { today, weekStartsOn: config.weekStartsOn, year: this.year }).end;
  }

  render() {
    const t = theme();
    const width = this.width || 960;
    const padding = width < 620 ? 12 : width < 900 ? 18 : 24;
    const content = [this.header(t)];
    if (this.error && this.snapshot) content.push(this.errorBanner(t));
    if (!this.snapshot) content.push(this.initialState(t));
    else if (this.showSettings) content.push(this.settingsView(t));
    else content.push(this.dashboardView(t));

    return v_flex().id("insights-root").size_full().min_h(0).bg(t.canvas ?? t.background).text_color(t.foreground)
      .overflow_y_scrollbar()
      .on_size_change((size, sizeCx) => {
        const changed = Math.abs((this.width || 0) - size.width) >= 1;
        this.width = size.width;
        this.height = size.height;
        if (changed) sizeCx.notify();
      })
      .child(h_flex().w_full().justify_center().p(padding)
        .child(v_flex().w_full().max_w(1180).gap(14).children(content)));
  }

  header(t) {
    const updated = this.snapshot ? formatTimestamp(this.snapshot.lastScanAt || this.snapshot.generatedAt) : "";
    const status = this.loading ? "Refreshing…" : this.saving ? "Saving…" : this.error ? (this.snapshot ? "Showing last snapshot" : "Unavailable") : updated ? `Updated ${updated}` : "";
    return h_flex().w_full().flex_wrap().gap(10).items_center().justify_between()
      .child(v_flex().gap(2)
        .child(div().text_size(21).font_semibold().child("Insights"))
        .child(div().text_size(11.5).text_color(t.dim).child("Local AI usage · private by design")))
      .child(h_flex().flex_wrap().gap(8).items_center()
        .when(Boolean(status), (el) => el.child(div().text_size(10.5).text_color(this.error ? t.blocked : t.dim).child(status)))
        .child(smallButton("insights-refresh", "↻ Refresh", (_event, clickCx) => this.refresh(clickCx), t, { disabled: this.busy() }))
        .when(Boolean(this.snapshot), (el) => el.child(smallButton(
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
          t,
        ))));
  }

  errorBanner(t) {
    return h_flex().w_full().gap(10).items_start().p(12).rounded(10).bg(t.surface)
      .border_1().border_color(t.blocked)
      .child(div().text_size(13).font_semibold().text_color(t.blocked).child("!"))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(12).font_medium().child("Could not refresh insights"))
        .child(div().text_size(11).text_color(t.muted).child(this.error)))
      .child(smallButton("insights-retry", "Retry", (_event, clickCx) => this.refresh(clickCx), t, { disabled: this.busy() }));
  }

  initialState(t) {
    const title = this.loading ? "Loading local insights" : "Insights needs its collector";
    const body = this.loading
      ? "Reading local session history. Nothing leaves this machine."
      : this.error || "The collector did not return a snapshot yet.";
    return card(t, 20).gap(10)
      .child(h_flex().items_center().gap(9)
        .child(div().size(8).rounded_full().bg(this.loading ? t.accent : t.blocked))
        .child(div().text_size(14).font_semibold().child(title)))
      .child(div().text_size(12).text_color(t.muted).child(body))
      .child(div().text_size(10.5).text_color(t.dim).child("The collector runs as a local Node process and prints one JSON snapshot. No network, no transcripts, no prompts."))
      .when(!this.busy(), (el) => el.child(h_flex().pt(4)
        .child(smallButton("insights-initial-retry", "Retry", (_event, clickCx) => this.refresh(clickCx), t, { primary: true }))));
  }

  dashboardView(t) {
    const snapshot = this.snapshot;
    const derived = this.dashboardCache.read(snapshot, {
      filters: this.filters,
      period: this.period,
      year: this.year,
      heatmapMode: this.heatmapMode,
      leaderboardGroup: this.leaderboardGroup,
      selectedDay: this.selectedDay,
      today: todayKey(),
    });
    const { config, rows, range, lifetime, peak, streaks, heatmap, totals, leaders, selectedDay, selectedRows, selectedTotals, selectedTop } = derived;

    return v_flex().w_full().gap(14)
      .child(this.hero(t, config, lifetime, streaks))
      .child(this.filtersBar(t, rows, config, range, derived.facets, derived.today))
      .when(rows.length === 0, (el) => el.child(this.emptyNotice(t, config)))
      .child(this.metricStrip(t, lifetime, peak, streaks))
      .child(this.heatmapCard(t, config, heatmap, selectedDay, selectedRows, selectedTotals, selectedTop))
      .child(this.leaderboardCard(t, leaders, range))
      .child(this.bottomGrid(t, totals, range, config, snapshot));
  }

  hero(t, config, lifetime, streaks) {
    const avatarPath = safeAvatarPath(config.profile.avatar);
    const avatar = Avatar.new().size(84).rounded_full().overflow_hidden().bg(t.raised).border_1().border_color(t.border)
      .when(Boolean(avatarPath), (el) => el.image(AvatarImage.new(avatarPath).size_full()))
      .fallback(AvatarFallback.new().size_full().items_center().justify_center()
        .child(div().text_size(27).font_semibold().text_color(t.accent).child(initials(config.profile.name || "Insights"))));

    const nameInput = Input.new(this.nameInput).w_full().max_w(340).h(38).px(10).text_center().text_size(25)
      .font_semibold().text_color(t.foreground).bg(t.canvas).rounded(9).border_1().border_color(t.border)
      .focus((style) => style.border_color(t.accent));
    const handleInput = Input.new(this.handleInput).w(170).h(30).px(8).text_size(12.5)
      .text_color(t.foreground).bg(t.canvas).rounded(8).border_1().border_color(t.border)
      .focus((style) => style.border_color(t.accent));

    return v_flex().w_full().items_center().gap(8).py(8)
      .child(avatar)
      .child(nameInput)
      .child(h_flex().items_center().gap(2)
        .child(div().text_size(13).text_color(t.dim).child("@"))
        .child(handleInput))
      .child(div().text_size(10.5).text_color(t.dim)
        .child(`${formatInt(lifetime.sessions)} sessions · ${formatInt(streaks.activeDays)} active days`))
      .when(this.profileDirty, (el) => el.child(smallButton(
        "insights-save-profile",
        this.saving ? "Saving…" : "Save profile",
        (_event, clickCx) => this.saveConfig(clickCx),
        t,
        { primary: true, disabled: this.busy() },
      )));
  }

  filtersBar(t, rows, config, range, facets, today) {
    const sourceOptions = buildFacetOptions("source", facets.source, config);
    const providerOptions = buildFacetOptions("provider", facets.provider, config);
    const modelOptions = buildFacetOptions("model", facets.model, config);
    const projectOptions = buildFacetOptions("project", facets.project, config);
    const years = availableYears(rows, today);
    const active = Object.values(this.filters).some((value) => value !== "all");

    return card(t, 12).gap(9)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center()
        .child(segmented("ins-period", [
          { key: "week", label: "Week" },
          { key: "month", label: "Month" },
          { key: "year", label: "Year" },
          { key: "all", label: "All" },
        ], this.period, (key) => this.setPeriod(key), t))
        .when(this.period === "year", (el) => el.child(h_flex().gap(4).items_center()
          .child(iconButton("ins-year-older", "‹", "Older year", (_event, clickCx) => { this.setYear(1); clickCx.notify(); }, t))
          .child(div().min_w(38).text_center().text_size(12).font_medium().child(String(this.year)))
          .child(iconButton("ins-year-newer", "›", "Newer year", (_event, clickCx) => { this.setYear(-1); clickCx.notify(); }, t, { color: this.year >= years[0] ? t.dim : t.muted })))))
      .child(h_flex().w_full().flex_wrap().gap(8).items_center()
        .child(this.filterMenu("source", "Source", this.filters.source, sourceOptions, t, (value) => { this.filters.source = value; }))
        .child(this.filterMenu("provider", "Provider", this.filters.provider, providerOptions, t, (value) => { this.filters.provider = value; }))
        .child(this.filterMenu("model", "Model", this.filters.model, modelOptions, t, (value) => { this.filters.model = value; }))
        .child(this.filterMenu("project", "Project", this.filters.project, projectOptions, t, (value) => { this.filters.project = value; }))
        .when(active, (el) => el.child(smallButton("ins-clear-filters", "Clear filters", (_event, clickCx) => {
          this.filters = { source: "all", provider: "all", model: "all", project: "all" };
          clickCx.notify();
        }, t))))
      .child(div().text_size(10.5).text_color(t.dim).child(this.period === "all" ? range.label : `${range.label} · calendar period`));
  }

  filterMenu(field, label, value, facet, t, onPick) {
    const selected = selectedFacet(facet.options, value, field, normalizeConfig(this.snapshot?.config ?? {}));
    const trigger = h_flex().id(`ins-${field}-trigger`).h(31).px(9).gap(8).items_center().rounded(8)
      .border_1().border_color(value === "all" ? t.border : t.accent).bg(t.surface).cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .child(div().text_size(10).font_medium().text_color(t.dim).child(label))
      .child(div().max_w(132).truncate().text_size(11.5).text_color(t.foreground).child(selected.label))
      .child(div().text_size(11).text_color(t.dim).child("⌄"));

    const content = v_flex().w(230).max_h(310).overflow_y_scrollbar().p(4).gap(1).rounded(10)
      .bg(t.popover).border_1().border_color(t.border).shadow_md()
      .children(facet.options.map((option, index) => h_flex().id(`ins-${field}-option-${index}`)
        .h(28).px(7).gap(7).items_center().rounded(6).cursor_pointer()
        .when(option.value === value, (el) => el.bg(t.selected))
        .hover((style) => style.bg(t.hover))
        .on_click((_event, clickCx) => {
          this.openFilter = null;
          onPick(option.value);
          clickCx.notify();
        })
        .child(div().w(12).text_size(10).text_color(t.accent).child(option.value === value ? "✓" : ""))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(11.5).text_color(t.foreground).truncate().tooltip(option.tooltip || option.label).child(option.label))
          .when(Boolean(option.detail), (el) => el.child(div().text_size(9.5).text_color(t.dim).truncate().child(option.detail))))
        .child(div().text_size(9.5).text_color(t.dim).child(option.meta ?? ""))))
      .when(facet.truncated, (el) => el.child(div().p(6).text_size(9.5).text_color(t.dim)
        .child(`Showing top ${MAX_FACET_OPTIONS} by tokens.`)));

    return Popover.new(`ins-${field}-filter`).trigger(trigger).content(content)
      .open(this.openFilter === `ins-${field}-filter`)
      .on_open_change((open, changeCx) => {
        this.openFilter = open ? `ins-${field}-filter` : null;
        changeCx.notify();
      });
  }

  emptyNotice(t, config) {
    const roots = [];
    for (const source of config.sources ?? []) {
      if (source?.enabled === false) continue;
      for (const root of source.roots ?? []) roots.push(root);
    }
    return card(t, 16).gap(8)
      .child(h_flex().items_center().gap(9)
        .child(div().size(8).rounded_full().bg(t.accent))
        .child(div().text_size(13).font_semibold().child("No usage found yet")))
      .child(div().text_size(11.5).text_color(t.muted)
        .child("Enable a source and check its roots. Insights only reads local harness session files and never stores prompts or code."))
      .when(roots.length > 0, (el) => el.child(v_flex().gap(2)
        .children(roots.slice(0, 4).map((root) => div().text_size(10.5).text_color(t.dim).truncate().child(root)))))
      .child(h_flex().pt(2)
        .child(smallButton("ins-empty-settings", "Open settings", (_event, clickCx) => this.openSettings(clickCx), t)));
  }

  metricStrip(t, lifetime, peak, streaks) {
    const cards = [
      metricCard("Lifetime tokens", formatCompact(lifetime.total), `${formatInt(lifetime.sessions)} sessions · all time`, t, {
        tooltip: `${formatInt(lifetime.total)} tokens${lifetime.reasoning ? ` · ${formatInt(lifetime.reasoning)} reasoning inside output` : ""}`,
      }),
      metricCard("Peak day", peak.day ? formatCompact(peak.tokens) : "—", peak.day ? dayLabel(peak.day) : "No activity yet", t, {
        tooltip: peak.day ? `${formatInt(peak.tokens)} tokens on ${dayLabel(peak.day)}` : "No activity yet",
      }),
      metricCard("Longest task", formatDuration(lifetime.longestTaskMs), "Observed task span", t, {
        tooltip: lifetime.longestTaskMs > 0 ? `${formatInt(lifetime.longestTaskMs)} ms observed` : "Unknown task duration",
      }),
      metricCard("Longest streak", `${formatInt(streaks.longest)}d`, "Consecutive active days", t, {
        tooltip: `${formatInt(streaks.longest)} consecutive active days`,
      }),
      metricCard("Current streak", `${formatInt(streaks.current)}d`, streaks.current > 0 ? "Includes yesterday grace" : "No active streak", t, {
        color: streaks.current > 0 ? t.accent : t.foreground,
        tooltip: `${formatInt(streaks.current)} current consecutive active days`,
      }),
    ];
    if ((this.width || 960) >= 860) return metricRow(cards);
    if ((this.width || 960) >= 560) {
      return v_flex().w_full().gap(10)
        .child(metricRow(cards.slice(0, 3)))
        .child(metricRow(cards.slice(3)));
    }
    return v_flex().w_full().gap(10)
      .child(metricRow(cards.slice(0, 2)))
      .child(metricRow(cards.slice(2, 4)))
      .child(metricRow(cards.slice(4)));
  }

  heatmapCard(t, config, heatmap, selectedDay, selectedRows, selectedTotals, selectedTop) {
    const dark = isDarkTheme(t);
    const palette = PALETTES.includes(config.palette) ? config.palette : "blue";
    const contentWidth = DAY_LABEL_WIDTH + (heatmap.weeks.length * WEEK_WIDTH);
    const months = heatmap.months.map((month) => div().w(month.span * WEEK_WIDTH).flex_none()
      .text_size(9.5).text_color(t.dim).child(month.label));
    const weekLabels = weekdayLabels(heatmap.weekStartsOn).map((label) => div().h(CELL).text_size(9)
      .text_color(t.dim).child(label));

    const cellElement = (cell) => {
      const color = cell.future
        ? t.raised
        : cell.level > 0 ? heatColor(cell.level, palette, dark) : t.raised;
      return div().id(`ins-cell-${cell.date}`).size(CELL).flex_none().rounded(3).bg(color)
        .opacity(cell.future ? 0.35 : 1)
        .when(!cell.future, (el) => el.cursor_pointer()
          .hover((style) => style.opacity(0.8))
          .on_click((_event, clickCx) => { this.selectedDay = cell.date; clickCx.notify(); })
          .tooltip(heatmapTooltip(cell, heatmap.mode)))
        .when(cell.date === selectedDay, (el) => el.border_1().border_color(t.accent));
    };
    const weekElements = heatmap.weeks.map((week) => v_flex().gap(CELL_GAP).children(week.days.map(cellElement)));
    const grid = v_flex().w(contentWidth).flex_none().gap(4)
      .child(h_flex().h(15).children([
        div().w(DAY_LABEL_WIDTH).flex_none(),
        ...months,
      ]))
      .child(h_flex().gap(CELL_GAP).items_start()
        .child(v_flex().w(DAY_LABEL_WIDTH).flex_none().gap(CELL_GAP).children(weekLabels))
        .child(h_flex().gap(CELL_GAP).children(weekElements)));

    const legend = h_flex().w_full().flex_wrap().gap(7).items_center().justify_end()
      .child(div().text_size(9.5).text_color(t.dim).child("Less"))
      .children([0, 1, 2, 3, 4].map((level) => div().size(10).rounded(2)
        .bg(level === 0 ? t.raised : heatColor(level, palette, dark))))
      .child(div().text_size(9.5).text_color(t.dim).child("More"))
      .child(div().text_size(9.5).text_color(t.dim).child(`${formatCompact(heatmap.windowTotal)} in window`));

    return card(t).gap(12)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(14).font_semibold().child("Contribution history"))
          .child(div().text_size(10.5).text_color(t.dim)
            .child(`53 weeks · ends ${dayLabel(heatmap.range.dataEnd)} · ${config.includeCache ? "cache included" : "cache excluded"}`)))
        .child(segmented("ins-heat-mode", [
          { key: "daily", label: "Daily" },
          { key: "weekly", label: "Weekly" },
          { key: "cumulative", label: "Cumulative" },
        ], this.heatmapMode, (key) => { this.heatmapMode = key; }, t)))
      .child(v_flex().w_full().overflow_x_scrollbar().child(grid))
      .child(legend)
      .child(this.selectedDetail(t, heatmap, selectedDay, selectedRows, selectedTotals, selectedTop));
  }

  selectedDetail(t, heatmap, selectedDay, selectedRows, selectedTotals, selectedTop) {
    const cell = heatmap.cells.find((item) => item.date === selectedDay);
    const modeLabel = heatmap.mode === "weekly" ? "Week total" : heatmap.mode === "cumulative" ? "Cumulative through day" : "Daily tokens";
    const value = cell ? formatCompact(cell.value) : "0";
    const exact = cell ? formatInt(cell.value) : "0";
    const dayExact = formatInt(selectedTotals.total);
    const cacheNote = heatmap.includeCache ? "included" : "excluded";

    return v_flex().w_full().gap(10).p(12).rounded(10).bg(t.raised).border_1().border_color(t.border)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(12).font_medium().child(dayLabel(selectedDay, { weekday: true, longWeekday: true })))
          .child(div().text_size(10).text_color(t.dim).child(`${modeLabel}${heatmap.mode === "daily" ? "" : ` · this day ${formatCompact(selectedTotals.total)} tokens`}`)))
        .child(v_flex().items_end().gap(1)
          .child(div().text_size(18).font_semibold().tooltip(`${exact} tokens`).child(value))
          .child(div().text_size(9.5).text_color(t.dim).child(`${dayExact} tokens on this day`))))
      .when(selectedRows.length === 0, (el) => el.child(div().text_size(11).text_color(t.muted)
        .child("No usage recorded on this day.")))
      .child(h_flex().w_full().flex_wrap().gap(14)
        .child(detailStat("Input", formatCompact(selectedTotals.input), t, { tooltip: `${formatInt(selectedTotals.input)} input tokens` }))
        .child(detailStat("Output", formatCompact(selectedTotals.output), t, {
          note: "includes reasoning",
          tooltip: `${formatInt(selectedTotals.output)} output tokens · reasoning ${formatInt(selectedTotals.reasoning)}`,
        }))
        .child(detailStat("Cache read", formatCompact(selectedTotals.cacheRead), t, {
          note: cacheNote,
          tooltip: `${formatInt(selectedTotals.cacheRead)} cache-read tokens`,
        }))
        .child(detailStat("Cache write", formatCompact(selectedTotals.cacheWrite), t, {
          note: cacheNote,
          tooltip: `${formatInt(selectedTotals.cacheWrite)} cache-write tokens`,
        })))
      .child(h_flex().w_full().flex_wrap().gap(14)
        .child(detailStat("Sessions", formatInt(selectedTotals.sessions), t, { tooltip: `${formatInt(selectedTotals.sessions)} sessions on this day` }))
        .child(detailStat("Messages", formatInt(selectedTotals.messages), t, { tooltip: `${formatInt(selectedTotals.messages)} messages with usage` }))
        .child(detailStat("Longest task", formatDuration(selectedTotals.longestTaskMs), t, {
          tooltip: selectedTotals.longestTaskMs > 0 ? `${formatInt(selectedTotals.longestTaskMs)} ms observed` : "Unknown task duration",
        }))
        .when(Boolean(selectedTop), (el) => el.child(detailStat("Top model", selectedTop.name, t, {
          note: selectedTop.sublabel,
          tooltip: `${selectedTop.name} · ${selectedTop.sublabel}`,
        }))));
  }

  leaderboardCard(t, leaders, range) {
    const entries = leaders.entries;
    const half = Math.ceil(entries.length / 2);
    const left = entries.slice(0, half);
    const right = entries.slice(half);
    const twoColumns = (this.width || 960) >= 960 && right.length > 0;

    const row = (entry) => v_flex().w_full().gap(6).p(9).rounded(10).bg(t.background).border_1().border_color(t.border)
      .child(h_flex().items_center().gap(9)
        .child(div().w(22).text_size(10.5).text_color(t.dim).child(`#${entry.rank}`))
        .child(div().size(30).flex_none().rounded(8).bg(tileColor(entry.name)).items_center().justify_center()
          .child(div().text_size(10).font_semibold().text_color("#ffffff").child(tileInitials(entry.name))))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(12).font_medium().text_color(t.foreground).truncate().tooltip(entry.name).child(entry.name))
          .child(div().text_size(10).text_color(t.dim).truncate().child(entry.sublabel)))
        .child(v_flex().items_end().gap(1)
          .child(div().text_size(12).font_semibold().text_color(t.foreground).tooltip(`${formatInt(entry.tokens)} tokens`).child(formatCompact(entry.tokens)))
          .child(div().text_size(9.5).text_color(changeColor(entry.change, t))
            .tooltip(entry.change.kind === "none" ? "No previous period" : `Previous ${formatInt(entry.previous ?? 0)} tokens`)
            .child(`${entry.change.kind === "up" ? "▲ " : entry.change.kind === "down" ? "▼ " : ""}${entry.change.label}`))))
      .child(h_flex().h(3).w_full().rounded(2).bg(t.raised)
        .child(h_flex().h(3).rounded(2).bg(t.accent).flex_grow(Math.max(0.001, entry.sharePct)))
        .child(div().flex_grow(Math.max(0.001, 100 - entry.sharePct))));

    const empty = v_flex().w_full().items_center().gap(8).p(18)
      .child(div().text_size(12).font_medium().child("No usage in this period"))
      .child(div().text_size(10.5).text_color(t.dim).child("Try All time, another year, or clear the filters."))
      .child(smallButton("ins-leaders-all", "Show all time", (_event, clickCx) => {
        this.setPeriod("all");
        clickCx.notify();
      }, t));

    return card(t).gap(11)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(14).font_semibold().child("Usage leaders"))
          .child(div().text_size(10.5).text_color(t.dim)
            .child(`${range.label} · ${formatCompact(leaders.totalTokens)} tokens · ${formatInt(leaders.totalSessions)} sessions${leaders.hasPrevious ? "" : " · no previous period"}`)))
        .child(segmented("ins-leaders-group", [
          { key: "model", label: "Models" },
          { key: "provider", label: "Providers" },
        ], this.leaderboardGroup, (key) => { this.leaderboardGroup = key; }, t)))
      .when(entries.length === 0, (el) => el.child(empty))
      .when(entries.length > 0 && twoColumns, (el) => el.child(h_flex().w_full().gap(10).items_start()
        .child(v_flex().flex_1().min_w(0).gap(7).children(left.map(row)))
        .child(v_flex().flex_1().min_w(0).gap(7).children(right.map(row)))))
      .when(entries.length > 0 && !twoColumns, (el) => el.child(v_flex().w_full().gap(7).children(entries.map(row))))
      .when(leaders.totalGroups > entries.length, (el) => el.child(div().text_size(9.5).text_color(t.dim)
        .child(`Showing top ${entries.length} of ${leaders.totalGroups} by tokens.`)));
  }

  bottomGrid(t, totals, range, config, snapshot) {
    const breakdown = this.breakdownCard(t, totals, range, config);
    const status = this.statusCard(t, snapshot, config);
    if ((this.width || 960) >= 960) {
      return h_flex().w_full().gap(14).items_start()
        .child(div().flex_1().min_w(0).child(breakdown))
        .child(div().flex_1().min_w(0).child(status));
    }
    return v_flex().w_full().gap(14).children([breakdown, status]);
  }

  breakdownCard(t, totals, range, config) {
    const cacheNote = config.includeCache ? "included in totals" : "excluded from totals";
    return card(t).gap(11)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(14).font_semibold().child("Token breakdown"))
          .child(div().text_size(10.5).text_color(t.dim).child(`${range.label} · ${cacheNote}`)))
        .child(div().text_size(18).font_semibold().tooltip(`${formatInt(totals.total)} tokens`).child(formatCompact(totals.total))))
      .child(h_flex().w_full().flex_wrap().gap(14)
        .child(detailStat("Input", formatCompact(totals.input), t, { tooltip: `${formatInt(totals.input)} input tokens` }))
        .child(detailStat("Output", formatCompact(totals.output), t, {
          note: "includes reasoning",
          tooltip: `${formatInt(totals.output)} output tokens · reasoning ${formatInt(totals.reasoning)}`,
        }))
        .child(detailStat("Cache read", formatCompact(totals.cacheRead), t, {
          note: cacheNote,
          tooltip: `${formatInt(totals.cacheRead)} cache-read tokens`,
        }))
        .child(detailStat("Cache write", formatCompact(totals.cacheWrite), t, {
          note: cacheNote,
          tooltip: `${formatInt(totals.cacheWrite)} cache-write tokens`,
        })))
      .child(div().text_size(9.5).text_color(t.dim)
        .child(`Reasoning ${formatInt(totals.reasoning)} is already inside output and is never added twice.`));
  }

  statusCard(t, snapshot, config) {
    const stats = snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : null;
    const errors = stats && Number.isFinite(Number(stats.errors)) ? Number(stats.errors) : null;
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.map(warningText).filter(Boolean) : [];
    const sources = config.sources ?? [];
    return card(t).gap(11)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(14).font_semibold().child("Scan status"))
          .child(div().text_size(10.5).text_color(t.dim)
            .child(`Generated ${formatTimestamp(snapshot.generatedAt) || "unknown"} · last scan ${formatTimestamp(snapshot.lastScanAt) || "unknown"}`)))
        .child(div().text_size(10.5).text_color(errors > 0 ? t.blocked : errors === 0 ? t.done : t.dim)
          .child(errors === null ? "No scan stats" : errors > 0 ? `${formatInt(errors)} errors` : "No scan errors")))
      .child(h_flex().w_full().flex_wrap().gap(14)
        .child(detailStat("Files", statCount(stats?.files), t, { tooltip: stats?.files === undefined ? "No scan stats" : `${formatInt(stats.files)} files indexed` }))
        .child(detailStat("Read", statCount(stats?.filesRead), t, { tooltip: stats?.filesRead === undefined ? "No scan stats" : `${formatInt(stats.filesRead)} files read` }))
        .child(detailStat("Unchanged", statCount(stats?.unchangedFiles), t, { tooltip: stats?.unchangedFiles === undefined ? "No scan stats" : `${formatInt(stats.unchangedFiles)} unchanged files` }))
        .child(detailStat("Bytes", statBytes(stats?.bytesRead), t, { tooltip: stats?.bytesRead === undefined ? "No scan stats" : `${formatInt(stats.bytesRead)} bytes read` })))
      .child(v_flex().w_full().gap(6)
        .children(sources.map((source, index) => {
          const entry = sourceStatEntry(snapshot, source);
          const status = entry?.status || (source?.enabled === false ? "disabled" : "enabled");
          const statsText = sourceStatsText(entry);
          return h_flex().w_full().gap(8).items_center()
            .opacity(source?.enabled === false ? 0.55 : 1)
            .child(div().size(7).flex_none().rounded_full().bg(sourceStatusColor(status, t)))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(11.5).text_color(t.foreground).child(source?.label || source?.adapter || `Source ${index + 1}`))
              .child(div().text_size(9.5).text_color(t.dim).truncate()
                .child([(Array.isArray(source?.roots) ? source.roots.join(" · ") : ""), statsText].filter(Boolean).join(" · ") || "No roots configured")))
            .child(v_flex().items_end().gap(1)
              .child(div().text_size(9).text_color(sourceStatusColor(status, t)).child(sourceStatusLabel(status)))
              .child(div().text_size(9).text_color(t.dim).child(source?.adapter || "")));
        })))
      .when(sources.length === 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("No sources configured.")))
      .child(v_flex().w_full().gap(3)
        .child(div().text_size(10).font_medium().text_color(t.dim).child("WARNINGS"))
        .when(warnings.length === 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("No scan warnings.")))
        .children(warnings.slice(0, 6).map((warning) => h_flex().w_full().gap(6).items_start()
          .child(div().text_size(10).text_color(t.blocked).child("!"))
          .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.muted).child(warning))))
        .when(warnings.length > 6, (el) => el.child(div().text_size(9.5).text_color(t.dim).child(`+${warnings.length - 6} more warnings`))));
  }

  settingsView(t) {
    const config = normalizeConfig(this.configDraft ?? this.snapshot?.config ?? {});
    const textInput = (state) => Input.new(state).w_full().h(34).px(10).rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground).focus((style) => style.border_color(t.accent));
    const refreshInput = Input.new(this.refreshInput).w(110).h(34).px(10).rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground).focus((style) => style.border_color(t.accent));

    const profile = card(t).gap(11)
      .child(v_flex().gap(2)
        .child(div().text_size(14).font_semibold().child("Profile"))
        .child(div().text_size(10.5).text_color(t.dim).child("Shown at the top of the dashboard.")))
      .child(field("Avatar path", textInput(this.avatarInput), t, "A local path under the Herdr app folder, such as mods/insights/avatar.png. Remote URLs are ignored; initials are used when empty."))
      .child(field("Name", textInput(this.nameInput), t))
      .child(field("Handle", textInput(this.handleInput), t, "Stored without the @."));

    const preferences = card(t).gap(13)
      .child(v_flex().gap(2)
        .child(div().text_size(14).font_semibold().child("Preferences"))
        .child(div().text_size(10.5).text_color(t.dim).child("Theme-adaptive dashboard settings.")))
      .child(h_flex().w_full().flex_wrap().gap(12).items_center().justify_between()
        .child(v_flex().gap(2).child(div().text_size(11.5).font_medium().child("Heatmap palette")).child(div().text_size(9.5).text_color(t.dim).child("Blue, green or purple intensity.")))
        .child(segmented("ins-palette", [
          { key: "blue", label: "Blue" },
          { key: "green", label: "Green" },
          { key: "purple", label: "Purple" },
        ], config.palette, (key) => this.updateDraft((draft) => { draft.palette = key; }), t)))
      .child(h_flex().w_full().flex_wrap().gap(12).items_center().justify_between()
        .child(v_flex().gap(2).child(div().text_size(11.5).font_medium().child("Week starts on")).child(div().text_size(9.5).text_color(t.dim).child("Calendar weeks and heatmap rows.")))
        .child(segmented("ins-week-start", [
          { key: "0", label: "Sunday" },
          { key: "1", label: "Monday" },
        ], String(config.weekStartsOn), (key) => this.updateDraft((draft) => { draft.weekStartsOn = Number(key); }), t)))
      .child(h_flex().w_full().flex_wrap().gap(12).items_center().justify_between()
        .child(v_flex().gap(2).child(div().text_size(11.5).font_medium().child("Include cache tokens"))
          .child(div().text_size(9.5).text_color(t.dim).child("Count cache read/write in totals and heatmap intensity.")))
        .child(togglePill("ins-include-cache", config.includeCache, (checked) => this.updateDraft((draft) => { draft.includeCache = checked; }), t)))
      .child(h_flex().w_full().flex_wrap().gap(12).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(11.5).font_medium().child("Refresh interval"))
          .child(div().text_size(9.5).text_color(t.dim).child("Seconds, 30 to 3600. Default 60.")))
        .child(h_flex().gap(6).items_center().child(refreshInput).child(div().text_size(10).text_color(t.dim).child("sec"))));

    const sourceCards = (config.sources ?? []).map((source, index) => {
      const key = sourceKey(source, index);
      const state = this.sourceInputs.get(key);
      return v_flex().w_full().gap(6).p(10).rounded(10).bg(t.raised).border_1().border_color(t.border)
        .child(h_flex().w_full().flex_wrap().gap(8).items_center()
          .child(togglePill(`ins-source-${index}`, source?.enabled !== false, (checked) => this.updateDraft((draft) => {
            const target = (draft.sources ?? []).find((item, itemIndex) => sourceKey(item, itemIndex) === key);
            if (target) target.enabled = checked;
          }), t))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(11.5).font_medium().child(source?.label || source?.adapter || `Source ${index + 1}`))
            .child(div().text_size(9.5).text_color(t.dim).child(`adapter ${source?.adapter || source?.id || "unknown"} · ${source?.enabled === false ? "disabled" : "enabled"}`))))
        .when(state, (el) => el.child(textInput(state)))
        .when(!state, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(rootsText(source) || "No roots configured")))
        .child(div().text_size(9.5).text_color(t.dim).child("One root per line or comma-separated."));
    });

    const sources = card(t).gap(10)
      .child(v_flex().gap(2)
        .child(div().text_size(14).font_semibold().child("Sources"))
        .child(div().text_size(10.5).text_color(t.dim).child("Toggle harnesses and edit their roots. Changed mappings are invalidated by the collector.")))
      .when(sourceCards.length === 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("No sources in this configuration. Add one in the JSON editor.")))
      .children(sourceCards)
      .child(div().text_size(9.5).text_color(t.dim).child("Custom JSONL adapters are declarative field mappings in the configuration JSON below."));

    const json = card(t).gap(10)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(14).font_semibold().child("Configuration JSON"))
          .child(div().text_size(10.5).text_color(t.dim).child("Full declarative config, including custom adapters.")))
        .child(h_flex().flex_wrap().gap(6)
          .child(smallButton("ins-config-format", "Format", (_event, clickCx) => this.formatConfigEditor(clickCx), t))
          .child(smallButton("ins-config-reset", "Reset", (_event, clickCx) => this.resetConfigDraft(clickCx), t))))
      .child(Editor.new(this.configEditor).w_full().h(330).rounded(8).border_1().border_color(t.border))
      .child(div().text_size(9.5).text_color(t.dim)
        .child("Saved with the collector's configure command. Invalid JSON or an invalid adapter is reported below and nothing is written."));

    const save = card(t).gap(9)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .when(Boolean(this.saveError), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.saveError)))
          .when(Boolean(this.saveMessage), (el) => el.child(div().text_size(11).text_color(t.done).child(this.saveMessage)))
          .when(!this.saveError && !this.saveMessage, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("Changes are validated before they are saved."))))
        .child(smallButton("ins-config-save", this.saving ? "Saving…" : "Save configuration", (_event, clickCx) => this.saveConfig(clickCx), t, {
          primary: true,
          disabled: this.busy(),
        })));

    return v_flex().w_full().gap(14)
      .child(h_flex().w_full().flex_wrap().gap(8).items_center().justify_between()
        .child(v_flex().gap(2)
          .child(div().text_size(18).font_semibold().child("Settings"))
          .child(div().text_size(10.5).text_color(t.dim).child("Profile, sources and the complete declarative configuration.")))
        .child(smallButton("ins-settings-back", "Back to dashboard", (_event, clickCx) => {
          this.showSettings = false;
          clickCx.notify();
        }, t)))
      .child(profile)
      .child(preferences)
      .child(sources)
      .child(json)
      .child(save);
  }
}
