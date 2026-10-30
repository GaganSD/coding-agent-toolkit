import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPresentation, normalizeConfig } from "../mods/insights/analytics.js";
import { run as runPresenter } from "../mods/insights/presenter.mjs";
import {
  emptyStore,
  newFileEntry,
  saveStore,
} from "../mods/insights/core/store.mjs";

const TODAY = "2026-03-04";
const OPTIONS = {
  filters: { source: "all", provider: "all", model: "all", project: "all" },
  period: "all",
  year: 2026,
  heatmapMode: "daily",
  leaderboardGroup: "model",
  selectedDay: TODAY,
  today: TODAY,
};

function config() {
  return normalizeConfig({
    includeCache: true,
    weekStartsOn: 0,
    refreshSeconds: 60,
    sources: [{ id: "saved", label: "Saved", adapter: "pi", enabled: true, roots: ["~/saved"] }],
  });
}

async function fixtureStore(directory) {
  const store = emptyStore(config());
  const entry = newFileEntry(store, {
    sourceId: "saved",
    path: "/tmp/session.jsonl",
    adapter: "saved",
    size: 0,
    mtimeMs: 0,
  });
  entry.rows.push(
    {
      day: TODAY,
      session: "session-a",
      harness: "saved",
      provider: "provider-a",
      model: "model-a",
      project: "/tmp/project-a",
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      reasoning: 0,
      messages: 1,
    },
    {
      day: TODAY,
      session: "session-b",
      harness: "saved",
      provider: "provider-b",
      model: "model-b",
      project: "/tmp/project-b",
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      messages: 1,
    },
  );
  const path = join(directory, "insights.json");
  await saveStore(path, store);
  return { path, store };
}

test("prepare returns only compact presentation data and does not write the store", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insights-presenter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { path } = await fixtureStore(directory);
  const before = await readFile(path, "utf8");
  const beforeStat = await stat(path);

  const result = await runPresenter([
    "prepare",
    "--store",
    path,
    "--options",
    JSON.stringify(OPTIONS),
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(isPresentation(payload), true);
  assert.equal(payload.command, "prepare");
  assert.equal(payload.snapshot.rowCount, 2);
  assert.equal(payload.snapshot.rows, undefined);
  assert.equal(payload.dashboard.rowCount, 2);
  assert.equal(payload.dashboard.lifetime.total, 185);
  assert.equal(payload.dashboard.leaders.entries.length, 2);
  assert.equal(payload.dashboard.heatmap.weeks.length, 53);
  assert.equal(Buffer.byteLength(result.stdout) < 512 * 1024, true, "payload stays bounded");

  const after = await readFile(path, "utf8");
  const afterStat = await stat(path);
  assert.equal(after, before);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "prepare must not rewrite the store");
});

test("prepare re-derives the compact dashboard for filter changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insights-presenter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { path } = await fixtureStore(directory);

  const result = await runPresenter([
    "prepare",
    "--store",
    path,
    "--options",
    JSON.stringify({ ...OPTIONS, filters: { ...OPTIONS.filters, model: "model-a" } }),
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.options.filters.model, "model-a");
  assert.equal(payload.dashboard.rowCount, 2);
  assert.equal(payload.dashboard.lifetime.total, 185, "lifetime covers every row, not the filter");
  assert.equal(payload.dashboard.leaders.entries[0].name, "model-a");
  assert.equal(payload.dashboard.leaders.entries.length, 1, "model usage respects the filter");
});

test("presenter rejects missing arguments and invalid options without output", async () => {
  const missing = await runPresenter(["prepare"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /--store/);

  await assert.rejects(
    runPresenter(["prepare", "--store", "/tmp/missing.json", "--options", "[]"]),
    /expected one JSON object/,
  );
});

test("presentation validation requires compact metadata and a dashboard slot", () => {
  assert.equal(isPresentation(null), false);
  assert.equal(isPresentation({ kind: "insights-presentation", version: 1 }), false);
  assert.equal(isPresentation({
    kind: "insights-presentation",
    version: 1,
    snapshot: { config: {}, rowCount: 1 },
    dashboard: null,
  }), true);
});

test("presenter configure and snapshot wrap the collector in one exec", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "insights-presenter-collector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const session = join(home, ".codex/sessions/a/rollout-plain.jsonl");
  await mkdir(dirname(session), { recursive: true });
  await copyFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-legacy.jsonl"), session);
  const store = join(directory, "data", "insights.json");
  const config = JSON.stringify({
    includeCache: true,
    weekStartsOn: 0,
    refreshSeconds: 60,
    sources: [{ id: "codex", label: "Codex", adapter: "codex", enabled: true, roots: ["~/.codex/sessions"] }],
  });

  const configured = await runPresenter([
    "configure",
    "--store",
    store,
    "--home",
    home,
    "--config",
    config,
    "--options",
    JSON.stringify(OPTIONS),
  ]);
  assert.equal(configured.exitCode, 0, configured.stderr);
  const configuredPayload = JSON.parse(configured.stdout);
  assert.equal(isPresentation(configuredPayload), true);
  assert.equal(configuredPayload.command, "configure");
  assert.equal(configuredPayload.snapshot.rowCount, 1);
  assert.equal(configuredPayload.snapshot.rows, undefined);
  assert.equal(configuredPayload.dashboard.rowCount, 1);
  assert.equal(configuredPayload.snapshot.stats.files, 1);

  const refreshed = await runPresenter([
    "snapshot",
    "--store",
    store,
    "--home",
    home,
    "--options",
    JSON.stringify(OPTIONS),
  ]);
  assert.equal(refreshed.exitCode, 0, refreshed.stderr);
  const payload = JSON.parse(refreshed.stdout);
  assert.equal(payload.command, "snapshot");
  assert.equal(payload.dashboard.rowCount, 1);
  assert.equal(payload.snapshot.rows, undefined);
  assert.equal(payload.error, null);
});
