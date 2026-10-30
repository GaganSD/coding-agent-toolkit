import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PACKAGE_ROOT,
  assertNoSymlinkComponents,
  collectSourceFiles,
  dataDir,
  ensureDirectory,
  expandHome,
  herdrFailure,
  lstatOrNull,
  localPath,
  manifestPath,
  modDir,
  readManifest,
  relayHerdrOutput,
  resolveAppHome,
  runHerdr,
  sha256,
  writeFileAtomic,
  writeManifest,
} from "./lib.mjs";

const OPEN_ARGS = ["do", "tab.new", '{"name":"Insights","mod":"insights"}'];

function usage() {
  return `Insights local installer

Usage:
  npm run install:local -- [options]
  node scripts/install.mjs [options]

Options:
  --open                Open the Insights tab after herdr-app check passes
  --force               Replace owned files edited locally (never unowned files or links)
  --source <folder>     Source package folder containing mods/insights (development)
  --app-home <folder>   Herdr app home (default: $HERDR_APP_HOME or ~/.config/herdr-app)
  -h, --help            Show this help

The installer copies only mods/insights, creates data/insights, and never writes
layouts, keys, shipped mods, or insights.json. It does not publish or use the network.
`;
}

function parseArgs(argv) {
  const options = {
    appHome: null,
    force: false,
    help: false,
    open: false,
    source: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--open") {
      options.open = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--source") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source needs a folder.");
      options.source = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--source=")) {
      const value = argument.slice("--source=".length);
      if (!value) throw new Error("--source needs a folder.");
      options.source = value;
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

async function addParentIssues(targetDirectory, target, issues) {
  const relative = path.relative(targetDirectory, target);
  const parts = relative.split(path.sep).slice(0, -1);
  let current = targetDirectory;

  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      issues.push(`Refusing a symbolic-link target directory: ${current}`);
      return;
    }
    if (!stat.isDirectory()) {
      issues.push(`A parent of a target file is not a directory: ${current}`);
      return;
    }
  }
}

async function install(options) {
  const appHome = await resolveAppHome(options.appHome);
  const sourceRoot = options.source
    ? path.resolve(expandHome(options.source))
    : PACKAGE_ROOT;
  const source = await collectSourceFiles(sourceRoot);

  const targetDirectory = modDir(appHome);
  const targetDataDirectory = dataDir(appHome);
  const targetManifest = manifestPath(appHome);

  if (path.resolve(source.modDir) === path.resolve(targetDirectory)) {
    throw new Error("Source and target are the same mod folder; refusing to install over itself.");
  }

  const targetStat = await lstatOrNull(targetDirectory);
  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing a symbolic-link target: ${targetDirectory}`);
    }
    if (!targetStat.isDirectory()) {
      throw new Error(`Target mod path is not a directory: ${targetDirectory}`);
    }
  }

  const manifest = await readManifest(appHome);
  if (targetStat && !manifest) {
    throw new Error(
      `Refusing an unowned collision at ${targetDirectory}.\nNo ${targetManifest} proves this installer owns it. Move the folder aside or install with Herdr's own mod tools.`,
    );
  }

  const issues = [];
  const sourcePaths = new Set(source.files.map((file) => file.relative));

  for (const file of source.files) {
    const target = localPath(targetDirectory, file.relative);
    await addParentIssues(targetDirectory, target, issues);
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      issues.push(`Refusing to replace a symbolic link: ${target}`);
      continue;
    }
    if (!stat.isFile()) {
      issues.push(`Refusing to replace a non-regular file: ${target}`);
      continue;
    }

    const oldHash = manifest?.files[file.relative];
    if (!oldHash) {
      issues.push(`Unowned target file would be replaced: ${target}`);
      continue;
    }

    const currentHash = sha256(await fs.readFile(target));
    if (currentHash !== oldHash && currentHash !== file.hash && !options.force) {
      issues.push(
        `Owned file was edited locally: ${target} (use --force to replace it with reviewed source)`,
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Refusing to install; no target files were changed:\n${issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    );
  }

  await ensureDirectory(appHome, path.join(appHome, "mods"), "Herdr mods directory");
  await ensureDirectory(appHome, targetDirectory, "Insights mod directory");
  await ensureDirectory(appHome, targetDataDirectory, "Insights data directory");

  const written = [];
  const unchanged = [];
  for (const file of source.files) {
    const target = localPath(targetDirectory, file.relative);
    await ensureDirectory(
      appHome,
      path.dirname(target),
      `Target directory for ${file.relative}`,
    );

    const existing = await lstatOrNull(target);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing to replace a non-regular file: ${target}`);
      }
      if (sha256(await fs.readFile(target)) === file.hash) {
        unchanged.push(file.relative);
        continue;
      }
    }

    await writeFileAtomic(target, file.data, file.mode);
    written.push(file.relative);
  }

  const removed = [];
  const keptStale = [];
  if (manifest) {
    for (const [relative, oldHash] of Object.entries(manifest.files)) {
      if (sourcePaths.has(relative)) continue;
      const target = localPath(targetDirectory, relative);
      try {
        await assertNoSymlinkComponents(appHome, target);
      } catch (error) {
        keptStale.push(`${target} (${error.message})`);
        continue;
      }
      const stat = await lstatOrNull(target);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        keptStale.push(`${target} (not a regular file)`);
        continue;
      }
      if (sha256(await fs.readFile(target)) !== oldHash) {
        keptStale.push(`${target} (edited locally)`);
        continue;
      }
      await fs.unlink(target);
      removed.push(relative);
    }
  }

  const installedHashes = Object.fromEntries(
    source.files.map((file) => [file.relative, file.hash]),
  );
  await writeManifest(appHome, installedHashes);

  console.log(
    `Installed ${source.files.length} owned file(s) to ${targetDirectory} ` +
      `(${written.length} written, ${unchanged.length} unchanged${
        removed.length ? `, ${removed.length} stale removed` : ""
      }).`,
  );
  console.log(`Insights data stays at ${targetDataDirectory}; insights.json is untouched.`);
  for (const kept of keptStale) {
    console.warn(`Kept an owned file no longer in the source: ${kept}`);
  }

  const herdrEnv = { HERDR_APP_HOME: appHome };
  const check = await runHerdr(["check", targetDirectory], { env: herdrEnv });
  relayHerdrOutput(check);
  if (check.error || check.code !== 0 || check.signal) {
    throw new Error(
      `${herdrFailure(check, "herdr-app check")}\nFiles are installed; fix the mod and rerun the installer.`,
    );
  }
  console.log("herdr-app check passed.");

  if (options.open) {
    const opened = await runHerdr(OPEN_ARGS, { env: herdrEnv });
    relayHerdrOutput(opened);
    if (opened.error || opened.code !== 0 || opened.signal) {
      throw new Error(herdrFailure(opened, "herdr-app do tab.new"));
    }
    console.log("Opened the Insights tab in the current Herdr space.");
  }
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
    await install(options);
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
