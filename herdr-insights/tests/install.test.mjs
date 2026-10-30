import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isNodeVersionSupported } from "../scripts/lib.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const INSTALL_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "install.mjs");
const UNINSTALL_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "uninstall.mjs");
const CHECK_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "check.mjs");
const OPEN_JSON = '{"name":"Insights","mod":"insights"}';
const RUNTIME_REL = "runtime.json";

const DEFAULT_MOD_FILES = {
  "analytics.js": "export const version = 1;\n",
  "collector.mjs": "export const collector = true;\n",
  "core/usage.mjs": "export const usage = true;\n",
  "icons/insights.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  "main.js": "export default class Insights {}\n",
  "mod.json": '{\n  "place": "none"\n}\n',
};

function runtimeContent(nodePath = process.execPath) {
  return `${JSON.stringify({ node: nodePath })}\n`;
}

function ownedFiles() {
  return [...Object.keys(DEFAULT_MOD_FILES), RUNTIME_REL].sort();
}

const APP_FILES = {
  "data/insights/insights.json": '{"version":1,"keep":"local"}\n',
  "data/insights/local-note.txt": "local data\n",
  "keys.json": '{"global":{"ctrl-shift-t":"tab.new"}}\n',
  "layouts/main.json": '{"id":"root","type":"row","children":[]}\n',
  "mods/other/main.js": "export default class Other {}\n",
  "settings.json": '{"zoom":1}\n',
};

test("manifest keys round-trip safely, including __proto__", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root, { ...DEFAULT_MOD_FILES, ["__proto__"]: "owned\n" });
  const appHome = path.join(root, "app");
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const manifest = await readJson(path.join(appHome, "data/insights/install-manifest.json"));
  assert.equal(manifest.files.__proto__, hash("owned\n"));
  assertSuccess(runUninstall({ appHome }));
  assert.equal(await exists(path.join(appHome, "mods/insights/__proto__")), false);
});

test("corrupt manifests fail closed with recovery guidance and preserve data", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app");
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const manifest = path.join(appHome, "data/insights/install-manifest.json");
  await fs.writeFile(manifest, "{broken");
  const snapshot = async () => Promise.all((await listFiles(appHome)).map(async (relative) =>
    [relative, await fs.readFile(path.join(appHome, relative), "utf8")]));
  const before = await snapshot();
  for (const result of [runInstall({ appHome, fake, sourceRoot }), runUninstall({ appHome })]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /preserve or move aside both/);
    assert.match(result.stderr, /insights.json.*in place/);
  }
  assert.deepEqual(await snapshot(), before);
});

test("reinstall retains ownership proof for edited stale files", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root, { ...DEFAULT_MOD_FILES, "stale.js": "original\n" });
  const appHome = path.join(root, "app");
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const target = path.join(appHome, "mods/insights/stale.js");
  await fs.writeFile(target, "local edit\n");
  await fs.unlink(path.join(sourceRoot, "mods/insights/stale.js"));
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const manifest = await readJson(path.join(appHome, "data/insights/install-manifest.json"));
  assert.equal(manifest.files["stale.js"], hash("original\n"));
  assert.equal(await fs.readFile(target, "utf8"), "local edit\n");
  await fs.writeFile(target, "original\n");
  assertSuccess(runUninstall({ appHome }));
  assert.equal(await exists(target), false);
});

test("fresh install copies only owned mod files and preserves local app state", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "herdr app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);

  const result = runInstall({ appHome, fake, pathLookup: true, sourceRoot });
  assertSuccess(result);
  assert.equal((await fs.stat(path.join(appHome, "data/insights"))).mode & 0o777, 0o700);

  assert.deepEqual(
    await listFiles(path.join(appHome, "mods", "insights")),
    ownedFiles(),
  );
  for (const [relative, content] of Object.entries(DEFAULT_MOD_FILES)) {
    assert.equal(
      await fs.readFile(path.join(appHome, "mods", "insights", relative), "utf8"),
      content,
      relative,
    );
  }
  assert.equal(
    await fs.readFile(path.join(appHome, "mods", "insights", RUNTIME_REL), "utf8"),
    runtimeContent(),
  );

  for (const [relative, content] of Object.entries(APP_FILES)) {
    assert.equal(
      await fs.readFile(path.join(appHome, relative), "utf8"),
      content,
      `preserved ${relative}`,
    );
  }

  assert.equal(await exists(path.join(appHome, "README.md")), false);
  assert.equal(await exists(path.join(appHome, "tests", "source-only.txt")), false);
  assert.equal(await exists(path.join(appHome, "layouts", "other.json")), false);

  const manifest = await readJson(path.join(appHome, "data", "insights", "install-manifest.json"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.owner, "herdr-insights");
  assert.equal(manifest.target, "mods/insights");
  assert.deepEqual(Object.keys(manifest.files).sort(), ownedFiles());
  for (const [relative, content] of Object.entries(DEFAULT_MOD_FILES)) {
    assert.equal(manifest.files[relative], hash(content), relative);
  }
  assert.equal(manifest.files[RUNTIME_REL], hash(runtimeContent()));

  const log = await readLog(fake);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].args, [
    "check",
    path.join(await fs.realpath(appHome), "mods", "insights"),
  ]);
  assert.equal(log[0].appHome, await fs.realpath(appHome));

  const fakeHome = path.join(root, "fake home");
  if (await exists(fakeHome)) {
    assert.deepEqual(await fs.readdir(fakeHome), []);
  }
});

test("Herdr-generated declarations and jsconfig.json are ignored by source installs", async (t) => {
  const root = await temporaryRoot(t);
  const generatedFiles = {
    "insights.d.ts": "declare const generated: true;\n",
    "jsconfig.json": '{"compilerOptions":{"strict":true}}\n',
    "nested/schema.d.ts": "export type Generated = true;\n",
    "nested/jsconfig.json": '{"compilerOptions":{}}\n',
  };
  const sourceRoot = await createSource(root, {
    ...DEFAULT_MOD_FILES,
    ...generatedFiles,
  });
  const appHome = path.join(root, "app home");
  const fake = await createFakeRunner(root);

  const result = runInstall({ appHome, fake, sourceRoot });
  assertSuccess(result);
  assert.match(result.stdout, /Installed 7 owned file/);

  const installed = await listFiles(path.join(appHome, "mods", "insights"));
  assert.deepEqual(installed, ownedFiles());

  const manifest = await readJson(
    path.join(appHome, "data", "insights", "install-manifest.json"),
  );
  assert.deepEqual(Object.keys(manifest.files).sort(), ownedFiles());
  for (const relative of Object.keys(generatedFiles)) {
    assert.equal(
      await exists(path.join(sourceRoot, "mods", "insights", relative)),
      true,
      `generated source ${relative}`,
    );
    assert.equal(
      await exists(path.join(appHome, "mods", "insights", relative)),
      false,
      `not copied ${relative}`,
    );
    assert.equal(manifest.files[relative], undefined, `not hashed ${relative}`);
  }
});

test("runtime.json is generated from the installer Node, replaces a source copy, and rejects a source symlink", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root, {
    ...DEFAULT_MOD_FILES,
    [RUNTIME_REL]: '{"node":"/definitely/not/the/installer/node"}\n',
  });
  const appHome = path.join(root, "runtime app home");
  const fake = await createFakeRunner(root);

  const result = runInstall({ appHome, fake, sourceRoot });
  assertSuccess(result);
  assert.match(result.stdout, /Generated runtime\.json for Node /);

  const runtimePath = path.join(appHome, "mods", "insights", RUNTIME_REL);
  assert.equal(await fs.readFile(runtimePath, "utf8"), runtimeContent());
  assert.deepEqual(JSON.parse(await fs.readFile(runtimePath, "utf8")), {
    node: process.execPath,
  });
  const manifest = await readJson(
    path.join(appHome, "data", "insights", "install-manifest.json"),
  );
  assert.equal(manifest.files[RUNTIME_REL], hash(runtimeContent()));

  const symlinkSource = await createSource(
    root,
    DEFAULT_MOD_FILES,
    "runtime symlink source",
  );
  const outside = path.join(root, "outside-runtime.json");
  await fs.writeFile(outside, '{"node":"outside"}\n');
  await fs.symlink(outside, path.join(symlinkSource, "mods", "insights", RUNTIME_REL));
  const symlinkApp = path.join(root, "runtime symlink app");
  const refused = runInstall({ appHome: symlinkApp, fake, sourceRoot: symlinkSource });
  assertFailure(refused);
  assert.match(refused.stderr, /symbolic link/i);
  assert.equal(await fs.readFile(outside, "utf8"), '{"node":"outside"}\n');
  assert.equal(await exists(path.join(symlinkApp, "mods", "insights")), false);
});

test("--open uses argv-safe executable arguments and runs only after a passing check", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root, DEFAULT_MOD_FILES, "reviewed source's tree");
  const appHome = path.join(root, "herdr app's home (dev)");
  const fake = await createFakeRunner(root);

  const result = runInstall({
    appHome,
    fake,
    pathLookup: true,
    sourceRoot,
    extra: ["--open"],
  });
  assertSuccess(result);

  const log = await readLog(fake);
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].args, [
    "check",
    path.join(await fs.realpath(appHome), "mods", "insights"),
  ]);
  assert.equal(log[0].appHome, await fs.realpath(appHome));
  assert.deepEqual(log[1].args, ["do", "tab.new", OPEN_JSON]);
  assert.match(result.stdout, /Opened the Insights tab/);
});

test("reinstall is idempotent, updates reviewed files, removes stale ones, and keeps local extras", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);

  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const localExtra = path.join(appHome, "mods", "insights", "local-note.txt");
  await fs.writeFile(localExtra, "keep me\n");

  await fs.writeFile(
    path.join(sourceRoot, "mods", "insights", "main.js"),
    "export default class Insights { version = 2; }\n",
  );
  await writeTree(path.join(sourceRoot, "mods", "insights"), {
    "extra/new.mjs": "export const added = true;\n",
  });
  await fs.unlink(path.join(sourceRoot, "mods", "insights", "icons", "insights.svg"));

  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  assert.equal(
    await fs.readFile(path.join(appHome, "mods", "insights", "main.js"), "utf8"),
    "export default class Insights { version = 2; }\n",
  );
  assert.equal(await exists(path.join(appHome, "mods", "insights", "extra", "new.mjs")), true);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "icons", "insights.svg")), false);
  assert.equal(await fs.readFile(localExtra, "utf8"), "keep me\n");

  const manifest = await readJson(path.join(appHome, "data", "insights", "install-manifest.json"));
  assert.equal(manifest.files["extra/new.mjs"], hash("export const added = true;\n"));
  assert.equal(manifest.files["icons/insights.svg"], undefined);
  assert.equal(manifest.files["local-note.txt"], undefined);

  const third = runInstall({ appHome, fake, sourceRoot });
  assertSuccess(third);
  assert.match(third.stdout, /0 written/);
  assert.equal(await fs.readFile(localExtra, "utf8"), "keep me\n");

  const log = await readLog(fake);
  assert.equal(log.filter((entry) => entry.args[0] === "check").length, 3);
});

test("locally edited owned files are refused unless --force is explicit", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);

  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const targetMain = path.join(appHome, "mods", "insights", "main.js");
  await fs.writeFile(targetMain, "local edit\n");
  await fs.writeFile(
    path.join(sourceRoot, "mods", "insights", "main.js"),
    "reviewed edit\n",
  );

  const refused = runInstall({ appHome, fake, sourceRoot });
  assertFailure(refused);
  assert.match(refused.stderr, /edited locally/i);
  assert.equal(await fs.readFile(targetMain, "utf8"), "local edit\n");
  assert.equal((await readLog(fake)).length, 1);

  const forced = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
  assertSuccess(forced);
  assert.equal(await fs.readFile(targetMain, "utf8"), "reviewed edit\n");
  const manifest = await readJson(path.join(appHome, "data", "insights", "install-manifest.json"));
  assert.equal(manifest.files["main.js"], hash("reviewed edit\n"));
});

test("runtime.json is idempotent, protected from local edits, and never overwrites unowned copies", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "runtime idempotence app");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);

  assertSuccess(runInstall({ appHome, fake, sourceRoot }));
  const runtimePath = path.join(appHome, "mods", "insights", RUNTIME_REL);
  const dataPath = path.join(appHome, "data", "insights", "insights.json");
  assert.equal(await fs.readFile(runtimePath, "utf8"), runtimeContent());
  assert.equal(await fs.readFile(dataPath, "utf8"), APP_FILES["data/insights/insights.json"]);

  const second = runInstall({ appHome, fake, sourceRoot });
  assertSuccess(second);
  assert.match(second.stdout, /0 written/);
  assert.equal(await fs.readFile(runtimePath, "utf8"), runtimeContent());
  assert.equal(await fs.readFile(dataPath, "utf8"), APP_FILES["data/insights/insights.json"]);

  await fs.writeFile(runtimePath, '{"node":"/local/edit"}\n');
  const refused = runInstall({ appHome, fake, sourceRoot });
  assertFailure(refused);
  assert.match(refused.stderr, /edited locally/i);
  assert.equal(await fs.readFile(runtimePath, "utf8"), '{"node":"/local/edit"}\n');
  assert.equal(await fs.readFile(dataPath, "utf8"), APP_FILES["data/insights/insights.json"]);

  const forced = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
  assertSuccess(forced);
  assert.equal(await fs.readFile(runtimePath, "utf8"), runtimeContent());
  const manifest = await readJson(
    path.join(appHome, "data", "insights", "install-manifest.json"),
  );
  assert.equal(manifest.files[RUNTIME_REL], hash(runtimeContent()));
  assert.equal(await fs.readFile(dataPath, "utf8"), APP_FILES["data/insights/insights.json"]);

  const collisionApp = path.join(root, "runtime collision app");
  await writeTree(collisionApp, {
    "mods/insights/runtime.json": '{"node":"someone else"}\n',
    "data/insights/install-manifest.json": JSON.stringify({
      version: 1,
      owner: "herdr-insights",
      target: "mods/insights",
      files: {},
    }),
  });
  const collisionFake = await createFakeRunner(path.join(root, "collision runner"));
  const collision = runInstall({
    appHome: collisionApp,
    fake: collisionFake,
    sourceRoot,
    extra: ["--force"],
  });
  assertFailure(collision);
  assert.match(collision.stderr, /Unowned target file would be replaced: .*runtime\.json/);
  assert.equal(
    await fs.readFile(path.join(collisionApp, "mods", "insights", RUNTIME_REL), "utf8"),
    '{"node":"someone else"}\n',
  );
  assert.deepEqual(await readLog(collisionFake), []);
});

test("unowned collisions are refused even with --force and are never overwritten", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, {
    ...APP_FILES,
    "mods/insights/main.js": "someone else's mod\n",
  });
  const fake = await createFakeRunner(root);

  const result = runInstall({ appHome, fake, sourceRoot, extra: ["--force"] });
  assertFailure(result);
  assert.match(result.stderr, /unowned collision/i);
  assert.equal(
    await fs.readFile(path.join(appHome, "mods", "insights", "main.js"), "utf8"),
    "someone else's mod\n",
  );
  assert.equal(await exists(path.join(appHome, "data", "insights", "install-manifest.json")), false);
  assert.deepEqual(await readLog(fake), []);
});

test("source and target symlinks are refused without following or overwriting them", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "outside stays\n");
  await fs.symlink(outside, path.join(sourceRoot, "mods", "insights", "leak.mjs"));

  const sourceApp = path.join(root, "source app home");
  const fake = await createFakeRunner(root);
  const sourceResult = runInstall({ appHome: sourceApp, fake, sourceRoot });
  assertFailure(sourceResult);
  assert.match(sourceResult.stderr, /symbolic link/i);
  assert.equal(await exists(path.join(sourceApp, "mods", "insights")), false);
  assert.deepEqual(await readLog(fake), []);

  await fs.unlink(path.join(sourceRoot, "mods", "insights", "leak.mjs"));
  const targetApp = path.join(root, "target app home");
  assertSuccess(runInstall({ appHome: targetApp, fake, sourceRoot }));
  const targetMain = path.join(targetApp, "mods", "insights", "main.js");
  await fs.unlink(targetMain);
  await fs.symlink(outside, targetMain);

  const targetResult = runInstall({
    appHome: targetApp,
    fake,
    sourceRoot,
    extra: ["--force"],
  });
  assertFailure(targetResult);
  assert.match(targetResult.stderr, /symbolic link/i);
  assert.equal(await fs.readFile(outside, "utf8"), "outside stays\n");
  assert.equal((await fs.lstat(targetMain)).isSymbolicLink(), true);

  const linkedApp = path.join(root, "linked app home");
  const outsideDir = path.join(root, "outside mod");
  await writeTree(outsideDir, { "main.js": "outside mod\n" });
  await fs.mkdir(path.join(linkedApp, "mods"), { recursive: true });
  await fs.symlink(outsideDir, path.join(linkedApp, "mods", "insights"));
  const linkedResult = runInstall({ appHome: linkedApp, fake, sourceRoot });
  assertFailure(linkedResult);
  assert.match(linkedResult.stderr, /symbolic-link target/i);
  assert.equal(await fs.readFile(path.join(outsideDir, "main.js"), "utf8"), "outside mod\n");
});

test("a failed herdr-app check exits nonzero, does not open, and the install can be rerun", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);

  const failed = runInstall({
    appHome,
    fake,
    sourceRoot,
    extra: ["--open"],
    fail: "check",
  });
  assertFailure(failed);
  assert.match(failed.stderr, /fake herdr-app: check failed/);
  assert.match(failed.stderr, /herdr-app check failed/);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "main.js")), true);
  let log = await readLog(fake);
  assert.equal(log.length, 1);
  assert.equal(log[0].args[0], "check");

  const rerun = runInstall({ appHome, fake, sourceRoot, extra: ["--open"] });
  assertSuccess(rerun);
  log = await readLog(fake);
  assert.equal(log.length, 3);
  assert.equal(log[1].args[0], "check");
  assert.deepEqual(log[2].args, ["do", "tab.new", OPEN_JSON]);
  assert.equal(
    await fs.readFile(path.join(appHome, "data", "insights", "insights.json"), "utf8"),
    APP_FILES["data/insights/insights.json"],
  );
});

test("uninstall removes only unchanged owned files and preserves data and local edits", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));

  const targetMain = path.join(appHome, "mods", "insights", "main.js");
  await fs.writeFile(targetMain, "local edit\n");
  await fs.writeFile(path.join(appHome, "mods", "insights", "local-note.txt"), "local\n");

  const result = runUninstall({ appHome });
  assertSuccess(result);
  assert.match(result.stdout, /Removed 6 unchanged owned file/);
  assert.match(result.stderr, /Kept .*main\.js.*edited locally/);
  assert.equal(await fs.readFile(targetMain, "utf8"), "local edit\n");
  assert.equal(
    await fs.readFile(path.join(appHome, "mods", "insights", "local-note.txt"), "utf8"),
    "local\n",
  );
  assert.equal(await exists(path.join(appHome, "mods", "insights", "collector.mjs")), false);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "icons", "insights.svg")), false);
  assert.equal(await exists(path.join(appHome, "mods", "insights", RUNTIME_REL)), false);

  for (const [relative, content] of Object.entries(APP_FILES)) {
    assert.equal(await fs.readFile(path.join(appHome, relative), "utf8"), content, relative);
  }

  const manifest = await readJson(path.join(appHome, "data", "insights", "install-manifest.json"));
  assert.deepEqual(Object.keys(manifest.files), ["main.js"]);
  assert.equal(manifest.files["main.js"], hash(DEFAULT_MOD_FILES["main.js"]));
});

test("uninstall removes a clean install, keeps data, and is safe without a manifest", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "clean app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));

  assertSuccess(runUninstall({ appHome }));
  assert.equal(await exists(path.join(appHome, "mods", "insights")), false);
  assert.equal(await exists(path.join(appHome, "data", "insights", "install-manifest.json")), false);
  assert.equal(
    await fs.readFile(path.join(appHome, "data", "insights", "insights.json"), "utf8"),
    APP_FILES["data/insights/insights.json"],
  );
  assert.equal(
    await fs.readFile(path.join(appHome, "data", "insights", "local-note.txt"), "utf8"),
    "local data\n",
  );

  const again = runUninstall({ appHome });
  assertSuccess(again);
  assert.match(again.stdout, /nothing to remove/);

  const unownedHome = path.join(root, "unowned app home");
  await writeTree(unownedHome, { "mods/insights/main.js": "unowned\n" });
  const refused = runUninstall({ appHome: unownedHome });
  assertFailure(refused);
  assert.match(refused.stderr, /No install manifest/);
  assert.equal(
    await fs.readFile(path.join(unownedHome, "mods", "insights", "main.js"), "utf8"),
    "unowned\n",
  );
});

test("uninstall of a missing app home creates nothing", async (t) => {
  const root = await temporaryRoot(t);
  const appHome = path.join(root, "missing app home");
  const result = runUninstall({ appHome });
  assertSuccess(result);
  assert.match(result.stdout, /nothing to remove/);
  assert.equal(await exists(appHome), false);
});

test("uninstall prunes only owned-file parents and preserves nested unowned empty directories", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));

  const unownedNested = path.join(appHome, "mods", "insights", "unowned-empty", "nested");
  const unownedWithinOwnedParent = path.join(appHome, "mods", "insights", "icons", "local-empty", "nested");
  await fs.mkdir(unownedNested, { recursive: true });
  await fs.mkdir(unownedWithinOwnedParent, { recursive: true });

  assertSuccess(runUninstall({ appHome }));
  assert.equal(await exists(unownedNested), true);
  assert.equal(await exists(unownedWithinOwnedParent), true);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "unowned-empty")), true);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "icons")), true);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "core")), false);
  assert.equal(await exists(path.join(appHome, "mods", "insights", "collector.mjs")), false);
});

test("source validation requires main.js and mod.json with place none", async (t) => {
  const root = await temporaryRoot(t);
  const fake = await createFakeRunner(root);

  const wrongPlaceRoot = await createSource(root, {
    ...DEFAULT_MOD_FILES,
    "mod.json": '{"place":"right"}\n',
  });
  const wrongPlaceApp = path.join(root, "wrong place app");
  const wrongPlace = runInstall({ appHome: wrongPlaceApp, fake, sourceRoot: wrongPlaceRoot });
  assertFailure(wrongPlace);
  assert.match(wrongPlace.stderr, /place.*none/i);
  assert.equal(await exists(wrongPlaceApp), false);
  assert.equal(await exists(path.join(wrongPlaceApp, "mods", "insights")), false);

  const noMainRoot = path.join(root, "no main source");
  await writeTree(path.join(noMainRoot, "mods", "insights"), {
    "mod.json": '{"place":"none"}\n',
  });
  const noMainApp = path.join(root, "no main app");
  const noMain = runInstall({ appHome: noMainApp, fake, sourceRoot: noMainRoot });
  assertFailure(noMain);
  assert.match(noMain.stderr, /main\.js/);
  assert.equal(await exists(noMainApp), false);
  assert.equal(await exists(path.join(noMainApp, "mods", "insights")), false);
  assert.deepEqual(await readLog(fake), []);
});

test("stale removal never follows a symlinked target directory", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, APP_FILES);
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));

  const outside = path.join(root, "outside core");
  await writeTree(outside, { "usage.mjs": DEFAULT_MOD_FILES["core/usage.mjs"] });
  const targetCore = path.join(appHome, "mods", "insights", "core");
  await fs.rm(targetCore, { recursive: true });
  await fs.symlink(outside, targetCore);
  await fs.unlink(path.join(sourceRoot, "mods", "insights", "core", "usage.mjs"));

  const result = runInstall({ appHome, fake, sourceRoot });
  assertSuccess(result);
  assert.match(result.stderr, /symbolic link/i);
  assert.equal(
    await fs.readFile(path.join(outside, "usage.mjs"), "utf8"),
    DEFAULT_MOD_FILES["core/usage.mjs"],
  );
  assert.equal((await fs.lstat(targetCore)).isSymbolicLink(), true);

  const manifest = await readJson(path.join(appHome, "data", "insights", "install-manifest.json"));
  assert.equal(manifest.files["core/usage.mjs"], hash(DEFAULT_MOD_FILES["core/usage.mjs"]),
    "retain proof without ever following the replacement link");
});

test("manifest path traversal is refused before any target write", async (t) => {
  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "app home");
  await writeTree(appHome, {
    "data/insights/install-manifest.json": JSON.stringify({
      files: { "../escape.js": hash("escape\n") },
      owner: "herdr-insights",
      target: "mods/insights",
      version: 1,
    }),
  });
  const fake = await createFakeRunner(root);

  const result = runInstall({ appHome, fake, sourceRoot });
  assertFailure(result);
  assert.match(result.stderr, /Path traversal/i);
  assert.equal(await exists(path.join(appHome, "escape.js")), false);
  assert.equal(await exists(path.join(appHome, "mods", "escape.js")), false);
  assert.equal(await exists(path.join(appHome, "mods", "insights")), false);
  assert.deepEqual(await readLog(fake), []);
});

test("installer rejects an older Node before creating mod or data folders", async (t) => {
  const oldNode = findUnsupportedNode();
  if (!oldNode) {
    t.skip("No local Node older than 22.15 is available");
    return;
  }

  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "old node app home");
  const fake = await createFakeRunner(root);
  const environment = makeEnvironment(root, appHome, fake, { pathLookup: true });

  const result = spawnSync(
    oldNode.binary,
    [INSTALL_SCRIPT, "--source", sourceRoot, "--app-home", appHome],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      timeout: 30_000,
    },
  );

  assertFailure(result);
  assert.match(result.stderr, /Node >=22\.15 is required/);
  assert.match(result.stderr, new RegExp(`running ${oldNode.version.replaceAll(".", "\\.")}`));
  assert.equal(await exists(appHome), false);
  assert.equal(await exists(path.join(appHome, "mods", "insights")), false);
  assert.equal(await exists(path.join(appHome, "data", "insights")), false);
  assert.deepEqual(await readLog(fake), []);
});

test("uninstaller remains usable on an older Node runtime", async (t) => {
  const oldNode = findUnsupportedNode();
  if (!oldNode) {
    t.skip("No local Node older than 22.15 is available");
    return;
  }

  const root = await temporaryRoot(t);
  const sourceRoot = await createSource(root);
  const appHome = path.join(root, "old node uninstall app home");
  const fake = await createFakeRunner(root);
  assertSuccess(runInstall({ appHome, fake, sourceRoot }));

  const result = spawnSync(
    oldNode.binary,
    [UNINSTALL_SCRIPT, "--app-home", appHome],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: { ...process.env, HERDR_APP_HOME: appHome },
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      timeout: 30_000,
    },
  );

  assertSuccess(result);
  assert.equal(await exists(path.join(appHome, "mods", "insights")), false);
  assert.equal(
    await exists(path.join(appHome, "data", "insights", "install-manifest.json")),
    false,
  );
});

test("the package stays private, dependency-free, and the check script passes", async () => {
  const packageJson = await readJson(path.join(PACKAGE_ROOT, "package.json"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
  assert.deepEqual(packageJson.engines, { node: ">=22.15" });
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.equal(packageJson[field], undefined, field);
  }
  assert.deepEqual(packageJson.scripts, {
    check: "node scripts/check.mjs",
    "install:local": "node scripts/install.mjs",
    test: "node --test tests/*.test.mjs",
    "uninstall:local": "node scripts/uninstall.mjs",
  });
  assert.equal(packageJson.publishConfig, undefined);
  assert.equal(packageJson.scripts.prepublishOnly, undefined);

  const result = spawnSync(process.execPath, [CHECK_SCRIPT], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    shell: false,
  });
  assertSuccess(result);
  assert.match(result.stdout, /Insights package checks passed/);
});

function findUnsupportedNode() {
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/opt/node@20/bin/node",
    "/usr/bin/node",
  ];

  for (const binary of new Set(candidates)) {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) continue;
    const match = /^v?(\d+\.\d+\.\d+)$/.exec((result.stdout || "").trim());
    if (!match || isNodeVersionSupported(match[1])) continue;
    return { binary, version: match[1] };
  }
  return null;
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-insights-test-"));
  t.after(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });
  return root;
}

async function createSource(root, files = DEFAULT_MOD_FILES, name = "reviewed source") {
  const sourceRoot = path.join(root, name);
  await writeTree(path.join(sourceRoot, "mods", "insights"), files);
  await writeTree(sourceRoot, {
    "README.md": "not part of the mod\n",
    "keys.json": '{"global":{}}\n',
    "layouts/other.json": '{"id":"other"}\n',
    "tests/source-only.txt": "not installed\n",
  });
  return sourceRoot;
}

async function createFakeRunner(root) {
  const bin = path.join(root, "fake bin");
  const runner = path.join(bin, "herdr-app");
  const log = path.join(root, "fake herdr log.jsonl");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    runner,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ appHome: process.env.HERDR_APP_HOME ?? null, args }) + "\\n");

if (process.env.FAKE_HERDR_FAIL === "check" && args[0] === "check") {
  console.error("fake herdr-app: check failed");
  process.exit(7);
}
if (process.env.FAKE_HERDR_FAIL === "open" && args[0] === "do") {
  console.error("fake herdr-app: open failed");
  process.exit(8);
}
console.log("fake herdr-app: " + args.join(" "));
`,
    { mode: 0o755 },
  );
  await fs.chmod(runner, 0o755);
  return { bin, log, runner };
}

function makeEnvironment(root, appHome, fake, options = {}) {
  const env = {
    ...process.env,
    FAKE_HERDR_LOG: fake.log,
    HERDR_APP_HOME: appHome,
    HOME: path.join(root, "fake home"),
  };
  delete env.FAKE_HERDR_FAIL;
  if (options.fail) env.FAKE_HERDR_FAIL = options.fail;

  if (options.pathLookup) {
    delete env.HERDR_APP_BIN;
    env.PATH = `${path.dirname(fake.runner)}${path.delimiter}${process.env.PATH ?? ""}`;
  } else {
    env.HERDR_APP_BIN = fake.runner;
  }
  return env;
}

function runInstall({ appHome, fake, sourceRoot, extra = [], fail, pathLookup = false }) {
  const root = path.dirname(appHome);
  const environment = makeEnvironment(root, appHome, fake, { fail, pathLookup });
  return runNode(INSTALL_SCRIPT, ["--source", sourceRoot, "--app-home", appHome, ...extra], environment);
}

function runUninstall({ appHome }) {
  const environment = { ...process.env, HERDR_APP_HOME: appHome };
  return runNode(UNINSTALL_SCRIPT, ["--app-home", appHome], environment);
}

function runNode(script, args, environment) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
    timeout: 30_000,
  });
}

function assertSuccess(result) {
  assert.equal(
    result.status,
    0,
    `expected success\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function assertFailure(result) {
  assert.notEqual(
    result.status,
    0,
    `expected failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.error, undefined, String(result.error));
}

async function readLog(fake) {
  let text;
  try {
    text = await fs.readFile(fake.log, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeTree(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(base, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function listFiles(base) {
  const files = [];
  async function walk(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, childRelative);
      } else if (entry.isFile()) {
        files.push(childRelative);
      }
    }
  }
  await walk(base, "");
  return files.sort();
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}
