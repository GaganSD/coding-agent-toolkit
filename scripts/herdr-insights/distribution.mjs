import { promises as fs } from "node:fs";
import path from "node:path";

import { lstatOrNull } from "../../herdr-insights/scripts/lib.mjs";
import { validatePng } from "./png.mjs";

/** The one native Herdr mod this distribution ships. */
export const INSIGHTS_MOD = "insights";

const ALLOWED_SCRIPTS = ["install.mjs", "lib.mjs", "toolbar.mjs", "uninstall.mjs"];

function modEntries(entries) {
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".DS_Store")
    .map((entry) => entry.name)
    .sort();
}

export async function inspectDistribution(packageRoot) {
  const errors = [];
  const notes = [];

  if (path.basename(packageRoot) !== "herdr-insights") {
    errors.push("Distribution folder must be herdr-insights");
  }
  for (const [relative, message] of [
    ["layouts", "Herdr mods must not ship layouts/"],
    ["keys.json", "Herdr mods must not ship keys.json"],
    ["tests", "Developer tests and fixtures must stay outside herdr-insights/"],
  ]) {
    try {
      if (await lstatOrNull(path.join(packageRoot, relative))) errors.push(message);
    } catch (error) {
      errors.push(`Cannot inspect ${relative}: ${error.message}`);
    }
  }

  try {
    const mods = modEntries(await fs.readdir(path.join(packageRoot, "mods"), { withFileTypes: true }));
    if (!mods.includes(INSIGHTS_MOD)) {
      errors.push(`Distribution must contain mods/${INSIGHTS_MOD}`);
    }
    for (const name of mods) {
      if (name !== INSIGHTS_MOD) {
        errors.push(`Distribution ships one native mod; remove mods/${name}`);
      }
    }
  } catch (error) {
    errors.push(`Cannot inspect mods/: ${error.message}`);
  }

  try {
    const allowed = new Set(ALLOWED_SCRIPTS);
    for (const name of await fs.readdir(path.join(packageRoot, "scripts"))) {
      if (!allowed.has(name)) errors.push(`Developer tooling must stay outside herdr-insights/scripts/: ${name}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(`Cannot inspect install scripts: ${error.message}`);
  }

  try {
    const preview = await fs.readFile(path.join(packageRoot, "preview.png"));
    const image = validatePng(preview);
    notes.push(`preview.png is a complete ${image.width}x${image.height} PNG`);
  } catch (error) {
    errors.push(`preview.png is not a complete, valid PNG image: ${error.message}`);
  }

  try {
    const mod = JSON.parse(
      await fs.readFile(path.join(packageRoot, `mods/${INSIGHTS_MOD}/mod.json`), "utf8"),
    );
    if (mod.title !== "Insights" || mod.place !== "none") {
      errors.push('mod.json must use title "Insights" and place "none"');
    }
  } catch (error) {
    errors.push(`Invalid Herdr distribution: ${error.message}`);
  }

  return { errors, notes };
}
