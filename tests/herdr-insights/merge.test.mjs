import test from "node:test";
import assert from "node:assert/strict";
import { deriveDashboard } from "../../herdr-insights/mods/insights/analytics.js";
import {
  REMOTE_RECORD_VERSION,
  machineStatus,
  mergeSnapshots,
} from "../../herdr-insights/mods/insights/merge.mjs";

function row(day, session, total, extra = {}) {
  return {
    day,
    session,
    harness: "codex",
    provider: "openai",
    model: "gpt-5",
    project: "/work/app",
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total },
    messages: 1,
    activeMs: 0,
    longestTaskMs: 0,
    ...extra,
  };
}

function localSnapshot(rows) {
  return {
    version: 1,
    generatedAt: "2026-11-13T00:00:00.000Z",
    config: { includeCache: true, weekStartsOn: 0 },
    rows,
    stats: { files: 1 },
    scan: { status: "complete" },
    warnings: [],
  };
}

function record(machine, rows, extra = {}) {
  return {
    version: REMOTE_RECORD_VERSION,
    machine,
    fetchedAt: "2026-11-13T01:00:00.000Z",
    attemptedAt: "2026-11-13T01:00:00.000Z",
    error: null,
    snapshot: { rows, lastCompletedScanAt: "2026-11-13T00:59:00.000Z", scan: { status: "complete" } },
    ...extra,
  };
}

test("local rows are tagged with machine null and keep their session ids", () => {
  const merged = mergeSnapshots(localSnapshot([row("2026-11-10", "s1", 10)]), []);
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].machine, null);
  assert.equal(merged.rows[0].session, "s1");
});

test("remote rows are appended, tagged, and session ids are machine-scoped", () => {
  const merged = mergeSnapshots(
    localSnapshot([row("2026-11-10", "s1", 10)]),
    [record("box", [row("2026-11-10", "s1", 5)])],
  );
  assert.equal(merged.rows.length, 2);
  const remote = merged.rows.find((r) => r.machine === "box");
  assert.equal(remote.session, "box/s1");
  const dashboard = deriveDashboard(merged, { today: "2026-11-13" });
  assert.equal(dashboard.lifetime.total, 15);
  assert.equal(dashboard.lifetime.sessions, 2, "same id on two machines is two sessions");
});

test("remote rows keep empty and missing session ids empty", () => {
  const missing = row("2026-11-10", "unused", 1);
  delete missing.session;
  const merged = mergeSnapshots(localSnapshot([]), [
    record("box", [row("2026-11-10", "", 1), missing]),
  ]);
  assert.deepEqual(merged.rows.map((r) => r.session), ["", ""]);
});

test("rows without session ids contribute usage without increasing the dashboard session count", () => {
  const merged = mergeSnapshots(
    localSnapshot([row("2026-11-10", "", 10), row("2026-11-10", "s1", 2)]),
    [record("box", [row("2026-11-10", "", 5), row("2026-11-10", "s1", 3)])],
  );
  const dashboard = deriveDashboard(merged, { today: "2026-11-13" });
  assert.equal(dashboard.lifetime.total, 20);
  assert.equal(dashboard.lifetime.sessions, 2);
});

test("streaks are recomputed across machines", () => {
  const merged = mergeSnapshots(
    localSnapshot([row("2026-11-11", "a", 1), row("2026-11-13", "a", 1)]),
    [record("box", [row("2026-11-12", "b", 1)])],
  );
  const dashboard = deriveDashboard(merged, { today: "2026-11-13" });
  assert.equal(dashboard.streaks.current, 3);
});

test("local snapshot fields other than rows are preserved", () => {
  const local = localSnapshot([]);
  const merged = mergeSnapshots(local, [record("box", [])]);
  assert.deepEqual(merged.config, local.config);
  assert.deepEqual(merged.scan, local.scan);
  assert.deepEqual(merged.stats, local.stats);
  assert.notEqual(merged, local, "input is not mutated");
  assert.equal(local.rows.length, 0);
});

test("machines summary lists this computer first, then remotes by name", () => {
  const merged = mergeSnapshots(
    localSnapshot([row("2026-11-10", "s1", 10)]),
    [record("zeta", [row("2026-11-10", "x", 1)]), record("alpha", [])],
  );
  assert.deepEqual(merged.machines.map((m) => m.name), [null, "alpha", "zeta"]);
  assert.equal(merged.machines[0].rowCount, 1);
  assert.equal(merged.machines[2].rowCount, 1);
  assert.equal(merged.machines[2].status, "ok");
  assert.equal(merged.machines[2].fetchedAt, "2026-11-13T01:00:00.000Z");
});

test("an offline machine keeps its last rows and reports offline with its timestamp", () => {
  const offline = record("box", [row("2026-11-10", "s1", 7)], {
    attemptedAt: "2026-11-13T02:00:00.000Z",
    error: "machine unreachable",
  });
  const merged = mergeSnapshots(localSnapshot([]), [offline]);
  assert.equal(merged.rows.length, 1);
  const box = merged.machines.find((m) => m.name === "box");
  assert.equal(box.status, "offline");
  assert.equal(box.fetchedAt, "2026-11-13T01:00:00.000Z");
  assert.equal(box.error, "machine unreachable");
});

test("a machine that never synced reports error and contributes no rows", () => {
  const never = { version: REMOTE_RECORD_VERSION, machine: "box", fetchedAt: null, attemptedAt: "2026-11-13T02:00:00.000Z", error: "no node", snapshot: null };
  const merged = mergeSnapshots(localSnapshot([]), [never]);
  assert.equal(merged.rows.length, 0);
  assert.equal(merged.machines.find((m) => m.name === "box").status, "error");
});

test("malformed records are skipped with a warning instead of breaking the merge", () => {
  const merged = mergeSnapshots(localSnapshot([row("2026-11-10", "s1", 10)]), [
    null,
    "garbage",
    { version: 999, machine: "future", snapshot: { rows: [] } },
    { version: REMOTE_RECORD_VERSION, machine: "", snapshot: { rows: [] } },
    record("good", [row("2026-11-10", "g", 2)]),
  ]);
  assert.equal(merged.rows.length, 2);
  assert.deepEqual(merged.machines.map((m) => m.name), [null, "good"]);
  assert.ok(merged.warnings.length >= 4);
});

test("invalid remote rows are dropped and token counts are sanitized", () => {
  const merged = mergeSnapshots(localSnapshot([]), [record("box", [
    row("not-a-day", "a", 1),
    null,
    row("2026-11-10", "b", 3, { tokens: { input: -5, output: "2", cacheRead: 1.9, cacheWrite: null, reasoning: 0, total: 999 } }),
  ])]);
  assert.equal(merged.rows.length, 1);
  // Same rules as core/util.mjs toNonNegInt: non-numbers and negatives become 0.
  assert.deepEqual(merged.rows[0].tokens, { input: 0, output: 0, cacheRead: 1, cacheWrite: 0, reasoning: 0, total: 1 });
  assert.ok(merged.warnings.some((w) => w.includes("box")));
});

test("a remote row cannot spoof this computer by carrying machine null", () => {
  const merged = mergeSnapshots(localSnapshot([]), [record("box", [row("2026-11-10", "s", 1, { machine: null })])]);
  assert.equal(merged.rows[0].machine, "box");
});

test("duplicate machine records keep the newest fetch", () => {
  const older = record("box", [row("2026-11-10", "old", 1)], { fetchedAt: "2026-11-12T00:00:00.000Z" });
  const newer = record("box", [row("2026-11-10", "new", 1)]);
  const merged = mergeSnapshots(localSnapshot([]), [newer, older]);
  assert.deepEqual(merged.rows.map((r) => r.session), ["box/new"]);
});

test("machine names containing / are rejected so scoped session ids cannot collide", () => {
  const merged = mergeSnapshots(localSnapshot([]), [
    record("a", [row("2026-11-10", "b/c", 1)]),
    record("a/b", [row("2026-11-10", "c", 1)]),
  ]);
  assert.deepEqual(merged.machines.map((m) => m.name), [null, "a"]);
  assert.ok(merged.warnings.some((w) => w.includes("a/b")));
});

test("machine names with leading or trailing whitespace are rejected", () => {
  const merged = mergeSnapshots(localSnapshot([]), [
    record(" box", [row("2026-11-10", "leading", 1)]),
    record("box ", [row("2026-11-10", "trailing", 1)]),
    record("box", [row("2026-11-10", "valid", 1)]),
  ]);
  assert.deepEqual(merged.machines.map((m) => m.name), [null, "box"]);
  assert.deepEqual(merged.rows.map((r) => r.session), ["box/valid"]);
  assert.ok(merged.warnings.some((warning) => warning.includes('" box"')));
  assert.ok(merged.warnings.some((warning) => warning.includes('"box "')));
});

test("impossible calendar days are dropped", () => {
  const merged = mergeSnapshots(localSnapshot([]), [record("box", [
    row("2026-13-45", "a", 1),
    row("0000-00-00", "b", 1),
    row("2026-02-30", "c", 1),
    row("2024-02-29", "d", 1),
  ])]);
  assert.deepEqual(merged.rows.map((r) => r.day), ["2024-02-29"]);
});

test("machineStatus classifies records", () => {
  assert.equal(machineStatus(record("a", [])), "ok");
  assert.equal(machineStatus(record("a", [], { error: "x" })), "offline");
  assert.equal(machineStatus({ ...record("a", []), snapshot: null, fetchedAt: null, error: "x" }), "error");
});
