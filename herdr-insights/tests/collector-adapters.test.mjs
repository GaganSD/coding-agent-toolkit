import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, "..", "mods", "insights", "collector.mjs");
const fixtures = path.join(here, "fixtures");

async function env() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-adapters-"));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(home, { recursive: true });
  return { root, home, store };
}

function run(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collector, ...args], {
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

async function configure(context, sources, extra = {}, environment = {}) {
  const config = {
    profile: { name: "Test", handle: "@test", avatar: "" },
    palette: "blue",
    includeCache: true,
    weekStartsOn: 0,
    refreshSeconds: 60,
    sources,
    ...extra,
  };
  const result = await run(
    [
      "configure",
      "--store",
      context.store,
      "--home",
      context.home,
      "--config",
      JSON.stringify(config),
    ],
    environment,
  );
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function placeFixture(context, relative, fixture) {
  const target = path.join(context.home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(fixtures, fixture), target);
  return target;
}

function rowsByModel(snapshot) {
  return new Map(snapshot.rows.map((row) => [row.model, row]));
}

test("Pi adapter: native usage, cache, model switching, failed zero, dedup, durations", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  const snapshot = await configure(context, [
    {
      id: "pi",
      label: "Pi",
      adapter: "pi",
      enabled: true,
      roots: ["~/.pi/agent/sessions"],
    },
  ]);
  assert.equal(snapshot.rows.length, 2);
  const rows = rowsByModel(snapshot);
  const m1 = rows.get("m1");
  assert.deepEqual(m1.tokens, {
    input: 13,
    output: 9,
    cacheRead: 3,
    cacheWrite: 2,
    reasoning: 1,
    total: 27,
  });
  assert.equal(m1.messages, 3);
  assert.equal(m1.activeMs, 2000);
  assert.equal(m1.longestTaskMs, 2000);
  assert.equal(m1.session, "pi:pi-fixture");
  assert.equal(m1.harness, "pi");
  assert.equal(m1.provider, "p1");
  assert.equal(m1.project, "/repo/pi");
  assert.equal(m1.day, "2026-03-01");

  const m2 = rows.get("m2");
  assert.deepEqual(m2.tokens, {
    input: 4,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 10,
  });
  assert.equal(m2.messages, 1);
  assert.equal(m2.activeMs, 4000);
  assert.equal(m2.longestTaskMs, 4000);
  assert.equal(snapshot.stats.errors, 0);
  assert.equal(snapshot.sourceStats.pi.status, "ok");
  assert.deepEqual(snapshot.warnings, []);
});

test("Pi sub-agent transcript artifacts are counted with their own stable session", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".pi/agent/sessions/parent/subagent-artifacts/run_transcript.jsonl",
    "pi-subagent.jsonl",
  );
  const snapshot = await configure(context, [
    {
      id: "pi",
      label: "Pi",
      adapter: "pi",
      enabled: true,
      roots: ["~/.pi/agent/sessions"],
    },
  ]);
  assert.equal(snapshot.rows.length, 1);
  const row = snapshot.rows[0];
  assert.equal(row.session, "pi-sub:sub-run-1:0");
  assert.equal(row.provider, "sub-provider");
  assert.equal(row.model, "sub-model");
  assert.equal(row.project, "/repo/sub");
  assert.deepEqual(row.tokens, {
    input: 5,
    output: 2,
    cacheRead: 1,
    cacheWrite: 0,
    reasoning: 0,
    total: 8,
  });
  assert.equal(row.messages, 1);
  assert.equal(row.activeMs, 2000);
  assert.equal(row.longestTaskMs, 2000);
});

test("Claude adapter: revised duplicate ids use max fields, not double counts", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".claude/projects/repo/session.jsonl",
    "claude-session.jsonl",
  );
  const snapshot = await configure(context, [
    {
      id: "claude",
      label: "Claude Code",
      adapter: "claude",
      enabled: true,
      roots: ["~/.claude/projects"],
    },
  ]);
  assert.equal(snapshot.rows.length, 2);
  const rows = rowsByModel(snapshot);
  const cm1 = rows.get("cm1");
  assert.deepEqual(cm1.tokens, {
    input: 2,
    output: 7,
    cacheRead: 10,
    cacheWrite: 5,
    reasoning: 2,
    total: 24,
  });
  assert.equal(cm1.messages, 1);
  assert.equal(cm1.activeMs, 5000);
  assert.equal(cm1.longestTaskMs, 5000);
  assert.equal(cm1.provider, "unknown");
  assert.equal(cm1.session, "claude:claude-fixture");
  assert.equal(cm1.project, "/repo/claude");
  assert.equal(cm1.day, "2026-03-02");

  const cm2 = rows.get("cm2");
  assert.deepEqual(cm2.tokens, {
    input: 5,
    output: 4,
    cacheRead: 6,
    cacheWrite: 7,
    reasoning: 3,
    total: 22,
  });
  assert.equal(cm2.messages, 1);
  assert.equal(cm2.activeMs, 1000);
  assert.equal(cm2.longestTaskMs, 1000);
  assert.equal(snapshot.stats.errors, 0);
  assert.equal(snapshot.sourceStats.claude.status, "ok");
});

test("Codex modern adapter: token_usage_record wins over token_count, exact tasks, cache folded once", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".codex/sessions/2026/03/03/rollout-modern.jsonl",
    "codex-modern.jsonl",
  );
  const snapshot = await configure(context, [
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    },
  ]);
  assert.equal(snapshot.rows.length, 2);
  const rows = rowsByModel(snapshot);
  const first = rows.get("gpt-6.1");
  assert.deepEqual(first.tokens, {
    input: 20,
    output: 20,
    cacheRead: 80,
    cacheWrite: 0,
    reasoning: 5,
    total: 120,
  });
  assert.equal(first.messages, 1);
  assert.equal(first.activeMs, 3000);
  assert.equal(first.longestTaskMs, 3000);
  assert.equal(first.provider, "openai");
  assert.equal(first.session, "codex:codex-fixture");
  assert.equal(first.project, "/repo/codex");
  assert.equal(first.day, "2026-03-03");

  const second = rows.get("gpt-6.2");
  assert.deepEqual(second.tokens, {
    input: 35,
    output: 10,
    cacheRead: 10,
    cacheWrite: 5,
    reasoning: 2,
    total: 60,
  });
  assert.equal(second.messages, 1);
  assert.equal(second.activeMs, 4000);
  assert.equal(second.longestTaskMs, 4000);
  assert.equal(snapshot.stats.errors, 0);
});

test("Codex legacy adapter: cumulative totals become deltas, repeats and resets are safe", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".codex/sessions/legacy/rollout-legacy.jsonl",
    "codex-legacy.jsonl",
  );
  const snapshot = await configure(context, [
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    },
  ]);
  assert.equal(snapshot.rows.length, 1);
  const row = snapshot.rows[0];
  assert.equal(row.model, "legacy-model");
  assert.equal(row.provider, "openai");
  assert.deepEqual(row.tokens, {
    input: 340,
    output: 55,
    cacheRead: 110,
    cacheWrite: 0,
    reasoning: 0,
    total: 505,
  });
  assert.equal(row.messages, 4);
  assert.equal(row.activeMs, 1000);
  assert.equal(row.longestTaskMs, 1000);
  assert.equal(snapshot.stats.errors, 0);
});

test("Custom declarative mapping: role filter, max revisions, harness/provider/model, duration", async () => {
  const context = await env();
  await placeFixture(context, "logs/custom.jsonl", "custom.jsonl");
  const snapshot = await configure(context, [
    {
      id: "acme",
      label: "Acme CLI",
      adapter: "custom",
      enabled: true,
      roots: ["~/logs"],
      mapping: {
        session: "session.id",
        timestamp: "ts",
        messageId: "messageId",
        project: "cwd",
        provider: "vendor",
        model: "model",
        role: "actor",
        roles: ["assistant"],
        include: [{ path: "record", equals: "usage" }],
        usage: {
          input: "usage.in",
          output: "usage.out",
          cacheRead: "usage.cr",
          cacheWrite: "usage.cw",
          reasoning: "usage.think",
        },
        taskDurationMs: "dur",
        harness: "acme",
      },
    },
  ]);
  assert.equal(snapshot.rows.length, 1);
  const row = snapshot.rows[0];
  assert.deepEqual(row.tokens, {
    input: 10,
    output: 9,
    cacheRead: 3,
    cacheWrite: 2,
    reasoning: 2,
    total: 24,
  });
  assert.equal(row.messages, 1);
  assert.equal(row.session, "custom:acme:custom-fixture");
  assert.equal(row.harness, "acme");
  assert.equal(row.provider, "acme");
  assert.equal(row.model, "cm");
  assert.equal(row.project, "/repo/custom");
  assert.equal(row.activeMs, 2500);
  assert.equal(row.longestTaskMs, 2500);
  assert.equal(snapshot.config.sources[0].mapping.harness, "acme");
  assert.equal(snapshot.stats.errors, 0);
});

test("Snapshot rows never include transcript bodies", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  const snapshot = await configure(context, [
    {
      id: "pi",
      label: "Pi",
      adapter: "pi",
      enabled: true,
      roots: ["~/.pi/agent/sessions"],
    },
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("synthetic prompt"), false);
  assert.equal(serialized.includes("synthetic failure"), false);
  assert.equal(serialized.includes("content"), false);
  const storeText = await readFile(context.store, "utf8");
  assert.equal(storeText.includes("synthetic prompt"), false);
  assert.equal(storeText.includes("synthetic failure"), false);
});
