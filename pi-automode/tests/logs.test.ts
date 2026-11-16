import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isDecisionLog, LogError, LogStore } from "../src/logs.js";
import { validateSettings } from "../src/settings.js";
import type { AutomodeSettings, DecisionLog } from "../src/types.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "automode-logs-"));
}

function cfg(overrides: Record<string, unknown> = {}): AutomodeSettings {
  return validateSettings({ version: 1, enabled: true, ...overrides });
}

let counter = 0;
function entry(overrides: Partial<DecisionLog> = {}): DecisionLog {
  counter += 1;
  return {
    id: `id-${counter}`,
    time: new Date().toISOString(),
    action: { requestId: `req-${counter}`, tool: "bash", args: { command: "ls" }, cwd: "/ws" },
    outcome: "allow",
    source: "policy:workspace-floor",
    reason: "test entry",
    ...overrides,
  };
}

test("append/read roundtrip preserves order and exact action text", async () => {
  const dir = await tempDir();
  const store = new LogStore(path.join(dir, "automode-logs.json"));
  const a = entry({ action: { requestId: "r1", tool: "bash", args: { command: "echo 中文 🚀" }, cwd: "/ws" } });
  const b = entry({ outcome: "block", source: "rule:blocklist", reason: "exact block" });
  await store.append(a, cfg());
  await store.append(b, cfg());
  const read = await store.read(cfg());
  assert.equal(read.length, 2);
  assert.deepEqual(read[0], a);
  assert.deepEqual(read[1], b);
  assert.equal(store.warning, null);
});

test("log file has restrictive 0600 permissions", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const store = new LogStore(file);
  await store.append(entry(), cfg());
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("missing file reads as empty without warning; clear is a no-op", async () => {
  const dir = await tempDir();
  const store = new LogStore(path.join(dir, "automode-logs.json"));
  assert.deepEqual(await store.read(cfg()), []);
  assert.equal(store.warning, null);
  await store.clear();
});

test("clear removes all records", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const store = new LogStore(file);
  await store.append(entry(), cfg());
  await store.clear();
  assert.deepEqual(await store.read(cfg()), []);
  assert.equal((await fs.lstat(file).catch(() => null)), null);
});

test("age retention drops old entries explicitly", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const old = entry({ time: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  const fresh = entry();
  // Read-side retention (e.g. after external writes).
  await fs.writeFile(file, `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);
  const store = new LogStore(file);
  const read = await store.read(cfg({ logRetentionDays: 7 }));
  assert.deepEqual(read.map((e) => e.id), [fresh.id]);
  assert.match(store.warning ?? "", /older than 7 day/);

  // Append-side retention: an aged entry is pruned durably on the next append.
  const file2 = path.join(dir, "second.json");
  const store2 = new LogStore(file2);
  await store2.append(old, cfg({ logRetentionDays: 7 }));
  await store2.append(fresh, cfg({ logRetentionDays: 7 }));
  assert.deepEqual((await store2.read(cfg({ logRetentionDays: 7 }))).map((e) => e.id), [fresh.id]);
  const onDisk = (await fs.readFile(file2, "utf8")).trim().split("\n");
  assert.equal(onDisk.length, 1, "aged entry pruned from the file itself");
});

test("entry-count bound keeps the most recent entries and rewrites atomically", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const store = new LogStore(file);
  const small = cfg({ logMaxEntries: 3 });
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const e = entry();
    ids.push(e.id);
    await store.append(e, small);
  }
  const read = await store.read(small);
  assert.deepEqual(read.map((e) => e.id), ids.slice(2), "last 3 kept");
  // The file itself was pruned, not just the read view.
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("byte bound drops the oldest entries", async () => {
  const dir = await tempDir();
  const store = new LogStore(path.join(dir, "automode-logs.json"), { maxBytes: 1200 });
  const settings = cfg({ logMaxEntries: 1000 });
  for (let i = 0; i < 10; i += 1) {
    await store.append(entry({ reason: `payload ${i} ${"x".repeat(200)}` }), settings);
  }
  const read = await store.read(settings);
  assert.ok(read.length < 10, `byte bound must drop old entries, kept ${read.length}`);
  assert.deepEqual(read[read.length - 1]?.id, `id-${counter}`);
  const size = (await fs.stat(store.path)).size;
  assert.ok(size <= 1200, `file within byte bound, got ${size}`);
});

test("oversized single entry is refused", async () => {
  const dir = await tempDir();
  const store = new LogStore(path.join(dir, "automode-logs.json"), { maxBytes: 500 });
  await assert.rejects(store.append(entry({ reason: "x".repeat(1000) }), cfg()), LogError);
});

test("corrupt lines are skipped and reported, never silently dropped or repaired", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const good = entry();
  const content = [
    JSON.stringify(good),
    "{ not json",
    JSON.stringify({ id: "x" }), // valid JSON, invalid shape
    JSON.stringify(entry({ reason: "" })), // empty reason: fabricated-reason guard
    "", // trailing newline
  ].join("\n");
  await fs.writeFile(file, content);
  const store = new LogStore(file);
  const read = await store.read(cfg());
  assert.deepEqual(read.map((e) => e.id), [good.id]);
  assert.match(store.warning ?? "", /corrupt/);
});

test("isDecisionLog validates structure strictly", () => {
  assert.equal(isDecisionLog(entry()), true);
  assert.equal(isDecisionLog(entry({ matchedRule: { text: "ls" } })), true);
  // Legacy log entries carrying type: "command" still parse; message-rule entries are corrupt.
  assert.equal(isDecisionLog(entry({ matchedRule: { type: "command", text: "ls" } as never })), true);
  assert.equal(isDecisionLog(entry({ matchedRule: { type: "message", text: "ls" } as never })), false);
  assert.equal(isDecisionLog(null), false);
  assert.equal(isDecisionLog({}), false);
  assert.equal(isDecisionLog(entry({ outcome: "maybe" as never })), false);
  assert.equal(isDecisionLog(entry({ reason: "" })), false);
  assert.equal(isDecisionLog(entry({ source: "" })), false);
  assert.equal(isDecisionLog(entry({ time: "not a date" })), false);
  assert.equal(isDecisionLog(entry({ id: "" })), false);
  const extra = { ...entry(), unexpected: 1 };
  assert.equal(isDecisionLog(extra), false);
  const proto = JSON.parse('{"__proto__":{"x":1}}') as unknown;
  assert.equal(isDecisionLog(proto), false);
  assert.equal(isDecisionLog(entry({ matchedRule: { type: "cmd", text: "ls" } as never })), false);
});

test("append rejects structurally invalid entries (no fabricated records)", async () => {
  const dir = await tempDir();
  const store = new LogStore(path.join(dir, "automode-logs.json"));
  await assert.rejects(store.append(entry({ reason: "" }), cfg()), LogError);
  await assert.rejects(store.append({ id: "x" } as unknown as DecisionLog, cfg()), LogError);
  assert.deepEqual(await store.read(cfg()), []);
});

test("symlink log path is refused on read, append and clear", async () => {
  const dir = await tempDir();
  const target = path.join(dir, "real.log");
  await fs.writeFile(target, "");
  const link = path.join(dir, "automode-logs.json");
  await fs.symlink(target, link);
  const store = new LogStore(link);
  await assert.rejects(store.read(cfg()), LogError);
  await assert.rejects(store.append(entry(), cfg()), LogError);
  await assert.rejects(store.clear(), LogError);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test("read applies bounds even without appends (external growth)", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const lines: string[] = [];
  for (let i = 0; i < 10; i += 1) lines.push(JSON.stringify(entry()));
  await fs.writeFile(file, lines.join("\n") + "\n");
  const store = new LogStore(file);
  const read = await store.read(cfg({ logMaxEntries: 4 }));
  assert.equal(read.length, 4);
  assert.match(store.warning ?? "", /truncated/);
});

test("oversized log is windowed BEFORE parse and pruned durably", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  // Externally grown far beyond the byte ceiling.
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) lines.push(JSON.stringify(entry()));
  await fs.writeFile(file, lines.join("\n") + "\n");
  const before = (await fs.stat(file)).size;
  const store = new LogStore(file, { maxBytes: 2000 });
  assert.ok(before > 2000);
  const read = await store.read(cfg({ logMaxEntries: 1000 }));
  assert.ok(read.length > 0 && read.length < 200, `windowed read, got ${read.length}`);
  assert.match(store.warning ?? "", /byte window/);
  // Newest entries survive; pruning is durable on disk.
  assert.deepEqual(read[read.length - 1]?.id, `id-${counter}`);
  assert.ok((await fs.stat(file)).size <= 2000, "file pruned to the byte ceiling");
});

test("a single line larger than the byte bound is never parsed", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  await fs.writeFile(file, `${JSON.stringify(entry({ reason: "x".repeat(5000) }))}\n`);
  const store = new LogStore(file, { maxBytes: 2000 });
  const read = await store.read(cfg());
  assert.deepEqual(read, []);
  assert.match(store.warning ?? "", /byte window/);
  assert.ok((await fs.stat(file)).size <= 2000);
});

test("age pruning on plain read is durable on disk", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const old = entry({ time: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  const fresh = entry();
  await fs.writeFile(file, `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);
  const store = new LogStore(file);
  const read = await store.read(cfg({ logRetentionDays: 7 }));
  assert.deepEqual(read.map((e) => e.id), [fresh.id]);
  const onDisk = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(onDisk.length, 1, "aged entry pruned from the file itself on access");
  assert.equal(JSON.parse(onDisk[0] as string).id, fresh.id);
});

test("corrupt lines are durably removed from disk on read", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const good = entry();
  await fs.writeFile(file, `{ not json\n${JSON.stringify(good)}\n`);
  const store = new LogStore(file);
  const read = await store.read(cfg());
  assert.deepEqual(read.map((e) => e.id), [good.id]);
  assert.match(store.warning ?? "", /corrupt/);
  const onDisk = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(onDisk.length, 1);
  assert.equal(JSON.parse(onDisk[0] as string).id, good.id);
});

test("concurrent appends from cooperating stores lose no entries", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const settings = cfg();
  const stores = [new LogStore(file), new LogStore(file), new LogStore(file)];
  const entries = Array.from({ length: 30 }, () => entry());
  await Promise.all(entries.map((e, i) => (stores[i % 3] as LogStore).append(e, settings)));
  const read = await new LogStore(file).read(settings);
  assert.deepEqual(
    new Set(read.map((e) => e.id)),
    new Set(entries.map((e) => e.id)),
    "every concurrently appended entry survives",
  );
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-") || f.endsWith(".lock"));
  assert.deepEqual(leftovers, []);
});

test("concurrent appends with pruning active stay bounded and consistent", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  const settings = cfg({ logMaxEntries: 10 });
  const stores = [new LogStore(file), new LogStore(file)];
  const entries = Array.from({ length: 30 }, () => entry());
  await Promise.all(entries.map((e, i) => (stores[i % 2] as LogStore).append(e, settings)));
  const read = await new LogStore(file).read(settings);
  assert.ok(read.length <= 10, `bounded, got ${read.length}`);
  assert.equal(new Set(read.map((e) => e.id)).size, read.length, "no duplicated or resurrected entries");
  for (const e of read) {
    assert.ok(entries.some((issued) => issued.id === e.id), "only issued entries present");
  }
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.ok(lines.length <= 10);
});

test("hard-linked log file is refused (private storage)", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode-logs.json");
  await fs.writeFile(file, "");
  await fs.link(file, path.join(dir, "alias.json"));
  const store = new LogStore(file);
  await assert.rejects(store.read(cfg()), LogError);
  await assert.rejects(store.append(entry(), cfg()), LogError);
  await assert.rejects(store.clear(), LogError);
});
