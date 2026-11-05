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
  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /node scripts\/quickstart-ci\.mjs/);
});

test("post-main quickstart runs only for selected changes after successful validation/publication", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
  const job = workflow.split("  quickstart:\n")[1].split("\n  publish:")[0];
  assert.match(job, /needs: \[validate, eligible, publish\]/);
  assert.match(job, /uses: .\/\.github\/workflows\/quickstart.yml/);
  const condition = job.match(/if: >-\n([\s\S]*?)\n {4}uses:/)[1].trim();
  const selected = new Function("needs", "always", "cancelled", `return (${condition});`);
  const needs = {
    validate: { result: "success", outputs: { run_quickstart: "true" } },
    eligible: { result: "success" }, publish: { result: "skipped" },
  };
  const run = (jobs, cancelled = false) => selected(jobs, () => true, () => cancelled);
  assert.equal(run(needs), true);
  assert.equal(run({ ...needs, publish: { result: "success" } }), true);
  assert.equal(run(needs, true), false);
  for (const name of Object.keys(needs)) {
    for (const result of ["failure", "cancelled"]) {
      assert.equal(run({ ...needs, [name]: { ...needs[name], result } }), false);
    }
  }
  for (const value of ["false", "", undefined]) {
    assert.equal(run({ ...needs, validate: { result: "success", outputs: { run_quickstart: value } } }), false);
  }
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
  assert.match(readme, /workflow\/status\/GaganSD\/coding-agent-toolkit\/publish\.yml\?branch=main/);
  assert.match(readme, /actions\/workflows\/quickstart\.yml/);
  assert.match(readme, /workflow\/status\/GaganSD\/coding-agent-toolkit\/quickstart\.yml\?branch=main/);
});
