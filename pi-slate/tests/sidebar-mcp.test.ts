import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { loadSidebarMcpHost } from "../extensions/pi-slate/sidebar-mcp.ts";
import { SidebarMcpFiles } from "../extensions/pi-slate/sidebar-data.ts";

// Check both installations even at the same version: the operator's actual host may differ from the dev pin.
const installed = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const installedVersion = await readFile(join(installed, "package.json"), "utf8").then(text => (JSON.parse(text) as { version: string }).version).catch(() => "unavailable");
const packages = [[getPackageDir(), VERSION], [installed, installedVersion]] as const;
for (const [packageDir, version] of packages) {
  test(`MCP parity with native ${version}: exact names, invalid values, overrides, collisions and project auth`, async t => {
    const root = await mkdtemp(join(tmpdir(), "slate-mcp-parity-")); t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent"), cwd = join(root, "repo"); await mkdir(agentDir); await mkdir(join(cwd, ".pi"), { recursive: true });
    let native: { loadMcpConfig: (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => { servers: Array<{ name: string; config: { enabled?: boolean } }>; errors: string[] } };
    try { native = await import(pathToFileURL(join(packageDir, "dist/extensions/mcp/config.js")).href); }
    catch { if (packageDir !== getPackageDir()) { t.skip("operator host not installed here"); return; } throw new Error("pinned parser unavailable"); }
    const host = await loadSidebarMcpHost(packageDir, version); assert(host);
    const cache = new SidebarMcpFiles(); cache.setHost(host);
    assert.deepEqual(cache.snapshot(agentDir, cwd, true, []), { mcp: [] }, "missing configuration files are not an MCP error");
    const fixtures = [
      [{}, {}],
      [{ x: { command: "server" } }, { x: { enabled: false } }],
      [{ x: { command: "server" } }, { x: { enabled: false, env: { SECRET: "SECRET" } } }],
      [{ x: { command: "server" } }, { x: { command: "replacement", args: 123 } }],
      [{ "web-search": { command: "server" }, web_search: { command: "collision" } }, {}],
      [{ x: { url: "https://example.com", headers: { token: 123 } }, y: { url: "https://example.com", oauth: { callbackPort: -1, clientSecret: "SECRET" } } }, {}],
      [{}, { x: { url: "https://example.com", auth: { provider: "fixture" } } }],
      [{ x: { command: "server", enabled: false, exposure: "codemode-deferred" } }, {}],
      [{ auto: { url: "https://example.com/mcp", oauth: { clientRegistration: "auto" } } }, {}],
    ];
    for (const [global, project] of fixtures) {
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: global }));
      await writeFile(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: project }));
      cache.clear();
      const loaded = native.loadMcpConfig({ agentDir, cwd, projectTrusted: true });
      const result = cache.snapshot(agentDir, cwd, true, []);
      const configured = new Set([...Object.keys(global), ...Object.keys(project)]);
      const nativeRows = loaded.servers.filter(row => configured.has(row.name)).map(row => [row.name, row.config.enabled !== false]).sort();
      assert.equal(Boolean(result.mcpError), loaded.errors.length > 0);
      assert.equal(result.mcpWarning, undefined);
      assert.deepEqual(
        result.mcp.filter(row => row.enabled !== null && configured.has(row.name)).map(row => [row.name, row.enabled]).sort(),
        nativeRows,
      );
      assert(!JSON.stringify(result).includes("SECRET"));
    }
    if (host.stripBom) {
      await writeFile(join(agentDir, "mcp.json"), '\uFEFF{"mcpServers":{"bom":{"command":"server"}}}');
      await writeFile(join(cwd, ".pi/mcp.json"), '\uFEFF{"mcpServers":{"bom":{"enabled":false}}}'); cache.clear();
      const loaded = native.loadMcpConfig({ agentDir, cwd, projectTrusted: true });
      assert.deepEqual(loaded.errors, []);
      const result = cache.snapshot(agentDir, cwd, true, []);
      assert.equal(result.mcpError, undefined);
      assert.deepEqual(result.mcp.map(row => [row.name, row.enabled]), loaded.servers.map(row => [row.name, row.config.enabled !== false]));
    }
    await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{}}');
    await writeFile(join(cwd, ".pi/mcp.json"), '{"mcpServers":{"registered":{"enabled":false}}}'); cache.clear();
    assert.equal(cache.snapshot(agentDir, cwd, true, [{ name: "registered", config: { command: "server" } }]).mcp[0]!.enabled, true);
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { auto: { url: "https://example.com/mcp", oauth: { clientRegistration: "auto" } } } }));
    await writeFile(join(cwd, ".pi/mcp.json"), '{"mcpServers":{}}'); cache.clear();
    const autoLoaded = native.loadMcpConfig({ agentDir, cwd, projectTrusted: true });
    const autoResult = cache.snapshot(agentDir, cwd, true, []);
    const autoEnabled = autoResult.mcp.find(row => row.name === "auto")?.enabled ?? null;
    assert.equal(autoEnabled === true, autoLoaded.servers.some(row => row.name === "auto"), `${version} uses the running native validator`);
    assert.equal(Boolean(autoResult.mcpError), autoLoaded.errors.length > 0);
    assert.equal(autoResult.mcpWarning, undefined);
    if (version === "1.4.0") assert.equal(autoEnabled, null, "Pi 1.4 rejects oauth.clientRegistration auto");
    if (version === "1.5.0") assert.equal(autoEnabled, true, "Pi 1.5 accepts oauth.clientRegistration auto");
  });
}
test("host adapter requires native validation and modern namespaces", async t => {
  const root = await mkdtemp(join(tmpdir(), "slate-mcp-exports-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    { name: "missing-validator", exports: "export const mcpNamespace = name => name;", modern: false, legacy: false },
    { name: "invalid-validator", exports: "export const validateMcpServerConfig = true; export const mcpNamespace = name => name;", modern: false, legacy: false },
    { name: "missing-namespace", exports: "export const validateMcpServerConfig = (_name, value) => value;", modern: false, legacy: true },
    { name: "invalid-namespace", exports: "export const validateMcpServerConfig = (_name, value) => value; export const mcpNamespace = true;", modern: false, legacy: true },
    { name: "complete", exports: "export const validateMcpServerConfig = (_name, value) => value; export const mcpNamespace = name => name;", modern: true, legacy: true },
    { name: "throws", exports: "throw new Error(\"load failed\");", modern: false, legacy: false },
  ];
  const modernVersions = ["1.1.0", "1.4.0", "2.0.0", "not-a-version"];
  for (const fixture of fixtures) {
    const packageDir = join(root, fixture.name);
    await mkdir(join(packageDir, "dist/core"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), '{"type":"module"}');
    await writeFile(join(packageDir, "dist/core/mcp-servers.js"), fixture.exports);
    for (const version of modernVersions) {
      assert.equal(Boolean(await loadSidebarMcpHost(packageDir, version)), fixture.modern, `${fixture.name}@${version}`);
    }
    assert.equal(Boolean(await loadSidebarMcpHost(packageDir, "0.99.0")), fixture.legacy, fixture.name);
    assert.equal(Boolean(await loadSidebarMcpHost(packageDir, "1.0.0")), fixture.legacy, fixture.name);
  }
  for (const [version, projectOverrides, stripBom] of [
    ["0.99.0", false, false], ["1.0.0", false, false], ["1.0.3", true, true], ["1.0.4", true, false],
    ["1.0.99", true, false], ["1.1.0", true, false], ["1.2.0", true, false], ["1.3.0", true, false],
    ["1.3.1", true, false], ["1.4.0", true, true], ["1.4.1", true, true], ["1.5.0", true, true],
    ["1.5.1", true, true], ["1.10.0", true, true], ["2.0.0", true, true], ["9.1.0", true, true],
    ["unknown", true, true], ["1.5.0-rc.1", true, true], ["", true, true],
  ] as const) {
    const host = await loadSidebarMcpHost(join(root, "complete"), version); assert(host, version);
    assert.equal(host.projectOverrides, projectOverrides, version);
    assert.equal(host.stripBom, stripBom, version);
  }
  assert.equal(await loadSidebarMcpHost(join(root, "absent"), "1.5.0"), undefined);
  assert.equal(await loadSidebarMcpHost(join(root, "absent"), "not-a-version"), undefined);
});

test("unavailable validation is not an error without entries, but file errors remain visible", async t => {
  const root = await mkdtemp(join(tmpdir(), "slate-mcp-empty-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  const cache = new SidebarMcpFiles();
  assert.deepEqual(cache.snapshot(root, root, true, []), { mcp: [] }, "missing files need no validation");
  await writeFile(join(root, "mcp.json"), "{}");
  await writeFile(join(root, ".pi/mcp.json"), '{"mcpServers":{}}');
  assert.deepEqual(cache.snapshot(root, root, true, []), { mcp: [] }, "empty files need no validation");
  await writeFile(join(root, ".pi/mcp.json"), '{"mcpServers":{"project":{"command":"server"}}}');
  assert.deepEqual(cache.snapshot(root, root, false, []), { mcp: [] }, "untrusted entries are not read");
  const project = cache.snapshot(root, root, true, []);
  assert.equal(project.mcp[0]!.enabled, null);
  assert.equal(project.mcpError, undefined);
  assert.match(project.mcpWarning!, /unavailable/);
  await writeFile(join(root, ".pi/mcp.json"), "{bad");
  const unreadable = cache.snapshot(root, root, true, []);
  assert.equal(unreadable.mcpError, "MCP config unreadable");
  assert.equal(unreadable.mcpWarning, undefined);
  await writeFile(join(root, "mcp.json"), '{"mcpServers":[]}');
  const invalid = cache.snapshot(root, root, false, []);
  assert.equal(invalid.mcpError, "MCP config invalid");
  assert.equal(invalid.mcpWarning, undefined);
  await writeFile(join(root, "mcp.json"), '{"mcpServers":{"global":{"command":"server"}}}');
  const global = cache.snapshot(root, root, false, []);
  assert.equal(global.mcp[0]!.enabled, null);
  assert.equal(global.mcpError, undefined);
  assert.match(global.mcpWarning!, /unavailable/);
  await writeFile(join(root, "mcp.json"), "{bad");
  const fileAndAdapter = cache.snapshot(root, root, false, [{ name: "registered", config: { command: "server", env: { TOKEN: "SECRET" } } }]);
  assert.equal(fileAndAdapter.mcpError, "MCP config unreadable");
  assert.match(fileAndAdapter.mcpWarning!, /unavailable/);
  assert.equal(fileAndAdapter.mcp.find(row => row.name === "registered")?.enabled, null);
  assert(!JSON.stringify(fileAndAdapter).includes("SECRET"));
});

test("unavailable host adapter never fabricates enabled/disabled state", async () => {
  assert.equal(await loadSidebarMcpHost("/missing", "1.5.0"), undefined);
  assert.equal(await loadSidebarMcpHost("/missing", "2.0.0"), undefined);
  const cache = new SidebarMcpFiles();
  const result = cache.snapshot("/missing", "/missing", false, [{ name: "registered", config: { command: "server" } }]);
  assert.equal(result.mcp[0]!.enabled, null);
  assert.equal(result.mcpError, undefined);
  assert.match(result.mcpWarning!, /unavailable/);
  assert.deepEqual(cache.snapshot("/missing", "/missing", false, []), { mcp: [] });
});
