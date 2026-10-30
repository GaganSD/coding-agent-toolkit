import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const modsDir = path.join(here, "..", "mods", "insights");

function run(script, args, { cwd, environment = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, TZ: "UTC", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function symlinkedCollector() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "insights-cli-")),
  );
  const target = await realpath(modsDir);
  const link = path.join(root, "linked mods ü");
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  return { root, collector: path.join(link, "collector.mjs") };
}

test("snapshot --help works through a symlinked parent directory", async () => {
  const { collector } = await symlinkedCollector();
  const result = await run(collector, ["snapshot", "--help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Usage:/);
});

test("snapshot works through a relative symlinked path with spaces and unicode", async () => {
  const { root, collector } = await symlinkedCollector();
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(home, { recursive: true });

  const result = await run(
    path.relative(root, collector),
    ["snapshot", "--store", store, "--home", home],
    { cwd: root },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.rows, []);
});

test("snapshot removes its scan progress sidecar when it settles", async () => {
  const { root, collector } = await symlinkedCollector();
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(home, { recursive: true });

  const result = await run(collector, ["snapshot", "--store", store, "--home", home]);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(stat(`${store}.progress.json`), /ENOENT/);
});

test("importing the collector through a symlinked path stays quiet", async () => {
  const { root, collector } = await symlinkedCollector();
  const wrapper = path.join(root, "import wrapper ü.mjs");
  const collectorUrl = pathToFileURL(collector).href;
  await writeFile(
    wrapper,
    [
      `import { run } from ${JSON.stringify(collectorUrl)};`,
      'const help = await run(["snapshot", "--help"]);',
      'if (help.exitCode !== 0 || !help.stderr.startsWith("Usage:")) {',
      '  throw new Error("run export is not usable");',
      "}",
      'process.stdout.write("import-ok\\n");',
      "",
    ].join("\n"),
  );

  const result = await run(wrapper, []);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "import-ok\n");
  assert.equal(result.stderr, "");
});
