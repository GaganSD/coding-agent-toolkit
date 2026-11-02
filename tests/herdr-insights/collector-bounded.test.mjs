import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";
import { normalizeConfig } from "../../herdr-insights/mods/insights/core/config.mjs";
import { scanSources } from "../../herdr-insights/mods/insights/core/scan.mjs";
import { emptyStore, snapshotRows } from "../../herdr-insights/mods/insights/core/store.mjs";

const piSource = [{
  id: "pi",
  label: "Pi",
  adapter: "pi",
  enabled: true,
  roots: ["~/.pi/agent/sessions"],
}];

function piSession(sessionId, input, timestamp = "2026-04-01T10:00:00Z") {
  return [
    JSON.stringify({ type: "session", id: sessionId, timestamp, cwd: "/repo/bounded" }),
    JSON.stringify({
      type: "message",
      id: `user-${sessionId}`,
      timestamp,
      message: { role: "user", content: "prompt" },
    }),
    JSON.stringify({
      type: "message",
      id: `assistant-${sessionId}`,
      timestamp,
      message: {
        role: "assistant",
        model: "bounded-model",
        provider: "bounded-provider",
        usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        stopReason: "stop",
        content: [],
      },
    }),
  ].map((line) => `${line}\n`).join("");
}

async function context(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(root, "home");
  const store = path.join(root, "data", "insights.json");
  await mkdir(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
  return { root, home, store };
}

function sourceConfig() {
  return { sources: piSource };
}

test("tiny deterministic budgets converge to the one-shot oracle without retries", async () => {
  const bounded = await context("insights-bounded-");
  for (let index = 0; index < 7; index += 1) {
    await writeFile(
      path.join(bounded.home, ".pi", "agent", "sessions", `s${index}.jsonl`),
      piSession(`s${index}`, index + 1),
    );
  }
  const oracleStore = path.join(bounded.root, "oracle", "insights.json");
  const oracle = await collectSnapshot("configure", {
    store: oracleStore,
    home: bounded.home,
    config: sourceConfig(),
  });
  assert.equal(oracle.scan.status, "complete");

  let tick = Date.now();
  const fastClock = () => {
    tick += 1_000;
    return tick;
  };
  const first = await collectSnapshot("configure", {
    store: bounded.store,
    home: bounded.home,
    config: sourceConfig(),
    budgetMs: 1,
    now: fastClock,
  });
  assert.equal(first.scan.status, "partial", "the first slice is bounded");

  const statuses = [first.scan.status];
  let snapshot = first;
  for (let attempt = 0; attempt < 30 && snapshot.scan.status !== "complete"; attempt += 1) {
    snapshot = await collectSnapshot("snapshot", {
      store: bounded.store,
      home: bounded.home,
      budgetMs: 1,
      now: fastClock,
    });
    statuses.push(snapshot.scan.status);
  }
  assert.equal(snapshot.scan.status, "complete");
  assert.ok(statuses.length > 2, `expected several bounded slices, got ${statuses.join(",")}`);
  assert.deepEqual(snapshot.rows, oracle.rows);
  assert.equal(snapshot.scan.pendingFile, null);
  assert.equal(snapshot.stats.errors, 0);

  const saved = JSON.parse(await readFile(bounded.store, "utf8"));
  assert.equal(saved.scan.status, "complete");
  assert.equal(typeof saved.lastCompletedScanAt, "string");
  assert.equal(saved.scan.pendingFile, null);
});

test("plain JSONL continuation reads only the unfinished tail and is not fingerprinted as complete", async () => {
  const contextInfo = await context("insights-plain-tail-");
  const file = path.join(contextInfo.home, ".pi", "agent", "sessions", "big.jsonl");
  const filler = JSON.stringify({ type: "event", payload: "x".repeat(1024) });
  const lines = [piSession("plain-tail", 5)];
  for (let index = 0; index < 2_400; index += 1) lines.push(`${filler}\n`);
  await writeFile(file, lines.join(""));
  const totalSize = (await stat(file)).size;
  assert.ok(totalSize > 2_000_000, "fixture must exceed one read chunk");

  const store = emptyStore(normalizeConfig(sourceConfig()));
  const first = await scanSources(store, {
    home: contextInfo.home,
    deadline: Date.now(),
    now: Date.now,
  });
  assert.equal(first.complete, false);
  assert.equal(first.stopped, true);
  const entry = Object.values(store.files)[0];
  assert.ok(entry.offset > 0 && entry.offset < totalSize, "offset advanced inside the file");
  assert.equal(entry.state.scanPending, true, "unfinished tail is not marked complete");
  assert.notEqual(entry.size, totalSize, "an unfinished tail must not match the file fingerprint");
  assert.equal(snapshotRows(store)[0].messages, 1, "accepted prefix contributes exactly once");
  const accepted = entry.offset;

  const second = await scanSources(store, { home: contextInfo.home });
  assert.equal(second.complete, true);
  assert.equal(second.stats.bytesRead, totalSize - accepted, "only the unfinished tail is read");
  assert.equal(second.stats.filesRead, 1);
  assert.equal(entry.offset, totalSize);
  assert.equal(entry.size, totalSize);
  assert.equal(entry.state.scanPending, undefined);
  assert.equal(snapshotRows(store)[0].messages, 1, "continuation does not replay the prefix");

  const third = await scanSources(store, { home: contextInfo.home });
  assert.equal(third.stats.bytesRead, 0);
  assert.equal(third.stats.filesRead, 0);
});

test("partial scans expose savedAt separately from the last completed scan", async () => {
  const contextInfo = await context("insights-timestamps-");
  for (let index = 0; index < 3; index += 1) {
    await writeFile(
      path.join(contextInfo.home, ".pi", "agent", "sessions", `s${index}.jsonl`),
      piSession(`t${index}`, index + 1),
    );
  }
  let tick = Date.parse("2026-04-02T00:00:00Z");
  const fastClock = () => {
    tick += 5_000;
    return tick;
  };
  const partial = await collectSnapshot("configure", {
    store: contextInfo.store,
    home: contextInfo.home,
    config: sourceConfig(),
    budgetMs: 1,
    now: fastClock,
  });
  assert.equal(partial.scan.status, "partial");
  assert.equal(partial.lastCompletedScanAt, null);
  const saved = JSON.parse(await readFile(contextInfo.store, "utf8"));
  assert.equal(saved.scan.status, "partial");
  assert.equal(saved.lastCompletedScanAt, null);
  assert.equal(typeof saved.lastScanAt, "string");
  assert.equal(partial.lastScanAt, saved.lastScanAt);
  assert.equal(partial.savedAt, saved.lastScanAt);
  assert.equal(typeof partial.generatedAt, "string");

  let complete = await collectSnapshot("snapshot", {
    store: contextInfo.store,
    home: contextInfo.home,
    budgetMs: 60_000,
    now: fastClock,
  });
  for (let attempt = 0; attempt < 10 && complete.scan.status !== "complete"; attempt += 1) {
    complete = await collectSnapshot("snapshot", {
      store: contextInfo.store,
      home: contextInfo.home,
      budgetMs: 60_000,
      now: fastClock,
    });
  }
  assert.equal(complete.scan.status, "complete");
  assert.equal(typeof complete.lastCompletedScanAt, "string");
  assert.ok(Date.parse(complete.lastCompletedScanAt) >= Date.parse(saved.lastScanAt));

  const beforeWarm = await stat(contextInfo.store);
  const warm = await collectSnapshot("snapshot", {
    store: contextInfo.store,
    home: contextInfo.home,
    budgetMs: 60_000,
    now: fastClock,
  });
  const afterWarm = await stat(contextInfo.store);
  assert.equal(warm.scan.status, "complete");
  assert.equal(warm.stats.filesRead, 0);
  assert.equal(afterWarm.mtimeMs, beforeWarm.mtimeMs, "no-op refresh must not rewrite the store");
  assert.equal(afterWarm.size, beforeWarm.size);
  assert.equal(warm.lastCompletedScanAt, complete.lastCompletedScanAt);
});

test("a bounded scan never exposes rows from an unfinished archive", async () => {
  const { zstdCompressSync } = await import("node:zlib");
  const contextInfo = await mkdtemp(path.join(tmpdir(), "insights-archive-visibility-"));
  const home = path.join(contextInfo, "home");
  const sessions = path.join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-03T00:00:00Z", payload: { id: "archive", cwd: "/repo", model_provider: "openai" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-04-03T00:00:01Z", payload: { turn_id: "t", model: "archive-model", cwd: "/repo" } }),
  ];
  for (let index = 0; index < 20_000; index += 1) {
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: "2026-04-03T00:00:02Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
          total_token_usage: { input_tokens: index + 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
        },
      },
    }));
  }
  await writeFile(path.join(sessions, "big.jsonl.zst"), zstdCompressSync(lines.join("\n")));
  const store = emptyStore(normalizeConfig({
    sources: [{
      id: "codex",
      label: "Codex",
      adapter: "codex",
      enabled: true,
      roots: ["~/.codex/sessions"],
    }],
  }));
  const result = await scanSources(store, {
    home,
    deadline: Date.now(),
    now: Date.now,
  });
  assert.equal(result.abortedFile?.path?.endsWith("big.jsonl.zst"), true);
  assert.equal(Object.keys(store.files).length, 0, "an aborted archive contributes no file entry");
  assert.deepEqual(snapshotRows(store), []);
});
