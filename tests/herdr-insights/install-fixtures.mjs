import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../herdr-insights",
);
export const INSTALL_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "install.mjs");
export const UNINSTALL_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "uninstall.mjs");
export const RUNTIME_REL = "runtime.json";

export const DEFAULT_MOD_FILES = {
  "analytics.js": "export const version = 1;\n",
  "collector.mjs": "export const collector = true;\n",
  "core/usage.mjs": "export const usage = true;\n",
  "icons/insights.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  "main.js": "export default class Insights {}\n",
  "mod.json": '{\n  "place": "none"\n}\n',
};

export const TOOLBAR_LAYOUT = JSON.stringify({ id: "root", type: "column", children: [
  { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs" } },
  { id: "main", type: "block", content: { tab: "active" } },
] }) + "\n";

export const APP_FILES = {
  "data/insights/insights.json": '{"version":1,"keep":"local"}\n',
  "data/insights/local-note.txt": "local data\n",
  "keys.json": '{"global":{"ctrl-shift-t":"tab.new"}}\n',
  "layouts/main.json": TOOLBAR_LAYOUT,
  "mods/other/main.js": "export default class Other {}\n",
  "settings.json": '{"zoom":1}\n',
};

export async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-insights-test-"));
  t.after(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });
  return root;
}

export async function createSource(root, files = DEFAULT_MOD_FILES, name = "reviewed source") {
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

export async function createSourceWithLauncher(root) {
  const sourceRoot = await createSource(root);
  await fs.cp(path.join(PACKAGE_ROOT, "mods/insights-launcher"),
    path.join(sourceRoot, "mods/insights-launcher"), { recursive: true });
  return sourceRoot;
}

export async function createFakeRunner(root) {
  const bin = path.join(root, "fake bin");
  const runner = path.join(bin, "herdr-app");
  const log = path.join(root, "fake herdr log.jsonl");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    runner,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ appHome: process.env.HERDR_APP_HOME ?? null, args }) + "\\n");

if (args[0] === "check" && (process.env.FAKE_HERDR_FAIL === "check" ||
    (process.env.FAKE_HERDR_FAIL === "launcher-check" && args[1].endsWith("insights-launcher")))) {
  console.error("fake herdr-app: check failed");
  process.exit(7);
}
if (process.env.FAKE_HERDR_FAIL === "open" && args[0] === "do") {
  console.error("fake herdr-app: open failed");
  process.exit(8);
}
if (args[0] === "status") {
  const entries = fs.readFileSync(log, "utf8").trim().split("\\n").map(line => JSON.parse(line));
  const last = entries.reverse().find(entry => entry.appHome === process.env.HERDR_APP_HOME && entry.args[0] === "do" && ["layout.clone", "layout.switch"].includes(entry.args[1]) &&
    !(process.env.FAKE_HERDR_FAIL === "ignored-switch" && entry.args[1] === "layout.switch"));
  const chosen = last ? JSON.parse(last.args[2]) : null;
  console.log(JSON.stringify({ layout: chosen?.as ?? chosen?.name ?? "main", overlays: [], errors: [] }));
  process.exit(0);
}
if (args[0] === "do" && args[1] === "layout.clone") {
  const request = JSON.parse(args[2]);
  const dir = path.join(process.env.HERDR_APP_HOME, "layouts");
  fs.copyFileSync(path.join(dir, request.name + ".json"), path.join(dir, request.as + ".json"), fs.constants.COPYFILE_EXCL);
  const state = path.join(dir, ".state");
  fs.mkdirSync(state, { recursive: true });
  if (fs.existsSync(path.join(state, request.name + ".json"))) {
    fs.copyFileSync(path.join(state, request.name + ".json"), path.join(state, request.as + ".json"));
  } else fs.rmSync(path.join(state, request.as + ".json"), { force: true });
}
console.log("fake herdr-app: " + args.join(" "));
`,
    { mode: 0o755 },
  );
  await fs.chmod(runner, 0o755);
  return { bin, log, runner };
}

export function makeEnvironment(root, appHome, fake, options = {}) {
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

export function runInstall({ appHome, fake, sourceRoot, extra = [], fail, pathLookup = false }) {
  const root = path.dirname(appHome);
  const environment = makeEnvironment(root, appHome, fake, { fail, pathLookup });
  return runNode(INSTALL_SCRIPT, ["--source", sourceRoot, "--app-home", appHome, ...extra], environment);
}

export function runUninstall({ appHome, fake, fail }) {
  const environment = fake ? makeEnvironment(path.dirname(appHome), appHome, fake, { fail })
    : { ...process.env, HERDR_APP_HOME: appHome };
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

export function assertSuccess(result) {
  assert.equal(
    result.status,
    0,
    `expected success\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

export function assertFailure(result) {
  assert.notEqual(
    result.status,
    0,
    `expected failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.error, undefined, String(result.error));
}

export async function readLog(fake) {
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

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function snapshotTree(root) {
  return Promise.all((await listFiles(root)).map(async (relative) =>
    [relative, await fs.readFile(path.join(root, relative), "utf8")]));
}

export async function writeTree(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(base, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

export async function listFiles(base) {
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

export async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}
