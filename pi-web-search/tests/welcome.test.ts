import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH_ENV_VAR } from "../src/providers/config.ts";
import { hasSeenWelcome, markWelcomeSeen, maybeShowWelcome, welcomeStatePath } from "../src/welcome.ts";

async function isolated(run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-search-welcome-"));
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	process.env[CONFIG_PATH_ENV_VAR] = join(dir, "web-search.json");
	try { await run(dir); }
	finally {
		if (previous === undefined) delete process.env[CONFIG_PATH_ENV_VAR]; else process.env[CONFIG_PATH_ENV_VAR] = previous;
		await rm(dir, { recursive: true, force: true });
	}
}

const notice = "web search ready · no keys needed · /web-search to customise";
function ui(notes: [string, string][]) {
	return { notify: (line: string, type: string) => notes.push([line, type]), select: () => assert.fail("no modal") } as unknown as ExtensionContext["ui"];
}

test("welcome sends one dim info line, never a modal, and only writes the seen sidecar", () => isolated(async (dir) => {
	const notes: [string, string][] = [];
	const ctx = { mode: "tui" as const, hasUI: true, ui: ui(notes) };
	assert.equal(await hasSeenWelcome(), false);
	await maybeShowWelcome(ctx);
	await maybeShowWelcome(ctx);
	assert.deepEqual(notes, [[notice, "info"]]);
	assert.equal(await hasSeenWelcome(), true);
	assert.deepEqual(await readdir(dir), ["web-search-welcome.json"]);
}));

test("print and RPC runs do not notify or mark welcome seen", () => isolated(async () => {
	const notes: [string, string][] = [];
	for (const mode of ["print", "rpc"] as const) await maybeShowWelcome({ mode, hasUI: true, ui: ui(notes) });
	assert.deepEqual(notes, []);
	assert.equal(await hasSeenWelcome(), false);
}));

test("welcome sidecar cannot overwrite config or an existing file", () => isolated(async (dir) => {
	const path = join(dir, "web-search-welcome.json");
	assert.equal(welcomeStatePath(path), `${path}.welcome.json`);
	await writeFile(path, "broken state");
	await markWelcomeSeen(path);
	assert.equal(await readFile(path, "utf8"), "broken state");
}));
