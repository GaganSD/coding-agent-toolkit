import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { affectedChecks, affectedPackages, checkOutputs, ciMatrix, detectChecks } from "../ci.mjs";
import { isolatedEnvironment, root } from "../lib.mjs";
import { packages } from "../packages.mjs";
import { validateContents } from "../package.mjs";
import { selectTests, testFiles } from "../test-package.mjs";

test("package changes select only their packages; shared changes select all", () => {
  assert.deepEqual(affectedPackages(["pi-ask/src/index.ts"]), ["pi-ask"]);
  assert.deepEqual(affectedPackages(["pi-slate/package.json", "pi-ask/tests/example.test.ts"]), ["pi-ask", "pi-slate"]);
  assert.deepEqual(affectedPackages(["README.md", "docs/releases.md"]), []);
  for (const file of ["package-lock.json", ".github/workflows/ci.yml", "scripts/packages.mjs", ".release/plan.json"]) {
    assert.deepEqual(affectedPackages([file]), Object.keys(packages));
  }
});

const noChecks = { packages: [], insights: false, tooling: false, quickstart: false, unknown: [] };
const allChecks = { packages: Object.keys(packages), insights: true, tooling: true, quickstart: true, unknown: [] };
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("Herdr-only changes skip Pi packages, tooling, and quickstart", () => {
  const paths = JSON.parse(read("./fixtures/herdr-only-paths.json"));
  assert.deepEqual(affectedChecks(paths), { ...noChecks, insights: true });
  for (const path of paths) assert.deepEqual(affectedChecks([path]), { ...noChecks, insights: true });
});

test("ownership covers test-only, mixed, tooling, and documentation changes", () => {
  for (const [paths, expected] of [
    [["pi-ask/tests/example.test.ts"], { packages: ["pi-ask"], quickstart: true }],
    [["pi-subagents/test/example.test.ts"], { packages: ["pi-subagents"], quickstart: true }],
    [["tests/herdr-insights/example.test.mjs", "pi-slate/themes/example.json"],
      { packages: ["pi-slate"], insights: true, quickstart: true }],
    [["scripts/herdr-insights/check.mjs"], { insights: true, tooling: true }],
    [["docs/herdr-insights-development.md"], { insights: true }],
    [["README.md", "docs/ci-cd.md", ".github/CODEOWNERS"], {}],
    [["scripts/tests/release.test.mjs", ".gitleaks.toml"], { tooling: true }],
    [["scripts/quickstart-ci.mjs"], { tooling: true, quickstart: true }],
    [["package-lock.json", "eslint.config.mjs", "scripts/test-package.mjs"],
      { packages: Object.keys(packages), tooling: true, quickstart: true }],
    [["package.json"], allChecks],
    [["scripts/ci.mjs"], allChecks],
    [[".github/workflows/ci.yml"], allChecks],
    [["new-shared-code/index.ts"], { ...allChecks, unknown: ["new-shared-code/index.ts"] }],
    [["herdr-insights-other/file.js"], { ...allChecks, unknown: ["herdr-insights-other/file.js"] }],
  ]) assert.deepEqual(affectedChecks(paths), { ...noChecks, ...expected }, paths.join(", "));
});

test("release plans select their packages rather than every Pi package", () => {
  assert.deepEqual(affectedChecks([".release/plan.json"], { releasePackages: ["pi-ask"] }),
    { ...noChecks, packages: ["pi-ask"], quickstart: true });
  assert.throws(() => affectedChecks([".release/plan.json"], { releasePackages: ["unknown"] }), /Unknown release package/);
});

test("manual/full runs and outputs are explicit, including empty matrices", () => {
  const head = "a".repeat(40);
  assert.deepEqual(detectChecks("", head), allChecks);
  assert.deepEqual(detectChecks("0".repeat(40), head), allChecks);
  assert.throws(() => detectChecks("", "HEAD"), /head SHA/);
  assert.throws(() => detectChecks("HEAD^", head), /base SHA/);
  assert.equal(checkOutputs(noChecks), 'has_packages=false\nmatrix={"include":[]}\nrun_insights=false\nrun_tooling=false\nrun_quickstart=false\n');
});

test("Git detection covers multiple commits, deleted tests, cross-owner moves, and release cancellation", t => {
  const directory = mkdtempSync(join(tmpdir(), "ci-routing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  const env = isolatedEnvironment(join(directory, "env"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  const put = (path, content = "example\n") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  put("tests/herdr-insights/deleted.test.mjs");
  const base = commit();
  rmSync(join(repo, "tests/herdr-insights/deleted.test.mjs"));
  const deleted = commit();
  assert.deepEqual(detectChecks(base, deleted, git), { ...noChecks, insights: true });
  put("pi-ask/tests/moved.test.ts");
  const beforeMove = commit();
  mkdirSync(join(repo, "pi-slate/tests"), { recursive: true });
  renameSync(join(repo, "pi-ask/tests/moved.test.ts"), join(repo, "pi-slate/tests/moved.test.ts"));
  const moved = commit();
  assert.deepEqual(detectChecks(beforeMove, moved, git),
    { ...noChecks, packages: ["pi-ask", "pi-slate"], quickstart: true });
  assert.deepEqual(detectChecks(base, moved, git),
    { ...noChecks, packages: ["pi-slate"], insights: true, quickstart: true });
  put(".release/plan.json", JSON.stringify({ schema: 1, sourceSha: moved, notes: "fixture",
    packages: [{ path: "pi-ask", name: packages["pi-ask"].name, bump: "patch", from: "1.0.0", to: "1.0.1" }] }));
  const release = commit();
  const expected = { ...noChecks, packages: ["pi-ask"], quickstart: true };
  assert.deepEqual(detectChecks(moved, release, git), expected);
  rmSync(join(repo, ".release/plan.json"));
  assert.deepEqual(detectChecks(release, commit(), git), expected);
  put(".release/plan.json", "{}");
  assert.throws(() => detectChecks(release, commit(), git));
});

test("CI gate accepts only successful selected jobs and intentional skips", () => {
  const workflow = read("../../.github/workflows/ci.yml");
  const gate = workflow.match(/node -e '([\s\S]*?)'/)[1];
  const jobs = {
    changes: { result: "success", outputs: { has_packages: "false", run_insights: "true", run_tooling: "false" } },
    secrets: { result: "success" }, packages: { result: "skipped" },
    insights: { result: "success" }, tooling: { result: "skipped" },
  };
  const runGate = needs => spawnSync(process.execPath, ["-e", gate], {
    env: { ...process.env, RESULTS: JSON.stringify(needs) },
  }).status;
  assert.equal(runGate(jobs), 0);
  for (const name of Object.keys(jobs)) {
    for (const result of ["failure", "cancelled"]) {
      assert.notEqual(runGate({ ...jobs, [name]: { ...jobs[name], result } }), 0);
    }
  }
  assert.notEqual(runGate({ ...jobs, insights: { result: "skipped" } }), 0);
  assert.notEqual(runGate({ ...jobs, packages: { result: "success" } }), 0);
  for (const value of [undefined, "", "unexpected"]) {
    const invalid = structuredClone(jobs);
    invalid.changes.outputs.has_packages = value;
    assert.notEqual(runGate(invalid), 0);
  }
  const full = structuredClone(jobs);
  full.changes.outputs = { has_packages: "true", run_insights: "true", run_tooling: "true" };
  full.packages.result = full.tooling.result = "success";
  assert.equal(runGate(full), 0);
  const docs = structuredClone(jobs);
  docs.changes.outputs.run_insights = "false";
  docs.insights.result = "skipped";
  assert.equal(runGate(docs), 0);
});

test("workflow wires routing, full sweeps, and unconditional dependency-free release validation", () => {
  const workflow = read("../../.github/workflows/ci.yml");
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /\["workflow_dispatch", "schedule"\]/);
  for (const [job, output] of [["tooling", "run_tooling"], ["insights", "run_insights"], ["packages", "has_packages"]]) {
    assert.match(workflow, new RegExp(`  ${job}:\\n    needs: changes\\n    if: needs.changes.outputs.${output} == 'true'`));
  }
  const changes = workflow.split("  changes:")[1].split("\n  tooling:")[0];
  assert.match(changes, /node scripts\/release.mjs check/);
  assert.doesNotMatch(changes, /run: npm ci/);
  assert.match(workflow, / {2}secrets:\n {4}uses: .\/\.github\/workflows\/secret-scan.yml/);
});

test("the matrix is exactly one combined leg per affected package", () => {
  assert.deepEqual(ciMatrix(["pi-ask"]), [{ package: "pi-ask" }]);
  assert.deepEqual(ciMatrix(["pi-ask", "pi-web-search"]), [{ package: "pi-ask" }, { package: "pi-web-search" }]);
  assert.deepEqual(ciMatrix([]), []);
});

test("test suites partition every test exactly once and contain real integration tests", () => {
  for (const [path, config] of Object.entries(packages)) {
    const files = testFiles(join(root, path, config.tests));
    const unit = selectTests(files, config.integration, "unit");
    const integration = selectTests(files, config.integration, "integration");
    assert.deepEqual([...unit, ...integration].sort(), files);
    assert.equal(new Set([...unit, ...integration]).size, files.length);
  }
  assert.throws(() => selectTests(["a.test.ts"], ["missing.test.ts"], "unit"), /Missing/);
  assert.throws(() => selectTests(["a.test.ts"], [], "integration"), /Empty/);
  assert.throws(() => selectTests([], [], "all"), /Expected/);
});

test("package content checks reject missing entrypoints, secrets and development files", () => {
  const manifest = { pi: { extensions: ["./src/index.ts"] } };
  const files = ["package.json", "README.md", "LICENSE", "src/index.ts"];
  validateContents(manifest, files);
  for (const extra of [".env", ".env.local", ".npmrc", "auth.json", "secrets/private.pem", "../secret", "/absolute", "node_modules/x.js", "scripts/publish.js", "tests/a.test.ts"]) {
    assert.throws(() => validateContents(manifest, [...files, extra]));
  }
  assert.throws(() => validateContents(manifest, files.slice(0, -1)), /entrypoint/);
  assert.throws(() => validateContents({ ...manifest, scripts: { postinstall: "anything" } }, files), /install hook/);
});
