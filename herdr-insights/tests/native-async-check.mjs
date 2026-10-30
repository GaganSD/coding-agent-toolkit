#!/usr/bin/env node
// True asynchronous lifecycle check for the Insights native mod.
//
// The older loaded-render check injected applySnapshot in init, which never
// exercised the exec -> Task continuation -> timer -> presentation helper path.
// This harness launches a throwaway Herdr window with a minimal layout, a
// fixture store (10k rows by default), and the real presenter helper. Startup
// overlays are closed before the layout switch, and the first settled frame is
// captured before another status command so a later notify cannot mask a failed
// cold dashboard render. It fails on the old "error in a promise continuation:
// interrupted" signature.
//
// Usage:
//   node tests/native-async-check.mjs
//   node tests/native-async-check.mjs --rows 10000 --snapshot /path/to/snapshot.json
//   node tests/native-async-check.mjs --store /tmp/store-copy.json --wait 5000
//   node tests/native-async-check.mjs --settings --appearance light --zoom-out 2
//   node tests/native-async-check.mjs --menu --shot /tmp/menu.png --keep
//
// Only the Herdr process started here is stopped. It creates no terminals,
// spaces, tabs, or user-home writes.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig, todayKey } from "../mods/insights/analytics.js";
import {
  emptyStore,
  newFileEntry,
  saveStore,
} from "../mods/insights/core/store.mjs";
import { run as runPresenter } from "../mods/insights/presenter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const modSource = resolve(here, "../mods/insights");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function baseRows(snapshotPath) {
  if (!snapshotPath) {
    return Array.from({ length: 60 }, (_, index) => ({
      day: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
      session: `fixture-${index}`,
      harness: index % 2 ? "pi" : "codex",
      provider: index % 3 ? "openai" : "anthropic",
      model: `model-${index % 8}`,
      project: `/tmp/repo-${index % 25}`,
      tokens: { input: 1000 + index, output: 100, cacheRead: 500, cacheWrite: 0, reasoning: 20 },
      messages: index % 5,
      activeMs: index * 1000,
      longestTaskMs: index * 100,
    }));
  }
  const parsed = JSON.parse(readFileSync(resolve(snapshotPath), "utf8"));
  if (!Array.isArray(parsed.rows) || !parsed.rows.length) throw new Error("snapshot has no rows");
  return parsed.rows;
}

function rowsFor(base, count) {
  return Array.from({ length: count }, (_, index) => {
    const row = base[index % base.length];
    const copy = {
      ...row,
      session: count === base.length ? row.session : `${row.session ?? "fixture"}:async-${index}`,
      project: count === base.length ? row.project : `${row.project ?? "/tmp/repo"}/project-${index % 250}`,
      model: count === base.length ? row.model : `${row.model ?? "model"}-v${index % 80}`,
    };
    if (index < base.length) return copy;
    return copy;
  });
}

function flatRow(row) {
  const tokens = row.tokens ?? {};
  return {
    day: row.day,
    session: row.session,
    harness: row.harness,
    provider: row.provider,
    model: row.model,
    project: row.project,
    input: Number(tokens.input ?? row.input ?? 0),
    output: Number(tokens.output ?? row.output ?? 0),
    cacheRead: Number(tokens.cacheRead ?? row.cacheRead ?? 0),
    cacheWrite: Number(tokens.cacheWrite ?? row.cacheWrite ?? 0),
    reasoning: Number(tokens.reasoning ?? row.reasoning ?? 0),
    messages: Number(row.messages ?? 0),
  };
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function cliEnv(home) {
  return { ...process.env, HERDR_APP_HOME: home };
}

function runCli(args, home, timeout = 15_000) {
  return new Promise((resolveRun) => {
    const child = spawn(process.env.HERDR_APP_BIN ?? "herdr-app", args, {
      env: cliEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: error.message });
    });
  });
}

const snapshotPath = argument("--snapshot", null);
const sourceStorePath = argument("--store", null);
const requestedArgument = argument("--rows", null);
const requestedRows = requestedArgument === null ? (sourceStorePath ? null : 10_000) : Number(requestedArgument);
if (requestedRows !== null && (!Number.isInteger(requestedRows) || requestedRows < 1)) {
  throw new Error("--rows must be a positive integer");
}
const keep = process.argv.includes("--keep");
const settingsMode = process.argv.includes("--settings");
const menuMode = process.argv.includes("--menu");
const zoomOut = Number(argument("--zoom-out", "0"));
if (!Number.isInteger(zoomOut) || zoomOut < 0 || zoomOut > 6) {
  throw new Error("--zoom-out must be an integer from 0 to 6");
}
const appearance = argument("--appearance", null);
if (appearance !== null && !["dark", "light"].includes(appearance)) {
  throw new Error("--appearance must be dark or light");
}
const home = realpathSync(mkdtempSync(join(tmpdir(), "insights-native-async-")));
const logPath = "/tmp/insights-native-async.log";
const shotPath = argument("--shot", "/tmp/insights-native-async.png");
const mod = join(home, "mods", "insights");
const storePath = join(home, "data", "insights", "insights.json");
const appBinary = process.env.HERDR_APP_BINARY ?? "/Applications/Herdr.app/Contents/MacOS/Herdr";
let app = null;
let output = "";

try {
  if (!existsSync(appBinary)) throw new Error(`Herdr app not found at ${appBinary}; set HERDR_APP_BINARY`);
  mkdirSync(dirname(storePath), { recursive: true });
  if (sourceStorePath) {
    copyFileSync(resolve(sourceStorePath), storePath);
  } else {
    const base = baseRows(snapshotPath);
    const rows = rowsFor(base, requestedRows);

    const fixtureRoot = join(home, "fixture-sessions");
    mkdirSync(fixtureRoot, { recursive: true });
    const config = normalizeConfig({
      includeCache: true,
      weekStartsOn: 0,
      refreshSeconds: 3600,
      sources: [{ id: "fixture", label: "Fixture", adapter: "pi", enabled: true, roots: [fixtureRoot] }],
    });
    const store = emptyStore(config);
    const entry = newFileEntry(store, {
      sourceId: "fixture",
      path: join(fixtureRoot, "fixture.jsonl"),
      adapter: "pi",
      size: 0,
      mtimeMs: 0,
    });
    entry.rows = rows.map(flatRow);
    await saveStore(storePath, store);
  }

  cpSync(modSource, mod, { recursive: true });
  writeFileSync(join(mod, "runtime.json"), `${JSON.stringify({ node: process.execPath })}\n`);
  if (settingsMode || menuMode) {
    const mainPath = join(mod, "main.js");
    const main = readFileSync(mainPath, "utf8");
    const marker = "    this.commandTask = cx.spawn(async (commandCx) => {";
    if (!main.includes(marker)) throw new Error("cannot find main.js settings injection point");
    let injected = "";
    if (settingsMode) injected += "    this.showSettings = true;\n";
    if (menuMode) {
      injected += [
        "    cx.timer.after(4000, (menuCx) => {",
        "      if (!this.dashboard) return;",
        "      this.openFilter = \"ins-project-filter\";",
        "      this.openOptions = buildFacetOptions(\"project\", this.dashboard.facets.project, normalizeConfig(this.snapshot.config));",
        "      menuCx.notify();",
        "    });",
        "",
      ].join("\n");
    }
    writeFileSync(mainPath, main.replace(marker, `${injected}${marker}`));
  }
  mkdirSync(join(home, "layouts"), { recursive: true });
  writeFileSync(
    join(home, "layouts", "insights-async.json"),
    `${JSON.stringify({
      id: "root",
      type: "row",
      background: "canvas",
      children: [{ id: "insights", type: "block", content: { mod: "insights" } }],
    }, null, 2)}\n`,
  );
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(appearance ? { zoom: 1, appearance } : { zoom: 1 })}\n`);
  writeFileSync(join(home, "keys.json"), '{}\n');
  writeFileSync(join(home, "seen.json"), '["frame-welcome"]\n');
  // The welcome frame asks shared state, not seen.json, before opening.
  writeFileSync(join(home, "shared.json"), '{"frame.welcomed":"skipped"}\n');

  const today = todayKey();
  const options = JSON.stringify({
    filters: { source: "all", provider: "all", model: "all", project: "all" },
    period: "all",
    year: Number(today.slice(0, 4)),
    heatmapMode: "daily",
    leaderboardGroup: "model",
    selectedDay: today,
    today,
  });
  const planned = await runPresenter(["prepare", "--store", storePath, "--options", options]);
  if (planned.exitCode !== 0) throw new Error(planned.stderr);
  const plannedBytes = Buffer.byteLength(planned.stdout);
  const plannedPayload = JSON.parse(planned.stdout);
  const preparedRows = plannedPayload.dashboard?.rowCount;
  if (!Number.isInteger(preparedRows) || preparedRows < 1) {
    throw new Error(`presenter prepared ${preparedRows} rows`);
  }
  if (requestedRows !== null && preparedRows !== requestedRows) {
    throw new Error(`presenter prepared ${preparedRows} rows, expected ${requestedRows}`);
  }
  if (plannedBytes >= 8 * 1024 * 1024) throw new Error(`presentation payload is ${plannedBytes} bytes`);
  console.log(`presenter preflight: ${preparedRows} rows, ${plannedBytes} payload bytes`);

  app = spawn(appBinary, [], {
    env: { ...cliEnv(home), HERDR_APP_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.setEncoding("utf8");
  app.stderr.setEncoding("utf8");
  app.stdout.on("data", (chunk) => { output += chunk; });
  app.stderr.on("data", (chunk) => { output += chunk; });

  let status = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`Herdr exited early with ${app.exitCode}`);
    if (existsSync(join(home, "herdr-app.sock"))) {
      const probe = await runCli(["status"], home);
      if (probe.code === 0) {
        status = JSON.parse(probe.stdout);
        break;
      }
    }
    await sleep(500);
  }
  if (!status) throw new Error("Herdr did not become ready");
  // Close startup overlays before the layout switch. A first launch can stack
  // more than one (for example a welcome window and an update notice), and
  // overlay.close closes only the top one. Closing them afterwards forces a
  // second redraw and can hide a failed first dashboard frame.
  console.log(`startup overlays: ${status.overlays?.length ?? 0}`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const probe = await runCli(["status"], home);
    if (probe.code !== 0) throw new Error(probe.stderr || "status failed");
    const current = JSON.parse(probe.stdout);
    if (!Array.isArray(current.overlays) || current.overlays.length === 0) break;
    for (const overlay of current.overlays) {
      const id = typeof overlay === "string" ? overlay : overlay?.id;
      const closed = await runCli(id ? ["do", "overlay.close", "--id", id] : ["do", "overlay.close"], home);
      if (closed.code !== 0) throw new Error(closed.stderr || `overlay.close failed for ${id ?? "top"}`);
    }
    await sleep(300);
  }
  const ready = await runCli(["status"], home);
  if (ready.code !== 0) throw new Error(ready.stderr || "status failed");
  const readyStatus = JSON.parse(ready.stdout);
  if (Array.isArray(readyStatus.overlays) && readyStatus.overlays.length) {
    throw new Error(`startup overlays did not close: ${JSON.stringify(readyStatus.overlays)}`);
  }
  await sleep(500);
  const switched = await runCli(["do", "layout.switch", "--name", "insights-async"], home);
  if (switched.code !== 0) throw new Error(switched.stderr || "layout.switch failed");
  for (let step = 0; step < zoomOut; step += 1) {
    const zoomed = await runCli(["do", "app.zoom_out"], home);
    if (zoomed.code !== 0) throw new Error(zoomed.stderr || "app.zoom_out failed");
  }
  await sleep(Number(argument("--wait", sourceStorePath ? 20_000 : 8_000)));

  // Capture the first settled frame before asking for status again.
  const shot = await runCli(["shot", shotPath], home);
  if (shot.code !== 0) throw new Error(shot.stderr || "herdr-app shot failed");
  const finalStatus = await runCli(["status"], home);
  if (finalStatus.code !== 0) throw new Error(finalStatus.stderr || "herdr-app status failed");
  status = JSON.parse(finalStatus.stdout);

  if (status.layout !== "insights-async") throw new Error(`unexpected layout ${JSON.stringify(status.layout)}`);
  const errors = Array.isArray(status.errors) ? status.errors : [];
  if (errors.length) throw new Error(`Herdr reported mod errors: ${JSON.stringify(errors)}`);
  if (/error in a promise continuation|interrupted/i.test(output)) {
    throw new Error("the app log contains the old interrupted promise continuation");
  }
  writeFileSync(logPath, output);
  console.log(`native async check passed: ${preparedRows} rows, no mod errors${appearance ? `, ${appearance}` : ""}${settingsMode ? ", settings" : ""}${menuMode ? ", menu" : ""}${zoomOut ? `, zoom out ${zoomOut}` : ""}`);
  console.log(`status: layout=${status.layout} overlays=${status.overlays?.length ?? 0}`);
  console.log(`screenshot: ${shotPath}`);
  console.log(`log: ${logPath}`);
} finally {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    for (let attempt = 0; attempt < 30 && app.exitCode === null; attempt += 1) await sleep(200);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  if (!keep) rmSync(home, { recursive: true, force: true });
  else console.log(`kept ${home}`);
}
