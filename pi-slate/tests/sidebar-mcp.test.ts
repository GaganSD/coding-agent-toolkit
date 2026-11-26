import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpRuntimeTracker, mcpDetails, parseMcpFile, sidebarMcp, SidebarMcpFiles } from "../extensions/pi-slate/sidebar-mcp.ts";

const file = (servers: Record<string, unknown>) => parseMcpFile(JSON.stringify({ mcpServers: servers }));

test("MCP is a version-independent configuration projection, never a second server validator", () => {
  const result = sidebarMcp([], file({
    command: { command: "never executed", env: { TOKEN: "!never execute this SECRET" } },
    disabled: { enabled: false, command: "server" },
    future: { type: "future-transport", oauth: { futureField: "SECRET" } },
    invalidToPi: { url: "file:///not-accepted-by-Pi", oauth: false },
    empty: {}, scalar: null, unknownFlag: { enabled: "yes" },
  }));
  assert.deepEqual(result.map(row => [row.name, row.enabled]), [
    ["command", true], ["disabled", false], ["empty", true], ["future", true],
    ["invalidToPi", true], ["scalar", null], ["unknownFlag", null],
  ]);
  assert(!JSON.stringify(result).includes("SECRET"));
  assert.match(mcpDetails(result[0]!), /does not validate/);
  assert.match(mcpDetails(result.find(row => row.name === "scalar")!), /Enabled state could not be read/);
});

test("file declarations override registrations without revalidating the public registry", () => {
  const result = sidebarMcp([
    { name: "web_search", config: { command: "extension", enabled: false } },
    { name: "registered", config: { enabled: true, futureTransport: {} } },
  ], file({ "web-search": { enabled: true, command: "file" } }));
  assert.deepEqual(result, [
    { name: "registered", source: "extension", enabled: true, runtime: "idle" },
    { name: "web-search", source: "global", enabled: true, runtime: "idle" },
  ]);
});

test("runtime state handles success, sticky errors, retries, and concurrent calls", () => {
  const tracker = new McpRuntimeTracker();
  const rows = sidebarMcp([], file({ "dev-radius": { command: "server" } }));
  const tools = () => [{ name: "lookup", namespace: { name: "mcp__dev_radius" } }];
  tracker.apply(rows);

  tracker.start("a", "lookup", tools);
  tracker.start("b", "lookup", tools);
  assert.equal(tracker.state("dev-radius"), "active");
  tracker.finish("a", true);
  assert.equal(tracker.state("dev-radius"), "active", "another in-flight call takes precedence over failure");
  tracker.finish("b", true);
  assert.equal(tracker.state("dev-radius"), "error");

  tracker.start("retry", "lookup", tools);
  assert.equal(tracker.state("dev-radius"), "active");
  tracker.finish("retry", false);
  assert.equal(tracker.state("dev-radius"), "idle", "a later success clears the sticky error");
});

test("runtime mapping prefers raw aliases over exact and canonical namespace candidates", () => {
  const tracker = new McpRuntimeTracker();
  const rows = sidebarMcp([], file({ "foo-bar": {}, foo_bar: {}, exact: {}, "unique-name": {} }));
  tracker.apply(rows);

  tracker.start("hyphen", "lookup", () => [{ name: "lookup", namespace: { name: "mcp__foo_bar", aliases: ["foo-bar"] } }]);
  assert.equal(tracker.state("foo-bar"), "active");
  assert.equal(tracker.state("foo_bar"), "idle");
  tracker.finish("hyphen", false);

  tracker.start("underscore", "lookup", () => [{ name: "lookup", namespace: { name: "mcp__foo_bar", aliases: ["foo_bar"] } }]);
  assert.equal(tracker.state("foo_bar"), "active");
  tracker.finish("underscore", false);

  tracker.start("exact", "exact-tool", () => [{ name: "exact-tool", namespace: { name: "mcp__exact" } }]);
  assert.equal(tracker.state("exact"), "active");
  tracker.finish("exact", false);

  tracker.start("canonical", "unique-tool", () => [{ name: "unique-tool", namespace: { name: "mcp__unique_name" } }]);
  assert.equal(tracker.state("unique-name"), "active");
});

test("runtime mapping accepts double separators and leaves canonical collisions untracked", () => {
  const tracker = new McpRuntimeTracker();
  const rows = sidebarMcp([], file({ "double--dash": {}, double__underscore: {}, "same--name": {}, same__name: {} }));
  tracker.apply(rows);

  tracker.start("double-hyphen", "a", () => [{ name: "a", namespace: { name: "mcp__double__dash", aliases: ["double--dash"] } }]);
  tracker.start("double-underscore", "b", () => [{ name: "b", namespace: { name: "mcp__double__underscore", aliases: ["double__underscore"] } }]);
  tracker.start("ambiguous", "c", () => [{ name: "c", namespace: { name: "mcp__same-_name" } }]);
  assert.deepEqual(rows.map(row => tracker.state(row.name)), ["active", "active", "idle", "idle"]);
});

test("runtime state ignores unrelated and unknown tools and resets with the session", () => {
  const tracker = new McpRuntimeTracker();
  const rows = sidebarMcp([], file({ docs: {}, other: {} }));
  tracker.apply(rows);
  tracker.start("builtin", "read", () => [{ name: "read" }]);
  tracker.start("unknown", "search", () => [{ name: "search", namespace: { name: "mcp__missing" } }]);
  assert.deepEqual(rows.map(row => tracker.state(row.name)), ["idle", "idle"]);

  tracker.start("docs", "search", () => [{ name: "search", namespace: { name: "mcp__docs" } }]);
  tracker.finish("docs", true);
  assert.equal(tracker.state("docs"), "error");
  tracker.reset();
  tracker.apply(rows);
  assert.deepEqual(rows.map(row => tracker.state(row.name)), ["idle", "idle"]);
});

test("runtime lookup fails open for malformed, ambiguous, oversized, and throwing catalogs", () => {
  const tracker = new McpRuntimeTracker();
  const rows = sidebarMcp([], file({ "same-name_part": {}, "same_name-part": {}, safe: {} }));
  tracker.apply(rows);
  const throwing = () => { throw new Error("catalog unavailable"); };
  assert.doesNotThrow(() => tracker.start("throw", "tool", throwing));
  tracker.start("ambiguous", "tool", () => [{ name: "tool", namespace: { name: "mcp__same-name-part" } }]);
  tracker.start("prefix-only", "mcp__safe__tool", () => [{ name: "mcp__safe__tool" }]);
  tracker.start("oversized", "x".repeat(513), () => [{ name: "x".repeat(513), namespace: { name: "mcp__safe" } }]);
  tracker.start("malformed", "tool", () => [{ name: "tool", namespace: { get name(): never { throw new Error("bad getter"); } } }]);
  assert.deepEqual(rows.map(row => tracker.state(row.name)), ["idle", "idle", "idle"]);
});

test("trusted project declarations inherit exact-name global flags or replace full declarations", () => {
  const global = file({ a: { command: "a", enabled: false }, b: { command: "b", enabled: false }, "web-search": { command: "web" } });
  const project = file({ a: { exposure: "future", futureOverrideField: true }, b: { command: "replacement" }, web_search: { enabled: false } });
  assert.deepEqual(sidebarMcp([], global, project).map(row => [row.name, row.enabled]), [
    ["a", false], ["b", true], ["web_search", false], ["web-search", true],
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  assert.equal(sidebarMcp([], global, file({ a: { enabled: true } })).find(row => row.name === "a")!.enabled, true);
});

test("BOM normalization is independent of host capabilities; actual malformed files remain errors", () => {
  const text = '{"mcpServers":{"server":{"command":"server"}}}';
  assert.deepEqual(parseMcpFile(`\uFEFF${text}`), parseMcpFile(text));
  assert.equal(parseMcpFile('\uFEFF\uFEFF{}').error, "MCP config unreadable");
  assert.equal(parseMcpFile('{"token":"SECRET",bad}').error, "MCP config unreadable");
  for (const text of ['[]', 'null', '{"mcpServers":[]}']) assert.equal(parseMcpFile(text).error, "MCP config invalid");
  assert.deepEqual(parseMcpFile(undefined), { servers: {} });
  assert.deepEqual(parseMcpFile('{}'), { servers: {} });
});

test("cache follows edits/removal, bounds reads, and never reads untrusted project configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "slate-mcp-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent"), cwd = join(root, "repo");
  await mkdir(agent); await mkdir(join(cwd, ".pi"), { recursive: true });
  const global = join(agent, "mcp.json"), project = join(cwd, ".pi/mcp.json");
  const cache = new SidebarMcpFiles();
  assert.deepEqual(cache.snapshot(agent, cwd, false, []), { mcp: [] });
  await writeFile(global, '\uFEFF{"mcpServers":{"a":{"command":"!never run","enabled":false}}}');
  await writeFile(project, '{"mcpServers":{"a":{"enabled":true}}}');
  assert.equal(cache.snapshot(agent, cwd, false, []).mcp[0]!.enabled, false);
  const parsed = cache.read(global);
  assert.equal(cache.read(global), parsed);
  assert.equal(cache.snapshot(agent, cwd, true, []).mcp[0]!.enabled, true);
  await writeFile(project, '{broken SECRET');
  assert.equal(cache.snapshot(agent, cwd, false, []).mcpError, undefined);
  const result = cache.snapshot(agent, cwd, true, []);
  assert.equal(result.mcpError, "MCP config unreadable");
  assert.equal(result.mcp[0]!.enabled, false, "a malformed project file does not erase readable global state");
  assert(!JSON.stringify(result).includes("SECRET"));
  await writeFile(global, '{"mcpServers":{"b":{"command":"new"}}}');
  assert.equal(cache.snapshot(agent, cwd, false, []).mcp[0]!.name, "b");
  await writeFile(global, " ".repeat(1024 * 1024 + 1));
  assert.equal(cache.snapshot(agent, cwd, false, []).mcpError, "MCP config unreadable");
  await rm(global);
  assert.deepEqual(cache.snapshot(agent, cwd, false, []), { mcp: [] });
  cache.clear();
  assert.match(await readFile(project, "utf8"), /SECRET/, "inspection never rewrites files");
});
