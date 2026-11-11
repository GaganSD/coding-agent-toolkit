import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const repository = "GaganSD/coding-agent-toolkit";

export function validateRetry(run, jobs) {
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.path, ".github/workflows/publish.yml");
  assert.equal(run.event, "push");
  assert.equal(run.head_branch, "main");
  assert.equal(run.status, "completed");
  assert(["failure", "success"].includes(run.conclusion));
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  for (const name of ["validate / CI passed", "eligible"]) {
    assert(jobs.some(job => job.name === name && job.conclusion === "success"), `Missing successful ${name}`);
  }
  return run.head_sha;
}

// download-artifact v8 flattens a single match, even with merge-multiple: false.
export function normalizeArtifacts(root) {
  const directory = join(root, ".artifacts");
  if (!existsSync(join(directory, "manifest.json"))) return;
  const plan = JSON.parse(readFileSync(join(root, ".release/plan.json"), "utf8"));
  assert.equal(plan.packages.length, 1, "Flat artifacts require exactly one release package");
  const item = plan.packages[0];
  assert.match(item.path, /^[a-z0-9-]+$/);
  const metadata = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.equal(metadata.name, item.name);
  assert.equal(metadata.version, item.to);
  assert.equal(metadata.filename, basename(metadata.filename));
  assert.equal(metadata.filename, `${item.name.replace(/^@/, "").replaceAll("/", "-")}-${item.to}.tgz`);
  const target = join(directory, `npm-${item.path}`);
  assert(!existsSync(target), "Refusing ambiguous flat and nested artifacts");
  mkdirSync(target);
  for (const file of [metadata.filename, "manifest.json"]) renameSync(join(directory, file), join(target, file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, value] = process.argv.slice(2);
  if (command === "normalize") normalizeArtifacts(value);
  else if (command === "retry") {
    assert.match(value, /^[1-9]\d*$/);
    const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
    const run = JSON.parse(gh("api", `repos/${repository}/actions/runs/${value}`));
    const pages = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${value}/jobs?per_page=100`));
    const sha = validateRetry(run, pages.flatMap(page => page.jobs));
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nrun_id=${value}\n`);
  } else throw new Error("Expected normalize or retry");
}
