import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { deriveDashboard } from "../../herdr-insights/mods/insights/analytics.js";
import { mergeSnapshots } from "../../herdr-insights/mods/insights/merge.mjs";
import { buildRemoteBundle, loadMachineRecords } from "../../herdr-insights/mods/insights/core/machines.mjs";
import {
  installCommand,
  machineFileStem,
  parseProbe,
  parseRows,
  probeCommand,
  rowsCommand,
  rowsFileText,
  stateFileText,
  syncMachine,
} from "../../herdr-insights/mods/insights/remote.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const modDir = path.resolve(here, "../../herdr-insights/mods/insights");
const fixtures = path.join(here, "fixtures");

function envelope(rows = [], extra = {}) {
  return {
    kind: "insights-remote-rows",
    version: 1,
    generatedAt: "2026-11-13T00:00:00.000Z",
    lastScanAt: "2026-11-13T00:00:00.000Z",
    lastCompletedScanAt: "2026-11-13T00:00:00.000Z",
    rowCount: rows.length,
    rows: gzipSync(JSON.stringify(rows)).toString("base64"),
    scan: { status: "complete", processed: 1, total: 1 },
    warnings: [],
    ...extra,
  };
}

const probeLine = (fields) => `${JSON.stringify({ ok: true, installed: true, dir: "/r/.cache/herdr-insights/0123456789abcdef", node: "/usr/bin/node", version: "v22.23.1", ...fields })}\n`;

test("parseProbe reads the last JSON line and rejects garbage", () => {
  assert.equal(parseProbe(`motd banner\n${probeLine({ installed: false })}`).installed, false);
  assert.deepEqual(parseProbe('{"ok":false,"error":"node was not found on PATH"}\n'), {
    ok: false, installed: false, dir: null, node: null, version: null, error: "node was not found on PATH",
  });
  assert.throws(() => parseProbe(""));
  assert.throws(() => parseProbe("not json"));
  assert.throws(() => parseProbe('{"ok":true,"installed":true}'), /dir/);
});

test("parseRows validates the envelope and surfaces remote errors", () => {
  const good = envelope();
  assert.equal(parseRows(`${JSON.stringify(good)}\n`).rowCount, 0);
  assert.throws(() => parseRows(JSON.stringify({ kind: "insights-remote-rows", version: 1, error: "boom" })), /boom/);
  assert.throws(() => parseRows(JSON.stringify({ ...good, kind: "other" })));
  assert.throws(() => parseRows(JSON.stringify({ ...good, version: 2 })));
  assert.throws(() => parseRows(JSON.stringify({ ...good, rows: 5 })));
  assert.throws(() => parseRows(JSON.stringify({ ...good, rowCount: -1 })));
  assert.throws(() => parseRows(JSON.stringify({ ...good, scan: null })));
  assert.throws(() => parseRows("{"));
});

test("machineFileStem is filesystem-safe and injective on tricky names", () => {
  const names = ["box", "a/b", "a_2f_b", "x-0061", "a", "..", ".", "機器", "x-", "A"];
  const stems = names.map(machineFileStem);
  assert.equal(new Set(stems).size, names.length);
  for (const stem of stems) assert.match(stem, /^[A-Za-z0-9._-]+$/);
  assert.ok(!stems.includes(".") && !stems.includes(".."));
  assert.equal(machineFileStem("local-container"), "local-container");
  const folded = ["Box", "box", "BOX"].map((name) => machineFileStem(name).toLowerCase());
  assert.equal(new Set(folded).size, 3, "names differing only in case must not share a file on a case-insensitive disk");
});

test("parseRows keeps only counters from scan progress, never remote file paths", () => {
  const value = parseRows(JSON.stringify(envelope([], {
    scan: { status: "running", processed: 3, total: 9, live: { file: "/home/u/.codex/sessions/secret.jsonl", phase: "scan", processed: 3, total: 9, decodedBytes: 10 } },
    warnings: ["x".repeat(1000)],
  })));
  assert.deepEqual(value.scan, { status: "running", processed: 3, total: 9, live: { phase: "scan", processed: 3, total: 9, decodedBytes: 10 } });
  assert.ok(value.warnings[0].length <= 300);
});

test("install command keeps the payload in one bounded argument", () => {
  const command = installCommand("0123456789abcdef", "QUJD");
  assert.equal(command.command, "sh");
  assert.deepEqual(command.args.slice(-2), ["0123456789abcdef", "QUJD"]);
  assert.equal(probeCommand("0123456789abcdef").args.at(-1), "0123456789abcdef");
  assert.throws(() => installCommand("0123456789abcdef", "A".repeat(120000)), /too large/);
});

function fakeExec(responses) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { code: 0, stderr: "", ...next };
  };
  return { exec, calls };
}

const bundle = async () => ({ hash: "0123456789abcdef", payload: "UEFZTE9BRA" });

test("syncMachine runs probe then rows when the bundle is installed", async () => {
  const { exec, calls } = fakeExec([{ stdout: probeLine() }, { stdout: JSON.stringify(envelope()) }]);
  const result = await syncMachine({ exec, bundle });
  assert.equal(result.envelope.kind, "insights-remote-rows");
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].args.includes("UEFZTE9BRA"));
  assert.ok(calls[1].args.includes("/r/.cache/herdr-insights/0123456789abcdef/remote-entry.mjs"));
  assert.ok(calls.every((call) => Number.isInteger(call.options?.timeout)));
});

test("syncMachine installs a missing bundle before fetching rows", async () => {
  const { exec, calls } = fakeExec([
    { stdout: probeLine({ installed: false }) },
    { stdout: probeLine() },
    { stdout: JSON.stringify(envelope()) },
  ]);
  await syncMachine({ exec, bundle });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].args.at(-1), "UEFZTE9BRA");
});

test("syncMachine reports unreachable machines, missing node, old node, and failed commands", async () => {
  await assert.rejects(syncMachine({ exec: fakeExec([new Error("machine unreachable")]).exec, bundle }), /unreachable/);
  await assert.rejects(
    syncMachine({ exec: fakeExec([{ stdout: '{"ok":false,"error":"node was not found on PATH"}' }]).exec, bundle }),
    /node was not found/,
  );
  await assert.rejects(
    syncMachine({ exec: fakeExec([{ stdout: '{"ok":false,"error":"Node 22.15+ is required (found v20.1.0)"}' }]).exec, bundle }),
    /22\.15/,
  );
  await assert.rejects(
    syncMachine({ exec: fakeExec([{ stdout: probeLine() }, { code: 1, stdout: "", stderr: "trace\nError: disk full\n" }]).exec, bundle }),
    /disk full/,
  );
  await assert.rejects(
    syncMachine({ exec: fakeExec([{ stdout: probeLine({ installed: false }) }, { stdout: probeLine({ installed: false }) }]).exec, bundle }),
    /install/,
  );
});

function run(command, env) {
  return new Promise((resolve, reject) => {
    execFile(command.command, command.args, { env, timeout: command.timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test("end to end: install, collect, and merge on this machine through the shell commands", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "insights-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const session = path.join(home, ".codex/sessions/2026/03/03/rollout-modern.jsonl");
  await mkdir(path.dirname(session), { recursive: true });
  await copyFile(path.join(fixtures, "codex-modern.jsonl"), session);
  const env = { ...process.env, HOME: home };

  const { hash, payload } = await buildRemoteBundle(modDir);
  assert.match(hash, /^[0-9a-f]{16}$/);

  const firstProbe = parseProbe((await run(probeCommand(hash), env)).stdout);
  assert.equal(firstProbe.ok, true);
  assert.equal(firstProbe.installed, false);

  const tampered = gzipSync(JSON.stringify({ files: { "collector.mjs": "export {}" } })).toString("base64");
  const rejected = parseProbe((await run(installCommand(hash, tampered), env)).stdout);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /hash mismatch/);
  const cacheBase = path.join(home, ".cache/herdr-insights");
  assert.equal(await exists(path.join(cacheBase, hash)), false);

  const installed = parseProbe((await run(installCommand(hash, payload), env)).stdout);
  assert.equal(installed.installed, true);
  assert.equal(installed.dir, path.join(cacheBase, hash));
  const again = parseProbe((await run(installCommand(hash, payload), env)).stdout);
  assert.equal(again.installed, true);
  assert.deepEqual((await readdir(cacheBase)).filter((name) => name.includes(".tmp-")), []);

  const rowsResult = await run(rowsCommand(installed), env);
  assert.equal(rowsResult.code, 0, rowsResult.stderr);
  const remote = parseRows(rowsResult.stdout);
  assert.ok(remote.rowCount > 0);

  const machinesDir = path.join(root, "machines");
  await mkdir(machinesDir);
  const fetchedAt = "2026-11-13T01:00:00.000Z";
  await writeFile(path.join(machinesDir, `${machineFileStem("box")}.rows.json`), rowsFileText({ machine: "box", envelope: remote, fetchedAt }));
  await writeFile(path.join(machinesDir, `${machineFileStem("box")}.state.json`), stateFileText({ machine: "box", attemptedAt: fetchedAt, error: null }));
  const { records, warnings } = await loadMachineRecords(machinesDir);
  assert.deepEqual(warnings, []);
  const merged = mergeSnapshots({ config: {}, rows: [] }, records);

  const direct = await run({
    command: process.execPath,
    args: [path.join(modDir, "collector.mjs"), "snapshot", "--store", path.join(root, "direct/insights.json"), "--home", home],
    timeout: 60_000,
  }, env);
  assert.equal(direct.code, 0, direct.stderr);
  const directSnapshot = JSON.parse(direct.stdout);
  const today = "2026-11-13";
  const expected = deriveDashboard(directSnapshot, { today }).lifetime.total;
  assert.ok(expected > 0);
  assert.equal(deriveDashboard(merged, { today }).lifetime.total, expected);
  assert.equal(deriveDashboard(merged, { today, filters: { machine: "box" } }).lifetime.total, expected);
});

test("loadMachineRecords pairs files, skips corrupt ones, and honors disabled machines", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "insights-machines-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const row = { day: "2026-11-10", session: "s", harness: "codex", provider: "openai", model: "m", project: "/p", tokens: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 } };
  await writeFile(path.join(dir, "box.rows.json"), rowsFileText({ machine: "box", envelope: envelope([row]), fetchedAt: "2026-11-13T01:00:00.000Z" }));
  await writeFile(path.join(dir, "box.state.json"), stateFileText({ machine: "box", attemptedAt: "2026-11-13T02:00:00.000Z", error: "machine unreachable" }));
  await writeFile(path.join(dir, "never.state.json"), stateFileText({ machine: "never", attemptedAt: "2026-11-13T02:00:00.000Z", error: "no node" }));
  await writeFile(path.join(dir, "off.rows.json"), rowsFileText({ machine: "off", envelope: envelope([row]), fetchedAt: "2026-11-13T01:00:00.000Z" }));
  await writeFile(path.join(dir, "bad.rows.json"), "{ truncated");
  await writeFile(path.join(dir, "notes.txt"), "ignored");

  const { records, warnings } = await loadMachineRecords(dir, { disabled: ["off"] });
  const byName = Object.fromEntries(records.map((record) => [record.machine, record]));
  assert.deepEqual(Object.keys(byName).sort(), ["box", "never"]);
  assert.equal(byName.box.snapshot.rows.length, 1);
  assert.equal(byName.box.error, "machine unreachable");
  assert.equal(byName.box.fetchedAt, "2026-11-13T01:00:00.000Z");
  assert.equal(byName.never.snapshot, null);
  assert.ok(warnings.some((warning) => warning.includes("bad.rows.json")));

  const merged = mergeSnapshots({ config: {}, rows: [] }, records);
  assert.equal(merged.machines.find((machine) => machine.name === "box").status, "offline");
  assert.deepEqual(await loadMachineRecords(path.join(dir, "missing")), { records: [], warnings: [] });
  assert.equal(JSON.parse(await readFile(path.join(dir, "box.state.json"), "utf8")).kind, "insights-remote-machine-state");
});
