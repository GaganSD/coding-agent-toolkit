import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeArtifacts, validateRetry } from "../release-recovery.mjs";

test("retry accepts only completed main publication runs with successful CI and eligibility", () => {
  const run = { repository: { full_name: "GaganSD/coding-agent-toolkit" }, path: ".github/workflows/publish.yml", event: "push", head_branch: "main", status: "completed", conclusion: "failure", head_sha: "a".repeat(40) };
  const jobs = ["validate / CI passed", "eligible"].map(name => ({ name, conclusion: "success" }));
  assert.equal(validateRetry(run, jobs), run.head_sha);
  assert.equal(validateRetry({ ...run, conclusion: "success" }, jobs), run.head_sha);
  for (const change of [
    { repository: { full_name: "other/repo" } }, { path: ".github/workflows/ci.yml" },
    { event: "pull_request" }, { head_branch: "feature" }, { status: "in_progress" },
    { conclusion: "cancelled" }, { head_sha: "main" },
  ]) assert.throws(() => validateRetry({ ...run, ...change }, jobs));
  for (const name of jobs.map(job => job.name)) {
    assert.throws(() => validateRetry(run, jobs.filter(job => job.name !== name)));
    assert.throws(() => validateRetry(run, jobs.map(job => job.name === name ? { ...job, conclusion: "failure" } : job)));
  }
});

for (const path of ["pi-slate", "pi-ask"]) {
  test(`normalizes flat ${path} downloads without changing archive bytes`, () => {
    const root = mkdtempSync(join(tmpdir(), "release-layout-"));
    const name = path === "pi-slate" ? path : "@gagansd/pi-ask";
    const item = { path, name, to: "0.2.1" };
    const filename = `${name.replace(/^@/, "").replaceAll("/", "-")}-0.2.1.tgz`;
    const writePlan = packages => writeFileSync(join(root, ".release/plan.json"), JSON.stringify({ packages }));
    const writeMetadata = changes => writeFileSync(join(root, ".artifacts/manifest.json"), JSON.stringify({ name, version: "0.2.1", filename, ...changes }));
    try {
      mkdirSync(join(root, ".release"));
      mkdirSync(join(root, ".artifacts"));
      writePlan([item]);
      writeFileSync(join(root, ".artifacts", filename), "original archive");
      for (const changes of [{ filename: "../escape.tgz" }, { name: "wrong" }, { version: "9.0.0" }]) {
        writeMetadata(changes);
        assert.throws(() => normalizeArtifacts(root));
      }
      writeMetadata({});
      writePlan([item, item]);
      assert.throws(() => normalizeArtifacts(root));
      writePlan([item]);
      normalizeArtifacts(root);
      const target = join(root, ".artifacts", `npm-${path}`);
      assert.equal(readFileSync(join(target, filename), "utf8"), "original archive");
      assert.equal(JSON.parse(readFileSync(join(target, "manifest.json"))).name, name);
      // Nested downloads (including multiple artifacts) and repeat calls are untouched.
      normalizeArtifacts(root);
      assert.equal(readFileSync(join(target, filename), "utf8"), "original archive");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
