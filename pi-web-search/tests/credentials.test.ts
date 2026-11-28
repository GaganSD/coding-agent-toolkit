import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CREDENTIAL_ENV_ALIASES,
	disableStoredCredentials,
	enableStoredCredentials,
	exaApiKey,
	githubToken,
	parallelApiKey,
	removeApiKey,
	resolveCredential,
	storeApiKey,
} from "../src/env.ts";

async function tempAuthFile(
	contents: unknown,
	run: (authPath: string) => Promise<void> | void,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-auth-"));
	const authPath = join(dir, "auth.json");
	try {
		await writeFile(authPath, JSON.stringify(contents), "utf-8");
		await run(authPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("every nonblank env alias beats the stored credential", () => {
	assert.deepEqual(
		resolveCredential("github", {
			env: { GH_TOKEN: "env-gh" },
			readCredential: () => ({ key: "stored" }),
		}),
		{ key: "env-gh", source: "env", name: "GH_TOKEN" },
	);
});

test("the stored credential is used only when no alias is set", () => {
	assert.deepEqual(
		resolveCredential("parallel", {
			env: {},
			readCredential: () => ({ type: "api_key", key: " stored-key " }),
		}),
		{ key: "stored-key", source: "auth", name: "parallel" },
	);
});

test("rotation and removal of the stored key are observed on the next call", async () => {
	await tempAuthFile({ parallel: { type: "api_key", key: "old" } }, async (authPath) => {
		assert.equal(
			resolveCredential("parallel", { env: {}, authPath })?.key,
			"old",
		);
		await writeFile(
			authPath,
			JSON.stringify({ parallel: { type: "api_key", key: "rotated" } }),
			"utf-8",
		);
		assert.equal(
			resolveCredential("parallel", { env: {}, authPath })?.key,
			"rotated",
		);
		assert.equal(await removeApiKey("parallel", authPath), true);
		assert.equal(resolveCredential("parallel", { env: {}, authPath }), undefined);
		assert.equal(await removeApiKey("parallel", authPath), false);
		await writeFile(authPath, '{"parallel":{"type":"oauth","access":"keep"}}');
		assert.equal(await removeApiKey("parallel", authPath), false);
		assert.equal(await readFile(authPath, "utf8"), '{"parallel":{"type":"oauth","access":"keep"}}');
		await writeFile(authPath, "{ malformed");
		await assert.rejects(removeApiKey("parallel", authPath), /malformed/);
		assert.equal(await readFile(authPath, "utf8"), "{ malformed");
	});
});

test("a whitespace-only value is absent whether it comes from env or auth", () => {
	assert.equal(
		resolveCredential("exa", {
			env: { EXA_API_KEY: "   " },
			readCredential: () => ({ key: "   " }),
		}),
		undefined,
	);
});

test("an unreadable auth file is treated as an absent credential", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-auth-"));
	try {
		const missing = join(dir, "does-not-exist.json");
		assert.equal(resolveCredential("github", { env: {}, authPath: missing }), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("provider helpers resolve through the single resolver", () => {
	assert.equal(exaApiKey({ env: { EXA_API_KEY: " e " }, readCredential: () => undefined }), "e");
	assert.equal(
		parallelApiKey({ env: { PARALLEL_API_KEY: "p" }, readCredential: () => undefined }),
		"p",
	);
	assert.equal(
		githubToken({ env: { GH_TOKEN: "g" }, readCredential: () => undefined }),
		"g",
	);
});

test("enabling stored credentials reads the given auth file until disabled", async () => {
	await tempAuthFile({ exa: { type: "api_key", key: "auth-exa" } }, async (authPath) => {
		try {
			enableStoredCredentials(authPath);
			assert.equal(exaApiKey({ env: {} }), "auth-exa");
		} finally {
			disableStoredCredentials();
		}
		assert.equal(exaApiKey({ env: {} }), undefined);
	});
});

test("the alias table documents every supported provider id", () => {
	assert.deepEqual(CREDENTIAL_ENV_ALIASES.github, ["GITHUB_TOKEN", "GH_TOKEN"]);
	assert.deepEqual(Object.keys(CREDENTIAL_ENV_ALIASES), ["exa", "parallel", "github", "brave"]);
	assert.ok(Object.values(CREDENTIAL_ENV_ALIASES).flat().every((name) => !["TYPESAFE_API_KEY", "CLASSIFIER_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"].includes(name)));
});

test("storeApiKey merges one literal key and leaves other entries", async () => {
	await tempAuthFile({ openai: { type: "api_key", key: "keep" } }, async (authPath) => {
		await storeApiKey("exa", "  new-key  ", authPath);
		assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
			openai: { type: "api_key", key: "keep" },
			exa: { type: "api_key", key: "new-key" },
		});
	});
});

test("a malformed auth file is never overwritten", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-auth-"));
	const authPath = join(dir, "auth.json");
	try {
		await writeFile(authPath, "{ broken", "utf-8");
		await assert.rejects(storeApiKey("exa", "secret", authPath), /malformed/);
		assert.equal(await readFile(authPath, "utf-8"), "{ broken");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a competing Pi-style writer's refresh is preserved under the shared auth lock", async () => {
	await tempAuthFile({ another: { type: "oauth", access: "before" } }, async (authPath) => {
		const lock = authPath + ".lock";
		await mkdir(lock);
		const pending = storeApiKey("exa", "saved", authPath);
		const completed = pending.then(() => true);
		assert.equal(await Promise.race([completed, sleep(60, false)]), false);
		try { await writeFile(authPath, JSON.stringify({ another: { type: "oauth", access: "refreshed" } })); }
		finally { await rmdir(lock); }
		await pending;
		assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
			another: { type: "oauth", access: "refreshed" }, exa: { type: "api_key", key: "saved" },
		});
	});
});

test("stored-key helpers cannot override or delete a Pi-managed credential", async () => {
	const managed = { exa: { type: "oauth", access: "unchanged" } };
	await tempAuthFile(managed, async (authPath) => {
		await assert.rejects(storeApiKey("exa", "replacement", authPath), /managed by Pi/);
		assert.equal(await removeApiKey("exa", authPath), false);
		assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), managed);
	});
});

test("literal-key helpers reject commands and references and leave existing expressions untouched", async () => {
	const managed = { exa: { type: "api_key", key: "!managed-command" }, brave: { type: "api_key", key: "$BRAVE_SECRET" } };
	await tempAuthFile(managed, async (authPath) => {
		for (const key of ["!command", "$OPTIONAL_KEY", "prefix-${OPTIONAL_KEY}", "$$escape", "$!escape"]) {
			await assert.rejects(storeApiKey("parallel", key, authPath), /literal API key/);
		}
		for (const id of ["exa", "brave"] as const) {
			assert.equal(resolveCredential(id, { authPath, env: {} }), undefined);
			await assert.rejects(storeApiKey(id, "replacement", authPath), /managed by Pi/);
			assert.equal(await removeApiKey(id, authPath), false);
		}
		assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), managed);
	});
});

test("replacing and removing a literal key preserve sibling credential fields", async () => {
	const siblings = { type: "api_key", env: { SHARED: "keep" }, metadata: { another: true } };
	await tempAuthFile({ exa: { ...siblings, key: "old" } }, async (path) => {
		await storeApiKey("exa", "new", path);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { exa: { ...siblings, key: "new" } });
		assert.equal(await removeApiKey("exa", path), true);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { exa: siblings });
		await storeApiKey("exa", "restored", path);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { exa: { ...siblings, key: "restored" } });
	});
});
