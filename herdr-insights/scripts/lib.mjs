import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const MIN_NODE_VERSION = "22.15";
export const MOD_REL = "mods/insights";
export const DATA_REL = "data/insights";
export const MANIFEST_NAME = "install-manifest.json";
export const RUNTIME_NAME = "runtime.json";
export const MANIFEST_VERSION = 1;
export const MANIFEST_OWNER = "herdr-insights";
export const HASH_RE = /^[0-9a-f]{64}$/;

export function isNodeVersionSupported(version) {
  if (typeof version !== "string") return false;
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minimumMajor, minimumMinor] = MIN_NODE_VERSION.split(".").map(Number);
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (isNodeVersionSupported(version)) return;
  throw new Error(`Node >=${MIN_NODE_VERSION} is required; running ${version}.`);
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function createRuntimeFile(nodePath = process.execPath) {
  const data = Buffer.from(`${JSON.stringify({ node: nodePath })}\n`);
  return {
    absolute: null,
    data,
    hash: sha256(data),
    mode: 0o644,
    relative: RUNTIME_NAME,
  };
}

export function modDir(appHome) {
  return path.join(appHome, "mods", "insights");
}

export function dataDir(appHome) {
  return path.join(appHome, "data", "insights");
}

export function manifestPath(appHome) {
  return path.join(dataDir(appHome), MANIFEST_NAME);
}

export async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function expandHome(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty path.");
  }
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export async function resolveAppHome(explicit, options = {}) {
  const configured =
    explicit && explicit.length > 0
      ? explicit
      : process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
  const absolute = path.resolve(expandHome(configured));
  const create = options.create !== false;

  if (!create) {
    const existing = await lstatOrNull(absolute);
    if (!existing) return null;
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`App home is not a directory: ${absolute}`);
    }
    return fs.realpath(absolute);
  }

  try {
    await fs.mkdir(absolute, { recursive: true });
  } catch (error) {
    throw new Error(`Cannot create or use app home ${absolute}: ${error.message}`, {
      cause: error,
    });
  }

  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`App home is not a directory: ${absolute}`);
  }
  return fs.realpath(absolute);
}

export function validateRelativeKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Relative path must be a non-empty string.");
  }
  if (key.includes("\0") || key.includes("\\")) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(key)}`);
  }
  if (path.posix.isAbsolute(key)) {
    throw new Error(`Absolute paths are not allowed: ${key}`);
  }
  const parts = key.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Path traversal is not allowed: ${key}`);
  }
  return key;
}

export function localPath(base, relativeKey) {
  validateRelativeKey(relativeKey);
  const target = path.resolve(base, ...relativeKey.split("/"));
  const relative = path.relative(base, target);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes its root: ${relativeKey}`);
  }
  return target;
}

export function isInside(base, target) {
  const relative = path.relative(base, target);
  return (
    relative.length === 0 ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export async function assertNoSymlinkComponents(root, target) {
  const rootAbsolute = path.resolve(root);
  const targetAbsolute = path.resolve(target);
  if (!isInside(rootAbsolute, targetAbsolute)) {
    throw new Error(`Refusing to use a path outside ${rootAbsolute}: ${targetAbsolute}`);
  }

  const rootStat = await lstatOrNull(rootAbsolute);
  if (rootStat?.isSymbolicLink()) {
    throw new Error(`Refusing to use a symbolic link: ${rootAbsolute}`);
  }

  const relative = path.relative(rootAbsolute, targetAbsolute);
  if (relative.length === 0) return;

  let current = rootAbsolute;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to use a symbolic link: ${current}`);
    }
  }
}

export async function ensureDirectory(root, target, label = "directory", mode) {
  await assertNoSymlinkComponents(root, target);
  const existing = await lstatOrNull(target);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`${label} is not a directory: ${target}`);
    }
    if (mode !== undefined) await fs.chmod(target, mode);
    return;
  }
  await fs.mkdir(target, { recursive: true, mode });
  await assertNoSymlinkComponents(root, target);
  const created = await fs.lstat(target);
  if (!created.isDirectory()) {
    throw new Error(`${label} is not a directory: ${target}`);
  }
}

export async function readManifest(appHome) {
  try {
    return await readManifestData(appHome);
  } catch (error) {
    throw new Error(
      `${error.message}\nNo target files were changed. To recover, preserve or move aside both ` +
      `${modDir(appHome)} and ${manifestPath(appHome)}, then reinstall. ` +
      `Leave ${path.join(dataDir(appHome), "insights.json")} in place.`,
      { cause: error },
    );
  }
}

async function readManifestData(appHome) {
  const file = manifestPath(appHome);
  await assertNoSymlinkComponents(appHome, file);
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to read a symbolic-link manifest: ${file}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Install manifest is not a regular file: ${file}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Install manifest is not valid JSON: ${file}: ${error.message}`, {
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Install manifest has an invalid shape: ${file}`);
  }
  if (parsed.version !== MANIFEST_VERSION) {
    throw new Error(`Unsupported install manifest version: ${String(parsed.version)}`);
  }
  if (parsed.owner !== MANIFEST_OWNER) {
    throw new Error(`Install manifest belongs to another owner: ${String(parsed.owner)}`);
  }
  if (parsed.target !== MOD_REL) {
    throw new Error(`Install manifest targets another folder: ${String(parsed.target)}`);
  }
  if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    throw new Error(`Install manifest has no file map: ${file}`);
  }

  const files = Object.create(null);
  for (const [relative, hash] of Object.entries(parsed.files)) {
    validateRelativeKey(relative);
    if (typeof hash !== "string" || !HASH_RE.test(hash)) {
      throw new Error(`Install manifest has an invalid hash for ${relative}`);
    }
    files[relative] = hash;
  }

  return { ...parsed, files, path: file };
}

export async function writeManifest(appHome, files) {
  const directory = dataDir(appHome);
  await ensureDirectory(appHome, directory, "Insights data directory");

  const sortedFiles = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((relative) => {
        const hash = files[relative];
        if (typeof hash !== "string" || !HASH_RE.test(hash)) {
          throw new Error(`Refusing to write an invalid hash for ${relative}`);
        }
        return [validateRelativeKey(relative), hash];
      }),
  );

  const manifest = {
    version: MANIFEST_VERSION,
    owner: MANIFEST_OWNER,
    target: MOD_REL,
    installedAt: new Date().toISOString(),
    files: sortedFiles,
  };
  const file = manifestPath(appHome);
  await assertNoSymlinkComponents(appHome, file);
  await writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
  return manifest;
}

async function renameWithReplace(source, target) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error.code === "EEXIST" || error.code === "EPERM")
    ) {
      const existing = await lstatOrNull(target);
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`Refusing to replace a non-regular file: ${target}`, { cause: error });
      }
      if (existing) await fs.unlink(target);
      await fs.rename(source, target);
      return;
    }
    throw error;
  }
}

export async function writeFileAtomic(target, data, mode = 0o644) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.insights-tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const fileMode = (mode & 0o777) || 0o644;

  try {
    await fs.writeFile(temporary, data, { flag: "wx", mode: fileMode });
    await fs.chmod(temporary, fileMode);
    await renameWithReplace(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isGeneratedSourceFile(name) {
  return name === "jsconfig.json" || name.endsWith(".d.ts");
}

export async function collectSourceFiles(sourceRoot) {
  const declaredModDir = path.join(path.resolve(sourceRoot), MOD_REL);
  const declaredStat = await lstatOrNull(declaredModDir);
  if (!declaredStat) {
    throw new Error(
      `Source folder not found: ${declaredModDir}\nExpected ${MOD_REL}/ with main.js, mod.json (place "none") and the collector.`,
    );
  }
  if (declaredStat.isSymbolicLink()) {
    throw new Error(`Refusing a symbolic-link source folder: ${declaredModDir}`);
  }
  if (!declaredStat.isDirectory()) {
    throw new Error(`Source mod path is not a directory: ${declaredModDir}`);
  }

  const root = await fs.realpath(declaredModDir);
  const files = [];

  async function walk(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      if (entry.isDirectory() && (entry.name === ".git" || entry.name === "node_modules")) {
        continue;
      }
      if (entry.isFile() && isGeneratedSourceFile(entry.name)) continue;

      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      validateRelativeKey(relative);

      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing a symbolic link in the source tree: ${absolute}`);
      }
      if (stat.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Refusing a non-regular source file: ${absolute}`);
      }

      const realFile = await fs.realpath(absolute);
      if (!isInside(root, realFile)) {
        throw new Error(`Source file escapes the mod folder: ${absolute}`);
      }

      const data = await fs.readFile(absolute);
      files.push({
        absolute,
        data,
        hash: sha256(data),
        mode: stat.mode & 0o777,
        relative,
      });
    }
  }

  await walk(root, "");
  files.sort((left, right) => left.relative.localeCompare(right.relative));

  const main = files.find((file) => file.relative === "main.js");
  if (!main) {
    throw new Error(`Source mod is missing main.js: ${root}`);
  }
  const modJsonFile = files.find((file) => file.relative === "mod.json");
  if (!modJsonFile) {
    throw new Error(`Source mod is missing mod.json: ${root}`);
  }

  let modJson;
  try {
    const text = modJsonFile.data.toString("utf8").replace(/^\uFEFF/, "");
    modJson = JSON.parse(text);
  } catch (error) {
    throw new Error(`Source mod.json is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!modJson || typeof modJson !== "object" || Array.isArray(modJson)) {
    throw new Error("Source mod.json must contain a JSON object.");
  }
  if (modJson.place !== "none") {
    throw new Error(
      'Source mod.json must use "place": "none"; Insights opens through the installed mod tab, not as a docked panel.',
    );
  }

  return { files, modDir: root, modJson };
}

export function runHerdr(args, options = {}) {
  const binary =
    typeof process.env.HERDR_APP_BIN === "string" && process.env.HERDR_APP_BIN.trim()
      ? process.env.HERDR_APP_BIN.trim()
      : "herdr-app";

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, error, signal: null, stderr: "", stdout: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let spawnError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      resolve({ code, error: spawnError, signal, stderr, stdout });
    });
  });
}

export function relayHerdrOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export function herdrFailure(result, action) {
  if (result.error) {
    const detail =
      result.error.code === "ENOENT"
        ? "herdr-app was not found. Install Herdr or set HERDR_APP_BIN."
        : result.error.message;
    return `${action} could not start: ${detail}`;
  }
  if (result.signal) {
    return `${action} was stopped by ${result.signal}.`;
  }
  return `${action} failed with exit code ${String(result.code)}.`;
}
