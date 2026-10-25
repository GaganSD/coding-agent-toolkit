import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { packages } from "../packages.mjs";
import { packageSpecs, piCliVersion, waitForRegistryPackage } from "../quickstart-ci.mjs";

test("quickstart package downloads match the release allowlist and exact manifests", () => {
  const specs = packageSpecs();
  assert.deepEqual(specs.map(spec => spec.directory), Object.keys(packages));
  for (const spec of specs) {
    const manifest = JSON.parse(readFileSync(new URL(`../../${spec.directory}/package.json`, import.meta.url), "utf8"));
    assert.equal(spec.spec, `${manifest.name}@${manifest.version}`);
    assert.match(spec.version, /^\d+\.\d+\.\d+/);
  }
});

test("quickstart smoke uses the pinned Pi CLI and the dedicated workflow is release-safe", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../pi-slate/package.json", import.meta.url), "utf8"));
  assert.equal(piCliVersion(), manifest.devDependencies["@earendil-works/pi-coding-agent"]);

  const workflow = readFileSync(new URL("../../.github/workflows/quickstart.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["Main CI and releases"\]/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /node scripts\/quickstart-ci\.mjs/);
});

test("quickstart waits through npm's post-publish processing delay", () => {
  let calls = 0;
  const version = waitForRegistryPackage("demo@1.2.3", {
    timeoutMs: 50,
    intervalMs: 1,
    sleepMs: () => {},
    check: () => {
      calls += 1;
      if (calls < 3) throw new Error("notarget");
      return "1.2.3";
    },
  });
  assert.equal(version, "1.2.3");
  assert.equal(calls, 3);
  assert.throws(() => waitForRegistryPackage("missing@1.0.0", {
    timeoutMs: 0,
    intervalMs: 1,
    sleepMs: () => {},
    check: () => { throw new Error("notarget"); },
  }), /Timed out waiting for missing@1\.0\.0/);
});

test("README badges point at workflows that run on main", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme, /actions\/workflows\/publish\.yml/);
  assert.match(readme, /workflow\/status\/GaganSD\/pi-extensions\/publish\.yml\?branch=main/);
  assert.match(readme, /actions\/workflows\/quickstart\.yml/);
  assert.match(readme, /workflow\/status\/GaganSD\/pi-extensions\/quickstart\.yml\?branch=main/);
});
