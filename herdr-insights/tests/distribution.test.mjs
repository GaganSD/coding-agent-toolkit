import assert from "node:assert/strict";
import { readFile, readdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("Herdr distribution has the requested folder and display name, with no layouts or bindings", async () => {
  assert.equal(path.basename(root), "herdr-insights");
  assert.deepEqual(JSON.parse(await read("mods/insights/mod.json")), { place: "none", title: "Insights" });
  assert.deepEqual(await readdir(path.join(root, "mods")), ["insights"]);
  await assert.rejects(lstat(path.join(root, "layouts")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(root, "keys.json")), { code: "ENOENT" });
  assert.match(await read("RECIPE.md"), /^# Insights\n/);
});

test("Community preview is a PNG referenced by both human and agent instructions", async () => {
  const image = await readFile(path.join(root, "preview.png"));
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.toString("ascii", 12, 16), "IHDR");
  assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0);
  for (const file of ["README.md", "RECIPE.md"]) {
    const text = await read(file);
    assert.match(text, /!\[Insights\]\(preview\.png\)/);
    assert.match(text, /synthetic data/i);
    assert.doesNotMatch(text, /image2\.png/);
  }
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
