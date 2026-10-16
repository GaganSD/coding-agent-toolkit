/**
 * Test runner: compiles the strict test tree (src + tests, same compiler
 * flags as production, NodeNext .js specifiers) into
 * node_modules/.automode-test-tmp/test-tree, copies the inert fixtures, and
 * runs `node --test` on the COMPILED JavaScript — no raw-TS `.js` specifier
 * problem, no loader dependency.
 *
 * ANY compiler diagnostic fails the run non-zero (noEmitOnError: true): there
 * is no known-error whitelist. Test files are enumerated explicitly (compiled
 * *.test.js) because Node's directory-based discovery ignores trees under
 * node_modules.
 *
 * Test-suite partition: `--suite unit` and `--suite integration` select the
 * disjoint halves listed in the monorepo `scripts/packages.mjs` (the same
 * partition repo CI uses); no argument runs every compiled test file.
 *
 * Fixture temp root: PI_AUTOMODE_TEST_TMPDIR when explicitly set, else the
 * OS temp dir. The base is never .git-derived (core protects all .git
 * metadata) and never inside the package root. Only the unique subdirectory
 * this runner creates is removed; a caller-provided base is left untouched.
 *
 * SDK isolation: the native SDK's SessionManager resolves its agent dir from
 * the GLOBAL environment (PI_CODING_AGENT_DIR, else HOME-derived), ignoring
 * any caller-provided agentDir. Each test file therefore runs in its own
 * `node --test` process with a unique runner-owned HOME (+USERPROFILE) and
 * PI_CODING_AGENT_DIR, both under tmpRoot and removed with it, so fallback
 * SDK session/state writes can never touch the real home, auth, or session
 * files. PI_OFFLINE=1 and PI_SKIP_VERSION_CHECK=1 block live provider/model
 * and version-check traffic. The child environment is an ALLOWLIST, not an
 * inheritance: only PATH and locale/terminal basics (LANG, LC_*, TERM,
 * NO_COLOR, COLORTERM) pass through. Live provider keys, cloud profiles,
 * auth commands, and real PI_* settings never reach the test children; tests
 * set their own dummy fixture env (BASH_ENV, fake PATH, ...) explicitly.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const suiteArgv = process.argv.slice(2);
const suiteIndex = suiteArgv.findIndex((arg) => arg === "--suite" || arg.startsWith("--suite="));
const suite = suiteIndex < 0
	? "all"
	: suiteArgv[suiteIndex].startsWith("--suite=")
		? suiteArgv[suiteIndex].slice("--suite=".length)
		: suiteArgv[suiteIndex + 1];
if (!["all", "unit", "integration"].includes(suite)) {
	console.error(`run-tests: unknown suite "${suite}" (expected unit, integration, or all)`);
	process.exit(1);
}

let integration;
try {
	const { packageConfig } = await import("../../scripts/packages.mjs");
	integration = new Set(packageConfig("pi-automode").integration);
} catch (error) {
	console.error(
		`run-tests: cannot load the pi-automode suite partition from scripts/packages.mjs: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
	process.exit(1);
}

const scratch = path.join(root, "node_modules", ".automode-test-tmp");
const tree = path.join(scratch, "test-tree");

rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });

const tmpBase = process.env.PI_AUTOMODE_TEST_TMPDIR ?? os.tmpdir();
mkdirSync(tmpBase, { recursive: true });
const tmpRoot = mkdtempSync(path.join(tmpBase, "pi-automode-test-"));

const tsc = path.join(root, "node_modules", ".bin", "tsc");
const compile = spawnSync(tsc, ["-p", "tsconfig.test.json"], { cwd: root, encoding: "utf8" });
const compileOutput = `${compile.stdout ?? ""}${compile.stderr ?? ""}`.trim();
if (compile.error || compile.status !== 0 || compileOutput.includes("error TS")) {
	if (compileOutput) console.error(compileOutput);
	if (compile.error) console.error(`run-tests: failed to spawn tsc: ${compile.error.message}`);
	console.error("run-tests: test-tree compile failed (any diagnostic is fatal)");
	process.exit(1);
}

// ESM marker so the compiled tree resolves as ESM regardless of lookup roots.
writeFileSync(path.join(tree, "package.json"), `${JSON.stringify({ type: "module" })}\n`);

const fixtureSrc = path.join(root, "tests", "fixtures");
if (existsSync(fixtureSrc)) {
	cpSync(fixtureSrc, path.join(tree, "tests", "fixtures"), { recursive: true });
}

const testDir = path.join(tree, "tests");
const testFiles = readdirSync(testDir)
	.filter((name) => name.endsWith(".test.js"))
	.sort()
	.map((name) => path.join(testDir, name))
	.filter((file) => {
		if (suite === "all") return true;
		const source = path.relative(testDir, file).replace(/\.test\.js$/, ".test.ts");
		return integration.has(source) === (suite === "integration");
	});
if (testFiles.length === 0) {
	console.error(`run-tests: no compiled *.test.js files found for suite "${suite}"`);
	process.exit(1);
}
console.error(`run-tests: running ${testFiles.length} compiled test files`);

// Bounded file concurrency: the deadline tests use deliberately tiny fake
// TTLs (well under the real >=5s floor) around real disk I/O; running all
// files in parallel on a loaded machine inflates the pre-execution chain past
// those TTLs and flakes. Four files at a time keeps wall time low without
// starving the timing-sensitive files. One process per file so each gets its
// own isolated HOME/PI_CODING_AGENT_DIR (env is per-process).
let cursor = 0;
const ENV_ALLOWLIST = new Set(["PATH", "LANG", "TERM", "NO_COLOR", "COLORTERM"]);
const isolatedEnv = () => {
	const home = mkdtempSync(path.join(tmpRoot, "home-"));
	const agentDir = path.join(home, "pi-coding-agent");
	mkdirSync(agentDir, { recursive: true });
	const env = {
		TMPDIR: tmpRoot,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_AUTOMODE_PACKAGE_ROOT: root,
	};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && (ENV_ALLOWLIST.has(key) || key.startsWith("LC_"))) env[key] = value;
	}
	return env;
};
const runFile = (file) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test", file], { cwd: root, env: isolatedEnv() });
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => {
			process.stderr.write(out);
			resolve(1);
		});
		child.on("close", (code) => {
			process.stdout.write(out);
			resolve(code ?? 1);
		});
	});
const worker = async () => {
	let failures = 0;
	while (cursor < testFiles.length) {
		const file = testFiles[cursor];
		cursor += 1;
		if ((await runFile(file)) !== 0) failures += 1;
	}
	return failures;
};
const workers = Array.from({ length: Math.min(4, testFiles.length) }, () => worker());
const failures = (await Promise.all(workers)).reduce((sum, n) => sum + n, 0);
rmSync(tmpRoot, { recursive: true, force: true });
if (failures > 0) console.error(`run-tests: ${failures} test file(s) failed`);
process.exit(failures > 0 ? 1 : 0);
