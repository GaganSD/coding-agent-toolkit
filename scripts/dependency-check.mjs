// Dependency report for the tracking issue that replaces Dependabot pull
// requests. Version updates are disabled in .github/dependabot.yml, so this
// script turns the same signal into one issue instead of a stream of PRs.
//
// Usage: node scripts/dependency-check.mjs [output.md]
// Requires `npm-check-updates` (ncu) on PATH; the workflow installs it.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMain, root, run } from "./lib.mjs";

const workspaces = [".", "pi-ask", "pi-automode", "pi-slate", "pi-subagents", "pi-web-search"];
const workflowDir = join(root, ".github", "workflows");

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return 0;
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function parseUses(text) {
  const pins = new Map();
  for (const match of text.matchAll(/uses:\s+([^\s@]+)@([^\s#]+)/g)) {
    const [, slug, ref] = match;
    pins.set(slug, new Set([...(pins.get(slug) ?? []), ref]));
  }
  return pins;
}

function declaredVersions(workspace) {
  const manifest = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"));
  const versions = new Map();
  for (const section of ["peerDependencies", "optionalDependencies", "dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) versions.set(name, spec);
  }
  return versions;
}

function npmUpdates() {
  const updates = [];
  for (const workspace of workspaces) {
    const current = declaredVersions(workspace);
    let output;
    try {
      output = run("ncu", ["--jsonUpgraded", "--packageFile", join(root, workspace, "package.json")]);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("dependency-check requires npm-check-updates on PATH", { cause: error });
      throw error;
    }
    const upgraded = JSON.parse(output || "{}");
    for (const [name, latest] of Object.entries(upgraded).sort(([a], [b]) => a.localeCompare(b))) {
      updates.push({ workspace, name, current: current.get(name) ?? "unknown", latest });
    }
  }
  return updates;
}

async function github(pathname) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "coding-agent-toolkit-dependency-check" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${pathname} failed with ${response.status}`);
  return response.json();
}

async function actionUpdates() {
  const pins = new Map();
  for (const file of readdirSync(workflowDir).filter(name => name.endsWith(".yml"))) {
    for (const [slug, refs] of parseUses(readFileSync(join(workflowDir, file), "utf8"))) {
      pins.set(slug, new Set([...(pins.get(slug) ?? []), ...refs]));
    }
  }
  const updates = [];
  for (const [slug, refs] of [...pins].sort(([a], [b]) => a.localeCompare(b))) {
    const tags = await github(`/repos/${slug}/tags?per_page=100`) ?? [];
    const release = await github(`/repos/${slug}/releases/latest`);
    const latest = release?.tag_name ?? [...tags].map(tag => tag.name).filter(parseVersion).sort(compareVersions).pop();
    if (!latest) continue;
    for (const ref of refs) {
      const current = tags.find(tag => tag.commit?.sha === ref)?.name ?? (parseVersion(ref) ? ref : undefined);
      if (!current || compareVersions(current, latest) >= 0) continue;
      updates.push({ slug, current, latest, url: `https://github.com/${slug}/compare/${current}...${latest}` });
    }
  }
  return updates;
}

export function renderReport(npm, actions, today = new Date().toISOString().slice(0, 10)) {
  const lines = [
    "<!-- dependency-check -->",
    "# Dependency updates available",
    "",
    `Checked ${today}. Dependabot version updates are disabled for this repository, so this issue replaces its pull requests.`,
  ];
  if (actions.length) {
    lines.push("", "## GitHub Actions", "", "| Action | Current | Latest | Compare |", "| --- | --- | --- | --- |");
    for (const row of actions) {
      lines.push(`| [\`${row.slug}\`](https://github.com/${row.slug}) | \`${row.current}\` | \`${row.latest}\` | [diff](${row.url}) |`);
    }
    lines.push("");
  }
  if (npm.length) {
    lines.push("", "## npm", "");
    for (const workspace of workspaces) {
      const rows = npm.filter(row => row.workspace === workspace);
      if (!rows.length) continue;
      lines.push(`### \`${workspace === "." ? "root" : workspace}\``, "", "| Package | Current | Latest |", "| --- | --- | --- |");
      for (const row of rows) lines.push(`| \`${row.name}\` | \`${row.current}\` | \`${row.latest}\` |`);
      lines.push("");
    }
  }
  lines.push(
    "To apply an update: edit the manifest or workflow pin, refresh the lockfile with `npm install --prefix <workspace>`, and run the package checks.",
    "",
    "Re-enable Dependabot version updates by raising `open-pull-requests-limit` in `.github/dependabot.yml`.",
  );
  return lines.join("\n") + "\n";
}

async function main() {
  const output = process.argv[2] ?? join(root, ".artifacts", "dependency-check.md");
  const [npm, actions] = await Promise.all([npmUpdates(), actionUpdates()]);
  const hasUpdates = npm.length > 0 || actions.length > 0;
  if (hasUpdates) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderReport(npm, actions));
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `has_updates=${hasUpdates}\n`);
  process.stdout.write(`dependency-check: ${npm.length} npm updates, ${actions.length} action updates\n`);
}

if (isMain(import.meta.url)) await main();
