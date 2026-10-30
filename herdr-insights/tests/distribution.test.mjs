import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { inspectDistribution } from "../scripts/distribution.mjs";
import { validatePng } from "../scripts/png.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("Herdr distribution has the requested folder and display name, with no layouts or bindings", async () => {
  assert.equal(path.basename(root), "herdr-insights");
  assert.deepEqual(JSON.parse(await read("mods/insights/mod.json")), { place: "none", title: "Insights" });
  const modEntries = (await readdir(path.join(root, "mods"))).filter((name) => name !== ".DS_Store");
  assert.deepEqual(modEntries, ["insights"]);
  await assert.rejects(lstat(path.join(root, "layouts")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(root, "keys.json")), { code: "ENOENT" });
  assert.match(await read("RECIPE.md"), /^# Insights\n/);
});

test("Community preview is a complete PNG referenced by the recipe", async () => {
  const image = await readFile(path.join(root, "preview.png"));
  const parsed = validatePng(image);
  assert.ok(parsed.width > 0 && parsed.height > 0);
  const recipe = await read("RECIPE.md");
  assert.match(recipe, /!\[Insights\]\(preview\.png\)/);
  assert.doesNotMatch(recipe, /image2\.png/);
});

test("PNG validation rejects truncated and corrupted previews", async () => {
  const image = await readFile(path.join(root, "preview.png"));
  assert.throws(
    () => validatePng(image.subarray(0, image.length - 12)),
    /IEND|truncated/i,
  );
  assert.throws(() => validatePng(image.subarray(0, 40)), /truncated|IEND/i);

  let offset = 8;
  let dataStart = null;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      dataStart = offset + 8;
      break;
    }
    offset += 12 + length;
  }
  assert.notEqual(dataStart, null);
  const corrupted = Buffer.from(image);
  corrupted[dataStart] ^= 0xff;
  assert.throws(() => validatePng(corrupted), /CRC/i);
});

test("Distribution inspection rejects keys.json and layouts without ignoring them", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "insights-distribution-"));
  t.after(async () => rm(temporary, { recursive: true, force: true }));
  const packageRoot = path.join(temporary, "herdr-insights");
  await mkdir(path.join(packageRoot, "mods", "insights"), { recursive: true });
  await copyFile(path.join(root, "preview.png"), path.join(packageRoot, "preview.png"));
  await writeFile(
    path.join(packageRoot, "mods", "insights", "mod.json"),
    '{"place":"none","title":"Insights"}\n',
  );

  assert.deepEqual((await inspectDistribution(packageRoot)).errors, []);

  await writeFile(path.join(packageRoot, "keys.json"), "{}\n");
  assert.match((await inspectDistribution(packageRoot)).errors.join("\n"), /keys\.json/);
  await rm(path.join(packageRoot, "keys.json"));

  await mkdir(path.join(packageRoot, "layouts"));
  assert.match((await inspectDistribution(packageRoot)).errors.join("\n"), /layouts/i);
});

test("Recipe follows Herdr's required order and remains self-contained", async () => {
  const recipe = await read("RECIPE.md");
  let previous = -1;
  for (const marker of ["# Insights", "![Insights](preview.png)", "**What you see:**",
    "**How it behaves:**", "**Built from:**", "**Watch out:**", "**Done when:**"]) {
    const index = recipe.indexOf(marker);
    assert.ok(index > previous, `${marker} must exist and follow the preceding section`);
    previous = index;
  }
  assert.doesNotMatch(recipe, /schema is documented in README|exact README schema/);
});
