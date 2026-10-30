import { promises as fs } from "node:fs";
import path from "node:path";

import { lstatOrNull } from "./lib.mjs";
import { validatePng } from "./png.mjs";

export async function inspectDistribution(packageRoot) {
  const errors = [];
  const notes = [];

  if (path.basename(packageRoot) !== "herdr-insights") {
    errors.push("Distribution folder must be herdr-insights");
  }
  for (const [relative, message] of [
    ["layouts", "Herdr mods must not ship layouts/"],
    ["keys.json", "Herdr mods must not ship keys.json"],
  ]) {
    try {
      if (await lstatOrNull(path.join(packageRoot, relative))) errors.push(message);
    } catch (error) {
      errors.push(`Cannot inspect ${relative}: ${error.message}`);
    }
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
      await fs.readFile(path.join(packageRoot, "mods/insights/mod.json"), "utf8"),
    );
    if (mod.title !== "Insights" || mod.place !== "none") {
      errors.push('mod.json must use title "Insights" and place "none"');
    }
  } catch (error) {
    errors.push(`Invalid Herdr distribution: ${error.message}`);
  }

  return { errors, notes };
}
