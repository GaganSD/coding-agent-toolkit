import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import {
	AskConfigStore,
	getAskConfigPath,
	getAskConfigStore,
	resetAskConfigStore,
} from "../src/config/store.ts";

function expectedConfigFile() {
	return {
		schemaVersion: 1,
		answer: DEFAULT_ASK_CONFIG.answer,
		behaviour: DEFAULT_ASK_CONFIG.behaviour,
		expiry: DEFAULT_ASK_CONFIG.expiry,
		keymaps: DEFAULT_ASK_CONFIG.keymaps,
		notifications: DEFAULT_ASK_CONFIG.notifications,
	};
}

async function makeTempPath(name: string): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), name));
	return join(root, "pi-ask.json");
}

test("config path is first-party only", () => {
	assert.match(getAskConfigPath(), /extensions\/pi-ask\.json$/);
});

test("resetAskConfigStore reloads the global store from disk", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "pi-ask-config-reset-"));
	const path = join(root, "extensions", "pi-ask.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			...expectedConfigFile(),
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: true,
			},
		})
	);
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);

	resetAskConfigStore();
	const result = await getAskConfigStore().ensureLoaded();

	assert.equal(
		result.config.behaviour.autoSubmitWhenAnsweredWithoutNotes,
		true
	);
	delete process.env.PI_CODING_AGENT_DIR;
	resetAskConfigStore();
	await rm(root, { force: true, recursive: true });
});

test("config store writes defaults when file is missing", async () => {
	const path = await makeTempPath("pi-ask-config-missing-");
	const store = new AskConfigStore(path);

	const result = await store.ensureLoaded();

	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.deepEqual(
		JSON.parse(await readFile(path, "utf-8")),
		expectedConfigFile()
	);
});

test("config store writes full normalized config on save", async () => {
	const path = await makeTempPath("pi-ask-config-save-");
	const store = new AskConfigStore(path);
	await store.ensureLoaded();
	await store.save({
		...DEFAULT_ASK_CONFIG,
		behaviour: {
			...DEFAULT_ASK_CONFIG.behaviour,
			showFooterHints: false,
		},
	});
	const written = JSON.parse(await readFile(path, "utf-8"));
	assert.equal(written.schemaVersion, 1);
	assert.equal(written.behaviour.showFooterHints, false);
	assert.equal(written.behaviour.presentSingleAsMulti, undefined);
});

test("config store leaves invalid files unchanged", async () => {
	const path = await makeTempPath("pi-ask-config-invalid-");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "{not json");
	const store = new AskConfigStore(path);
	const result = await store.ensureLoaded();
	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.equal(result.notice?.kind, "error");
	assert.equal(await readFile(path, "utf-8"), "{not json");
});

test("expiry and background default on with a 30 second floor", () => {
	assert.deepEqual(DEFAULT_ASK_CONFIG.expiry, { enabled: true, minSeconds: 30 });
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.background, true);
});

test("configs written before expiry existed keep loading with defaults", async () => {
	const path = await makeTempPath("pi-ask-config-legacy-");
	const { expiry: _expiry, behaviour, ...legacy } = expectedConfigFile();
	const { background: _background, ...legacyBehaviour } = behaviour;
	await writeFile(
		path,
		JSON.stringify({
			...legacy,
			behaviour: { ...legacyBehaviour, showFooterHints: false },
			futureKey: { anything: true },
		})
	);
	const result = await new AskConfigStore(path).ensureLoaded();
	assert.equal(result.notice, undefined);
	assert.equal(result.config.behaviour.showFooterHints, false);
	assert.equal(result.config.behaviour.background, true);
	assert.deepEqual(result.config.expiry, DEFAULT_ASK_CONFIG.expiry);
});

test("expiry and background settings are normalised", async () => {
	const path = await makeTempPath("pi-ask-config-expiry-");
	await writeFile(
		path,
		JSON.stringify({
			behaviour: { background: false },
			expiry: { enabled: false, minSeconds: 90 },
		})
	);
	const loaded = (await new AskConfigStore(path).ensureLoaded()).config;
	assert.equal(loaded.behaviour.background, false);
	assert.deepEqual(loaded.expiry, { enabled: false, minSeconds: 90 });

	for (const minSeconds of [0, -1]) {
		await writeFile(path, JSON.stringify({ expiry: { minSeconds } }));
		const config = (await new AskConfigStore(path).ensureLoaded()).config;
		assert.deepEqual(config.expiry, { enabled: true, minSeconds: 30 });
	}
});

test("peek reads config without creating the file", async () => {
	const path = await makeTempPath("pi-ask-config-peek-");
	const store = new AskConfigStore(path);
	assert.deepEqual(await store.peek(), DEFAULT_ASK_CONFIG);
	await assert.rejects(readFile(path, "utf-8"), { code: "ENOENT" });

	await writeFile(path, JSON.stringify({ expiry: { enabled: false } }));
	assert.equal((await store.peek()).expiry.enabled, false);
	await writeFile(path, "{not json");
	assert.deepEqual(await store.peek(), DEFAULT_ASK_CONFIG);
	assert.equal(await readFile(path, "utf-8"), "{not json");
});
