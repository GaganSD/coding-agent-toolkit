import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, "..", "mods", "insights", "collector.mjs");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collector, ...args], {
      env: { ...process.env, TZ: "UTC" },
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

function assistantMessage(id, overrides = {}) {
  return JSON.stringify({
    role: "assistant",
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 200, write: 20 } },
    modelID: "gpt-test",
    providerID: "openai",
    path: { cwd: "/repo/insights" },
    time: { created: 1790400000000, completed: 1790400005000 },
    ...overrides,
  });
}

async function env() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-opencode-"));
  const home = path.join(root, "home");
  const share = path.join(home, ".local", "share", "opencode");
  const store = path.join(root, "data", "insights.json");
  await mkdir(share, { recursive: true });
  const db = new DatabaseSync(path.join(share, "opencode.db"));
  db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  return { root, home, share, store, db };
}

async function snapshot(context) {
  const result = await run(["snapshot", "--store", context.store, "--home", context.home]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("OpenCode adapter reads assistant usage from the SQLite store", async () => {
  const context = await env();
  const insert = context.db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  insert.run("m-user", "ses-1", 1790399990000, JSON.stringify({ role: "user" }));
  insert.run("m-zero", "ses-1", 1790399995000, assistantMessage("m-zero", {
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }));
  insert.run("m-1", "ses-1", 1790400000000, assistantMessage("m-1"));
  insert.run("m-2", "ses-2", 1790400100000, assistantMessage("m-2", {
    modelID: "global.xai.grok-4.6",
    providerID: "bedrock-mantle",
    time: { created: 1790400100000, completed: 1790400100000 },
  }));
  context.db.close();

  const sources = [{ id: "opencode", label: "OpenCode", adapter: "opencode", enabled: true, roots: ["~/.local/share/opencode"] }];
  const configured = await run([
    "configure",
    "--store", context.store,
    "--home", context.home,
    "--config", JSON.stringify({ sources }),
  ]);
  assert.equal(configured.code, 0, configured.stderr);
  const first = JSON.parse(configured.stdout);

  const rows = first.rows.filter((row) => row.harness === "opencode");
  assert.equal(rows.length, 2, "one row per session/model bucket");
  const totals = rows.reduce((sum, row) => ({
    input: sum.input + row.tokens.input,
    output: sum.output + row.tokens.output,
    cacheRead: sum.cacheRead + row.tokens.cacheRead,
    cacheWrite: sum.cacheWrite + row.tokens.cacheWrite,
    reasoning: sum.reasoning + row.tokens.reasoning,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(totals, { input: 200, output: 80, cacheRead: 400, cacheWrite: 40, reasoning: 20 });
  const grok = rows.find((row) => row.model === "global.xai.grok-4.6");
  assert.equal(grok.provider, "bedrock-mantle");
  assert.equal(grok.project, "/repo/insights");
  assert.equal(rows.find((row) => row.session === "ses-1").longestTaskMs, 5000);
  assert.equal(first.stats.errors, 0);

  // A second run fingerprints the database and reads nothing again.
  const second = await snapshot(context);
  assert.equal(second.stats.unchangedFiles, 1);
  assert.equal(second.stats.filesRead, 0);

  // New assistant rows append usage without double counting the old ones.
  const db = new DatabaseSync(path.join(context.share, "opencode.db"));
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "m-3",
    "ses-1",
    1790400200000,
    assistantMessage("m-3", { tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
  );
  db.close();
  const third = await snapshot(context);
  const sesOne = third.rows.filter((row) => row.harness === "opencode" && row.session === "ses-1");
  const sesOneTotals = sesOne.reduce((sum, row) => sum + row.tokens.input + row.tokens.output, 0);
  assert.equal(sesOneTotals, 100 + 40 + 50 + 10);
  assert.equal(third.stats.filesRead, 1);
});

test("OpenCode malformed message rows report bounded warnings, including on unchanged scans", async (t) => {
  const context = await env();
  t.after(() => rm(context.root, { recursive: true, force: true }));
  const insert = context.db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  insert.run("valid", "ses", 1790400000000, assistantMessage("valid"));
  for (let index = 0; index < 100; index += 1) insert.run(`bad-${index}`, "ses", 1790400000000, "{SECRET_CORRUPT_ROW");
  context.db.close();
  const first = await snapshot(context);
  assert.equal(first.sourceStats.opencode.status, "error");
  assert.equal(first.sourceStats.opencode.errors, 1, "aggregate corrupt rows into one bounded warning");
  assert.match(first.warnings.join("\n"), /100 malformed message rows/);
  assert.equal(JSON.stringify(first).includes("SECRET_CORRUPT_ROW"), false);
  const warm = await snapshot(context);
  assert.equal(warm.stats.filesRead, 0);
  assert.equal(warm.sourceStats.opencode.status, "error", "cached malformed state must not become falsely healthy");
});

test("OpenCode adapter skips a missing database without errors", async () => {
  const context = await env();
  context.db.close();
  const sources = [{ id: "opencode", label: "OpenCode", adapter: "opencode", enabled: true, roots: ["~/.local/share/opencode"] }];
  const emptyShare = path.join(context.home, "elsewhere");
  await mkdir(emptyShare, { recursive: true });
  const configured = await run([
    "configure",
    "--store", context.store,
    "--home", context.home,
    "--config", JSON.stringify({ sources: [{ ...sources[0], roots: ["~/elsewhere"] }] }),
  ]);
  assert.equal(configured.code, 0, configured.stderr);
  const snapshot = JSON.parse(configured.stdout);
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.stats.errors, 0);
});
