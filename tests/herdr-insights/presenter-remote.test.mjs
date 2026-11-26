import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { dashboardMarkdown, THIS_COMPUTER } from "../../herdr-insights/mods/insights/analytics.js";
import { run } from "../../herdr-insights/mods/insights/presenter.mjs";
import { rowsFileText, stateFileText, timeZoneStoreKey } from "../../herdr-insights/mods/insights/remote.mjs";

function row(day, session, total) {
  return {
    day, session, harness: "codex", provider: "openai", model: "gpt-5", project: "/p",
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total },
    messages: 1, activeMs: 0, longestTaskMs: 0,
  };
}

function envelope(rows) {
  return {
    kind: "insights-remote-rows", version: 1, generatedAt: null, lastScanAt: null,
    lastCompletedScanAt: "2026-11-13T00:59:00.000Z", rowCount: rows.length,
    rows: gzipSync(JSON.stringify(rows)).toString("base64"),
    scan: { status: "complete", processed: 1, total: 1 }, warnings: [],
  };
}

async function context(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "insights-presenter-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = path.join(root, "data/insights.json");
  const machinesRoot = path.join(root, "data/machines");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const machines = path.join(machinesRoot, timeZoneStoreKey(timeZone));
  const save = async (name, rows, { error = null, dir = machines, details = {}, attemptedAt = "2026-11-13T01:00:00.000Z" } = {}) => {
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(path.join(dir, `${name}.rows.json`), rowsFileText({ machine: name, envelope: { ...envelope(rows), ...details }, fetchedAt: "2026-11-13T01:00:00.000Z" })),
      writeFile(path.join(dir, `${name}.state.json`), stateFileText({ machine: name, attemptedAt, error })),
    ]);
  };
  return { root, store, machines, machinesRoot, timeZone, save, home: path.join(root, "home") };
}

async function prepare(ctx, options = {}) {
  const result = await run(["prepare", "--store", ctx.store, "--options", JSON.stringify({ today: "2026-11-13", ...options })]);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("prepare loads only remote snapshots for its own timezone", async (t) => {
  const ctx = await context(t);
  const otherZone = ctx.timeZone === "UTC" ? "America/Los_Angeles" : "UTC";
  await ctx.save("box", [row("2026-11-12", "a", 7)], { dir: ctx.machinesRoot });
  await ctx.save("box", [row("2026-11-12", "a", 11)], { dir: path.join(ctx.machinesRoot, timeZoneStoreKey(otherZone)) });
  assert.equal((await prepare(ctx)).dashboard.lifetime.total, 0);
  await ctx.save("box", [row("2026-11-13", "a", 3)]);
  const payload = await prepare(ctx);
  assert.equal(payload.snapshot.remoteTimeZone, ctx.timeZone);
  assert.equal(payload.dashboard.lifetime.total, 3);
});

test("export names the timezone used to group remote usage by day", async (t) => {
  const ctx = await context(t);
  await ctx.save("box", [row("2026-11-13", "a", 3)]);
  const { dashboard } = await prepare(ctx, { filters: { machine: "box" } });
  assert.ok(dashboardMarkdown(dashboard).includes(`- Remote usage timezone: ${ctx.timeZone}\n`));
});

test("export omits the remote timezone when no remote machine exists", async (t) => {
  const ctx = await context(t);
  const { dashboard } = await prepare(ctx, {});
  assert.ok(!dashboardMarkdown(dashboard).includes("Remote usage timezone"));
});

test("prepare merges saved remote machines next to the store", async (t) => {
  const ctx = await context(t);
  await ctx.save("box", [row("2026-11-12", "a", 7)]);
  await ctx.save("vps", [row("2026-11-13", "a", 3)], { error: "machine unreachable" });
  const payload = await prepare(ctx);
  assert.equal(payload.dashboard.lifetime.total, 10);
  assert.equal(payload.dashboard.lifetime.sessions, 2);
  assert.deepEqual(payload.snapshot.machines.map((m) => [m.name, m.status]), [[null, "ok"], ["box", "ok"], ["vps", "offline"]]);
  assert.deepEqual(payload.dashboard.machines.map((m) => m.name), [null, "box", "vps"]);
  assert.equal((await prepare(ctx, { filters: { machine: "box" } })).dashboard.lifetime.total, 7);
  assert.equal((await prepare(ctx, { filters: { machine: THIS_COMPUTER } })).dashboard.lifetime.total, 0);
});

test("prepare gives the dashboard a warning count for the affected remote machine", async (t) => {
  const ctx = await context(t);
  await ctx.save("box", [row("2026-11-12", "a", 7)], {
    details: { warningCount: 2, warnings: ["Could not read /private/remote/session.jsonl"] },
  });
  await ctx.save("vps", [row("2026-11-13", "a", 3)]);
  const payload = await prepare(ctx);
  assert.equal(payload.dashboard.lifetime.total, 10);
  assert.equal(payload.dashboard.machines.find((machine) => machine.name === "box").warningCount, 2);
  assert.equal(payload.dashboard.machines.find((machine) => machine.name === "vps").warningCount, 0);
  assert.doesNotMatch(JSON.stringify(payload), /\/private\/remote/);
});

test("a newly published rows file supersedes a failure from an older sync", async (t) => {
  const ctx = await context(t);
  await ctx.save("box", [row("2026-11-13", "a", 7)], {
    attemptedAt: "2026-11-13T00:59:00.000Z",
    error: "Previously unreachable",
  });
  const { dashboard } = await prepare(ctx);
  const machine = dashboard.machines.find((candidate) => candidate.name === "box");
  assert.equal(dashboard.lifetime.total, 7);
  assert.equal(machine.status, "ok");
  assert.equal(machine.error, null);
});

test("disabled machines in remote.json are left out", async (t) => {
  const ctx = await context(t);
  await ctx.save("box", [row("2026-11-12", "a", 7)]);
  await ctx.save("vps", [row("2026-11-13", "a", 3)]);
  await writeFile(path.join(path.dirname(ctx.store), "remote.json"), JSON.stringify({ disabled: ["vps"] }));
  const payload = await prepare(ctx);
  assert.equal(payload.dashboard.lifetime.total, 7);
  assert.deepEqual(payload.snapshot.machines.map((m) => m.name), [null, "box"]);
  assert.deepEqual(payload.snapshot.remoteDisabled, ["vps"], "main.js reads the disabled list from the presenter");
});

test("a corrupt machine file or remote.json never breaks the dashboard", async (t) => {
  const ctx = await context(t);
  await ctx.save("box", [row("2026-11-12", "a", 7)]);
  await writeFile(path.join(ctx.machines, "bad.rows.json"), "{");
  await writeFile(path.join(path.dirname(ctx.store), "remote.json"), "nope");
  const payload = await prepare(ctx);
  assert.equal(payload.error, null);
  assert.equal(payload.dashboard.lifetime.total, 7);
  assert.ok(payload.snapshot.warnings.some((w) => w.includes("bad.rows.json")));
  assert.ok(payload.snapshot.remoteWarnings.some((w) => w.includes("bad.rows.json")));
});

test("snapshot also merges remote machines", async (t) => {
  const ctx = await context(t);
  await mkdir(ctx.home);
  await ctx.save("box", [row("2026-11-12", "a", 7)]);
  const result = await run(["snapshot", "--store", ctx.store, "--home", ctx.home, "--options", JSON.stringify({ today: "2026-11-13" })]);
  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dashboard.lifetime.total, 7);
  assert.equal(payload.snapshot.machines.length, 2);
});

test("bundle prints the remote worker bundle", async () => {
  const result = await run(["bundle"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const bundle = JSON.parse(result.stdout);
  assert.match(bundle.hash, /^[0-9a-f]{16}$/);
  const files = JSON.parse(gunzipSync(Buffer.from(bundle.payload, "base64")).toString("utf8")).files;
  assert.ok(files["remote-entry.mjs"] && files["collector.mjs"]);
});
