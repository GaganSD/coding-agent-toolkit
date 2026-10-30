import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MIN_NODE_VERSION,
  PACKAGE_ROOT,
  assertSupportedNodeVersion,
  collectSourceFiles,
  lstatOrNull,
} from "./lib.mjs";

const errors = [];
const notes = [];

function fail(message) {
  errors.push(message);
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    fail(`Cannot read ${file}: ${error.message}`);
    return null;
  }
}

async function walkFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      fail(`Refusing a symbolic link in the package: ${absolute}`);
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
      continue;
    }
    if (stat.isFile()) files.push(absolute);
  }
  return files;
}

function checkNodeSyntax(file) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    fail(`Cannot run node --check for ${file}: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    fail(
      `Syntax check failed for ${file}:\n${(result.stderr || result.stdout || "").trim()}`,
    );
  }
}

async function checkPackage() {
  const packageFile = path.join(PACKAGE_ROOT, "package.json");
  const text = await readText(packageFile);
  if (text === null) return;

  let packageJson;
  try {
    packageJson = JSON.parse(text);
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`);
    return;
  }

  if (packageJson.private !== true) fail("package.json must stay private: true");
  if (packageJson.type !== "module") fail('package.json must use "type": "module"');
  const expectedEngines = `>=${MIN_NODE_VERSION}`;
  if (packageJson.engines?.node !== expectedEngines) {
    fail(`package.json must declare "engines": { "node": "${expectedEngines}" }`);
  }

  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = packageJson[field];
    if (value && typeof value === "object" && Object.keys(value).length > 0) {
      fail(`package.json must not have ${field}; Insights is dependency-free`);
    }
  }

  const expectedScripts = {
    check: "node scripts/check.mjs",
    "install:local": "node scripts/install.mjs",
    test: "node --test tests/*.test.mjs",
    "uninstall:local": "node scripts/uninstall.mjs",
  };
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (packageJson.scripts?.[name] !== expected) {
      fail(`package.json scripts.${name} must be ${JSON.stringify(expected)}`);
    }
  }
}

async function checkFiles() {
  for (const relative of [
    ".gitignore",
    "README.md",
    "RECIPE.md",
    "preview.png",
    "mods/insights/main.js",
    "mods/insights/mod.json",
    "scripts/install.mjs",
    "scripts/lib.mjs",
    "scripts/uninstall.mjs",
    "tests/install.test.mjs",
    "tests/node-version.test.mjs",
  ]) {
    const stat = await lstatOrNull(path.join(PACKAGE_ROOT, relative));
    if (!stat || !stat.isFile()) fail(`Missing owned file: ${relative}`);
  }

  const gitignore = await readText(path.join(PACKAGE_ROOT, ".gitignore"));
  if (gitignore !== null && !gitignore.includes("node_modules/")) {
    fail(".gitignore must ignore node_modules/");
  }
}

async function checkDocs() {
  const readme = await readText(path.join(PACKAGE_ROOT, "README.md"));
  if (readme !== null) {
    for (const heading of ["# Insights", "## Install", "## Use", "## Privacy", "## Development"]) {
      if (!readme.includes(heading)) fail(`README.md is missing ${heading}`);
    }
    for (const phrase of ["![Insights](preview.png)", "insights.json", "herdr-app check", "Node.js 22.15+", "synthetic data"]) {
      if (!readme.toLowerCase().includes(phrase.toLowerCase())) {
        fail(`README.md does not mention ${JSON.stringify(phrase)}`);
      }
    }
  }

  const recipe = await readText(path.join(PACKAGE_ROOT, "RECIPE.md"));
  if (recipe !== null) {
    const ordered = [
      "# Insights",
      "![Insights](preview.png)",
      "**What you see:**",
      "**How it behaves:**",
      "**Built from:**",
      "**Watch out:**",
      "**Done when:**",
    ];
    let previous = -1;
    for (const marker of ordered) {
      const index = recipe.indexOf(marker);
      if (index === -1) {
        fail(`RECIPE.md is missing ${JSON.stringify(marker)}`);
        continue;
      }
      if (index <= previous) {
        fail(`RECIPE.md has ${JSON.stringify(marker)} out of order`);
      }
      previous = index;
    }
  }
}

async function checkScriptsAndTests() {
  const directories = ["scripts", "tests"]
    .map((relative) => path.join(PACKAGE_ROOT, relative));
  for (const directory of directories) {
    const files = (await walkFiles(directory)).filter((file) =>
      /\.(?:mjs|js)$/.test(file),
    );
    for (const file of files) checkNodeSyntax(file);
  }

  const scriptFiles = (await walkFiles(path.join(PACKAGE_ROOT, "scripts"))).filter(
    (file) => file.endsWith(".mjs"),
  );
  for (const file of scriptFiles) {
    const text = await readText(file);
    if (text === null) continue;
    if (/shell\s*:\s*true/.test(text)) {
      fail(`${path.relative(PACKAGE_ROOT, file)} must not run through a shell`);
    }
    if (/\bexecSync\s*\(/.test(text)) {
      fail(`${path.relative(PACKAGE_ROOT, file)} must not use execSync`);
    }
  }
}

async function checkTestInventory() {
  const tests = (await walkFiles(path.join(PACKAGE_ROOT, "tests"))).filter((file) =>
    /install.*\.test\.mjs$/.test(path.basename(file)),
  );
  if (tests.length === 0) fail("No tests/install*.test.mjs files found");
}

async function checkDistribution() {
  if (path.basename(PACKAGE_ROOT) !== "herdr-insights") fail("Distribution folder must be herdr-insights");
  if (await lstatOrNull(path.join(PACKAGE_ROOT, "layouts"))) fail("Herdr mods must not ship layouts/");
  try {
    const preview = await fs.readFile(path.join(PACKAGE_ROOT, "preview.png"));
    if (preview.length < 24 || preview.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      || preview.toString("ascii", 12, 16) !== "IHDR"
      || preview.readUInt32BE(16) === 0 || preview.readUInt32BE(20) === 0) {
      fail("preview.png must be a PNG image with nonzero dimensions");
    }
    const mod = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "mods/insights/mod.json"), "utf8"));
    if (mod.title !== "Insights" || mod.place !== "none") {
      fail('mod.json must use title "Insights" and place "none"');
    }
  } catch (error) {
    fail(`Invalid Herdr distribution: ${error.message}`);
  }
}

async function checkSourceIfPresent() {
  const sourceMod = path.join(PACKAGE_ROOT, "mods", "insights");
  const stat = await lstatOrNull(sourceMod);
  if (!stat) {
    fail("mods/insights is required for the Herdr distribution");
    return;
  }
  try {
    const source = await collectSourceFiles(PACKAGE_ROOT);
    notes.push(`mods/insights source tree validates (${source.files.length} files)`);
  } catch (error) {
    fail(`mods/insights source tree is invalid: ${error.message}`);
  }
}

function checkNodeVersion() {
  try {
    assertSupportedNodeVersion(process.versions.node);
  } catch (error) {
    fail(error.message);
  }
}

checkNodeVersion();
await checkPackage();
await checkFiles();
await checkDistribution();
await checkDocs();
await checkScriptsAndTests();
await checkTestInventory();
await checkSourceIfPresent();

for (const note of notes) console.log(`Note: ${note}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`Error: ${error}`);
  process.exitCode = 1;
} else {
  console.log("Insights package checks passed.");
}
