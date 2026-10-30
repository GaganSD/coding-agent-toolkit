import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  defaultConfig,
  normalizeConfig,
} from "../../herdr-insights/mods/insights/core/config.mjs";
import { emptyStore, newFileEntry, saveStore } from "../../herdr-insights/mods/insights/core/store.mjs";
import { DEFAULT_SOURCES } from "../../herdr-insights/mods/insights/analytics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(here, "../../herdr-insights", "mods", "insights", "collector.mjs");
const fixtures = path.join(here, "fixtures");

async function env() {
  const root = await mkdtemp(path.join(tmpdir(), "insights-config-"));
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

async function configureRaw(context, config, environment = {}) {
  return run(
    [
      "configure",
      "--store",
      context.store,
      "--home",
      context.home,
      "--config",
      typeof config === "string" ? config : JSON.stringify(config),
    ],
    environment,
  );
}

async function configure(context, config, environment = {}) {
  const result = await configureRaw(context, config, environment);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function snapshot(context, extra = []) {
  const result = await run([
    "snapshot",
    "--store",
    context.store,
    "--home",
    context.home,
    ...extra,
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

const customSource = {
  id: "acme",
  label: "Acme",
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
};

test("configure rejects incomplete or invalid configs atomically", async () => {
  const context = await env();
  const invalidConfigs = [
    { refreshSeconds: 10 },
    { palette: "red" },
    {
      sources: [
        { id: "same", label: "A", adapter: "pi", enabled: true, roots: ["~/a"] },
        { id: "same", label: "B", adapter: "pi", enabled: true, roots: ["~/b"] },
      ],
    },
    {
      sources: [
        {
          id: "custom",
          label: "Custom",
          adapter: "custom",
          enabled: true,
          roots: ["~/logs"],
        },
      ],
    },
    {
      sources: [
        {
          id: "custom",
          label: "Custom",
          adapter: "custom",
          enabled: true,
          roots: ["~/logs"],
          mapping: {
            session: "session.id",
            timestamp: "ts",
            roles: ["assistant"],
            usage: { input: "usage.in" },
          },
        },
      ],
    },
    {
      profile: {
        name: "Unsafe",
        handle: "",
        avatar: "https://evil.example/avatar.png",
      },
    },
    {
      profile: { name: "Unsafe", handle: "", avatar: "/etc/passwd" },
    },
    {
      profile: { name: "Unsafe", handle: "", avatar: "../outside.png" },
    },
    {
      profile: { name: "Unsafe", handle: "", avatar: "mods/../../outside.png" },
    },
    { extra: true },
  ];
  for (const config of invalidConfigs) {
    const result = await configureRaw(context, config);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /invalid config/);
    await assert.rejects(access(context.store));
  }

  const badJson = await configureRaw(context, "{");
  assert.equal(badJson.code, 2);
  assert.match(badJson.stderr, /invalid --config/);

  const validConfig = {
    sources: [
      { id: "pi", label: "Pi", adapter: "pi", enabled: true, roots: ["~/a"] },
    ],
  };
  const valid = await configure(context, validConfig);
  assert.equal(valid.config.sources.length, 1);
  const before = await readFile(context.store, "utf8");
  const invalid = await configureRaw(context, { refreshSeconds: 30.5 });
  assert.equal(invalid.code, 2);
  const after = await readFile(context.store, "utf8");
  assert.equal(after, before);
});

test("profile-only configure stays incremental; source mapping changes invalidate and rescan", async () => {
  const context = await env();
  await placeFixture(context, "logs/custom.jsonl", "custom.jsonl");
  await mkdir(path.join(context.home, "empty"), { recursive: true });
  const firstConfig = {
    profile: { name: "One", handle: "@one", avatar: "" },
    sources: [customSource],
  };
  const first = await configure(context, firstConfig);
  assert.equal(first.rows[0].tokens.input, 10);
  const before = await stat(context.store, { bigint: true });

  const profileOnly = await configure(context, {
    ...firstConfig,
    profile: { name: "Two", handle: "@two", avatar: "" },
  });
  assert.equal(profileOnly.config.profile.name, "Two");
  assert.equal(profileOnly.rows[0].tokens.input, 10);
  assert.equal(profileOnly.stats.bytesRead, 0);
  const after = await stat(context.store, { bigint: true });
  assert.notEqual(after.mtimeNs, before.mtimeNs);

  const moved = await configure(context, {
    ...firstConfig,
    sources: [{ ...customSource, roots: ["~/empty"] }],
  });
  assert.equal(moved.rows.length, 0);
  assert.equal(moved.sourceStats.acme.status, "empty");
  assert.equal(moved.stats.bytesRead, 0);

  const restored = await configure(context, firstConfig);
  assert.equal(restored.rows[0].tokens.input, 10);

  const disabled = await configure(context, {
    ...firstConfig,
    sources: [{ ...customSource, enabled: false }],
  });
  assert.equal(disabled.rows.length, 0);
  assert.equal(disabled.sourceStats.acme.status, "disabled");

  const reenabled = await configure(context, firstConfig);
  assert.equal(reenabled.rows[0].tokens.input, 10);
});

test("corrupt stores are preserved, diagnosed, and replaced with a valid store", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  await mkdir(path.dirname(context.store), { recursive: true });
  const corrupt = '{"version":1,"files":';
  await writeFile(context.store, corrupt);
  const result = await snapshot(context);
  assert.ok(result.stats.errors >= 1);
  assert.ok(result.warnings.some((warning) => /corrupt/i.test(warning)));
  assert.ok(result.rows.some((row) => row.session === "pi:pi-fixture"));
  const entries = await readdir(path.dirname(context.store));
  const backup = entries.find((entry) => entry.includes(".corrupt-"));
  assert.ok(backup, `missing corrupt backup in ${entries.join(", ")}`);
  const backupText = await readFile(path.join(path.dirname(context.store), backup), "utf8");
  assert.equal(backupText, corrupt);
  const repaired = JSON.parse(await readFile(context.store, "utf8"));
  assert.equal(repaired.version, 1);
  assert.ok(result.warnings.some((warning) => warning.includes(backup)));
});

test("concurrent snapshots serialize on a safe lock and stale locks are reclaimed", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  await configure(context, {
    sources: [
      {
        id: "pi",
        label: "Pi",
        adapter: "pi",
        enabled: true,
        roots: ["~/.pi/agent/sessions"],
      },
    ],
  });

  const results = await Promise.all(
    Array.from({ length: 4 }, () => snapshot(context)),
  );
  for (const result of results) {
    assert.equal(result.stats.errors, 0);
    assert.equal(
      result.rows.reduce((sum, row) => sum + row.messages, 0),
      4,
    );
  }
  const store = JSON.parse(await readFile(context.store, "utf8"));
  assert.equal(store.version, 1);
  await assert.rejects(access(`${context.store}.lock`));

  await writeFile(
    `${context.store}.lock`,
    JSON.stringify({
      pid: 999_999_999,
      host: os.hostname(),
      startedAt: Date.now() - 1000,
      token: "stale-test",
    }),
  );
  const recovered = await snapshot(context);
  assert.equal(recovered.stats.errors, 0);
  await assert.rejects(access(`${context.store}.lock`));

  const baseSource = {
    id: "pi",
    label: "Pi",
    adapter: "pi",
    enabled: true,
    roots: ["~/.pi/agent/sessions"],
  };
  const writes = await Promise.all([
    configureRaw(context, {
      profile: { name: "A", handle: "@a", avatar: "" },
      sources: [baseSource],
    }),
    configureRaw(context, {
      profile: { name: "B", handle: "@b", avatar: "" },
      sources: [baseSource],
    }),
  ]);
  for (const write of writes) assert.equal(write.code, 0, write.stderr);
  const afterWrites = await snapshot(context);
  assert.ok(["A", "B"].includes(afterWrites.config.profile.name));
  assert.equal(
    afterWrites.rows.reduce((sum, row) => sum + row.messages, 0),
    4,
  );
});

test("sourceStats distinguishes disabled, missing, empty, ok, and error sources", async () => {
  const context = await env();
  await mkdir(path.join(context.home, "present"), { recursive: true });
  await placeFixture(context, "bad/x.jsonl", "pi-main.jsonl");
  const badPath = path.join(context.home, "bad", "x.jsonl");
  await writeFile(badPath, "this is not json\n");
  const result = await configure(context, {
    sources: [
      {
        id: "exist",
        label: "Existing empty",
        adapter: "pi",
        enabled: true,
        roots: ["~/present"],
      },
      {
        id: "gone",
        label: "Missing",
        adapter: "pi",
        enabled: true,
        roots: ["~/missing"],
      },
      {
        id: "off",
        label: "Off",
        adapter: "pi",
        enabled: false,
        roots: ["~/present"],
      },
      {
        id: "bad",
        label: "Bad",
        adapter: "pi",
        enabled: true,
        roots: ["~/bad"],
      },
    ],
  });
  assert.equal(result.sourceStats.exist.status, "empty");
  assert.equal(result.sourceStats.gone.status, "missing");
  assert.equal(result.sourceStats.off.status, "disabled");
  assert.equal(result.sourceStats.bad.status, "error");
  assert.ok(result.sourceStats.bad.errors >= 1);
  assert.equal(result.rows.length, 0);
  assert.ok(result.warnings.every((warning) => warning.startsWith("[")));
  assert.ok(result.warnings.some((warning) => warning.startsWith("[gone]")));
  assert.ok(result.warnings.some((warning) => warning.startsWith("[bad]")));
});

test("default config and empty input include Pi, Codex, OpenCode and Claude Code sources", () => {
  const expectedSources = [
    {
      id: "pi",
      label: "Pi",
      adapter: "pi",
      enabled: true,
      roots: ["~/.pi/agent/sessions"],
    },
    {
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions", "~/.codex/archived_sessions"],
    },
    {
      id: "opencode",
      label: "OpenCode",
      adapter: "opencode",
      enabled: true,
      roots: ["~/.local/share/opencode"],
    },
    {
      id: "claude",
      label: "Claude Code",
      adapter: "claude",
      enabled: true,
      roots: ["~/.claude/projects"],
    },
  ];
  assert.deepEqual(DEFAULT_CONFIG.sources, expectedSources);
  assert.deepEqual(defaultConfig().sources, expectedSources);
  assert.deepEqual(normalizeConfig({}).sources, expectedSources);
  assert.deepEqual(DEFAULT_SOURCES, expectedSources, "UI fallback defaults must not drift from collector defaults");
});

test("untouched pre-Claude default stores gain Claude Code and scan local sessions", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".claude/projects/repo/session.jsonl",
    "claude-session.jsonl",
  );
  const legacyDefaults = normalizeConfig({
    sources: [
      {
        id: "pi",
        label: "Pi",
        adapter: "pi",
        enabled: true,
        roots: ["~/.pi/agent/sessions"],
      },
      {
        id: "codex",
        label: "Codex",
        adapter: "codex",
        enabled: true,
        roots: ["~/.codex/sessions", "~/.codex/archived_sessions"],
      },
      {
        id: "opencode",
        label: "OpenCode",
        adapter: "opencode",
        enabled: true,
        roots: ["~/.local/share/opencode"],
      },
    ],
  });
  await saveStore(context.store, emptyStore(legacyDefaults));

  const result = await snapshot(context);
  assert.deepEqual(
    result.config.sources.map((source) => source.id),
    ["pi", "codex", "opencode", "claude"],
  );
  assert.equal(result.sourceStats.claude.status, "ok");
  assert.equal(result.rows.some((row) => row.harness === "claude"), true);

  const persisted = JSON.parse(await readFile(context.store, "utf8"));
  assert.equal(
    persisted.config.sources.some((source) => source.id === "claude"),
    true,
  );
});

test("configure with untouched legacy defaults keeps Claude and cached history", async () => {
  const context = await env();
  const legacyConfig = normalizeConfig({
    sources: DEFAULT_CONFIG.sources.slice(0, 3).map((source) => ({
      ...source,
      roots: [...source.roots],
    })),
  });
  const store = emptyStore(legacyConfig);
  const entry = newFileEntry(store, {
    sourceId: "pi",
    path: "/removed/pi-session.jsonl",
    adapter: "pi",
    size: 0,
    mtimeMs: 0,
  });
  entry.rows = [
    {
      day: "2026-03-01",
      session: "pi:removed",
      harness: "pi",
      provider: "openai",
      model: "gpt-old",
      project: "/repo/old",
      input: 7,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      messages: 1,
    },
  ];
  await saveStore(context.store, store);

  const result = await configure(context, { sources: legacyConfig.sources });
  assert.deepEqual(
    result.config.sources.map((source) => source.id),
    ["pi", "codex", "opencode", "claude"],
  );
  assert.equal(
    result.rows.some((row) => row.session === "pi:removed" && row.model === "gpt-old"),
    true,
    "legacy-default configure must not undo the migration and clear cached rows",
  );
});

test("customized pre-Claude stores are not rewritten by the default-source migration", async () => {
  const context = await env();
  const customDefaults = normalizeConfig({
    sources: [
      {
        id: "pi",
        label: "Pi",
        adapter: "pi",
        enabled: true,
        roots: ["~/.pi/agent/sessions"],
      },
    ],
  });
  await saveStore(context.store, emptyStore(customDefaults));
  const result = await snapshot(context);
  assert.deepEqual(
    result.config.sources.map((source) => source.id),
    ["pi"],
  );
});

test("explicit Claude source config is preserved", async () => {
  const context = await env();
  const legacySources = [
    {
      id: "claude",
      label: "Claude Code",
      adapter: "claude",
      enabled: true,
      roots: ["~/.claude/projects"],
    },
  ];
  assert.deepEqual(normalizeConfig({ sources: legacySources }).sources, legacySources);

  const configured = await configure(context, { sources: legacySources });
  assert.deepEqual(configured.config.sources, legacySources);
  const persisted = await snapshot(context);
  assert.deepEqual(persisted.config.sources, legacySources);
});

test("default config source order and shape round-trip through configure", async () => {
  const context = await env();
  await placeFixture(
    context,
    ".pi/agent/sessions/fixture/session.jsonl",
    "pi-main.jsonl",
  );
  const config = {
    profile: { name: "Dev", handle: "@dev", avatar: "data/insights/avatar.png" },
    palette: "purple",
    includeCache: false,
    weekStartsOn: 1,
    refreshSeconds: 120,
    sources: [
      {
        id: "pi",
        label: "Pi",
        adapter: "pi",
        enabled: true,
        roots: ["~/.pi/agent/sessions"],
      },
    ],
  };
  const result = await configure(context, config);
  assert.deepEqual(result.config.profile, config.profile);
  assert.equal(result.config.palette, "purple");
  assert.equal(result.config.includeCache, false);
  assert.equal(result.config.weekStartsOn, 1);
  assert.equal(result.config.refreshSeconds, 120);
  const m1 = result.rows.find((row) => row.model === "m1");
  assert.equal(m1.tokens.cacheRead, 3);
  assert.equal(m1.tokens.cacheWrite, 2);
  assert.equal(m1.tokens.total, 27);
  const second = await snapshot(context);
  assert.deepEqual(second.config, result.config);
  const storeInfo = await stat(context.store);
  assert.equal(storeInfo.mode & 0o777, 0o600);
});
