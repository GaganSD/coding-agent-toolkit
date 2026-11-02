import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MOD_NAMES,
  assertNoSymlinkComponents,
  isInside,
  lstatOrNull,
  localPath,
  manifestPath,
  modDir,
  readManifest,
  resolveAppHome,
  sha256,
  writeManifest,
  withInstallerLock,
} from "./lib.mjs";

import { prepareToolbarRemoval, removeToolbar } from "./toolbar.mjs";

function usage() {
  return `Insights safe uninstaller

Usage:
  npm run uninstall:local -- [options]
  node scripts/uninstall.mjs [options]

Options:
  --app-home <folder>   Herdr app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
  -h, --help            Show this help

Only files recorded in data/insights/*install-manifest.json are removed, and only
when their content still matches. The owned personal toolbar layout is removed
only if unchanged; Herdr returns to the original layout first. Edited/unowned files,
shipped layouts, keys and data/insights/insights.json are left alone.
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

function ownedParentDirectories(targetDirectory, target) {
  const parents = [];
  let current = path.dirname(target);
  while (isInside(targetDirectory, current)) {
    parents.push(current);
    if (path.resolve(current) === path.resolve(targetDirectory)) break;
    current = path.dirname(current);
  }
  return parents;
}

async function pruneOwnedDirectories(directories) {
  const ordered = [...new Set(directories)].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length,
  );
  for (const directory of ordered) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
}

async function prepareUninstall(appHome, modName) {
  const targetDirectory = modDir(appHome, modName);
  const targetManifest = manifestPath(appHome, modName);
  const manifest = await readManifest(appHome, modName);

  if (!manifest) {
    const target = await lstatOrNull(targetDirectory);
    if (target) {
      throw new Error(
        `No install manifest at ${targetManifest}; refusing to remove unowned files in ${targetDirectory}.`,
      );
    }
    return null;
  }

  const targetStat = await lstatOrNull(targetDirectory);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Refusing a symbolic-link target: ${targetDirectory}`);
  }
  if (targetStat && !targetStat.isDirectory()) {
    throw new Error(`Target mod path is not a directory: ${targetDirectory}`);
  }

  return { appHome, targetDirectory, targetManifest, manifest, targetStat, modName };
}

async function applyUninstall(plan) {
  const { appHome, targetDirectory, targetManifest, manifest, targetStat, modName } = plan;
  const removed = [];
  const kept = [];
  const ownedParents = [];
  const remaining = Object.create(null);

  const entries = targetStat ? Object.entries(manifest.files) : [];
  for (const [relative, oldHash] of entries) {
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
    ownedParents.push(...ownedParentDirectories(targetDirectory, target));
  }

  if (targetStat && removed.length > 0) {
    await pruneOwnedDirectories(ownedParents);
  }

  const remainingEntries = Object.entries(remaining);
  if (remainingEntries.length > 0) {
    await writeManifest(appHome, Object.fromEntries(remainingEntries), modName);
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
    const appHome = await resolveAppHome(options.appHome, { create: false });
    await withInstallerLock(appHome, async () => {
      // Validate ownership, manifests and target types before deleting either mod.
      const plans = [];
      if (appHome) {
        for (const modName of MOD_NAMES) {
          const plan = await prepareUninstall(appHome, modName);
          if (plan) plans.push(plan);
        }
      }
      const toolbar = await prepareToolbarRemoval(appHome);
      await removeToolbar(toolbar);
      for (const plan of plans) await applyUninstall(plan);
      if (plans.length === 0 && !toolbar) {
        console.log("Insights is not installed by this package; nothing to remove.");
      }
    });
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
