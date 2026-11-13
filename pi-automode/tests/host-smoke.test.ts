/**
 * Host smoke tests: real Pi 1.1.0 loader, session, and tool execution,
 * fully offline (scripted fake provider, temp agent dir, temp workspace,
 * in-memory sessions where possible). Never touches the real ~/.pi.
 */
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createVerifiedRuntime,
	GUARDED_TOOLS,
	runCheck,
	type LauncherDeps,
} from "../src/launcher.js";
import { createAutomodeExtension } from "../src/index.js";

/**
 * Package root: under the compiled test tree the bin/dist entries live in the
 * real package root, which the runner exports as PI_AUTOMODE_PACKAGE_ROOT.
 */
const PKG_ROOT = process.env.PI_AUTOMODE_PACKAGE_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
import { createFakeProviderExtension, FAKE_MODEL_ID, FAKE_PROVIDER, type FakeTurn } from "./helpers/fake-provider.js";
import { createTestGateProvider, type ExecutedCall } from "./helpers/test-gate.js";
import { createTempEnv, type TempEnv } from "./helpers/temp-env.js";

const execFileAsync = promisify(execFile);

interface Harness {
	env: TempEnv;
	deps: LauncherDeps;
	fatals: string[];
	executed: ExecutedCall[];
}

/**
 * Launcher deps wired to a temp environment: the test gate as
 * `createAutomodeExtension`, the scripted fake provider plus any scenario
 * extensions as `extraInlineExtensions`, fatal/output recorders.
 */
function createHarness(options: {
	env: TempEnv;
	turns: FakeTurn[];
	gate?: Parameters<typeof createTestGateProvider>[0];
	extra?: ExtensionFactory[];
	onExecute?: (call: ExecutedCall) => void;
}): Harness {
	const fatals: string[] = [];
	const executed: ExecutedCall[] = [];
	const deps: LauncherDeps = {
		cwd: options.env.workspace,
		agentDir: options.env.agentDir,
		createAutomodeExtension: createTestGateProvider({
			...options.gate,
			onExecute: (call) => {
				executed.push(call);
				options.onExecute?.(call);
			},
		}),
		extraInlineExtensions: [createFakeProviderExtension(options.turns), ...(options.extra ?? [])],
		onFatal: (message) => fatals.push(message),
		out: () => {},
		err: () => {},
	};
	return { env: options.env, deps, fatals, executed };
}

function fakeEnvSettings(): Record<string, unknown> {
	return { defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL_ID };
}

test("host-smoke: --check verifies the gate offline with no model call", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	let providerCalls = 0;
	const countingProvider: ExtensionFactory = (pi) => {
		createFakeProviderExtension([])(pi);
		pi.on("before_agent_start", () => {
			providerCalls += 1;
		});
	};
	const harness = createHarness({ env, turns: [] });
	harness.deps.extraInlineExtensions = [countingProvider];
	const result = await runCheck(harness.deps);
	assert.equal(providerCalls, 0, "--check must never start an agent run");
	assert.deepEqual(harness.fatals, []);
	assert.equal(result.code, 0, result.lines.join("\n"));
	assert.ok(result.lines.some((line) => line.includes("gate verified")), result.lines.join("\n"));
	assert.ok(result.lines.some((line) => line.includes("state: ON")), result.lines.join("\n"));
	env.cleanup();
});

test("host-smoke: gate factory failure aborts guarded start", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({ env, turns: [], gate: { failOnGenerations: [1] } });
	const result = await runCheck(harness.deps);
	assert.equal(result.code, 1);
	assert.ok(result.lines.join("\n").includes("deliberate load failure"), result.lines.join("\n"));
	env.cleanup();
});

test("host-smoke: missing health receipt fails --check", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({ env, turns: [], gate: { skipHealthOnGenerations: [1] } });
	const result = await runCheck(harness.deps);
	assert.equal(result.code, 1);
	assert.ok(result.lines.join("\n").includes("health"), result.lines.join("\n"));
	env.cleanup();
});

test("host-smoke: gate block at the tool_call boundary prevents the executor", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({
		env,
		turns: [
			{ kind: "toolCalls", calls: [{ name: "bash", args: { command: "echo pwn > blocked-marker.txt" } }] },
			{ kind: "text", text: "done" },
		],
		gate: {
			decide: (_tool, args) =>
				JSON.stringify(args).includes("blocked-marker")
					? { block: true, reason: "test policy" }
					: { block: false },
		},
	});
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.prompt("run the command");
		assert.equal(harness.executed.length, 1, "gate observed the call before blocking");
		assert.equal(existsSync(join(env.workspace, "blocked-marker.txt")), false, "blocked call reached the executor");
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: unknown/custom tool routes are blocked by the gate", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	let evilExecuted = 0;
	const evilTool: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "evil_tool",
			label: "evil",
			description: "test-only tool the gate must not allow",
			parameters: Type.Object({}),
			execute: async () => {
				evilExecuted += 1;
				return { content: [{ type: "text", text: "ran" }], details: undefined };
			},
		});
	};
	const harness = createHarness({
		env,
		turns: [
			{ kind: "toolCalls", calls: [{ name: "evil_tool", args: {} }] },
			{ kind: "text", text: "done" },
		],
		extra: [evilTool],
	});
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.prompt("call the tool");
		assert.equal(evilExecuted, 0, "unguarded tool executed despite the gate");
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: user/project executable resources and project settings are not loaded", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	// User-level extension that would prove execution by writing a marker.
	mkdirSync(join(env.agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(env.agentDir, "extensions", "evil-user.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(env.workspace, "evil-user-loaded.txt"))}, "yes"); }\n`,
	);
	// Project extension + project settings attempting tool widening.
	mkdirSync(join(env.workspace, ".pi", "extensions"), { recursive: true });
	writeFileSync(
		join(env.workspace, ".pi", "extensions", "evil-project.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(env.workspace, "evil-project-loaded.txt"))}, "yes"); }\n`,
	);
	writeFileSync(join(env.workspace, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+powershell", "+grep"] }));
	const harness = createHarness({ env, turns: [] });
	const { runtime, supervisor } = await createVerifiedRuntime(harness.deps);
	try {
		assert.equal(existsSync(join(env.workspace, "evil-user-loaded.txt")), false, "user extension executed");
		assert.equal(existsSync(join(env.workspace, "evil-project-loaded.txt")), false, "project extension executed");
		const active = runtime.session.getActiveToolNames().slice().sort();
		assert.deepEqual(active, [...GUARDED_TOOLS].slice().sort(), "project defaultTools must not widen the tool set");
		const all = runtime.session.getAllTools().map((tool) => tool.name);
		for (const banned of ["codemode", "tool_search", "powershell", "grep"]) {
			assert.ok(!all.includes(banned), `unexpected tool registered: ${banned}`);
		}
		const loaded = runtime.services.resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const paths = loaded.extensions.map((extension) => extension.path).sort();
		assert.deepEqual(paths, ["<inline:automode>", "<inline:2>"].sort(), `unexpected extensions loaded: ${paths.join(", ")}`);
		assert.equal(supervisor.currentGeneration(), 1);
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: reload re-runs the gate and re-reports health", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({ env, turns: [] });
	const { runtime, supervisor } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		assert.equal(supervisor.currentGeneration(), 1);
		assert.equal(supervisor.verifySessionStart().ok, true);
		await runtime.session.reload();
		assert.equal(supervisor.currentGeneration(), 2, "reload must re-invoke the gate factory");
		assert.equal(supervisor.verifySessionStart().ok, true, supervisor.verifySessionStart().problems.join("; "));
		assert.deepEqual(harness.fatals, []);
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: gate failure on reload escalates to fatal instead of running unguarded", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({ env, turns: [], gate: { failOnGenerations: [2] } });
	const { runtime, supervisor } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		assert.equal(supervisor.verifySessionStart().ok, true);
		await runtime.session.reload();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(supervisor.currentGeneration(), 2);
		assert.equal(harness.fatals.length, 1, "reload gate failure must escalate");
		assert.ok(harness.fatals[0]!.includes("deliberate load failure"));
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: provider construction throw on reload escalates to fatal", { timeout: 60_000 }, async () => {
	// Regression: the SDK loader swallows a throw from the gate PROVIDER
	// (factory construction) the same way it swallows a factory execution
	// throw. Before the fix, construction sat outside the supervisor's
	// try/catch: generation 2 was created, no supervisor session_start
	// handler was registered, no fatal fired, and the session continued
	// unguarded. Different layer from the inner factory execution failure
	// covered by "gate failure on reload escalates to fatal".
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({ env, turns: [] });
	const realProvider = harness.deps.createAutomodeExtension;
	let generation = 0;
	harness.deps.createAutomodeExtension = (options) => {
		generation += 1;
		if (generation === 2) throw new Error("inert provider construction failure");
		return realProvider(options);
	};
	const { runtime, supervisor } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		assert.equal(supervisor.verifySessionStart().ok, true);
		await runtime.session.reload();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(supervisor.currentGeneration(), 2);
		const verification = supervisor.verifySessionStart();
		assert.equal(verification.ok, false, "a failed generation must not verify as healthy");
		assert.ok(verification.problems.some((p) => p.includes("inert provider construction failure")));
		assert.equal(harness.fatals.length, 1, "reload provider failure must escalate exactly once");
		assert.ok(harness.fatals[0]!.includes("inert provider construction failure"));
		// Do NOT prompt after fatal here: the recorder does not stop the
		// process. The default fatal policy (which does) is proven by the
		// subprocess test below.
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: default fatal policy fires on reload gate failure (subprocess)", { timeout: 120_000 }, async () => {
	// The recorder seam (onFatal) used elsewhere does not stop the process;
	// this proves the production default (stderr notice + exit 1) actually
	// runs when no onFatal is injected. Runs in a child process because the
	// default policy terminates its host.
	const fixture = fileURLToPath(new URL("./fixtures/default-fatal-child.mjs", import.meta.url));
	const result = await execFileAsync(process.execPath, [fixture]).then(
		() => ({ code: 0, stderr: "" }),
		(error: unknown) => ({
			code: (error as { code?: number }).code,
			stderr: String((error as { stderr?: string }).stderr ?? ""),
		}),
	);
	assert.equal(result.code, 1, `default fatal policy must exit 1; stderr: ${result.stderr}`);
	assert.ok(result.stderr.includes("gate lost"), result.stderr);
	assert.ok(result.stderr.includes("inert provider construction failure"), result.stderr);
});

test("host-smoke: runtime replacement re-verifies the gate", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const harness = createHarness({ env, turns: [] });
	const { runtime, supervisor } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		const result = await runtime.newSession();
		assert.equal(result.cancelled, false);
		assert.equal(supervisor.currentGeneration(), 2, "replacement must re-run the gate factory");
		// The replacement's own load checkpoint ran inside the factory; binding
		// the new session emits its session_start and re-reports health.
		await runtime.session.bindExtensions({ onError: () => {} });
		assert.equal(supervisor.verifySessionStart().ok, true);
		assert.deepEqual(harness.fatals, []);
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: native path adapter semantics survive the wrapper (Off-equivalent delegation)", { timeout: 60_000 }, async () => {
	// Pi's native tools resolve paths with resolveToCwd: a leading "@" is
	// stripped, "~" expands, unicode spaces normalize. A wrapper that passed
	// path.resolve(raw) to the executor would target a DIFFERENT file than
	// the native tool. This test proves the pipeline invokes the real tool
	// with the final post-hook arguments unchanged, i.e. native semantics.
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const outside = join(env.agentDir, "outside-target.txt");
	const harness = createHarness({
		env,
		turns: [
			{ kind: "toolCalls", calls: [{ name: "write", args: { path: `@${outside}`, content: "via-at-prefix" } }] },
			{ kind: "text", text: "done" },
		],
	});
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.prompt("write the file");
		const call = harness.executed.find((entry) => entry.tool === "write");
		assert.equal(call?.args.path, `@${outside}`, "wrapper froze the final raw arguments");
		assert.equal(readFileSync(outside, "utf8"), "via-at-prefix", "native adapter stripped the @ prefix");
		assert.equal(existsSync(join(env.workspace, `@${outside}`)), false, "naive path.resolve target must not exist");
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: while On, an adapter-mismatch write must never floor-allow into an outside target", { timeout: 60_000 }, async () => {
	// Regression for the native path adapter mismatch: core evidence resolves
	// path.resolve(raw) while native tools strip "@"/expand "~". A floor allow
	// decided on the raw path would silently modify a different (possibly
	// protected) file. The conservative gate stand-in blocks file calls whose
	// raw path carries adapter syntax; the real gate regression runs after
	// integration (see the next test).
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const outside = join(env.agentDir, "outside-target.txt");
	const harness = createHarness({
		env,
		turns: [
			{ kind: "toolCalls", calls: [{ name: "write", args: { path: `@${outside}`, content: "must-not-land" } }] },
			{ kind: "text", text: "done" },
		],
		gate: {
			decide: (_tool, args) => {
				const raw = typeof args.path === "string" ? args.path : "";
				return raw.startsWith("@") || raw.startsWith("~") || raw.includes("..")
					? { block: true, reason: "adapter-mismatch path stays conservative" }
					: { block: false };
			},
		},
	});
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.prompt("write the file");
		assert.equal(harness.executed.length, 1, "wrapper observed the call before blocking");
		assert.equal(existsSync(outside), false, "blocked call must not modify the outside target");
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

const REAL_GATE_SETTINGS = {
	version: 1,
	enabled: true,
	decisionModel: null,
	disclosureConsent: "none",
	disclosureEndpoint: null,
	disclosureWorkspace: null,
	allowlist: [],
	blocklist: [],
	logRetentionDays: 7,
	logMaxEntries: 500,
	reviewTimeoutMs: 2000,
	reviewMaxRequests: 100,
	approvalTimeoutMs: 600_000,
};

test("host-smoke: an earlier PATH executable cannot hide behind a trusted agent-bin symlink", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const bin = join(env.agentDir, "bin");
	const earlier = join(env.root, "earlier-bin");
	const marker = join(env.workspace, "malicious-marker");
	mkdirSync(bin);
	mkdirSync(earlier);
	symlinkSync("/bin/ls", join(bin, "ls"));
	writeFileSync(join(earlier, "ls"), `#!/bin/sh\nprintf executed > '${marker}'\n`);
	chmodSync(join(earlier, "ls"), 0o700);
	writeFileSync(join(env.agentDir, "automode.json"), JSON.stringify({
		...REAL_GATE_SETTINGS, allowlist: [{ text: "ls -la" }],
	}));
	const savedPath = process.env.PATH;
	const savedAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PATH = [earlier, "/usr/bin", bin].join(":");
	process.env.PI_CODING_AGENT_DIR = env.agentDir;
	try {
		const harness = createHarness({ env, turns: [
			{ kind: "toolCalls", calls: [{ name: "bash", args: { command: "ls -la" } }] },
			{ kind: "text", text: "done" },
		] });
		harness.deps.createAutomodeExtension = createAutomodeExtension;
		const { runtime } = await createVerifiedRuntime(harness.deps);
		try {
			await runtime.session.bindExtensions({ onError: () => {} });
			await runtime.session.prompt("list files");
			assert.equal(existsSync(marker), false, "untrusted PATH executable ran without approval");
		} finally {
			await runtime.dispose();
		}
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgent;
	}
});

test("host-smoke: dangling links to protected files block before native write", { timeout: 60_000 }, async () => {
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	writeFileSync(join(env.agentDir, "automode.json"), JSON.stringify(REAL_GATE_SETTINGS));
	const targets = [join(env.workspace, ".env"), join(env.workspace, ".git", "config"), join(env.agentDir, "absent.json")];
	const calls = targets.map((target, index) => {
		const alias = join(env.workspace, `notes-${index}.txt`);
		symlinkSync(target, alias);
		return { name: "write", args: { path: alias, content: "must not write" } };
	});
	const harness = createHarness({ env, turns: [{ kind: "toolCalls", calls }, { kind: "text", text: "done" }] });
	harness.deps.createAutomodeExtension = createAutomodeExtension;
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		await runtime.session.prompt("write files");
		for (const target of targets) assert.equal(existsSync(target), false);
		const records = readFileSync(join(env.agentDir, "automode-logs.json"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.length, 3);
		assert.ok(records.every((entry) => entry.outcome === "block" && entry.source === "policy:protected-write"));
	} finally {
		await runtime.dispose();
	}
});

test("host-smoke: real gate floor-allows a plain workspace write end-to-end", { timeout: 60_000 }, async () => {
	// Positive control with the REAL createAutomodeExtension: an inert write
	// canonically inside the workspace is floor-allowed and actually executed
	// by the real Pi session (scripted offline provider; no keys, no cost).
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	writeFileSync(join(env.agentDir, "automode.json"), JSON.stringify(REAL_GATE_SETTINGS), { mode: 0o600 });
	const harness = createHarness({
		env,
		turns: [
			{ kind: "toolCalls", calls: [{ name: "write", args: { path: "floor-ok.txt", content: "floor-allowed" } }] },
			{ kind: "text", text: "done" },
		],
	});
	harness.deps.createAutomodeExtension = createAutomodeExtension;
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		await runtime.session.prompt("write the file");
		assert.equal(readFileSync(join(env.workspace, "floor-ok.txt"), "utf8"), "floor-allowed");
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

for (const probability of [0.999, 0.8]) {
	test(`host-smoke: native safety reviewer ${probability >= 0.99 ? "authorizes" : "refuses"} real Bash execution at the configured threshold`, { timeout: 60_000 }, async () => {
		using env = createTempEnv({ agentSettings: fakeEnvSettings() });
		const endpoint = "https://offline-classifier.example/v1";
		writeFileSync(join(env.agentDir, "automode.json"), JSON.stringify({ ...REAL_GATE_SETTINGS,
			decisionModel: { provider: "offline-classifier", model: "safety-test" }, disclosureConsent: "approved", disclosureVersion: 1,
			disclosureProvider: "offline-classifier", disclosureModel: "safety-test", disclosureEndpoint: endpoint,
			disclosureWorkspace: realpathSync(env.workspace),
		}));
		let classifications = 0;
		const offlineClassifier: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				const model = { provider: "offline-classifier", id: "safety-test", type: "classifier", api: "typesafe-system-one", baseUrl: endpoint };
				// Trusted, test-only registry seam. Production uses the native registry
				// unchanged; no network/provider credentials are present in this test.
				Object.defineProperties(ctx.modelRegistry, {
					findOfType: { value: () => model },
					getAvailableOfType: { value: async () => [model] },
					classify: { value: async (_model: unknown, input: { state: { action?: unknown } }) => {
						classifications++;
						assert.equal((input.state.action as { command: string }).command, "echo");
						return { provider: model.provider, model: model.id, stopReason: "stop", answers: { safety: {
							type: "choice", choice: "safe", confidence: 0.999,
							probabilities: { safe: probability, unsafe: (1 - probability) / 2, uncertain: (1 - probability) / 2 },
						} } };
					} },
				});
			});
		};
		const harness = createHarness({ env, extra: [offlineClassifier], turns: [
			{ kind: "toolCalls", calls: [{ name: "bash", args: { command: "echo" } }] }, { kind: "text", text: "done" },
		] });
		harness.deps.createAutomodeExtension = createAutomodeExtension;
		const { runtime } = await createVerifiedRuntime(harness.deps);
		try {
			await runtime.session.bindExtensions({ onError: () => {} });
			await runtime.session.prompt("run the inert command");
			assert.equal(classifications, 1);
			const result = runtime.session.messages.find((message) => message.role === "toolResult");
			assert.ok(result?.role === "toolResult");
			assert.equal(result.isError, probability < 0.99);
			const records = readFileSync(join(env.agentDir, "automode-logs.json"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(records.some((entry) => entry.outcome === "allow" && entry.source === "native-decision-model:offline-classifier/safety-test"), probability >= 0.99);
		} finally { await runtime.dispose(); }
	});
}

test("host-smoke: real gate never floor-allows an @-prefixed write onto the settings file", { timeout: 60_000 }, async () => {
	// Regression against the REAL gate: while On, a write to "@" +
	// <agentDir>/automode.json must never be floor-allowed by raw-path
	// evidence and then modify the protected file. No skips: the real gate is
	// integrated in this package.
	const realGate = createAutomodeExtension;
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const settingsFile = join(env.agentDir, "automode.json");
	writeFileSync(
		settingsFile,
		JSON.stringify({
			version: 1,
			enabled: true,
			decisionModel: null,
			disclosureConsent: "none",
			disclosureEndpoint: null,
			disclosureWorkspace: null,
			allowlist: [],
			blocklist: [],
			logRetentionDays: 7,
			logMaxEntries: 500,
			reviewTimeoutMs: 2000,
			reviewMaxRequests: 100,
			approvalTimeoutMs: 600_000,
		}),
		{ mode: 0o600 },
	);
	const before = readFileSync(settingsFile, "utf8");
	const harness = createHarness({ env, turns: [
		{ kind: "toolCalls", calls: [{ name: "write", args: { path: `@${settingsFile}`, content: "{\"hacked\":true}" } }] },
		{ kind: "text", text: "done" },
	] });
	harness.deps.createAutomodeExtension = realGate;
	const { runtime } = await createVerifiedRuntime(harness.deps);
	try {
		await runtime.session.bindExtensions({ onError: () => {} });
		await runtime.session.prompt("write the file");
		assert.equal(readFileSync(settingsFile, "utf8"), before, "protected settings file was modified through an adapter-mismatch write");
	} finally {
		await runtime.dispose();
	}
	env.cleanup();
});

test("host-smoke: package manifest declares a valid packed extension entry", { timeout: 60_000 }, async () => {
	// The pi.extensions manifest must point at the packed dist entry, and that
	// entry must actually load and export the gate factory (local install
	// discovery depends on it).
	const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./dist/index.js"]);
	const entry = join(PKG_ROOT, "dist", "index.js");
	assert.ok(existsSync(entry), "dist/index.js must be built before this test (npm test builds first)");
	const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
	assert.equal(typeof mod.default, "function");
	assert.equal(typeof mod.createAutomodeExtension, "function");
});

test("host-smoke: a local install is discovered by the real loader via the pi.extensions manifest", { timeout: 60_000 }, async () => {
	// Stage a local "install": <agentDir>/extensions/pi-automode with the
	// real package.json (pi.extensions manifest) and the built dist. The real
	// Pi loader must discover and load the gate with zero errors.
	using env = createTempEnv({ agentSettings: fakeEnvSettings() });
	const staged = join(env.agentDir, "extensions", "pi-automode");
	mkdirSync(staged, { recursive: true });
	cpSync(join(PKG_ROOT, "package.json"), join(staged, "package.json"));
	cpSync(join(PKG_ROOT, "dist"), join(staged, "dist"), { recursive: true });
	// Module resolution for the staged copy's SDK imports.
	symlinkSync(join(PKG_ROOT, "node_modules"), join(staged, "node_modules"), "dir");

	const { createAgentSessionServices, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const settingsManager = SettingsManager.create(env.workspace, env.agentDir, { projectTrusted: false });
	const services = await createAgentSessionServices({
		cwd: env.workspace,
		agentDir: env.agentDir,
		settingsManager,
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		resourceLoaderOptions: {
			disabledBuiltinExtensions: ["mcp", "codemode", "tool-search", "llama.cpp"],
		},
	});
	const loaded = services.resourceLoader.getExtensions();
	const gateEntry = loaded.extensions.find((extension) => extension.path.includes("pi-automode"));
	assert.ok(gateEntry, `gate not discovered; loaded: ${loaded.extensions.map((e) => e.path).join(", ")}; errors: ${loaded.errors.map((e) => e.error).join("; ")}`);
	assert.equal(loaded.errors.length, 0, loaded.errors.map((e) => `${e.path}: ${e.error}`).join("; "));
	assert.ok((gateEntry.handlers.get("tool_call") ?? []).length > 0, "discovered gate did not register its tool_call hook");
	env.cleanup();
});

test("host-smoke: bin --check verifies the real packed gate and exits 0", { timeout: 120_000 }, async () => {
	// End-to-end CLI: the bin entry loads dist/, verifies the gate before any
	// TUI, and exits — no model calls (offline fake-free: --check never prompts).
	using env = createTempEnv();
	const bin = join(PKG_ROOT, "bin", "pi-automode.js");
	const { stdout } = await execFileAsync(process.execPath, [bin, "--check"], {
		env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir },
		cwd: env.workspace,
	});
	assert.ok(stdout.includes("gate verified"), stdout);
	env.cleanup();
});

test("host-smoke: bin --help prints usage without loading the gate or a model", { timeout: 60_000 }, async () => {
	const bin = join(PKG_ROOT, "bin", "pi-automode.js");
	const { stdout } = await execFileAsync(process.execPath, [bin, "--help"], {
		env: { ...process.env, PI_CODING_AGENT_DIR: join(tmpdir(), "pi-automode-unused-agent") },
	});
	assert.ok(stdout.includes("pi-automode"), stdout);
	assert.ok(stdout.includes("--check"), stdout);
});

test("host-smoke: bin rejects unknown arguments", { timeout: 60_000 }, async () => {
	const bin = join(PKG_ROOT, "bin", "pi-automode.js");
	await assert.rejects(
		execFileAsync(process.execPath, [bin, "--bogus"]),
		(error: unknown) => {
			assert.equal((error as { code?: number }).code, 2);
			return true;
		},
	);
});
