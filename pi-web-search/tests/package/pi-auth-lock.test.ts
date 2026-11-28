import assert from "node:assert/strict";
import fs, { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { storeApiKey } from "../../src/env.ts";
import { withFileLock } from "../../src/file-write.ts";

test("symlinked auth coordinates with Pi's real FileAuthStorageBackend", async (t) => {
	// Test-only import: the class is not part of the public extension SDK.
	const { FileAuthStorageBackend } = await import(new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
		FileAuthStorageBackend: new (path: string) => { withLockAsync<T>(fn: (raw: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> };
	};
	const dir = await mkdtemp(join(tmpdir(), "pi-real-auth-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const target = join(dir, "auth-target.json"), path = join(dir, "auth.json");
	await writeFile(target, '{"another":{"type":"oauth","access":"before"}}');
	await symlink(target, path);
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>((done) => { entered = done; });
	const held = new Promise<void>((done) => { release = done; });
	const pi = new FileAuthStorageBackend(path);
	const refresh = pi.withLockAsync(async (raw) => {
		entered();
		await held;
		const next = JSON.parse(raw!);
		next.another.access = "after";
		return { result: undefined, next: JSON.stringify(next) };
	});
	await ready;
	assert.ok((await lstat(`${path}.lock`)).isDirectory());
	const pending = storeApiKey("parallel", "fixture-parallel", path);
	try { assert.equal(await Promise.race([pending.then(() => true), sleep(100, false)]), false); }
	finally { release(); await refresh; }
	await pending;
	assert.ok((await lstat(path)).isSymbolicLink());
	assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
		another: { type: "oauth", access: "after" }, parallel: { type: "api_key", key: "fixture-parallel" },
	});
});

test("retargeting auth.json after the read cannot copy credentials between profiles", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-retarget-auth-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "auth.json"), a = join(dir, "profile-a.json"), b = join(dir, "profile-b.json");
	await writeFile(a, '{"other":{"type":"api_key","key":"fixture-a"}}');
	await writeFile(b, '{"other":{"type":"api_key","key":"fixture-b"}}');
	await symlink(a, path);
	const targetA = await fs.realpath(a);
	const original = fs.readFile;
	const retarget = t.mock.method(fs, "readFile", async (target: Parameters<typeof original>[0], encoding: "utf8") => {
		const value = await original(target, encoding);
		if (target === targetA || target === path) {
			await fs.unlink(path);
			await symlink(b, path);
		}
		return value;
	});
	syncBuiltinESMExports();
	try { await assert.rejects(storeApiKey("exa", "fixture-exa", path), /auth\.json link changed/); }
	finally { retarget.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(await fs.readlink(path), b);
	assert.equal(JSON.parse(await readFile(a, "utf8")).other.key, "fixture-a");
	assert.deepEqual(JSON.parse(await readFile(b, "utf8")), { other: { type: "api_key", key: "fixture-b" } });
});

test("an alias waits for the canonical target lock and concurrent saves keep both keys", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-auth-alias-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const target = await fs.realpath(dir).then((root) => join(root, "target.json"));
	const alias = join(dir, "auth.json");
	await writeFile(target, "{}");
	await symlink(target, alias);
	let pending!: ReturnType<typeof storeApiKey>;
	await withFileLock(target, async () => {
		pending = storeApiKey("exa", "fixture-exa", alias);
		assert.equal(await Promise.race([pending.then(() => true), sleep(100, false)]), false);
		assert.equal(await readFile(target, "utf8"), "{}");
	}, 30_000);
	await Promise.all([pending, storeApiKey("brave", "fixture-brave", target)]);
	assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
		exa: { type: "api_key", key: "fixture-exa" }, brave: { type: "api_key", key: "fixture-brave" },
	});
});

test("a credential save refuses to overwrite an external edit after reading auth.json", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-auth-revision-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const target = join(await fs.realpath(dir), "auth.json");
	const edited = '{"another":{"type":"oauth","access":"refresh"}}';
	await writeFile(target, "{}");
	const original = fs.readFile;
	let changed = false;
	const edit = t.mock.method(fs, "readFile", async (path: Parameters<typeof original>[0], encoding: "utf8") => {
		const value = await original(path, encoding);
		if (path === target && !changed) {
			changed = true;
			await writeFile(target, edited);
		}
		return value;
	});
	syncBuiltinESMExports();
	try { await assert.rejects(storeApiKey("exa", "fixture-exa", target), /auth\.json changed during the save/); }
	finally { edit.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(await readFile(target, "utf8"), edited);
});
