import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withInstallerLock } from "../../herdr-insights/scripts/lib.mjs";
import {
  applyToolbar, prepareToolbar, prepareToolbarRemoval, removeToolbar,
} from "../../herdr-insights/scripts/toolbar.mjs";
import {
  APP_FILES, assertFailure, assertSuccess, createFakeRunner, createSourceWithLauncher,
  exists, makeEnvironment, readLog, runInstall, runUninstall, snapshotTree,
  temporaryRoot, writeTree,
} from "./install-fixtures.mjs";

function useFakeHerdr(t, fake) {
  for (const [key, value] of Object.entries({ HERDR_APP_BIN: fake.runner, FAKE_HERDR_LOG: fake.log })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function switchLayout(root, appHome, fake, name) {
  assertSuccess(spawnSync(fake.runner, ["do", "layout.switch", JSON.stringify({ name })], {
    env: makeEnvironment(root, appHome, fake), encoding: "utf8", timeout: 30_000,
  }));
}

test("the previously documented --open flag opens exactly one tab only after successful installation", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot, extra: ["--open"] }));
  let log = await readLog(fake);
  assert.deepEqual(log.at(-1).args, ["do", "tab.new", '{"name":"Insights","mod":"insights"}']);
  assert.equal(log.filter((entry) => entry.args[1] === "tab.new").length, 1);
  const result = runInstall({ appHome, fake, sourceRoot, extra: ["--open"], fail: "launcher-check" });
  assertFailure(result);
  log = await readLog(fake);
  assert.equal(log.filter((entry) => entry.args[1] === "tab.new").length, 1, "a failed check must never open a tab");
  const failedOpen = runInstall({ appHome, fake, sourceRoot, extra: ["--open"], fail: "open" });
  assertFailure(failedOpen);
  assert.match(failedOpen.stderr, /Opening Insights failed/);
  assert.equal(await exists(path.join(appHome, "mods/insights/main.js")), true);
  assert.equal(await exists(path.join(appHome, ".insights-install.lock")), false);
});

test("a failed check of either mod preserves an existing installation byte-for-byte", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const before = await snapshotTree(appHome);
  await fs.writeFile(path.join(sourceRoot, "mods/insights/main.js"), "new dashboard\n");
  await fs.writeFile(path.join(sourceRoot, "mods/insights-launcher/main.js"), "new launcher\n");
  for (const fail of ["check", "launcher-check"]) {
    const result = runInstall({ appHome, fake, sourceRoot, fail });
    assertFailure(result);
    assert.match(result.stderr, /No installed mod files were changed/);
    assert.deepEqual(await snapshotTree(appHome), before);
    assert.equal(await exists(path.join(appHome, ".insights-install.lock")), false);
    const checks = (await readLog(fake)).filter((entry) => entry.args[0] === "check");
    for (const entry of checks) assert.equal(await exists(entry.appHome), false, "staging is cleaned on failure");
  }
});

test("edits made during native checks are refused before either live mod is replaced", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const dashboard = path.join(appHome, "mods/insights/main.js");
  const launcher = path.join(appHome, "mods/insights-launcher/main.js");
  const before = await fs.readFile(dashboard, "utf8");
  await fs.writeFile(path.join(sourceRoot, "mods/insights/main.js"), "reviewed dashboard update\n");
  const result = runInstall({ appHome, fake, sourceRoot, env: { FAKE_HERDR_EDIT_TARGET: launcher } });
  assertFailure(result);
  assert.match(result.stderr, /Owned file was edited locally/);
  assert.equal(await fs.readFile(dashboard, "utf8"), before);
  assert.match(await fs.readFile(launcher, "utf8"), /edit during check/);
});

test("fresh launcher check failures leave neither live mod installed", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const before = await snapshotTree(appHome);
  const fake = await createFakeRunner(root);
  assertFailure(runInstall({ appHome, fake, sourceRoot, fail: "launcher-check" }));
  assert.deepEqual(await snapshotTree(appHome), before);
  assert.equal(await exists(path.join(appHome, "mods/insights")), false);
  assert.equal(await exists(path.join(appHome, "mods/insights-launcher")), false);
});

test("concurrent install and uninstall fail closed while another operation holds the lock", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  const before = await snapshotTree(appHome);
  await withInstallerLock(appHome, async () => {
    for (const result of [runInstall({ appHome, fake, sourceRoot, extra: ["--force"] }), runUninstall({ appHome, fake })]) {
      assertFailure(result);
      assert.match(result.stderr, /install\/uninstall is locked/);
    }
    assert.deepEqual(await snapshotTree(appHome), before);
    assert.deepEqual(await readLog(fake), []);
  });
  assert.equal(await exists(path.join(appHome, ".insights-install.lock")), false);
  await assert.rejects(withInstallerLock(appHome, async () => { throw new Error("failed operation"); }), /failed operation/);
  assert.equal(await exists(path.join(appHome, ".insights-install.lock")), false);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
});

test("toolbar revalidates destination state and source links after preflight", async (t) => {
  const root = await temporaryRoot(t);
  const fake = await createFakeRunner(root);
  useFakeHerdr(t, fake);
  for (const kind of ["destination-state", "destination-link", "source-link"]) {
    const appHome = path.join(root, kind);
    await writeTree(appHome, APP_FILES);
    const plan = await prepareToolbar(appHome);
    const state = path.join(appHome, "layouts/.state", kind === "source-link" ? "main.json" : "main-insights.json");
    await fs.mkdir(path.dirname(state), { recursive: true });
    const outside = path.join(root, `${kind}.json`);
    await fs.writeFile(outside, "preserved state\n");
    if (kind === "destination-state") await fs.writeFile(state, "new click state\n");
    else await fs.symlink(outside, state);
    await assert.rejects(applyToolbar(plan), /destination appeared|symbolic link/);
    assert.equal(await fs.readFile(outside, "utf8"), "preserved state\n");
    assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), false);
  }
  assert.equal((await readLog(fake)).filter((entry) => entry.args[1] === "layout.clone").length, 0);
});

test("uninstall rechecks the active layout instead of deleting a newly selected toolbar", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  useFakeHerdr(t, fake);
  switchLayout(root, appHome, fake, "main");
  const plan = await prepareToolbarRemoval(appHome);
  switchLayout(root, appHome, fake, "main-insights");
  await removeToolbar(plan);
  const log = await readLog(fake);
  assert.deepEqual(log.at(-2).args, ["do", "layout.switch", '{"name":"main"}']);
  assert.deepEqual(log.at(-1).args, ["status"]);
  assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), false);
});

test("uninstall preserves a toolbar edited while the layout-switch command is running", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const result = runUninstall({ appHome, fake, fail: "edit-on-switch" });
  assertFailure(result);
  assert.match(result.stderr, /Toolbar layout changed during uninstall/);
  assert.match(await fs.readFile(path.join(appHome, "layouts/main-insights.json"), "utf8"), /local edit/);
  for (const relative of ["mods/insights/main.js", "mods/insights-launcher/main.js", "data/insights/toolbar-install.json"]) {
    assert.equal(await exists(path.join(appHome, relative)), true);
  }
});
