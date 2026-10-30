#!/usr/bin/env node
// Loaded-render regression check for the Insights native mod.
//
// `herdr-app check` normally renders the empty initial state, so it cannot see
// a populated dashboard crossing the 50 ms render budget. This harness injects
// an already-presented dashboard through applySnapshot in init, then checks the
// first render. The true exec -> Task -> timer lifecycle is covered separately
// by tests/native-async-check.mjs.
//
// Usage:
//   node tests/native-loaded-check.mjs
//   node tests/native-loaded-check.mjs --rows 10000 --mode menu
//   node tests/native-loaded-check.mjs --snapshot /path/to/warm-snapshot.json
//
// The snapshot file is read only. Nothing is installed into the user's Herdr
// home: the check runs against a temporary HERDR_APP_HOME.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactDashboard, deriveDashboard, todayKey } from "../mods/insights/analytics.js";

const here = dirname(fileURLToPath(import.meta.url));
const modSource = resolve(here, "../mods/insights");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const mode = argument("--mode", "loaded");
if (!["loaded", "settings", "menu"].includes(mode)) throw new Error("--mode must be loaded, settings or menu");

const snapshotPath = argument("--snapshot", null);
const requestedRows = argument("--rows", null);
const baseSnapshot = snapshotPath
  ? JSON.parse(readFileSync(resolve(snapshotPath), "utf8"))
  : {
      version: 1,
      generatedAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString(),
      config: {
        profile: { name: "Legacy", handle: "legacy", avatar: "mods/insights/legacy.png" },
        palette: "blue",
        includeCache: true,
        weekStartsOn: 0,
        refreshSeconds: 60,
        sources: [{ id: "codex", label: "Codex", adapter: "codex", enabled: true, roots: ["~/.codex/sessions", "~/.codex/archived_sessions"] }],
      },
      rows: Array.from({ length: 50 }, (_, index) => ({
        day: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        session: `synthetic:${index}`,
        harness: index % 2 ? "pi" : "codex",
        provider: index % 3 ? "openai" : "anthropic",
        model: `model-${index % 8}`,
        project: `/tmp/repo-${index % 25}`,
        tokens: { input: 1000 + index, output: 100, cacheRead: 500, cacheWrite: 0, reasoning: 20, total: 1620 + index },
        messages: index % 5,
        activeMs: index * 1000,
        longestTaskMs: index * 100,
      })),
      stats: { files: 0, filesRead: 0, bytesRead: 0, unchangedFiles: 0, errors: 0 },
      warnings: [],
    };

const originalRows = Array.isArray(baseSnapshot.rows) ? baseSnapshot.rows : [];
if (!originalRows.length) throw new Error("snapshot has no rows to load");
const rowCount = requestedRows === null ? (snapshotPath ? originalRows.length : 1000) : Number(requestedRows);
if (!Number.isInteger(rowCount) || rowCount < 1) throw new Error("--rows must be a positive integer");
const rows = Array.from({ length: rowCount }, (_, index) => {
  const row = originalRows[index % originalRows.length];
  if (rowCount === originalRows.length) return row;
  return {
    ...row,
    session: `${row.session ?? "synthetic"}:check-${index}`,
    project: `${row.project ?? "/tmp/repo"}/project-${index % 250}`,
    model: `${row.model ?? "model"}-v${index % 80}`,
  };
});
const snapshot = { ...baseSnapshot, rows };

const home = mkdtempSync(join(tmpdir(), "insights-native-loaded-"));
try {
  const mod = join(home, "mods/insights");
  cpSync(modSource, mod, { recursive: true });
  writeFileSync(join(mod, "runtime.json"), `${JSON.stringify({ node: process.execPath })}\n`);

  const mainPath = join(mod, "main.js");
  let main = readFileSync(mainPath, "utf8");
  const constant = "const CELL = 12;";
  const init = "    this.commandTask = cx.spawn(async (commandCx) => {";
  if (!main.includes(constant) || !main.includes(init)) throw new Error("cannot find main.js injection points");
  const today = todayKey();
  const options = {
    filters: { source: "all", provider: "all", model: "all", project: "all" },
    period: "all",
    year: Number(today.slice(0, 4)),
    heatmapMode: "daily",
    leaderboardGroup: "model",
    selectedDay: today,
    today,
  };
  const { rows: _rows, ...metadata } = snapshot;
  const presentation = {
    version: 1,
    kind: "insights-presentation",
    command: "snapshot",
    options,
    snapshot: { ...metadata, rowCount: snapshot.rows.length },
    dashboard: compactDashboard(deriveDashboard(snapshot, options)),
    error: null,
  };
  main = main.replace(constant, `const INJECTED_PRESENTATION = ${JSON.stringify(presentation)};\n${constant}`);
  let injected = "    this.applySnapshot(INJECTED_PRESENTATION, cx);\n";
  if (mode === "settings") injected += "    this.showSettings = true;\n";
  if (mode === "menu") {
    injected += [
      "    this.openFilter = \"ins-project-filter\";",
      "    this.openOptions = buildFacetOptions(\"project\", this.dashboard.facets.project, normalizeConfig(this.snapshot.config));",
      "",
    ].join("\n");
  }
  main = main.replace(init, `${injected}${init}`);
  writeFileSync(mainPath, main);

  const result = spawnSync("herdr-app", ["check", mod], {
    cwd: resolve(here, ".."),
    env: { ...process.env, HERDR_APP_HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`herdr-app check failed with exit ${result.status}`);
  console.log(`loaded native ${mode} check passed: ${rows.length} rows, ${Buffer.byteLength(JSON.stringify(snapshot))} snapshot bytes`);
} finally {
  if (!process.argv.includes("--keep")) rmSync(home, { recursive: true, force: true });
  else console.log(`kept ${home}`);
}
