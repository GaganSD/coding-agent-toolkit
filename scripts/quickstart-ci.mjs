import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib.mjs";
import { packages } from "./packages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function packageSpecs() {
  return Object.entries(packages).map(([directory, config]) => {
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    if (manifest.name !== config.name) throw new Error(`${directory}: expected ${config.name}, found ${manifest.name}`);
    if (!manifest.version) throw new Error(`${directory}: package.json has no version`);
    return { directory, name: manifest.name, version: manifest.version, spec: `${manifest.name}@${manifest.version}` };
  });
}

export function piCliVersion() {
  const manifest = JSON.parse(readFileSync(join(root, "pi-slate", "package.json"), "utf8"));
  const version = manifest.devDependencies?.["@earendil-works/pi-coding-agent"];
  if (!version) throw new Error("pi-slate does not pin @earendil-works/pi-coding-agent");
  return version;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

function sleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function waitForRegistryPackage(
  spec,
  {
    timeoutMs = 10 * 60_000,
    intervalMs = 15_000,
    check = value => run(npm, ["view", value, "version", "--silent"], { stdio: ["ignore", "pipe", "pipe"] }),
    sleepMs = sleep,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const version = check(spec);
      if (version) return version;
      lastError = new Error(`${spec} is not visible on npm yet`);
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    console.log(`Waiting for npm to finish processing ${spec}`);
    sleepMs(Math.min(intervalMs, remaining));
  }
  throw new Error(`Timed out waiting for ${spec} on npm: ${lastError instanceof Error ? lastError.message : "not visible"}`);
}

function retry(command, args, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return run(command, args, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) console.warn(`Retry ${attempt}/3 failed: ${command} ${args.join(" ")}`);
    }
  }
  throw lastError;
}

function installPiCli(directory) {
  const cliRoot = join(directory, "pi-cli");
  mkdirSync(cliRoot, { recursive: true });
  retry(npm, [
    "install",
    "--prefix", cliRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `@earendil-works/pi-coding-agent@${piCliVersion()}`,
  ]);
  return join(cliRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
}

function rootInstallSmoke(pi, agentDir) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };
  run(pi, ["install", "."], { cwd: root, env });
  const help = run(pi, ["--help"], { cwd: root, env });
  if (!help.includes("Usage:")) throw new Error("Root install smoke did not produce Pi help output");
}

function downloadOne(spec, directory) {
  const before = new Set(readdirSync(directory));
  retry(npm, ["pack", spec, "--ignore-scripts", "--pack-destination", directory], { cwd: directory });
  const created = readdirSync(directory).filter(file => !before.has(file));
  if (created.length !== 1) throw new Error(`${spec}: expected one downloaded tarball, found ${created.length}`);
  const file = join(directory, created[0]);
  if (statSync(file).size <= 0) throw new Error(`${spec}: downloaded tarball is empty`);
  return created[0];
}

export function quickstartSmoke() {
  const work = mkdtempSync(join(tmpdir(), "coding-agent-toolkit-quickstart-"));
  try {
    const agentDir = join(work, "agent");
    const downloads = join(work, "downloads");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(downloads, { recursive: true });

    const pi = installPiCli(work);
    rootInstallSmoke(pi, agentDir);
    console.log("Root `pi install .` smoke: PASS");

    for (const item of packageSpecs()) {
      waitForRegistryPackage(item.spec);
      const file = downloadOne(item.spec, downloads);
      console.log(`Registry download ${item.spec}: PASS (${file})`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    quickstartSmoke();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
