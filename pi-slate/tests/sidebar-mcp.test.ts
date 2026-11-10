import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mcpDetails, parseMcpFile, sidebarMcp, SidebarMcpFiles } from "../extensions/pi-slate/sidebar-mcp.ts";

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
    { name: "registered", source: "extension", enabled: true },
    { name: "web-search", source: "global", enabled: true },
  ]);
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
