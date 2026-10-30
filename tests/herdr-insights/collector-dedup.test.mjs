import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, "../../herdr-insights", "mods", "insights", "collector.mjs");
const fixtures = path.join(here, "fixtures");

async function env() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-dedup-"));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(home, { recursive: true });
  return { root, home, store };
}

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

async function configure(context, sources) {
  const result = await run([
    "configure",
    "--store",
    context.store,
    "--home",
    context.home,
    "--config",
    JSON.stringify({ sources }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function snapshot(context) {
  const result = await run([
    "snapshot",
    "--store",
    context.store,
    "--home",
    context.home,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function placeFixture(context, relative, fixture) {
  const target = path.join(context.home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(fixtures, fixture), target);
  return target;
}

const piSource = [
  {
    id: "pi",
    label: "Pi",
    adapter: "pi",
    enabled: true,
    roots: ["~/.pi/agent/sessions"],
  },
];

function tinyPi(sessionId, input) {
  const timestamp = "2026-04-01T10:00:00Z";
  return (
    JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp,
      cwd: "/repo/tiny",
    }) +
    "\n" +
    JSON.stringify({
      type: "message",
      id: "user-1",
      timestamp,
      message: { role: "user", content: "prompt", timestamp },
    }) +
    "\n" +
    JSON.stringify({
      type: "message",
      id: "asst-1",
      timestamp,
      message: {
        role: "assistant",
        model: "tiny-model",
        provider: "tiny-provider",
        usage: {
          input,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: input + 1,
        },
        stopReason: "stop",
        content: [],
      },
    }) +
    "\n"
  );
}

test("copy ownership survives when the dedup owner file is truncated", async () => {
  const context = await env();
  const owner = await placeFixture(
    context,
    ".pi/agent/sessions/a/session.jsonl",
    "pi-main.jsonl",
  );
  await placeFixture(context, ".pi/agent/sessions/b/session.jsonl", "pi-main.jsonl");
  const first = await configure(context, piSource);
  assert.equal(first.rows.reduce((sum, row) => sum + row.messages, 0), 4);

  await writeFile(owner, "");
  const truncated = await snapshot(context);
  assert.equal(truncated.stats.errors, 0);
  assert.equal(truncated.rows.length, 2);
  assert.deepEqual(truncated.rows, first.rows);

  await writeFile(owner, tinyPi("replacement", 7));
  const replaced = await snapshot(context);
  assert.equal(replaced.rows.length, 3);
  const original = replaced.rows.find((row) => row.session === "pi:pi-fixture");
  assert.equal(original.messages, 3);
  assert.equal(original.activeMs, 2000);
  const replacement = replaced.rows.find((row) => row.session === "pi:replacement");
  assert.equal(replacement.tokens.input, 7);
});
