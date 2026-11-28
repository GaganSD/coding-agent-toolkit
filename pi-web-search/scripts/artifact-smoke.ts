import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const configPath = process.env.PI_WEB_SEARCH_CONFIG;
assert.ok(configPath, "Smoke load requires an isolated config path");
// No tool executes, and any unexpected network request fails immediately.
globalThis.fetch = async () => { throw new Error("Package smoke validation must not access the network"); };
for (const researchEnabled of [false, true]) {
	writeFileSync(configPath, JSON.stringify({ research: { enabled: researchEnabled } }));
	const loaded = await discoverAndLoadExtensions([packageRoot], packageRoot, getAgentDir());
	assert.deepEqual(loaded.errors, [], "Pi must load the packed source entrypoint without compilation");
	assert.deepEqual(loaded.warnings, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.equal(extension.resolvedPath, resolve(packageRoot, manifest.pi.extensions[0]));
	assert.deepEqual([...extension.tools.keys()], ["search"]);
	assert.ok(extension.commands.has("web-search"));
	assert.equal(extension.commands.has("web-search-settings"), false);
	// Standalone Pi's package directory contains assets, not a dependency tree.
	process.env.PI_PACKAGE_DIR = process.env.HOME;
	try {
		await extension.commands.get("web-search")!.handler("off", {
			mode: "tui", hasUI: true, ui: { notify: (text: string) => assert.match(text, /Saved/) },
		} as ExtensionCommandContext);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).classifier.enabled, false);
	} finally { delete process.env.PI_PACKAGE_DIR; }
}
console.log("Packed TypeScript entrypoint loads in Pi and saves settings with an asset-only PI_PACKAGE_DIR.");
