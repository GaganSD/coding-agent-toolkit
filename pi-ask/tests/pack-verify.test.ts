import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-ask-pack-verify-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files = [
		"src/index.ts", "skills/ask-user/SKILL.md", "README.md", "CHANGELOG.md",
		"LICENSE", "llms.txt", "assets/multi.png", "assets/single.png", "assets/text.png",
	];
	for (const path of files) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), "fixture\n");
	}
	await writeFile(join(root, "package.json"), JSON.stringify({
		name: "pi-ask-pack-fixture", version: "1.0.0", type: "module",
		files: ["src", "skills", "assets", "README.md", "CHANGELOG.md", "LICENSE", "llms.txt", "tests"],
	}));
	await mkdir(join(root, "scripts"));
	await writeFile(join(root, "scripts/pack-verify.mjs"), await readFile(
		new URL("../scripts/pack-verify.mjs", import.meta.url), "utf8"
	));
	return {
		root,
		run: () => spawnSync(process.execPath, [join(root, "scripts/pack-verify.mjs")], {
			cwd: root, encoding: "utf8",
		}),
	};
}

test("pack verifier validates the actual package", () => {
	const result = spawnSync(process.execPath, [
		fileURLToPath(new URL("../scripts/pack-verify.mjs", import.meta.url)),
	], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pack:verify: ok/);
});

test("pack verifier accepts the required package contents", async (t) => {
	const { run } = await fixture(t);
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pack:verify: ok/);
});

test("pack verifier rejects missing required files", async (t) => {
	const { root, run } = await fixture(t);
	await rm(join(root, "skills/ask-user/SKILL.md"));
	const result = run();
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /missing from tarball:\n {2}skills\/ask-user\/SKILL.md/);
});

test("pack verifier rejects root and nested development trees", async (t) => {
	const { root, run } = await fixture(t);
	for (const path of ["tests/leak.ts", "src/tests/leak.ts", "src/scripts/leak.mjs"]) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), "fixture\n");
		const result = run();
		assert.equal(result.status, 1, `${path}: ${result.stdout}\n${result.stderr}`);
		assert.ok(result.stderr.includes(path), result.stderr);
		await rm(join(root, path));
	}
});
