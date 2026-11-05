import { appendFileSync } from "node:fs";
import { packages } from "./packages.mjs";
import { git, isMain } from "./lib.mjs";
import { planPath, validatePlan } from "./release.mjs";

const packageNames = Object.keys(packages);
const packageTooling = new Set([
  "package-lock.json", "eslint.config.mjs", "scripts/packages.mjs",
  "scripts/lib.mjs", "scripts/test-package.mjs", "scripts/package.mjs",
  "scripts/artifact-smoke.mjs", "scripts/release.mjs",
]);

// Ownership, not directory depth, determines which checks consume a change.
// Unknown paths conservatively select full validation, never no checks.
export function affectedChecks(files, { releasePackages } = {}) {
  const selected = new Set();
  let insights = false, tooling = false, quickstart = false;
  const unknown = [];
  const allPackages = () => { packageNames.forEach(name => selected.add(name)); };
  const all = () => { allPackages(); insights = tooling = quickstart = true; };
  for (const file of files) {
    const owner = packageNames.find(name => file.startsWith(name + "/"));
    if (owner) {
      selected.add(owner);
      quickstart = true;
    } else if (/^(herdr-insights|tests\/herdr-insights|scripts\/herdr-insights)\//.test(file)
      || file === "docs/herdr-insights-development.md") {
      insights = true;
      // These scripts are also linted by the tooling job.
      if (file.startsWith("scripts/")) tooling = true;
    } else if (file === "package.json" || file === "scripts/ci.mjs"
      || file === "scripts/tests/ci.test.mjs" || file.startsWith(".github/workflows/")) {
      all();
    } else if (packageTooling.has(file)) {
      allPackages();
      tooling = quickstart = true;
    } else if (file === planPath) {
      // Release validation runs separately on every change. A missing plan
      // context (e.g. a caller doing path-only analysis) must not omit artifacts.
      if (releasePackages === undefined) allPackages();
      else for (const name of releasePackages) {
        if (!Object.hasOwn(packages, name)) throw new Error(`Unknown release package: ${name}`);
        selected.add(name);
      }
      quickstart = true;
    } else if (file === "scripts/quickstart-ci.mjs" || file === "scripts/tests/quickstart-ci.test.mjs") {
      tooling = quickstart = true;
    } else if (file.startsWith("scripts/tests/") || [
      "scripts/dependency-check.mjs", "scripts/tokens.mjs", "scripts/install-gitleaks.sh",
      "scripts/secret-scan.sh", "scripts/install-hooks.sh", ".gitleaks.toml", ".githooks/pre-commit",
    ].includes(file)) {
      tooling = true;
    } else if (/^(?:(?:README\.md|LICENSE|llms\.txt)$|(?:docs|reports)\/)/.test(file)
      || [".github/CODEOWNERS", ".github/dependabot.yml", ".github/pull_request_template.md"].includes(file)
      || file.startsWith(".github/ISSUE_TEMPLATE/")) {
      // Documentation and repository metadata have no package consumers.
    } else {
      unknown.push(file);
      all();
    }
  }
  return { packages: packageNames.filter(name => selected.has(name)), insights, tooling, quickstart, unknown };
}

export function affectedPackages(files) {
  return affectedChecks(files).packages;
}

// One combined leg per package keeps check names and the release gate simple.
export function ciMatrix(paths) {
  return paths.map(name => ({ package: name }));
}

export function detectChecks(base, head, gitCommand = git) {
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("Expected a full head SHA");
  if (!base || /^0+$/.test(base)) {
    return { packages: packageNames, insights: true, tooling: true, quickstart: true, unknown: [] };
  }
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Expected a full base SHA");
  // --no-renames reports both sides of moves, including moves across owners.
  const files = gitCommand("diff", "--name-only", "-z", "--no-renames", base, head).split("\0").filter(Boolean);
  let releasePackages;
  if (files.includes(planPath)) {
    // A deleted plan can be an exact release cancellation: use its old owners.
    const ref = gitCommand("ls-tree", "--name-only", head, "--", planPath) ? head : base;
    const plan = validatePlan(JSON.parse(gitCommand("show", `${ref}:${planPath}`)));
    releasePackages = plan.packages.map(item => item.path);
  }
  return affectedChecks(files, { releasePackages });
}

export function checkOutputs(checks) {
  return Object.entries({
    has_packages: checks.packages.length > 0,
    matrix: JSON.stringify({ include: ciMatrix(checks.packages) }),
    run_insights: checks.insights,
    run_tooling: checks.tooling,
    run_quickstart: checks.quickstart,
  }).map(([key, value]) => `${key}=${value}\n`).join("");
}

if (isMain(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  const checks = detectChecks(base, head);
  const output = checkOutputs(checks);
  process.stdout.write(output);
  if (checks.unknown.length) console.warn(`Full validation for unclassified paths: ${JSON.stringify(checks.unknown)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Selected checks\n\nPackages: ${checks.packages.join(", ") || "none"}\n\n`
    + `Herdr: ${checks.insights}; tooling: ${checks.tooling}; post-main quickstart: ${checks.quickstart}\n\n`
    + `Unclassified paths (full validation): ${JSON.stringify(checks.unknown)}\n`);
}
