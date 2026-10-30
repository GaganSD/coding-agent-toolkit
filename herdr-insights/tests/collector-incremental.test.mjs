import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, "..", "mods", "insights", "collector.mjs");
const fixtures = path.join(here, "fixtures");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function env() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-incremental-"));
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

async function configure(context, sources, environment = {}) {
  const result = await run(
    [
      "configure",
      "--store",
      context.store,
      "--home",
      context.home,
      "--config",
      JSON.stringify({ sources }),
    ],
    environment,
  );
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function snapshot(context, extra = [], environment = {}) {
  const result = await run(
    ["snapshot", "--store", context.store, "--home", context.home, ...extra],
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

const piSource = [
  {
    id: "pi",
    label: "Pi",
    adapter: "pi",
    enabled: true,
    roots: ["~/.pi/agent/sessions"],
  },
];

function tinyPi(sessionId, input, timestamp = "2026-04-01T10:00:00Z", cwd = "/repo/tiny") {
  return (
    JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp,
      cwd,
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

test("unchanged snapshots do not rewrite the store; append, restart cache, and partial tails are safe", async () => {
  const context = await env();
  const file = await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  const first = await configure(context, piSource);
  assert.equal(first.rows.reduce((sum, row) => sum + row.messages, 0), 4);
  const before = await stat(context.store, { bigint: true });
  await sleep(20);
  const second = await snapshot(context);
  const after = await stat(context.store, { bigint: true });
  assert.equal(second.stats.filesRead, 0);
  assert.equal(second.stats.bytesRead, 0);
  assert.equal(second.stats.unchangedFiles, 1);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.size, before.size);

  const appended = [
    JSON.stringify({
      type: "message",
      id: "new-user",
      timestamp: "2026-03-01T23:30:10Z",
      message: { role: "user", content: "append prompt" },
    }),
    JSON.stringify({
      type: "message",
      id: "new-assistant",
      timestamp: "2026-03-01T23:30:12Z",
      message: {
        role: "assistant",
        model: "m1",
        provider: "p1",
        usage: {
          input: 2,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 4,
        },
        stopReason: "stop",
        content: [],
      },
    }),
  ].join("\n") + "\n";
  await appendFile(file, appended);
  const third = await snapshot(context);
  assert.equal(third.stats.filesRead, 1);
  assert.equal(third.stats.bytesRead, Buffer.byteLength(appended));
  const m1 = third.rows.find((row) => row.model === "m1");
  assert.equal(m1.messages, 4);
  assert.deepEqual(m1.tokens, {
    input: 15,
    output: 11,
    cacheRead: 3,
    cacheWrite: 2,
    reasoning: 1,
    total: 31,
  });
  assert.equal(m1.activeMs, 4000);

  const fourth = await snapshot(context);
  assert.equal(fourth.stats.bytesRead, 0);

  const fullLine = JSON.stringify({
    type: "message",
    id: "partial-assistant",
    timestamp: "2026-03-01T23:30:20Z",
    message: {
      role: "assistant",
      model: "m1",
      provider: "p1",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 2,
      },
      stopReason: "stop",
      content: [{ type: "text", text: "SECRET_PARTIAL" }],
    },
  });
  const cut = Math.floor(fullLine.length / 2);
  await appendFile(file, fullLine.slice(0, cut));
  const fifth = await snapshot(context);
  assert.equal(fifth.stats.filesRead, 1);
  assert.equal(fifth.stats.bytesRead, Buffer.byteLength(fullLine.slice(0, cut)));
  assert.equal(fifth.rows.find((row) => row.model === "m1").messages, 4);
  assert.equal((await readFile(context.store, "utf8")).includes("SECRET_PARTIAL"), false);

  const sixth = await snapshot(context);
  assert.equal(sixth.stats.bytesRead, 0);
  assert.equal(sixth.rows.find((row) => row.model === "m1").messages, 4);

  await appendFile(file, `${fullLine.slice(cut)}\n`);
  const seventh = await snapshot(context);
  assert.equal(seventh.stats.errors, 0);
  assert.equal(seventh.stats.bytesRead, Buffer.byteLength(fullLine) + 1);
  assert.equal(seventh.rows.find((row) => row.model === "m1").messages, 5);
  assert.equal((await readFile(context.store, "utf8")).includes("SECRET_PARTIAL"), false);
});

test("truncation and inode replacement reset the file contribution instead of duplicating", async () => {
  const context = await env();
  const file = path.join(context.home, ".pi", "agent", "sessions", "x", "session.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, tinyPi("old", 100));
  const first = await configure(context, piSource);
  assert.equal(first.rows[0].tokens.input, 100);

  const smaller = tinyPi("new", 7);
  assert.ok(Buffer.byteLength(smaller) < Buffer.byteLength(tinyPi("old", 100)));
  await writeFile(file, smaller);
  const truncated = await snapshot(context);
  assert.equal(truncated.rows.length, 1);
  assert.equal(truncated.rows[0].session, "pi:new");
  assert.equal(truncated.rows[0].tokens.input, 7);
  assert.equal(truncated.rows.some((row) => row.session === "pi:old"), false);

  const replacement = path.join(context.home, ".pi", "agent", "sessions", "x", "replacement");
  await copyFile(path.join(fixtures, "pi-main.jsonl"), replacement);
  await rename(replacement, file);
  const inodeReset = await snapshot(context);
  assert.equal(inodeReset.rows.length, 2);
  assert.equal(inodeReset.rows.some((row) => row.session === "pi:pi-fixture"), true);
  assert.equal(inodeReset.rows.some((row) => row.session === "pi:new"), false);
  assert.equal(inodeReset.stats.errors, 0);
});

test("copied/forked session files dedup globally for usage and task durations", async () => {
  const context = await env();
  await placeFixture(context, ".pi/agent/sessions/a/session.jsonl", "pi-main.jsonl");
  await placeFixture(context, ".pi/agent/sessions/b/session.jsonl", "pi-main.jsonl");
  await placeFixture(context, ".claude/projects/a/session.jsonl", "claude-session.jsonl");
  await placeFixture(context, ".claude/projects/b/session.jsonl", "claude-session.jsonl");
  await placeFixture(context, ".codex/sessions/a/session.jsonl", "codex-modern.jsonl");
  await placeFixture(context, ".codex/sessions/b/session.jsonl", "codex-modern.jsonl");
  const result = await configure(context, [
    ...piSource,
    {
      id: "claude",
      label: "Claude Code",
      adapter: "claude",
      enabled: true,
      roots: ["~/.claude/projects"],
    },
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    },
  ]);
  assert.equal(result.stats.files, 6);
  const messages = (harness, model) =>
    result.rows
      .filter((row) => row.harness === harness && row.model === model)
      .reduce((sum, row) => sum + row.messages, 0);
  assert.equal(messages("pi", "m1"), 3);
  assert.equal(messages("pi", "m2"), 1);
  assert.equal(messages("claude", "cm1"), 1);
  assert.equal(messages("claude", "cm2"), 1);
  assert.equal(messages("codex", "gpt-6.1"), 1);
  assert.equal(messages("codex", "gpt-6.2"), 1);
  const piM1 = result.rows.find((row) => row.harness === "pi" && row.model === "m1");
  const piM2 = result.rows.find((row) => row.harness === "pi" && row.model === "m2");
  assert.equal(piM1.activeMs, 2000);
  assert.equal(piM2.activeMs, 4000);
  const cm1 = result.rows.find((row) => row.harness === "claude" && row.model === "cm1");
  assert.equal(cm1.activeMs, 5000);
  const firstCodex = result.rows.find(
    (row) => row.harness === "codex" && row.model === "gpt-6.1",
  );
  assert.equal(firstCodex.activeMs, 3000);
});

test("Codex legacy cumulative state survives restarts and appends use only the delta", async () => {
  const context = await env();
  const file = await placeFixture(
    context,
    ".codex/sessions/legacy/session.jsonl",
    "codex-legacy.jsonl",
  );
  const first = await configure(context, [
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    },
  ]);
  assert.equal(first.rows[0].tokens.total, 505);
  assert.equal(first.rows[0].messages, 4);

  const appended = [
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-03-03T03:00:08Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-03-03T03:00:09Z",
      payload: {
        type: "task_complete",
        turn_id: "legacy-turn-2",
        duration_ms: 2000,
        started_at: 1770000110,
        completed_at: 1770000112,
      },
    }),
  ].join("\n") + "\n";
  await appendFile(file, appended);
  const second = await snapshot(context);
  assert.equal(second.stats.errors, 0);
  const row = second.rows[0];
  assert.deepEqual(row.tokens, {
    input: 340 + 40,
    output: 55 + 5,
    cacheRead: 110 + 10,
    cacheWrite: 0,
    reasoning: 0,
    total: 505 + 55,
  });
  assert.equal(row.messages, 5);
  assert.equal(row.activeMs, 3000);
  assert.equal(row.longestTaskMs, 2000);
});

test("Codex mixed upgrade keeps the legacy prefix and appends without double counting", async () => {
  const context = await env();
  const file = path.join(
    context.home,
    ".codex",
    "sessions",
    "mixed",
    "session.jsonl",
  );
  await mkdir(path.dirname(file), { recursive: true });
  const line = (value) => `${JSON.stringify(value)}\n`;
  const prefix = [
    {
      type: "session_meta",
      timestamp: "2026-03-05T05:00:00Z",
      payload: { id: "codex-mixed-incremental", cwd: "/repo/mixed", model_provider: "openai" },
    },
    {
      type: "turn_context",
      timestamp: "2026-03-05T05:00:01Z",
      payload: { turn_id: "legacy-1", model: "legacy-model", cwd: "/repo/mixed" },
    },
    {
      type: "event_msg",
      timestamp: "2026-03-05T05:00:02Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-03-05T05:00:03Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 20,
            cache_write_input_tokens: 0,
            output_tokens: 15,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
  ].map(line).join("");
  await writeFile(file, prefix);

  const codexSource = [
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    },
  ];
  const first = await configure(context, codexSource);
  assert.deepEqual(first.rows[0].tokens, {
    input: 130,
    output: 15,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: 0,
    total: 165,
  });

  const appended = [
    {
      type: "turn_context",
      timestamp: "2026-03-05T05:00:04Z",
      payload: { turn_id: "modern-1", model: "modern-model", cwd: "/repo/mixed" },
    },
    {
      type: "event_msg",
      timestamp: "2026-03-05T05:00:05Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            cache_write_input_tokens: 0,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
          total_token_usage: {
            input_tokens: 250,
            cached_input_tokens: 40,
            cache_write_input_tokens: 0,
            output_tokens: 35,
            reasoning_output_tokens: 5,
          },
        },
      },
    },
    {
      type: "token_usage_record",
      timestamp: "2026-03-05T05:00:06Z",
      payload: {
        response_id: "mixed-resp-1",
        turn_id: "modern-1",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          cache_write_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      },
    },
    {
      type: "turn_context",
      timestamp: "2026-03-05T05:00:07Z",
      payload: { turn_id: "suffix-1", model: "suffix-model", cwd: "/repo/mixed" },
    },
    {
      type: "event_msg",
      timestamp: "2026-03-05T05:00:08Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 280,
            cached_input_tokens: 40,
            cache_write_input_tokens: 0,
            output_tokens: 41,
            reasoning_output_tokens: 5,
          },
        },
      },
    },
  ].map(line).join("");
  await appendFile(file, appended);
  const second = await snapshot(context);
  assert.equal(second.stats.bytesRead, Buffer.byteLength(appended));
  assert.equal(second.rows.length, 3);
  const byModel = new Map(second.rows.map((row) => [row.model, row]));
  assert.deepEqual(byModel.get("legacy-model").tokens, {
    input: 130,
    output: 15,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: 0,
    total: 165,
  });
  assert.deepEqual(byModel.get("modern-model").tokens, {
    input: 80,
    output: 20,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: 5,
    total: 120,
  });
  assert.equal(byModel.get("modern-model").messages, 1);
  assert.deepEqual(byModel.get("suffix-model").tokens, {
    input: 30,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 36,
  });

  const third = await snapshot(context);
  assert.equal(third.stats.bytesRead, 0);
  assert.deepEqual(third.rows, second.rows);
});

test("old file-level Codex modern state is rescanned once to recover the prefix", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".codex/sessions/mixed/rollout-mixed.jsonl",
    "codex-mixed.jsonl",
  );
  const codexSource = [
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    },
  ];
  await configure(context, codexSource);

  const store = JSON.parse(await readFile(context.store, "utf8"));
  const entry = Object.values(store.files)[0];
  entry.rows = [];
  entry.tasks = [];
  entry.state = { modern: true };
  store.dedup = {};
  store.tasks = {};
  await writeFile(context.store, JSON.stringify(store));

  const migrated = await snapshot(context);
  assert.equal(migrated.stats.errors, 0);
  assert.equal(migrated.rows.length, 5);
  assert.equal(
    migrated.rows.find((row) => row.model === "legacy-model").messages,
    2,
  );

  const stable = await snapshot(context);
  assert.equal(stable.stats.bytesRead, 0);
  assert.deepEqual(stable.rows, migrated.rows);
});

test("removed transcript history is retained until an explicit rebuild", async () => {
  const context = await env();
  const file = await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  await configure(context, piSource);
  await rm(file);
  const removed = await snapshot(context);
  assert.equal(removed.stats.files, 0);
  assert.equal(removed.sourceStats.pi.status, "empty");
  assert.equal(removed.rows.length, 2);
  assert.equal(removed.rows.reduce((sum, row) => sum + row.messages, 0), 4);

  const rebuilt = await snapshot(context, ["--rebuild"]);
  assert.equal(rebuilt.stats.files, 0);
  assert.equal(rebuilt.rows.length, 0);
});

test("overlapping roots do not scan the same file twice", async () => {
  const context = await env();
  await placeFixture(context, "root/sub/session.jsonl", "pi-main.jsonl");
  const result = await configure(context, [
    {
      id: "pi",
      label: "Pi",
      adapter: "pi",
      enabled: true,
      roots: ["~/root", "~/root/sub"],
    },
  ]);
  assert.equal(result.stats.files, 1);
  assert.equal(result.rows.reduce((sum, row) => sum + row.messages, 0), 4);
});

test("day is local, not UTC", async () => {
  const context = await env();
  const file = path.join(context.home, ".pi", "agent", "sessions", "tz", "session.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      type: "session",
      id: "tz-session",
      timestamp: "2026-01-02T01:00:00Z",
      cwd: "/repo/tz",
    }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "tz-user",
        timestamp: "2026-01-02T01:00:00Z",
        message: { role: "user", content: "prompt" },
      }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "tz-assistant",
        timestamp: "2026-01-02T01:00:01Z",
        message: {
          role: "assistant",
          model: "tz-model",
          provider: "tz-provider",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 2,
          },
          stopReason: "stop",
          content: [],
        },
      }) +
      "\n",
  );
  const result = await configure(context, piSource, {
    TZ: "America/Los_Angeles",
  });
  assert.equal(result.rows[0].day, "2026-01-01");
});
