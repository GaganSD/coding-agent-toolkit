import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, "../../herdr-insights", "mods", "insights", "collector.mjs");
const scanModule = path.join(here, "../../herdr-insights", "mods", "insights", "core", "scan.mjs");
const fixtures = path.join(here, "fixtures");

function probeWithoutZstd(nodePath) {
  const result = spawnSync(
    nodePath,
    [
      "--input-type=module",
      "-e",
      'import * as zlib from "node:zlib"; if (typeof zlib.createZstdDecompress === "function") process.exit(1); console.log(process.version);',
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return `${nodePath} (${result.stdout.trim()})`;
}

function findNodeWithoutZstd() {
  const candidates = [
    process.env.INSIGHTS_TEST_NODE_WITHOUT_ZSTD,
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
    process.execPath,
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const found = probeWithoutZstd(candidate);
    if (found) return { path: candidate, label: found };
  }
  return null;
}

function run(nodePath, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [collector, ...args], {
      env: { ...process.env, TZ: "UTC", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function env() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-runtime-"));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(home, { recursive: true });
  return { root, home, store };
}

async function placeFixture(context, relative, fixture) {
  const target = path.join(context.home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(fixtures, fixture), target);
  return target;
}

test("scanner imports zstd as an optional namespace export", async () => {
  const source = await readFile(scanModule, "utf8");
  assert.match(source, /import \* as zlib from "node:zlib";/);
  assert.doesNotMatch(source, /import\s*\{[^}]*createZstdDecompress[^}]*\}\s*from\s*"node:zlib"/);
});

const missingZstdNode = findNodeWithoutZstd();
test(
  "plain JSONL still scans when the runtime has no zstd API",
  { skip: missingZstdNode ? false : "no Node runtime without zstd found" },
  async () => {
    const context = await env();
    const plain = await placeFixture(
      context,
      ".codex/sessions/a/rollout-plain.jsonl",
      "codex-legacy.jsonl",
    );
    await placeFixture(
      context,
      ".codex/sessions/b/rollout-compressed.jsonl.zst",
      "codex-modern.jsonl.zst",
    );
    const result = await run(missingZstdNode.path, [
      "configure",
      "--store",
      context.store,
      "--home",
      context.home,
      "--config",
      JSON.stringify({
        sources: [
          {
            id: "codex",
            label: "Codex",
            adapter: "codex",
            enabled: true,
            roots: ["~/.codex/sessions"],
          },
        ],
      }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.rows.length, 1);
    assert.deepEqual(snapshot.rows[0].tokens, {
      input: 340,
      output: 55,
      cacheRead: 110,
      cacheWrite: 0,
      reasoning: 0,
      total: 505,
    });
    assert.equal(snapshot.stats.files, 2);
    assert.equal(snapshot.stats.filesRead, 1);
    assert.equal(snapshot.stats.bytesRead, (await stat(plain)).size);
    assert.equal(snapshot.stats.errors, 1);
    assert.equal(
      snapshot.warnings.some(
        (warning) =>
          warning.includes("rollout-compressed.jsonl.zst") &&
          warning.includes("zstd") &&
          warning.includes("Node 22.15+"),
      ),
      true,
    );
  },
);

test(
  "compressed Codex JSONL scans when the zstd API is present",
  { skip: typeof zlib.createZstdDecompress === "function" ? false : "current Node has no zstd API" },
  async () => {
    const context = await env();
    const compressed = await placeFixture(
      context,
      ".codex/sessions/compressed/rollout.jsonl.zst",
      "codex-modern.jsonl.zst",
    );
    const result = await run(process.execPath, [
      "configure",
      "--store",
      context.store,
      "--home",
      context.home,
      "--config",
      JSON.stringify({
        sources: [
          {
            id: "codex",
            label: "Codex",
            adapter: "codex",
            enabled: true,
            roots: ["~/.codex/sessions"],
          },
        ],
      }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.rows.length, 2);
    assert.equal(snapshot.stats.errors, 0);
    assert.equal(snapshot.stats.filesRead, 1);
    assert.equal(snapshot.stats.bytesRead, (await stat(compressed)).size);
    const first = snapshot.rows.find((row) => row.model === "gpt-6.1");
    assert.deepEqual(first.tokens, {
      input: 20,
      output: 20,
      cacheRead: 80,
      cacheWrite: 0,
      reasoning: 5,
      total: 120,
    });
  },
);
