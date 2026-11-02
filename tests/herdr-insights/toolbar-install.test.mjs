import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  APP_FILES,
  PACKAGE_ROOT,
  TOOLBAR_LAYOUT,
  assertFailure,
  assertStagedChecks,
  assertSuccess,
  createFakeRunner,
  createSourceWithLauncher,
  exists,
  listFiles,
  makeEnvironment,
  readJson,
  readLog,
  runInstall,
  runUninstall,
  snapshotTree,
  temporaryRoot,
  writeTree,
} from "./install-fixtures.mjs";

test("standalone distribution installs toolbar without repo tooling or a floating window", async (t) => {
  const root = await temporaryRoot(t);
  const distribution = path.join(root, "herdr-insights");
  await fs.cp(PACKAGE_ROOT, distribution, { recursive: true });
  const appHome = path.join(root, "app");
  await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
  const fake = await createFakeRunner(root);
  const result = spawnSync(process.execPath, [path.join(distribution, "scripts/install.mjs")], {
    cwd: distribution,
    env: makeEnvironment(root, appHome, fake),
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  assertSuccess(result);
  assert.match(result.stdout, /herdr-app check passed/);
  const log = await readLog(fake);
  const checks = await assertStagedChecks(log, ["insights", "insights-launcher"], appHome);
  assert.deepEqual(log.map((entry) => entry.args), [
    ["status"],
    ...checks,
    ["do", "layout.clone", '{"name":"main","as":"main-insights"}'],
  ]);
  await assert.rejects(fs.lstat(path.join(appHome, "data/insights/insights.json")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(root)).sort(),
    ["app", "fake bin", "fake herdr log.jsonl", "herdr-insights"]);
});

test("launcher installs, checks, reinstalls and uninstalls through the same safe ownership rules", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const log = await readLog(fake);
  const checks = await assertStagedChecks(log, ["insights", "insights-launcher"], appHome);
  assert.deepEqual(log.map((entry) => entry.args), [
    ["status"],
    ...checks,
    ["do", "layout.clone", '{"name":"main","as":"main-insights"}'],
  ]);
  const launcher = path.join(appHome, "mods/insights-launcher");
  assert.deepEqual(await listFiles(launcher), ["insights.svg", "main.js", "mod.json"]);
  const manifest = await readJson(path.join(appHome, "data/insights/launcher-install-manifest.json"));
  assert.equal(manifest.target, "mods/insights-launcher");
  assert.deepEqual(Object.keys(manifest.files), ["insights.svg", "main.js", "mod.json"]);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal((await readLog(fake)).filter((entry) => entry.args[1] === "layout.clone").length, 1,
    "reinstall must not clone another layout");
  assert.equal((await readLog(fake)).filter((entry) => entry.args[1] === "mod.open").length, 0,
    "no floating window");
  for (const [relative, content] of Object.entries(APP_FILES)) {
    assert.equal(await fs.readFile(path.join(appHome, relative), "utf8"), content);
  }
  await fs.writeFile(path.join(launcher, "main.js"), "local launcher edit\n");
  const before = await fs.readFile(path.join(appHome, "mods/insights/main.js"), "utf8");
  await fs.writeFile(path.join(sourceRoot, "mods/insights/main.js"), "new dashboard\n");
  const refused = runInstall({ appHome, fake, sourceRoot });
  assertFailure(refused);
  assert.match(refused.stderr, /Owned file was edited locally/);
  assert.equal(await fs.readFile(path.join(appHome, "mods/insights/main.js"), "utf8"), before);
  assertSuccess(runUninstall({ appHome, fake }));
  assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), false);
  assert.equal(await exists(path.join(appHome, "data/insights/toolbar-install.json")), false);
  assert.equal(await fs.readFile(path.join(launcher, "main.js"), "utf8"), "local launcher edit\n");
  assert.equal(await exists(path.join(launcher, "mod.json")), false);
  assert.equal(await exists(path.join(appHome, "mods/insights")), false);
});

test("launcher collisions and links fail before either mod is written, even with --force", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const fake = await createFakeRunner(root);
  for (const kind of ["unowned", "symlink"]) {
    const appHome = path.join(root, kind);
    const target = path.join(appHome, "mods/insights-launcher");
    if (kind === "unowned") await writeTree(target, { "main.js": "unowned\n" });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(sourceRoot, "mods/insights-launcher"), target);
    }
    const refused = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
    assertFailure(refused);
    assert.match(refused.stderr, /unowned collision|symbolic-link target/);
    assert.equal(await exists(path.join(appHome, "mods/insights")), false);
  }
  assert.deepEqual(await readLog(fake), []);
});

test("launcher check or activation failures never open a dashboard tab", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  for (const fail of ["launcher-check", "open"]) {
    const fake = await createFakeRunner(path.join(root, fail));
    const appHome = path.join(root, fail, "app");
    await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
    const result = runInstall({ appHome, fake, sourceRoot, fail });
    assertFailure(result);
    const log = await readLog(fake);
    assert.equal(log.filter((entry) => entry.args[1] === "tab.new").length, 0);
    if (fail === "launcher-check") {
      assert.equal(log.filter((entry) => entry.args[0] === "do").length, 0);
    } else {
      assert.match(result.stderr, /layout.clone.*failed/);
    }
  }
});

test("uninstall preflights both targets before deleting either mod", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const fake = await createFakeRunner(root);
  for (const kind of ["symlink", "unowned", "corrupt-manifest"]) {
    const appHome = path.join(root, kind);
    await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
    assertSuccess(runInstall({ appHome, fake, sourceRoot }));
    const target = path.join(appHome, "mods/insights-launcher");
    if (kind === "symlink") {
      await fs.rm(target, { recursive: true });
      await fs.symlink(path.join(sourceRoot, "mods/insights-launcher"), target);
    } else if (kind === "unowned") {
      await fs.unlink(path.join(appHome, "data/insights/launcher-install-manifest.json"));
    } else {
      await fs.writeFile(path.join(appHome, "data/insights/launcher-install-manifest.json"), "{broken");
    }
    const before = await snapshotTree(appHome);
    assertFailure(runUninstall({ appHome }));
    assert.deepEqual(await snapshotTree(appHome), before, kind);
    assert.equal(await exists(path.join(appHome, "mods/insights/main.js")), true);
  }
});

test("toolbar refuses unsupported layouts and state symlinks before writing either mod", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const fake = await createFakeRunner(root);
  for (const kind of ["unsupported", "symlink", "state-link", "state-directory-link"]) {
    const appHome = path.join(root, kind);
    await writeTree(appHome, { "layouts/main.json": TOOLBAR_LAYOUT });
    if (kind === "state-link") {
      await fs.mkdir(path.join(appHome, "layouts/.state"));
      await fs.symlink(path.join(sourceRoot, "layouts/other.json"), path.join(appHome, "layouts/.state/main.json"));
    }
    if (kind === "state-directory-link") {
      await fs.symlink(path.join(sourceRoot, "layouts"), path.join(appHome, "layouts/.state"));
    }
    if (kind === "unsupported") await fs.writeFile(path.join(appHome, "layouts/main.json"), '{"id":"root","type":"row","children":[]}');
    if (kind === "symlink") {
      await fs.unlink(path.join(appHome, "layouts/main.json"));
      await fs.symlink(path.join(sourceRoot, "layouts/other.json"), path.join(appHome, "layouts/main.json"));
    }
    const refused = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
    assertFailure(refused);
    assert.match(refused.stderr, /cannot be integrated safely|symbolic link/);
    assert.equal(await exists(path.join(appHome, "mods/insights")), false);
    assert.equal(await exists(path.join(appHome, "mods/insights-launcher")), false);
  }
});

test("reinstall preserves edited personal layouts and uninstall fails closed before deleting any files", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const layoutFile = path.join(appHome, "layouts/main-insights.json");
  const original = await fs.readFile(layoutFile, "utf8");
  const edited = JSON.parse(original);
  edited.ui_font = "My custom font";
  const custom = JSON.stringify(edited, null, 2) + "\n";
  await fs.writeFile(layoutFile, custom);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal(await fs.readFile(layoutFile, "utf8"), custom);
  const before = await Promise.all((await listFiles(appHome)).map(async (relative) =>
    [relative, await fs.readFile(path.join(appHome, relative), "utf8")]));
  const refused = runUninstall({ appHome, fake });
  assertFailure(refused);
  assert.match(refused.stderr, /Toolbar layout was edited locally/);
  const after = await Promise.all((await listFiles(appHome)).map(async (relative) =>
    [relative, await fs.readFile(path.join(appHome, relative), "utf8")]));
  assert.deepEqual(after, before);
  await fs.writeFile(layoutFile, original);
  assertSuccess(runUninstall({ appHome, fake }));
  const log = await readLog(fake);
  assert.equal(log.filter((entry) => entry.args[1] === "layout.clone").length, 1);
  assert.deepEqual(log.at(-2).args, ["do", "layout.switch", '{"name":"main"}']);
  assert.deepEqual(log.at(-1).args, ["status"]);
  assert.equal(await fs.readFile(path.join(appHome, "layouts/main.json"), "utf8"), TOOLBAR_LAYOUT);
});

test("toolbar skips layout/state collisions, preserves click state, and can reinstall after uninstall", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const appHome = path.join(root, "app");
  const state = '{"nodes":{"panel":{"hidden":false}},"theme":"ink"}\n';
  await writeTree(appHome, {
    ...APP_FILES,
    "layouts/.state/main.json": state,
    "layouts/main-insights.json": "unowned layout\n",
    "layouts/.state/main-insights-2.json": "unowned click state\n",
  });
  const outside = path.join(root, "outside-state.json");
  await fs.writeFile(outside, "outside state\n");
  await fs.symlink(outside, path.join(appHome, "layouts/.state/main-insights-3.json"));
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const recordFile = path.join(appHome, "data/insights/toolbar-install.json");
  assert.equal((await readJson(recordFile)).layout, "main-insights-4");
  const stateFile = path.join(appHome, "layouts/.state/main-insights-4.json");
  assert.equal(await fs.readFile(stateFile, "utf8"), state);
  await fs.writeFile(stateFile, "user's updated click state\n");
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal(await fs.readFile(stateFile, "utf8"), "user's updated click state\n");
  assertSuccess(runUninstall({ appHome, fake }));
  assert.equal(await fs.readFile(stateFile, "utf8"), "user's updated click state\n");
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal((await readJson(recordFile)).layout, "main-insights-5");
  assert.equal(await fs.readFile(path.join(appHome, "layouts/main-insights.json"), "utf8"), "unowned layout\n");
  assert.equal(await fs.readFile(path.join(appHome, "layouts/.state/main-insights-2.json"), "utf8"), "unowned click state\n");
  assert.equal(await fs.readFile(outside, "utf8"), "outside state\n");
});

test("uninstall verifies the original layout exists and actually became selected", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  for (const fail of ["missing-source", "ignored-switch"]) {
    const appHome = path.join(root, fail);
    await writeTree(appHome, APP_FILES);
    const fake = await createFakeRunner(path.join(root, `${fail}-runner`));
    assertSuccess(runInstall({ appHome, fake, sourceRoot }));
    if (fail === "missing-source") await fs.unlink(path.join(appHome, "layouts/main.json"));
    const refused = runUninstall({ appHome, fake, fail });
    assertFailure(refused);
    assert.match(refused.stderr, /Original layout main is missing|Herdr did not leave/);
    assert.equal(await exists(path.join(appHome, "layouts/main-insights.json")), true);
    assert.equal(await exists(path.join(appHome, "mods/insights/main.js")), true);
    assert.equal(await exists(path.join(appHome, "data/insights/toolbar-install.json")), true);
  }
});

test("toolbar ownership records reject traversal and do not overwrite personal files", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSourceWithLauncher(root);
  const fake = await createFakeRunner(root);
  const appHome = path.join(root, "app");
  await writeTree(appHome, {
    ...APP_FILES,
    "data/insights/toolbar-install.json": JSON.stringify({ version: 1, owner: "herdr-insights-toolbar",
      source: "../escape", layout: "../escape-insights", hash: "a".repeat(64) }),
  });
  const refused = runInstall({ appHome, fake, sourceRoot });
  assertFailure(refused);
  assert.match(refused.stderr, /Invalid toolbar ownership record/);
  assert.equal(await exists(path.join(appHome, "mods/insights")), false);
  assert.deepEqual(await readLog(fake), []);
  assertFailure(runUninstall({ appHome, fake }));
});
