import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseUses, parseVersion, renderReport } from "../dependency-check.mjs";

test("version parsing accepts plain tags and rejects ranges", () => {
  assert.deepEqual(parseVersion("v7.1.0"), [7, 1, 0]);
  assert.deepEqual(parseVersion("1.3.37"), [1, 3, 37]);
  assert.equal(parseVersion("^1.0.0"), null);
  assert.equal(parseVersion("main"), null);
  assert.equal(parseVersion(undefined), null);
});

test("compareVersions orders releases", () => {
  assert(compareVersions("v7.0.0", "v7.1.0") < 0);
  assert(compareVersions("8.0.2", "8.0.1") > 0);
  assert(compareVersions("1.10.0", "1.9.0") > 0);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareVersions("main", "v1.0.0"), 0);
});

test("parseUses keeps every pinned ref per action", () => {
  const pins = parseUses(`
    - uses: actions/checkout@abc # v7.0.1
    - uses: actions/setup-node@def # v7.0.0
    - uses: actions/checkout@ghi # v6
    - uses: ./.github/workflows/ci.yml
  `);
  assert.deepEqual([...pins.get("actions/checkout")], ["abc", "ghi"]);
  assert.deepEqual([...pins.get("actions/setup-node")], ["def"]);
  assert.equal(pins.size, 2);
});

test("renderReport lists updates and omits empty sections", () => {
  const body = renderReport(
    [{ workspace: "pi-ask", name: "@types/node", current: "26.6.3", latest: "26.6.5" }],
    [{ slug: "actions/setup-node", current: "v7.0.0", latest: "v7.1.0", url: "https://example.com/diff" }],
    "2025-01-01",
  );
  assert.match(body, /Checked 2025-01-01/);
  assert.match(body, /actions\/setup-node/);
  assert.match(body, /### `pi-ask`/);
  assert.match(body, /@types\/node/);
  const npmOnly = renderReport([{ workspace: ".", name: "eslint", current: "10.12.0", latest: "10.13.0" }], [], "2025-01-01");
  assert.match(npmOnly, /### `root`/);
  assert.doesNotMatch(npmOnly, /GitHub Actions/);
});
