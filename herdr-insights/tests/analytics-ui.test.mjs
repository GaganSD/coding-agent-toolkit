import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mainSource = await readFile(new URL("../mods/insights/main.js", import.meta.url), "utf8");
const analyticsSource = await readFile(new URL("../mods/insights/analytics.js", import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const analyticsUrl = dataUrl(analyticsSource);
const analyticsNames = Object.keys(await import(analyticsUrl)).join(", ");

globalThis.__insightsTestInputState = {
  new(options = {}) {
    const state = {
      value: String(options.value ?? ""),
      released: false,
      set_value(value) { state.value = String(value); },
      on() {},
    };
    return state;
  },
};

const transformedMain = mainSource
  .replace(/^import \{ View, div \} from "gpui-kit";$/m, "const View = class View {};")
  .replace(/^import \{[^}]*\} from "gpui-base";$/m, "const InputState = globalThis.__insightsTestInputState;")
  .replace(/^import \{[^}]*\} from "herdr";$/m, "const appHome = () => \"/app\"; const home = () => \"/home\";")
  .replace(
    /^import \{[\s\S]*?\} from "\.\/analytics\.js";$/m,
    `const { ${analyticsNames} } = await import("${analyticsUrl}");`,
  );
const { default: Insights } = await import(dataUrl(transformedMain));

function fakeCx() {
  const calls = { notify: 0, spawn: 0 };
  return {
    calls,
    notify() { calls.notify += 1; },
    spawn() { calls.spawn += 1; return { cancel() {} }; },
    timer: { every() { return { cancel() {} }; } },
  };
}

function blankInstance() {
  const instance = Object.create(Insights.prototype);
  instance.loading = false;
  instance.saving = false;
  instance.error = null;
  instance.snapshot = null;
  instance.year = 2024;
  instance.selectedDay = "2024-01-10";
  instance.collectorPath = () => "/app/mods/insights/collector.mjs";
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
  assert.match(mainSource, /exec\("node", \[/);
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
  assert.match(mainSource, /insights-save-profile[\s\S]*?disabled: this\.busy\(\)/);
});

test("dashboard render reads the memoized derivation instead of recomputing analytics", () => {
  assert.match(mainSource, /dashboardCache\.read\(snapshot/);
  assert.doesNotMatch(mainSource, /\b(buildHeatmap|facetStats|filterRows|filterRowsByRange|leaderboard|peakDay|streakStats|sumTokens)\(/);
  assert.match(mainSource, /buildFacetOptions\("model", facets\.model, config\)/);
  assert.match(mainSource, /safeAvatarPath\(config\.profile\.avatar\)/);
  assert.doesNotMatch(mainSource, /AvatarImage\.new\(config\.profile\.avatar\)/);
});

test("background snapshots preserve dirty draft sources and custom fields", () => {
  const draft = configDraft();
  const customState = {
    value: "~/custom",
    released: false,
    set_value(value) { this.value = String(value); },
    on() {},
  };
  const instance = blankInstance();
  Object.assign(instance, {
    configDirty: true,
    editorDirty: false,
    profileDirty: false,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: draft,
    sourceInputs: new Map([["custom", customState]]),
    nameInput: { set_value() {}, value: () => "" },
    handleInput: { set_value() {}, value: () => "" },
    avatarInput: { set_value() {}, value: () => "" },
    refreshInput: { set_value() {}, value: () => "120" },
    configEditor: { value: () => JSON.stringify(draft), set_value() {}, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
  });

  instance.applySnapshot(savedSnapshot(), fakeCx());
  assert.equal(instance.sourceInputs.has("custom"), true);
  assert.equal(instance.sourceInputs.has("saved"), false);
  assert.equal(instance.sourceInputs.get("custom"), customState);
  assert.equal(customState.released, false);
  assert.deepEqual(instance.configDraft.sources[0].mapping, { input: "usage.input" });
  assert.deepEqual(instance.configDraft.sources[0].extra, { keep: true });
  assert.deepEqual(instance.configDraft.customTopLevel, { keep: true });
  assert.equal(instance.editorTextWrites ?? 0, 0);
  assert.equal(instance.scheduleCalls, 1);

  const savedState = {
    value: "~/saved",
    released: false,
    set_value(value) { this.value = String(value); },
    release() { this.released = true; },
    on() {},
  };
  const editorInstance = blankInstance();
  Object.assign(editorInstance, {
    configDirty: false,
    editorDirty: true,
    profileDirty: false,
    rootsDirty: false,
    refreshDirty: false,
    configDraft: JSON.parse(JSON.stringify(savedSnapshot().config)),
    sourceInputs: new Map([["saved", savedState]]),
    nameInput: { set_value() {}, value: () => "" },
    handleInput: { set_value() {}, value: () => "" },
    avatarInput: { set_value() {}, value: () => "" },
    refreshInput: { set_value() {}, value: () => "60" },
    configEditor: { value: () => JSON.stringify(draft), set_value() {}, on() {} },
    setEditorText() { this.editorTextWrites = (this.editorTextWrites ?? 0) + 1; },
    schedule() { this.scheduleCalls = (this.scheduleCalls ?? 0) + 1; },
  });

  editorInstance.applySnapshot(savedSnapshot(), fakeCx());
  assert.equal(editorInstance.sourceInputs.has("custom"), true);
  assert.equal(editorInstance.sourceInputs.has("saved"), false);
  assert.equal(savedState.released, true);
  assert.equal(editorInstance.configEditor.value(), JSON.stringify(draft));
  assert.equal(editorInstance.editorTextWrites ?? 0, 0);
});
