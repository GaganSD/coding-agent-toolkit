import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mainSource = await readFile(new URL("../mods/insights/main.js", import.meta.url), "utf8");
const analyticsSource = await readFile(new URL("../mods/insights/analytics.js", import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const analyticsUrl = dataUrl(analyticsSource);
const analytics = await import(analyticsUrl);
const analyticsNames = Object.keys(analytics).join(", ");
const { compactDashboard, deriveDashboard } = analytics;

globalThis.__insightsTestHostCalls = { inputStates: 0, editorStates: 0 };

globalThis.__insightsTestInputState = {
  new(options = {}) {
    globalThis.__insightsTestHostCalls.inputStates += 1;
    const state = {
      text: String(options.value ?? ""),
      released: false,
      handlers: new Map(),
      value() { return state.text; },
      set_value(value) { state.text = String(value); },
      on(name, handler) { state.handlers.set(name, handler); },
      release() { state.released = true; },
    };
    return state;
  },
};

globalThis.__insightsTestEditorState = {
  new(options = {}) {
    globalThis.__insightsTestHostCalls.editorStates += 1;
    const state = {
      text: String(options.value ?? "{}"),
      released: false,
      value() { return state.text; },
      set_value(value) { state.text = String(value); },
      on() {},
      release() { state.released = true; },
    };
    return state;
  },
};

const transformedMain = mainSource
  .replace(/^import \{ View, div \} from "gpui-kit";$/m, "const View = class View {};")
  .replace(
    /^import \{[^}]*\} from "gpui-base";$/m,
    "const InputState = globalThis.__insightsTestInputState;\nconst EditorState = globalThis.__insightsTestEditorState;",
  )
  .replace(
    /^import \{[^}]*\} from "herdr";$/m,
    `const appHome = () => "/app";
const home = () => "/home";
const theme = () => ({});
const settings = () => ({});
const nextCommand = () => globalThis.__insightsTestHerdr.nextCommand();
const exec = (...args) => globalThis.__insightsTestHerdr.exec(...args);
const readTextFile = (...args) => globalThis.__insightsTestHerdr.readTextFile(...args);`,
  )
  .replace(
    /^import \{[\s\S]*?\} from "\.\/analytics\.js";$/m,
    `const { ${analyticsNames} } = await import("${analyticsUrl}");`,
  );
const { default: Insights } = await import(dataUrl(transformedMain));

function optionArgument(args) {
  const index = args.indexOf("--options");
  return index >= 0 ? JSON.parse(args[index + 1]) : {};
}

function compactSnapshotFor(snapshot) {
  const { rows, ...rest } = snapshot;
  return { ...rest, rowCount: rows.length };
}

function presentationFor(snapshot, options, command = "snapshot") {
  return {
    version: 1,
    kind: "insights-presentation",
    command,
    options,
    snapshot: compactSnapshotFor(snapshot),
    dashboard: compactDashboard(deriveDashboard(snapshot, options)),
    error: null,
  };
}

function useHerdr({ readTextFile, execResult } = {}) {
  const state = { runtimeReads: [], execCalls: [] };
  state.herdr = {
    appHome: () => "/app",
    home: () => "/home",
    theme: () => ({}),
    settings: () => ({}),
    nextCommand: () => new Promise(() => {}),
    readTextFile: async (path) => {
      state.runtimeReads.push(path);
      return readTextFile ? readTextFile(path) : null;
    },
    exec: async (command, args) => {
      state.execCalls.push({ command, args });
      if (execResult) return execResult(command, args, state);
      const options = optionArgument(args);
      const payload = presentationFor(savedSnapshot(), options, args[1] ?? "snapshot");
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    },
  };
  globalThis.__insightsTestHerdr = state.herdr;
  return state;
}

function liveCx() {
  const calls = { notify: 0, spawn: 0, timers: [], after: [] };
  const cx = {
    calls,
    notify() { calls.notify += 1; },
    spawn(fn) {
      calls.spawn += 1;
      let cancelled = false;
      const done = Promise.resolve().then(() => (cancelled ? undefined : fn(cx)));
      return { cancel() { cancelled = true; return done; }, done };
    },
    timer: {
      every(ms, fn) {
        const timer = { ms, fn, cancel() {} };
        calls.timers.push(timer);
        return timer;
      },
      after(ms, fn) {
        const timer = {
          ms,
          fn: () => fn(cx),
          cancelled: false,
          cancel() { timer.cancelled = true; },
        };
        calls.after.push(timer);
        return timer;
      },
    },
  };
  calls.runAfter = async () => {
    const pending = calls.after.splice(0);
    for (const timer of pending) {
      if (!timer.cancelled) timer.fn();
    }
    await flush();
  };
  return { cx, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeCx() {
  const calls = { notify: 0, spawn: 0, after: [] };
  return {
    calls,
    notify() { calls.notify += 1; },
    spawn() { calls.spawn += 1; return { cancel() {} }; },
    timer: {
      every() { return { cancel() {} }; },
      after() {
        const timer = { cancel() {} };
        calls.after.push(timer);
        return timer;
      },
    },
  };
}

function blankInstance() {
  const instance = Object.create(Insights.prototype);
  instance.loading = false;
  instance.saving = false;
  instance.error = null;
  instance.snapshot = null;
  instance.runtimeReady = true;
  instance.runtimeError = null;
  instance.nodeBinary = "/test/node";
  instance.year = 2024;
  instance.selectedDay = "2024-01-10";
  instance.period = "all";
  instance.filters = { source: "all", provider: "all", model: "all", project: "all" };
  instance.heatmapMode = "daily";
  instance.leaderboardGroup = "model";
  instance.years = [2024];
  instance.dashboard = null;
  instance.dashboardKey = null;
  instance.dashboardPending = null;
  instance.dashboardError = null;
  instance.dashboardTimer = null;
  instance.dashboardTask = null;
  instance.dashboardQueued = false;
  instance.dashboardGeneration = 0;
  instance.refreshWatchdog = null;
  instance.saveWatchdog = null;
  instance.presenterPath = () => "/app/mods/insights/presenter.mjs";
  instance.storePath = () => "/app/data/insights/insights.json";
  return instance;
}

function savedSnapshot() {
  return {
    version: 1,
    generatedAt: "2024-01-10T12:00:00Z",
    lastScanAt: "2024-01-10T12:00:00Z",
    config: {
      profile: { name: "Saved", handle: "saved", avatar: "" },
      includeCache: true,
      weekStartsOn: 0,
      refreshSeconds: 60,
      sources: [{ id: "saved", label: "Saved", adapter: "saved", enabled: true, roots: ["~/saved"] }],
    },
    rows: [],
    stats: { files: 0, filesRead: 0, bytesRead: 0, unchangedFiles: 0, errors: 0 },
    warnings: [],
  };
}

function configDraft() {
  return {
    profile: { name: "Draft", handle: "draft", avatar: "mods/insights/draft.png" },
    includeCache: false,
    weekStartsOn: 1,
    refreshSeconds: 120,
    customTopLevel: { keep: true },
    sources: [{
      id: "custom",
      label: "Custom",
      adapter: "custom",
      enabled: true,
      roots: ["~/custom"],
      mapping: { input: "usage.input" },
      extra: { keep: true },
    }],
  };
}

test("native mod keeps timers and shell use inside the Herdr contract", () => {
  assert.doesNotMatch(mainSource, /\bsetTimeout\b/);
  assert.doesNotMatch(mainSource, /\bsetInterval\b/);
  assert.doesNotMatch(mainSource, /this\.cx\b/);
  assert.doesNotMatch(mainSource, /\bsh\s*,\s*\[/);
  assert.doesNotMatch(mainSource, /--rebuild/);
  assert.match(mainSource, /readTextFile\(this\.runtimePath\(\)\)/);
  assert.match(mainSource, /mods\/insights\/runtime\.json/);
  assert.equal((mainSource.match(/exec\(this\.nodeBinary, \[/g) ?? []).length, 3);
  assert.match(mainSource, /presenter\.mjs/);
  assert.match(mainSource, /"prepare"/);
  assert.match(mainSource, /timer\.after\(0/);
  assert.match(mainSource, /configure/);
  assert.match(mainSource, /--config/);
  assert.match(mainSource, /on_size_change/);
  assert.match(mainSource, /overflow_x_scrollbar/);
  assert.match(mainSource, /nextCommand/);
  assert.match(mainSource, /name === "refresh"/);
  assert.match(mainSource, /name === "settings"/);
  assert.match(mainSource, /name === "dashboard"/);
  assert.match(mainSource, /sourceStats/);
  assert.match(mainSource, /EditorState\.new/);
  assert.match(mainSource, /result\.code !== 0/);
  assert.match(mainSource, /\.release\(\)/);
});

test("analytics stays host-free and the UI keeps configuration JSON editable", () => {
  assert.doesNotMatch(analyticsSource, /from\s+["']herdr["']/);
  assert.doesNotMatch(analyticsSource, /from\s+["']gpui-kit["']/);
  assert.doesNotMatch(analyticsSource, /from\s+["']gpui-base["']/);
  assert.match(mainSource, /Configuration JSON/);
  assert.match(mainSource, /Save configuration/);
  assert.doesNotMatch(mainSource, /(^|[^.\w])localStorage\b/);
});

test("init reads the runtime config once and waits before the first snapshot", async () => {
  let finishRead;
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  const state = useHerdr({ readTextFile: () => pendingRead });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  assert.deepEqual(state.runtimeReads, ["/app/mods/insights/runtime.json"]);
  assert.equal(state.execCalls.length, 0, "no collector may start before runtime.json resolves");
  assert.equal(calls.timers.length, 0, "no poll may start before runtime.json resolves");

  instance.refresh(cx);
  await flush();
  assert.equal(state.execCalls.length, 0, "a manual refresh must also wait for runtime resolution");

  finishRead(null);
  await flush();
  await flush();
  assert.equal(instance.nodeBinary, "node", "manual-copy installs fall back to node on PATH");
  assert.equal(state.execCalls.length, 1);
  assert.equal(state.execCalls[0].command, "node");
  assert.equal(state.execCalls[0].args[1], "snapshot");
  assert.equal(calls.timers.length, 1);

  instance.refresh(cx);
  await flush();
  await flush();
  assert.equal(state.runtimeReads.length, 1, "refresh must not reread runtime.json");
  assert.equal(state.execCalls.length, 2);
  assert.equal(state.execCalls[1].command, "node");
  instance.close();
});

test("snapshot and configure both launch the installed Node executable", async () => {
  const node = "/opt/homebrew/opt/node@24/bin/node";
  const state = useHerdr({ readTextFile: () => JSON.stringify({ node }) });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  await flush();
  assert.equal(instance.nodeBinary, node);
  assert.equal(state.execCalls.length, 1);

  instance.saveConfig(cx);
  await flush();
  await flush();
  await flush();
  assert.deepEqual(state.execCalls.map((call) => call.command), [node, node]);
  assert.equal(state.execCalls[0].args[1], "snapshot");
  assert.equal(state.execCalls[1].args[1], "configure");
  instance.close();
});

test("invalid runtime config fails clearly without launching the collector", async () => {
  const cases = [
    ['{"node":"https://example.test/node"}', /URL/],
    ['{"node":"/usr/local/bin/node\\u0000"}', /control/],
    ['{"node":"   "}', /empty/],
    ["[]", /JSON object/],
    ['{"node":123}', /node string/],
    ["not json", /not valid JSON/],
  ];

  for (const [raw, reason] of cases) {
    const state = useHerdr({ readTextFile: () => raw });
    const { cx, calls } = liveCx();
    const instance = new Insights();
    instance.init({}, cx);

    await flush();
    await flush();
    assert.equal(state.execCalls.length, 0, raw);
    assert.equal(instance.nodeBinary, null, raw);
    assert.equal(instance.runtimeReady, true, raw);
    assert.match(instance.error, /runtime\.json/, raw);
    assert.match(instance.error, reason, raw);
    assert.equal(calls.timers.length, 0, raw);
    instance.close();
  }
});

test("refresh and configure share one single-flight guard", () => {
  const instance = blankInstance();
  const cx = fakeCx();

  instance.refresh(cx);
  assert.equal(instance.loading, true);
  assert.equal(instance.busy(), true);
  assert.equal(cx.calls.spawn, 1);
  assert.equal(cx.calls.notify, 1);

  instance.refresh(cx);
  instance.saveConfig(cx);
  assert.equal(cx.calls.spawn, 1, "a snapshot or configure call must not start while refresh is in flight");

  instance.loading = false;
  instance.saving = true;
  instance.refresh(cx);
  instance.saveConfig(cx);
  assert.equal(cx.calls.spawn, 1, "refresh and configure must not start while save is in flight");
  assert.equal(instance.busy(), true);

  instance.saving = false;
  assert.equal(instance.busy(), false);
  assert.match(mainSource, /smallButton\("insights-refresh",[^;]*?disabled: this\.busy\(\)/);
  assert.match(mainSource, /smallButton\("ins-config-save",[\s\S]*?disabled: this\.busy\(\)/);
  assert.doesNotMatch(mainSource, /insights-save-profile|profileDirty|AvatarImage|nameInput|handleInput|avatarInput/);
});

test("dashboard render uses the precomputed presentation and builds closed filter menus lazily", () => {
  assert.match(mainSource, /const derived = this\.dashboard;/);
  assert.doesNotMatch(mainSource, /dashboardCache|updateDashboard|deriveDashboard/);
  assert.doesNotMatch(mainSource, /\b(buildHeatmap|facetStats|filterRows|filterRowsByRange|leaderboard|peakDay|streakStats|sumTokens)\(/);
  assert.match(mainSource, /if \(this\.openFilter === id && this\.openOptions\)/);
  assert.match(mainSource, /this\.openOptions = open \? buildFacetOptions/);
  assert.match(mainSource, /menu\.content\(this\.filterMenuContent/);
  assert.doesNotMatch(mainSource, /const (source|provider|model|project)Options = buildFacetOptions/);
  assert.doesNotMatch(mainSource, /safeAvatarPath|AvatarImage|AvatarFallback|Profile/);
  assert.match(mainSource, /scheduleDashboard\(clickCx, \{ force: true \}\)/);
});

test("initial async snapshot publishes the dashboard before settings host controls exist", async () => {
  globalThis.__insightsTestHostCalls = { inputStates: 0, editorStates: 0 };
  const state = useHerdr({ readTextFile: () => JSON.stringify({ node: "/test/node" }) });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  const notifications = [];
  const notify = cx.notify.bind(cx);
  cx.notify = () => {
    notifications.push({ dashboard: instance.dashboard?.period ?? null, loading: instance.loading });
    notify();
  };
  instance.init({}, cx);

  assert.equal(instance.refreshInput, null);
  assert.equal(instance.configEditor, null);
  assert.equal(instance.sourceInputs.size, 0);

  await flush();
  await flush();
  await flush();

  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.snapshot?.rowCount, 0);
  assert.equal(instance.dashboard?.period, "all");
  assert.equal(instance.dashboardKey !== null, true);
  assert.equal(instance.refreshInput, null, "dashboard refresh must not create the refresh input");
  assert.equal(instance.configEditor, null, "dashboard refresh must not create the JSON editor");
  assert.equal(instance.sourceInputs.size, 0, "dashboard refresh must not create source inputs");
  assert.deepEqual(globalThis.__insightsTestHostCalls, { inputStates: 0, editorStates: 0 });
  assert.equal(calls.notify > 0, true);
  assert.deepEqual(notifications.at(-1), { dashboard: "all", loading: false });

  instance.openSettings(cx);
  assert.equal(instance.refreshInput !== null, true);
  assert.equal(instance.configEditor !== null, true);
  assert.equal(instance.sourceInputs.size, 1);
  assert.deepEqual(globalThis.__insightsTestHostCalls, { inputStates: 2, editorStates: 1 });
  assert.match(instance.configEditor.value(), /"refreshSeconds": 60/);
  instance.close();
});

test("form saves preserve the legacy profile and multi-root source mappings", () => {
  const instance = blankInstance();
  const saved = savedSnapshot();
  const profile = { name: "Legacy Name", handle: "legacy", avatar: "mods/insights/legacy.png" };
  const mapping = { session: "session.id", timestamp: "ts", usage: { input: "usage.input" } };
  saved.config.profile = profile;
  saved.config.sources = [{
    id: "codex",
    label: "Codex",
    adapter: "codex",
    enabled: true,
    roots: ["~/.codex/sessions", "~/.codex/archived_sessions"],
    mapping,
  }];
  Object.assign(instance, {
    snapshot: saved,
    configDirty: true,
    editorDirty: false,
    rootsDirty: false,
    refreshDirty: true,
    configDraft: JSON.parse(JSON.stringify(saved.config)),
    sourceInputs: new Map(),
    syncingInputs: false,
    refreshInput: { value: () => "120" },
    configEditor: { value: () => JSON.stringify(saved.config), set_value() {}, on() {} },
  });
  instance.ensureSourceInputs(instance.configDraft);
  const state = instance.sourceInputs.get("codex");
  assert.equal(state.value(), "~/.codex/sessions, ~/.codex/archived_sessions");
  const config = instance.buildConfigForSave();
  assert.deepEqual(config.profile, profile);
  assert.deepEqual(config.sources[0].roots, ["~/.codex/sessions", "~/.codex/archived_sessions"]);
  assert.deepEqual(config.sources[0].mapping, mapping);
  assert.equal(config.refreshSeconds, 120);
});

test("background snapshots leave closed settings drafts and host inputs untouched", async () => {
  const draft = configDraft();
  const customState = {
    value: "~/custom",
    released: false,
    writes: 0,
    set_value(value) { this.writes += 1; this.value = String(value); },
    on() {},
  };
  const instance = blankInstance();
  Object.assign(instance, {
    showSettings: false,
    configDirty: true,
    editorDirty: false,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: draft,
    sourceInputs: new Map([["custom", customState]]),
    refreshInput: { writes: 0, set_value() { this.writes += 1; }, value: () => "120" },
    configEditor: { writes: 0, value: () => JSON.stringify(draft), set_value() { this.writes += 1; }, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
    scheduleDashboard() { this.dashboardUpdates = (this.dashboardUpdates ?? 0) + 1; },
  });

  instance.applySnapshot(presentationFor(savedSnapshot(), instance.dashboardOptions()), fakeCx());
  assert.equal(instance.sourceInputs.has("custom"), true);
  assert.equal(instance.sourceInputs.has("saved"), false);
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.equal(customState.writes, 0);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.deepEqual(instance.configDraft.sources[0].extra, { keep: true });
  assert.deepEqual(instance.configDraft.customTopLevel, { keep: true });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.refreshInput.writes, 0);
  assert.equal(instance.configEditor.writes, 0);
  assert.equal(instance.scheduleCalls, 1);

  const editorInstance = blankInstance();
  const savedState = {
    value: "~/saved",
    released: false,
    writes: 0,
    set_value(value) { this.writes += 1; this.value = String(value); },
    release() { this.released = true; },
    on() {},
  };
  Object.assign(editorInstance, {
    showSettings: false,
    configDirty: false,
    editorDirty: true,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: JSON.parse(JSON.stringify(savedSnapshot().config)),
    sourceInputs: new Map([["saved", savedState]]),
    refreshInput: { writes: 0, set_value() { this.writes += 1; }, value: () => "60" },
    configEditor: { writes: 0, value: () => JSON.stringify(draft), set_value() { this.writes += 1; }, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
    scheduleDashboard() { this.dashboardUpdates = (this.dashboardUpdates ?? 0) + 1; },
  });

  editorInstance.applySnapshot(presentationFor(savedSnapshot(), editorInstance.dashboardOptions()), fakeCx());
  assert.equal(editorInstance.sourceInputs.has("saved"), true);
  assert.equal(savedState.released, false);
  assert.equal(savedState.writes, 0);
  assert.equal(editorInstance.configEditor.value(), JSON.stringify(draft));
  assert.equal(editorInstance.editorTextWrites ?? 0, 0);

  // Reopening Settings after a closed background refresh must reuse the dirty draft.
  instance.showSettings = true;
  const { cx } = liveCx();
  instance.applySnapshot(presentationFor(savedSnapshot(), instance.dashboardOptions()), cx);
  await flush();
  await flush();
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.configEditor.writes, 0);
});

test("async presentation refresh clears busy state and exposes a finite error", async () => {
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: () => ({ code: 1, stdout: "", stderr: "scan failed" }),
  });
  const { cx } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.loading, false);
  assert.equal(instance.busy(), false);
  assert.match(instance.error, /scan failed/);
  assert.equal(instance.snapshot, null);
  instance.close();
});

test("filter changes coalesce while a presentation prepare is in flight", async () => {
  const { todayKey } = analytics;
  const today = todayKey();
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${today}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  snapshot.rows = [{
    day: today,
    session: "session-a",
    harness: "saved",
    provider: "provider",
    model: "model",
    project: "/tmp/project",
    tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 120 },
    messages: 1,
    activeMs: 1000,
    longestTaskMs: 1000,
  }];
  const pending = [];
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare") {
        return new Promise((resolve) => {
          pending.push({ options: optionArgument(args), resolve });
        });
      }
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);
  assert.equal(instance.dashboard?.period, "all");
  assert.equal(instance.loading, false);

  instance.setPeriod("week", cx);
  await calls.runAfter();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].options.period, "week");
  assert.equal(instance.dashboardPending !== null, true);

  instance.setPeriod("month", cx);
  assert.equal(instance.dashboardQueued, true);
  const first = pending.shift();
  first.resolve({ code: 0, stdout: JSON.stringify(presentationFor(snapshot, first.options, "prepare")), stderr: "" });
  await flush();
  await flush();
  assert.equal(instance.dashboard?.period, "all", "a stale prepare must never replace the current filter result");
  assert.equal(calls.after.filter((timer) => !timer.cancelled).length, 1, "the latest filter is prepared next");

  await calls.runAfter();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].options.period, "month");
  const latest = pending.shift();
  latest.resolve({ code: 0, stdout: JSON.stringify(presentationFor(snapshot, latest.options, "prepare")), stderr: "" });
  await flush();
  await flush();

  assert.equal(instance.dashboard?.period, "month");
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardQueued, false);
  assert.equal(instance.dashboardError, null);
  instance.close();
});

test("a failed prepare leaves the old dashboard and a retryable error", async () => {
  const { todayKey } = analytics;
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${todayKey()}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  let failPrepare = true;
  const state = useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare" && failPrepare) {
        return { code: 1, stdout: "", stderr: "prepare failed" };
      }
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  assert.equal(state.execCalls.length, 1);

  instance.setPeriod("week", cx);
  await calls.runAfter();
  await flush();
  await flush();
  assert.match(instance.dashboardError, /prepare failed/);
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardTask, null);
  assert.equal(instance.dashboard?.period, "all");

  failPrepare = false;
  instance.scheduleDashboard(cx, { force: true });
  await calls.runAfter();
  await flush();
  await flush();
  assert.equal(instance.dashboardError, null);
  assert.equal(instance.dashboard?.period, "week");
  assert.equal(instance.dashboardPending, null);
  instance.close();
});

test("a hung prepare times out into a retryable dashboard error", async () => {
  const { todayKey } = analytics;
  const snapshot = savedSnapshot();
  snapshot.generatedAt = `${todayKey()}T12:00:00Z`;
  snapshot.lastScanAt = snapshot.generatedAt;
  let hang = true;
  useHerdr({
    readTextFile: () => JSON.stringify({ node: "/test/node" }),
    execResult: (command, args) => {
      if (args[1] === "prepare" && hang) return new Promise(() => {});
      return { code: 0, stdout: JSON.stringify(presentationFor(snapshot, optionArgument(args), args[1])), stderr: "" };
    },
  });
  const { cx, calls } = liveCx();
  const instance = new Insights();
  instance.init({}, cx);

  await flush();
  await flush();
  instance.setPeriod("week", cx);
  await calls.runAfter();
  assert.equal(instance.dashboardPending !== null, true);
  assert.equal(instance.dashboardTask !== null, true);

  await calls.runAfter();
  await flush();
  assert.match(instance.dashboardError, /timed out/);
  assert.equal(instance.dashboardPending, null);
  assert.equal(instance.dashboardTask, null);
  assert.equal(instance.dashboardQueued, false);

  hang = false;
  instance.scheduleDashboard(cx, { force: true });
  await calls.runAfter();
  await flush();
  await flush();
  assert.equal(instance.dashboardError, null);
  assert.equal(instance.dashboard?.period, "week");
  instance.close();
});
