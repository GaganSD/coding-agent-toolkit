import { promises as fs } from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  lstatOrNull,
  localPath,
  manifestPath,
  modDir,
  readManifest,
  resolveAppHome,
  sha256,
  writeManifest,
} from "./lib.mjs";

function usage() {
  return `Insights safe uninstaller

Usage:
  npm run uninstall:local -- [options]
  node scripts/uninstall.mjs [options]

Options:
  --app-home <folder>   Herdr app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
  -h, --help            Show this help

Only files recorded in data/insights/install-manifest.json are removed, and only
when their content still matches. Edited files, unowned files, layouts, keys and
data/insights/insights.json are left alone. The installer never uses the network.
`;
}

function parseArgs(argv) {
  const options = { appHome: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--app-home") {
      const value = argv[index + 1];
      if (!value) throw new Error("--app-home needs a folder.");
      options.appHome = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--app-home=")) {
      const value = argument.slice("--app-home=".length);
      if (!value) throw new Error("--app-home needs a folder.");
      options.appHome = value;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

async function pruneEmptyDirectories(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }

  let empty = true;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      empty = false;
      continue;
    }
    if (entry.isDirectory()) {
      const childEmpty = await pruneEmptyDirectories(path.join(directory, entry.name));
      if (!childEmpty) empty = false;
      continue;
    }
    empty = false;
  }

  if (!empty) return false;
  try {
    await fs.rmdir(directory);
    return true;
  } catch (error) {
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function uninstall(options) {
  const appHome = await resolveAppHome(options.appHome);
  const targetDirectory = modDir(appHome);
  const targetManifest = manifestPath(appHome);
  const manifest = await readManifest(appHome);

  if (!manifest) {
    const target = await lstatOrNull(targetDirectory);
    if (target) {
      throw new Error(
        `No install manifest at ${targetManifest}; refusing to remove unowned files in ${targetDirectory}.`,
      );
    }
    console.log("Insights is not installed by this package; nothing to remove.");
    return;
  }

  const targetStat = await lstatOrNull(targetDirectory);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Refusing a symbolic-link target: ${targetDirectory}`);
  }
  if (targetStat && !targetStat.isDirectory()) {
    throw new Error(`Target mod path is not a directory: ${targetDirectory}`);
  }

  const removed = [];
  const kept = [];
  const remaining = {};

  for (const [relative, oldHash] of Object.entries(manifest.files)) {
    if (!targetStat) break;
    const target = localPath(targetDirectory, relative);

    try {
      await assertNoSymlinkComponents(appHome, target);
    } catch (error) {
      kept.push(`${target} (${error.message})`);
      remaining[relative] = oldHash;
      continue;
    }

    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      kept.push(`${target} (not a regular file)`);
      remaining[relative] = oldHash;
      continue;
    }

    const currentHash = sha256(await fs.readFile(target));
    if (currentHash !== oldHash) {
      kept.push(`${target} (edited locally)`);
      remaining[relative] = oldHash;
      continue;
    }

    await fs.unlink(target);
    removed.push(relative);
  }

  if (targetStat) {
    await pruneEmptyDirectories(targetDirectory);
  }

  const remainingEntries = Object.entries(remaining);
  if (remainingEntries.length > 0) {
    await writeManifest(appHome, Object.fromEntries(remainingEntries));
  } else {
    const currentManifest = await lstatOrNull(targetManifest);
    if (currentManifest) {
      if (currentManifest.isSymbolicLink() || !currentManifest.isFile()) {
        throw new Error(`Refusing to remove a non-regular manifest: ${targetManifest}`);
      }
      await fs.unlink(targetManifest);
    }
  }

  console.log(`Removed ${removed.length} unchanged owned file(s).`);
  for (const entry of kept) {
    console.warn(`Kept ${entry}.`);
  }
  console.log("Left data/insights, insights.json and unowned files in place.");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  try {
    await uninstall(options);
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
