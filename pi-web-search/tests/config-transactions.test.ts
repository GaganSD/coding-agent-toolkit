import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyConfigFix, configureJudgment, readWebSearchConfig, saveSearchSetting } from "../src/providers/config.ts";
import { withFileLock } from "../src/file-write.ts";

async function withConfig(run: (path: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-search-transaction-"));
	const path = join(dir, "web-search.json");
	const prior = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = path;
	try { await writeFile(path, "{}"); await run(path); }
	finally {
		if (prior === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = prior;
		await rm(dir, { recursive: true, force: true });
	}
}

function discovery() {
	let started!: () => void, finish!: (value: []) => void;
	const ready = new Promise<void>((done) => { started = done; });
	const selection = new Promise<[]>((done) => { finish = done; });
	const pending = configureJudgment("on", () => { started(); return selection; });
	return { ready, pending, finish: () => finish([]) };
}

test("classifier discovery writes after concurrent processes and preserves unrelated edits", () => withConfig(async (path) => {
	const { ready, pending, finish } = discovery();
	await ready;
	const source = new URL("../src/providers/config.ts", import.meta.url).href;
	try {
		await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
			`import { saveSearchSetting } from ${JSON.stringify(source)}; await saveSearchSetting({kind: "set", field: "maxResults", value: 17});`]);
	} finally { finish(); }
	await pending;
	const config = JSON.parse(await readFile(path, "utf8"));
	assert.equal(config.maxResults, 17);
	assert.equal(config.research.enabled, true);
}));

test("a config save in a second process waits for the lock and merges the committed revision", () => withConfig(async (path) => {
	const source = new URL("../src/providers/config.ts", import.meta.url).href;
	let completed: Promise<unknown> | undefined;
	await withFileLock(path, async () => {
		const child = execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
			`import { saveSearchSetting } from ${JSON.stringify(source)}; console.log("ready"); await saveSearchSetting({kind: "set", field: "maxResults", value: 17});`]);
		completed = once(child, "exit").then(([code]) => { assert.equal(code, 0); return true; });
		assert.ok(child.stdout);
		await Promise.race([once(child.stdout, "data"), completed]);
		assert.equal(await Promise.race([completed, sleep(100, false)]), false);
		await writeFile(path, '{"timeoutMs":4000}');
	});
	await completed;
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { timeoutMs: 4000, maxResults: 17 });
}));

test("discovery refuses malformed config and omits an unknown syntax error line", () => withConfig(async (path) => {
	const { ready, pending, finish } = discovery();
	const rejected = assert.rejects(pending, { code: "invalid_config" });
	await ready;
	const malformed = '{\n  "maxResults": xxx,\n  "timeoutMs": 2000\n}';
	await writeFile(path, malformed);
	finish();
	await rejected;
	assert.equal(await readFile(path, "utf8"), malformed);
	const invalid = await readWebSearchConfig(path);
	assert.equal(invalid.status, "invalid");
	if (invalid.status === "invalid") assert.ok(invalid.error.issue?.line === undefined || invalid.error.issue.line === 2);
}));

test("repair refuses an edited revision even when the same typo remains", () => withConfig(async (path) => {
	await writeFile(path, '{"maxResult":9}');
	const typo = await readWebSearchConfig(path);
	if (typo.status !== "invalid" || !typo.error.issue?.fix) assert.fail("expected a repair");
	await writeFile(path, '{"maxResult":12}');
	await assert.rejects(applyConfigFix(path, typo.error.issue.fix), /settings changed/i);
	assert.equal(await readFile(path, "utf8"), '{"maxResult":12}');
}));

test("a killed writer's config lock expires and a subsequent save succeeds", { timeout: 15000 }, () => withConfig(async (path) => {
	const fileWrite = new URL("../src/file-write.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
		`import { withFileLock } from ${JSON.stringify(fileWrite)}; await withFileLock(process.argv[1], async () => { console.log("locked"); await new Promise(() => setInterval(() => {}, 1000)); });`, path],
	{ stdio: ["ignore", "pipe", "inherit"] });
	const exited = once(child, "exit");
	try {
		const [ready] = await Promise.race([once(child.stdout, "data"), exited]);
		assert.match(String(ready), /locked/);
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
	await saveSearchSetting({ kind: "set", field: "maxResults", value: 17 });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { maxResults: 17 });
}));
