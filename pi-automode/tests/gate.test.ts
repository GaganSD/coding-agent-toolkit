import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Gate, AutomodeBlockError, type GateUiContext } from "../src/gate.js";
import { ApprovalManager } from "../src/approval.js";
import { EpochController } from "../src/runtime/epoch.js";
import { SettingsStore } from "../src/settings.js";
import { LogStore } from "../src/logs.js";
import { buildEvidence } from "../src/evidence.js";
import { evaluatePolicy } from "../src/policy.js";
import { type AutomodeSettings } from "../src/types.js";
import type { ReviewReceipt } from "../src/reviewer.js";

/**
 * Gate tests run against the REAL core modules (settings/evidence/policy/logs)
 * and real temp files; only UI dialogs, the reviewer and the stock executor
 * are faked. No network, no paid API calls.
 */

// ------------------------------------------------------------------ harness

let ROOT: string;
let WS: string;
let AGENT: string;
let EXT: string;
let HOME: string;

before(() => {
	ROOT = realpathSync(mkdtempSync(join(tmpdir(), "automode-gate-")));
	WS = join(ROOT, "ws");
	AGENT = join(ROOT, "agent");
	EXT = join(ROOT, "ext");
	HOME = join(ROOT, "home");
	for (const dir of [WS, AGENT, EXT, HOME]) mkdirSync(dir, { recursive: true });
});

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

interface HarnessOptions {
	settings?: Partial<AutomodeSettings>;
	answers?: (string | "wait")[];
	reviewerReceipt?: Record<string, unknown>;
	registryModels?: Record<string, { baseUrl?: string }>;
	mode?: string;
	hasUI?: boolean;
	initialFile?: string | null;
}

async function makeHarness(opts: HarnessOptions = {}) {
	const agentDir = realpathSync(mkdtempSync(join(ROOT, "agent-run-")));
	const settingsPath = join(agentDir, "automode.json");
	if (opts.initialFile !== null && opts.initialFile !== undefined) {
		writeFileSync(settingsPath, opts.initialFile);
	}
	const settings = new SettingsStore(settingsPath);
	await settings.load();
	if (opts.settings) {
		await settings.update({ ...settings.current, ...opts.settings });
	}
	const logs = new LogStore(join(agentDir, "automode-logs.json"));
	const epochs = new EpochController();
	const approval = new ApprovalManager({ settings, epochs });
	const reviewerCalls: unknown[][] = [];
	const reviewer = {
		calls: reviewerCalls,
		async review(...args: unknown[]): Promise<ReviewReceipt> {
			reviewerCalls.push(args);
			return (opts.reviewerReceipt ?? { status: "ok", source: "fake", output: { answer: "allow" } }) as unknown as ReviewReceipt;
		},
	};
	const selectCalls: string[] = [];
	const pendingSelects: Array<(answer: string | undefined) => void> = [];
	const answers = [...(opts.answers ?? [])];
	const ui = {
		async select(title: string, _options: string[], selOpts?: { signal?: AbortSignal }) {
			selectCalls.push(title);
			const next = answers.length > 0 ? answers.shift() : "wait";
			if (next !== "wait") return next;
			return new Promise<string | undefined>((resolveFn) => {
				pendingSelects.push(resolveFn);
				const signal = selOpts?.signal;
				if (!signal) return;
				if (signal.aborted) return resolveFn(undefined);
				signal.addEventListener("abort", () => resolveFn(undefined), { once: true });
			});
		},
		notify() {},
	};
	const ctx: GateUiContext = {
		mode: opts.mode ?? "tui",
		hasUI: opts.hasUI ?? true,
		ui,
		modelRegistry: {
			findOfType(_t: string, provider: string, model: string) {
				return opts.registryModels?.[`${provider}/${model}`];
			},
		},
		cwd: WS,
	};
	const dirs = { workspace: WS, agentDir, extensionDir: EXT, homeDir: HOME };
	const gate = new Gate({
		settings,
		logs,
		buildEvidence,
		evaluatePolicy,
		reviewer,
		approval,
		epochs,
		dirs,
		host: () => ({}),
	});
	const runs: Record<string, unknown>[] = [];
	const run = async (args: Record<string, unknown>) => {
		runs.push(args);
		return { ran: true, args };
	};
	return { settings, logs, epochs, approval, reviewer, reviewerCalls, gate, ui, selectCalls, pendingSelects, ctx, dirs, runs, run, settingsPath, agentDir };
}

async function logEntries(logs: LogStore, settings: SettingsStore) {
	return logs.read(settings.current);
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/**
 * Live-TUI keepalive for deadline tests. These tests await only unref'd
 * AbortSignal.timeout timers behind the fake UI, so without a referenced
 * handle the test-process event loop would drain mid-test and node --test
 * would cancel the rest of the file. A real TUI keeps the loop alive; this
 * finite referenced timer simulates that handle. It is always cleared via
 * `finally`; the finite bound means a genuine hang still drains and surfaces
 * as a failure instead of being masked.
 */
function tuiKeepalive(ms = 30_000): () => void {
	const timer = setTimeout(() => {}, ms);
	return () => clearTimeout(timer);
}

// ------------------------------------------------------------------ basics

test("workspace floor allow executes with frozen args and logs the allow", async () => {
	writeFileSync(join(WS, "note.txt"), "hello");
	const h = await makeHarness({ settings: { enabled: true } });
	const result = await h.gate.executeGuarded({
		tool: "read",
		args: { path: "note.txt" },
		requestId: "r1",
		ctx: h.ctx,
		run: h.run,
	});
	assert.equal((result as { ran: boolean }).ran, true);
	const executed = h.runs[0] as { path: string };
	assert.equal(executed.path, join(WS, "note.txt"), "helper receives the resolved absolute path");
	assert.ok(Object.isFrozen(h.runs[0]));
	const entries = await logEntries(h.logs, h.settings);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.outcome, "allow");
	assert.equal(entries[0]?.source, "policy:workspace-floor");
	// Original local action recorded raw.
	assert.equal(entries[0]?.action.args.path, "note.txt");
});

test("post-validation mutation of the original args cannot change what runs", async () => {
	writeFileSync(join(WS, "a.txt"), "a");
	const h = await makeHarness({ settings: { enabled: true } });
	const args: Record<string, unknown> = { path: "a.txt" };
	const promise = h.gate.executeGuarded({ tool: "read", args, requestId: "r2", ctx: h.ctx, run: h.run });
	args.path = "../../etc/passwd"; // too late: args were validated and frozen at entry
	await promise;
	assert.equal((h.runs[0] as { path: string }).path, join(WS, "a.txt"));
});

test("protected write blocks and never reaches the executor", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	const target = join(h.agentDir, "automode.json");
	const beforeContent = readFileSync(target, "utf8");
	await assert.rejects(
		h.gate.executeGuarded({
			tool: "write",
			args: { path: target, content: "tampered" },
			requestId: "r3",
			ctx: h.ctx,
			run: h.run,
		}),
		AutomodeBlockError,
	);
	assert.equal(h.runs.length, 0);
	assert.equal(readFileSync(target, "utf8"), beforeContent, "protected store untouched");
	const entries = await logEntries(h.logs, h.settings);
	assert.equal(entries[0]?.outcome, "block");
	assert.equal(entries[0]?.source, "policy:protected-write");
});

test("ask path: allow-once executes once after revalidation; decline blocks replay", async () => {
	const h = await makeHarness({ settings: { enabled: true }, answers: ["Allow once"] });
	const run1 = await h.gate.executeGuarded({
		tool: "bash",
		args: { command: "npm test -- parser" },
		requestId: "r4",
		ctx: h.ctx,
		run: h.run,
	});
	assert.equal((run1 as { ran: boolean }).ran, true);
	let entries = await logEntries(h.logs, h.settings);
	assert.deepEqual(
		entries.map((e) => [e.outcome, e.source]),
		[
			["ask", "policy:no-matching-rule"],
			["allow", "approval-once"],
		],
	);

	// Decline the next distinct command; an identical retry never re-asks.
	const h2 = await makeHarness({ settings: { enabled: true }, answers: ["Decline"] });
	await assert.rejects(
		h2.gate.executeGuarded({
			tool: "bash",
			args: { command: "git push --force" },
			requestId: "r5",
			ctx: h2.ctx,
			run: h2.run,
		}),
		/declined/,
	);
	const dialogsBefore = h2.selectCalls.length;
	await assert.rejects(
		h2.gate.executeGuarded({
			tool: "bash",
			args: { command: "git push --force" },
			requestId: "r6",
			ctx: h2.ctx,
			run: h2.run,
		}),
		/declined|retry stays blocked/,
	);
	assert.equal(h2.selectCalls.length, dialogsBefore, "decline replay suppressed without a dialog");
	assert.equal(h2.runs.length, 0);
	entries = await logEntries(h2.logs, h2.settings);
	assert.ok(entries.some((e) => e.source === "decline-replay"));
});

// ------------------------------------------------------------------ path translation regressions (real tempfiles)

test("@-prefixed absolute write cannot reach the protected settings store", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	const target = join(h.agentDir, "automode.json");
	const beforeContent = readFileSync(target, "utf8");
	await assert.rejects(
		h.gate.executeGuarded({
			tool: "write",
			args: { path: `@${target}`, content: "tampered" },
			requestId: "r7",
			ctx: h.ctx,
			run: h.run,
		}),
		AutomodeBlockError,
	);
	assert.equal(h.runs.length, 0);
	assert.equal(readFileSync(target, "utf8"), beforeContent, "@-prefixed write must not modify the protected store");
});

test("tilde read resolves to the real home target and is never silently floor-allowed", async () => {
	mkdirSync(join(HOME, ".ssh"), { recursive: true });
	writeFileSync(join(HOME, ".ssh", "id_rsa"), "SECRET-KEY");
	const h = await makeHarness({ settings: { enabled: true }, mode: "print", hasUI: false });
	await assert.rejects(
		h.gate.executeGuarded({ tool: "read", args: { path: "~/.ssh/id_rsa" }, requestId: "r8", ctx: h.ctx, run: h.run }),
		AutomodeBlockError,
	);
	assert.equal(h.runs.length, 0, "home secret never reaches the executor");
	const entries = await logEntries(h.logs, h.settings);
	// Sensitive target: local Ask → no UI here → approval_required block. Never a floor allow.
	assert.ok(entries.every((e) => e.outcome !== "allow"));
	assert.ok(entries.some((e) => e.source === "policy:sensitive-read"));
});

test("read fallback variants cannot redirect a reviewed path while On", async () => {
	// Only the curly-quote/NFD-style variant exists; the plain name does not.
	const variant = join(WS, "Capture d’écran.png");
	writeFileSync(variant, "VARIANT-CONTENT");
	const h = await makeHarness({ settings: { enabled: true } });
	await assert.rejects(
		h.gate.executeGuarded({
			tool: "read",
			args: { path: "Capture d'écran.png" }, // straight apostrophe: exact target missing
			requestId: "r9",
			ctx: h.ctx,
			run: h.run,
		}),
		/fallback path variants are not reviewable/,
	);
	assert.equal(h.runs.length, 0);
});

test("unicode-space path is translated so evidence and execution see the same file", async () => {
	writeFileSync(join(WS, "uni file.txt"), "unicode");
	const h = await makeHarness({ settings: { enabled: true } });
	await h.gate.executeGuarded({
		tool: "read",
		args: { path: "uni file.txt" },
		requestId: "r10",
		ctx: h.ctx,
		run: h.run,
	});
	assert.equal((h.runs[0] as { path: string }).path, join(WS, "uni file.txt"));
	const entries = await logEntries(h.logs, h.settings);
	assert.equal(entries[0]?.outcome, "allow");
});

// ------------------------------------------------------------------ lifecycle / drift

test("external settings drift halts guarded execution — even an external enabled=false", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	// External edit (not through the store): same shape, one field changed.
	writeFileSync(h.settingsPath, JSON.stringify({ ...h.settings.current, logMaxEntries: 42 }, null, 2));
	await assert.rejects(
		h.gate.executeGuarded({ tool: "read", args: { path: "x" }, requestId: "d1", ctx: h.ctx, run: h.run }),
		/changed on disk/,
	);
	assert.equal(h.gate.state, "halted");
	assert.equal(h.runs.length, 0);

	// External disarm attempt: enabled=false written outside the operator path.
	const h2 = await makeHarness({ settings: { enabled: true } });
	writeFileSync(h2.settingsPath, JSON.stringify({ ...h2.settings.current, enabled: false }, null, 2));
	await assert.rejects(
		h2.gate.executeGuarded({ tool: "read", args: { path: "x" }, requestId: "d2", ctx: h2.ctx, run: h2.run }),
		/changed on disk/,
	);
	assert.equal(h2.gate.state, "halted", "external enabled=false must halt, not silently open the gate");
});

test("operator re-verification clears the halt; confirmed off delegates again", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	writeFileSync(h.settingsPath, JSON.stringify({ ...h.settings.current, logMaxEntries: 42 }, null, 2));
	await assert.rejects(
		h.gate.executeGuarded({ tool: "read", args: { path: "x" }, requestId: "v1", ctx: h.ctx, run: h.run }),
		/changed on disk/,
	);
	const reverified = await h.gate.reverify();
	assert.equal(reverified.ok, true);
	assert.equal(h.gate.state, "on");
	// Confirmed operator Off through the store: checks removed deliberately.
	await h.settings.update({ ...h.settings.current, enabled: false });
	h.gate.operatorUpdated();
	assert.equal(h.gate.state, "off");
	assert.equal(h.gate.coverageHook({ toolName: "anything" }), undefined);
});

test("invalid initial configuration halts instead of silently passing as Off", async () => {
	const h = await makeHarness({ initialFile: "{ not json" });
	assert.equal(h.settings.error !== null, true);
	assert.equal(h.gate.state, "halted");
	await assert.rejects(
		h.gate.executeGuarded({ tool: "read", args: { path: "x" }, requestId: "i1", ctx: h.ctx, run: h.run }),
		/halted/,
	);
	assert.equal(h.runs.length, 0);
	assert.equal(h.gate.coverageHook({ toolName: "read" })?.block, true);
});

test("off-mid-flight: turning Off cancels a held ask and nothing executes late", async () => {
	const h = await makeHarness({ settings: { enabled: true }, answers: ["wait"] });
	const pending = h.gate.executeGuarded({
		tool: "bash",
		args: { command: "git push origin main" },
		requestId: "m1",
		ctx: h.ctx,
		run: h.run,
	});
	await waitFor(() => h.approval.pendingCount === 1);
	await h.settings.update({ ...h.settings.current, enabled: false });
	h.gate.operatorUpdated(); // confirmed operator Off: invalidates the epoch
	await assert.rejects(pending, /cancelled|turned off/);
	assert.equal(h.runs.length, 0, "late completion never executes");
});

test("a block rule added while its approval dialog is open stops that action", async () => {
	const h = await makeHarness({ settings: { enabled: true }, answers: ["wait"] });
	const pending = h.gate.executeGuarded({
		tool: "bash",
		args: { command: "make deploy" },
		requestId: "p1",
		ctx: h.ctx,
		run: h.run,
	});
	await waitFor(() => h.pendingSelects.length === 1);
	// Operator policy edit mid-approval (rule edits do not invalidate the
	// lifecycle epoch; the settings epoch revalidation must catch it).
	await h.settings.update({
		...h.settings.current,
		blocklist: [{ type: "command", text: "make deploy" }],
	});
	h.pendingSelects.shift()?.("Allow once");
	await assert.rejects(pending, /invalidated|policy or session changed/);
	assert.equal(h.runs.length, 0);
});

test("evidence drift between approval and execution blocks the run", async () => {
	writeFileSync(join(WS, ".env"), "SECRET=1");
	const h = await makeHarness({ settings: { enabled: true }, answers: ["wait"] });
	const pending = h.gate.executeGuarded({
		tool: "read",
		args: { path: ".env" },
		requestId: "e1",
		ctx: h.ctx,
		run: h.run,
	});
	await waitFor(() => h.pendingSelects.length === 1);
	writeFileSync(join(WS, ".env"), "SECRET=2-changed"); // content change breaks the fingerprint
	h.pendingSelects.shift()?.("Allow once");
	await assert.rejects(pending, /changed while awaiting approval/);
	assert.equal(h.runs.length, 0);
});

// ------------------------------------------------------------------ coverage / integrity

test("coverage hook blocks unknown, custom, nested and codemode routes while On", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	assert.equal(h.gate.coverageHook({ toolName: "codemode" })?.block, true);
	assert.equal(h.gate.coverageHook({ toolName: "my_custom_tool" })?.block, true);
	assert.equal(h.gate.coverageHook({ toolName: "read", parentToolCallId: "x/1" })?.block, true);
	assert.equal(h.gate.coverageHook({ toolName: "bash", parentToolCallId: "x/1" })?.block, true);
	assert.equal(h.gate.coverageHook({ toolName: "read" }), undefined);
	assert.equal(h.gate.coverageHook({ toolName: "bash" }), undefined);
	// While Off: no opinion, no logging.
	await h.settings.update({ ...h.settings.current, enabled: false });
	h.gate.operatorUpdated();
	assert.equal(h.gate.coverageHook({ toolName: "codemode" }), undefined);
});

test("malformed post-hook args block before evidence is built", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: 42 }, requestId: "b1", ctx: h.ctx, run: h.run }),
		/must be a string/,
	);
	await assert.rejects(
		h.gate.executeGuarded(
			{ tool: "read", args: { path: "x", offset: "lots" }, requestId: "b2", ctx: h.ctx, run: h.run },
		),
		/finite number/,
	);
	assert.equal(h.runs.length, 0);
	const entries = await logEntries(h.logs, h.settings);
	assert.ok(entries.every((e) => e.outcome === "block" && e.source === "integrity"));
});

test("ambient shell customization blocks bash while On", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	const gated = new Gate({
		settings: h.settings,
		logs: h.logs,
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval: h.approval,
		epochs: h.epochs,
		dirs: h.dirs,
		host: () => ({ shellCommandPrefix: "source ~/.profile" }),
	});
	await assert.rejects(
		gated.executeGuarded({ tool: "bash", args: { command: "ls" }, requestId: "s1", ctx: h.ctx, run: h.run }),
		/ambient shell customization/,
	);
	assert.equal(h.runs.length, 0);
});

test("decision log failure on an allow path blocks execution", async () => {
	writeFileSync(join(WS, "logged.txt"), "x");
	const h = await makeHarness({ settings: { enabled: true } });
	const gated = new Gate({
		settings: h.settings,
		logs: { async append() { throw new Error("disk full"); } },
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval: h.approval,
		epochs: h.epochs,
		dirs: h.dirs,
		host: () => ({}),
	});
	await assert.rejects(
		gated.executeGuarded({ tool: "read", args: { path: "logged.txt" }, requestId: "l1", ctx: h.ctx, run: h.run }),
		/decision log unavailable/,
	);
	assert.equal(h.runs.length, 0, "logging failure must not silently become permission");
});

test("guarded executions are serialized", async () => {
	writeFileSync(join(WS, "s1.txt"), "1");
	writeFileSync(join(WS, "s2.txt"), "2");
	const h = await makeHarness({ settings: { enabled: true } });
	let active = 0;
	let maxActive = 0;
	const slowRun = async (args: Record<string, unknown>) => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 10));
		active -= 1;
		return args;
	};
	await Promise.all([
		h.gate.executeGuarded({ tool: "read", args: { path: "s1.txt" }, requestId: "c1", ctx: h.ctx, run: slowRun }),
		h.gate.executeGuarded({ tool: "read", args: { path: "s2.txt" }, requestId: "c2", ctx: h.ctx, run: slowRun }),
	]);
	assert.equal(maxActive, 1, "no model sibling write/review races");
});

// ------------------------------------------------------------------ shadow reviewer consent binding

async function askHarness(consent: Partial<AutomodeSettings>, baseUrl?: string) {
	return makeHarness({
		settings: {
			enabled: true,
			classifier: { provider: "typesafe", model: "jev-1.13.2" },
			// Consent binds provider+model too; tests override to drift them.
			disclosureProvider: "typesafe",
			disclosureModel: "jev-1.13.2",
			...consent,
		},
		answers: ["Decline"],
		registryModels: { "typesafe/jev-1.13.2": baseUrl === undefined ? {} : { baseUrl } },
		reviewerReceipt: { status: "ok", source: "fake", output: { answer: "allow" } },
	});
}

test("shadow reviewer runs with bound consent, and its allow-ish receipt never relaxes policy", async () => {
	const endpoint = "https://api.typesafe.ai/v1";
	const h = await askHarness(
		{ disclosureConsent: "approved", disclosureEndpoint: endpoint, disclosureWorkspace: WS },
		endpoint,
	);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "j1", ctx: h.ctx, run: h.run }),
		/declined/,
	);
	assert.equal(h.reviewerCalls.length, 1, "shadow review happened with bound consent");
	assert.equal(h.runs.length, 0, "shadow receipt never approves");
	const entries = await logEntries(h.logs, h.settings);
	const askEntry = entries.find((e) => e.outcome === "ask");
	assert.ok(askEntry?.classifier !== undefined, "receipt recorded on the log");
});

test("same provider/model with a different endpoint is NOT consented — no reviewer call", async () => {
	const h = await askHarness(
		{ disclosureConsent: "approved", disclosureEndpoint: "https://api.typesafe.ai/v1", disclosureWorkspace: WS },
		"https://evil.example.com/v1",
	);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "j2", ctx: h.ctx, run: h.run }),
		/declined/,
	);
	assert.equal(h.reviewerCalls.length, 0, "endpoint drift stays local");
});

test("different workspace than the consented binding is NOT consented", async () => {
	const endpoint = "https://api.typesafe.ai/v1";
	const h = await askHarness(
		{ disclosureConsent: "approved", disclosureEndpoint: endpoint, disclosureWorkspace: "/somewhere/else" },
		endpoint,
	);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "j3", ctx: h.ctx, run: h.run }),
	);
	assert.equal(h.reviewerCalls.length, 0, "workspace drift stays local");
});

test("approved consent with missing bindings is NOT consented", async () => {
	const endpoint = "https://api.typesafe.ai/v1";
	const h = await askHarness(
		{ disclosureConsent: "approved", disclosureEndpoint: null, disclosureWorkspace: null },
		endpoint,
	);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "j4", ctx: h.ctx, run: h.run }),
	);
	assert.equal(h.reviewerCalls.length, 0, "unbound approval cannot upload");
});

test("consent bound to a different provider/model is NOT consented — no reviewer call", async () => {
	const endpoint = "https://api.typesafe.ai/v1";
	for (const drift of [
		{ disclosureProvider: "typesafe", disclosureModel: "jev-OLD" },
		{ disclosureProvider: "othertype", disclosureModel: "jev-1.13.2" },
	]) {
		const h = await askHarness(
			{ disclosureConsent: "approved", ...drift, disclosureEndpoint: endpoint, disclosureWorkspace: WS },
			endpoint,
		);
		await assert.rejects(
			h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "jm1", ctx: h.ctx, run: h.run }),
			/declined/,
		);
		assert.equal(h.reviewerCalls.length, 0, `provider/model drift stays local: ${JSON.stringify(drift)}`);
	}
});

test("credential/query-bearing endpoint is refused, never leaked to", async () => {
	const h = await askHarness(
		{
			disclosureConsent: "approved",
			disclosureEndpoint: "https://api.typesafe.ai/v1",
			disclosureWorkspace: WS,
		},
		"https://key:secret@api.typesafe.ai/v1?token=1#frag",
	);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "j5", ctx: h.ctx, run: h.run }),
	);
	assert.equal(h.reviewerCalls.length, 0);
});

test("shadow review receives only the scope signal — no gate-level equal-timeout races the reviewer's deadline", async () => {
	const endpoint = "https://api.typesafe.ai/v1";
	const h = await askHarness(
		{
			disclosureConsent: "approved",
			disclosureEndpoint: endpoint,
			disclosureWorkspace: WS,
			reviewTimeoutMs: 250, // minimum bound: an equal gate timeout WOULD fire here
		},
		endpoint,
	);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "rm -rf build" }, requestId: "sig-rev-1", ctx: h.ctx, run: h.run }),
		/declined/,
	);
	assert.equal(h.reviewerCalls.length, 1);
	const signal = h.reviewerCalls[0]?.[3] as AbortSignal | undefined;
	assert.ok(signal instanceof AbortSignal, "the reviewer receives a caller signal");
	// Well past reviewTimeoutMs: a gate-level AbortSignal.timeout(250) mixed
	// into this signal would have fired by now. The scope signal must not have
	// — the reviewer's own deadline owns timeout/breaker accounting.
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(signal.aborted, false, "no gate-level review timeout is mixed into the reviewer signal");
	// It IS the scope/lifecycle signal: session invalidation aborts it.
	h.gate.invalidate("test-invalidation");
	assert.equal(signal.aborted, true, "the reviewer signal is the scope/lifecycle signal");
});

// ------------------------------------------------------------------ async-boundary regressions (parent-confirmed repro)

test("REPRO: a deferred Allow audit append + operator Off never releases execution", async () => {
	writeFileSync(join(WS, "deferred.txt"), "x");
	const h = await makeHarness({ settings: { enabled: true } });
	// Log store whose append the test controls: the Allow record is deferred
	// until the operator has already turned Automode Off.
	let releaseAppend: (() => void) | undefined;
	let appendCalls = 0;
	const gateLocal = new Gate({
		settings: h.settings,
		logs: {
			append: () => {
				appendCalls += 1;
				if (appendCalls > 1) return Promise.resolve();
				return new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
			},
		},
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval: h.approval,
		epochs: h.epochs,
		dirs: h.dirs,
		host: () => ({}),
	});
	const pending = gateLocal.executeGuarded({
		tool: "read",
		args: { path: "deferred.txt" },
		requestId: "defer-1",
		ctx: h.ctx,
		run: h.run,
	});
	await waitFor(() => appendCalls === 1);
	// Operator turns Off while the Allow audit append is still in flight.
	await h.settings.update({ ...h.settings.current, enabled: false });
	gateLocal.operatorUpdated();
	releaseAppend?.();
	await assert.rejects(pending, /turned off|invalidated|operator settings update/);
	assert.equal(h.runs.length, 0, "native executor must not run after operator Off (expected 0, old bug ran 1)");
});

test("REPRO: a deferred Allow audit append + workspace-target symlink swap never executes", async () => {
	const victim = join(WS, "swap-target.txt");
	writeFileSync(victim, "original");
	const h = await makeHarness({ settings: { enabled: true } });
	const protectedTarget = join(h.agentDir, "automode.json");
	const beforeContent = readFileSync(protectedTarget, "utf8");
	// Defer ONLY the allow audit append; the write is a workspace-floor allow,
	// so this is the first (and only) log await before execution.
	let releaseAllow: (() => void) | undefined;
	const gateLocal = new Gate({
		settings: h.settings,
		logs: {
			append: (entry) => {
				if (entry.outcome === "allow" && releaseAllow === undefined) {
					return new Promise<void>((resolve) => {
						releaseAllow = resolve;
					});
				}
				return h.logs.append(entry, h.settings.current);
			},
		},
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval: h.approval,
		epochs: h.epochs,
		dirs: h.dirs,
		host: () => ({}),
	});
	const pending = gateLocal.executeGuarded({
		tool: "write",
		args: { path: "swap-target.txt", content: "PWNED" },
		requestId: "swap-1",
		ctx: h.ctx,
		run: h.run,
	});
	await waitFor(() => releaseAllow !== undefined);
	// While the allow audit append is in flight, the reviewed workspace file is
	// replaced by a symlink to the protected store. The settings reload after
	// the append sees no drift; only the final evidence rebuild can catch this.
	rmSync(victim);
	symlinkSync(protectedTarget, victim);
	releaseAllow?.();
	await assert.rejects(pending, /changed while awaiting approval/);
	assert.equal(h.runs.length, 0, "the swapped target must never execute");
	assert.equal(readFileSync(protectedTarget, "utf8"), beforeContent, "protected store untouched");
});

test("external enabled=false written DURING the approval dialog halts before execution", async () => {
	const h = await makeHarness({ settings: { enabled: true }, answers: ["wait"] });
	const pending = h.gate.executeGuarded({
		tool: "bash",
		args: { command: "npm test -- parser" },
		requestId: "ext-1",
		ctx: h.ctx,
		run: h.run,
	});
	await waitFor(() => h.pendingSelects.length === 1);
	// External write (not through the store, not through the operator UI).
	writeFileSync(h.settingsPath, JSON.stringify({ ...h.settings.current, enabled: false }, null, 2));
	h.pendingSelects.shift()?.("Allow once");
	await assert.rejects(pending, /changed on disk|invalidated/);
	assert.equal(h.gate.state, "halted", "external enabled=false must halt, not open the gate");
	assert.equal(h.runs.length, 0, "no execution after external disarm, even with an approval answer");
});

test("Off->On never revives an old queued call", async () => {
	writeFileSync(join(WS, "hold.txt"), "1");
	writeFileSync(join(WS, "queued.txt"), "2");
	const h = await makeHarness({ settings: { enabled: true } });
	let releaseSlow: (() => void) | undefined;
	const slowRun = async (args: Record<string, unknown>) => {
		h.runs.push(args);
		await new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		return args;
	};
	const first = h.gate.executeGuarded({ tool: "read", args: { path: "hold.txt" }, requestId: "q1", ctx: h.ctx, run: slowRun });
	await waitFor(() => h.runs.length === 1);
	const second = h.gate.executeGuarded({ tool: "read", args: { path: "queued.txt" }, requestId: "q2", ctx: h.ctx, run: h.run });
	await waitFor(() => h.gate.pendingManaged === 2);
	// Operator Off, then back On, while call2 sits in the mutex queue.
	await h.settings.update({ ...h.settings.current, enabled: false });
	h.gate.operatorUpdated();
	await assert.rejects(second, /operator settings update|invalidated|turned off/);
	await h.settings.update({ ...h.settings.current, enabled: true });
	h.gate.operatorUpdated();
	releaseSlow?.();
	await first;
	// The re-enabled gate accepts NEW calls, but the old queued call is dead.
	assert.equal(h.runs.length, 1, "the old queued call must not revive across Off->On");
	assert.equal((h.runs[0] as { path: string }).path, join(WS, "hold.txt"));
	const again = await h.gate.executeGuarded({ tool: "read", args: { path: "queued.txt" }, requestId: "q3", ctx: h.ctx, run: h.run });
	assert.equal((again as { ran: boolean; args: { path: string } }).args.path, join(WS, "queued.txt"));
});

test("pending managed calls are bounded at 32 including the mutex queue", async () => {
	writeFileSync(join(WS, "bound.txt"), "x");
	const h = await makeHarness({ settings: { enabled: true } });
	let releaseSlow: (() => void) | undefined;
	const slowRun = async (args: Record<string, unknown>) => {
		h.runs.push(args);
		await new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		return args;
	};
	const first = h.gate.executeGuarded({ tool: "read", args: { path: "bound.txt" }, requestId: "b0", ctx: h.ctx, run: slowRun });
	await waitFor(() => h.runs.length === 1);
	const queued: Promise<unknown>[] = [];
	for (let i = 1; i <= 31; i += 1) {
		queued.push(h.gate.executeGuarded({ tool: "read", args: { path: "bound.txt" }, requestId: `b${i}`, ctx: h.ctx, run: h.run }));
	}
	await waitFor(() => h.gate.pendingManaged === 32);
	await assert.rejects(
		h.gate.executeGuarded({ tool: "read", args: { path: "bound.txt" }, requestId: "b-overflow", ctx: h.ctx, run: h.run }),
		/too many pending guarded actions/,
	);
	releaseSlow?.();
	const settled = await Promise.allSettled(queued);
	await first;
	assert.ok(settled.every((s) => s.status === "fulfilled"), "queued calls complete once the holder releases");
});

// Fake store with a test-controlled approval deadline (the real store
// enforces >= 5s). Gate reads approvalTimeoutMs ONCE per call at
// executeGuarded entry (the entry deadline), so the mutable knob lets a test
// give the mutex holder a generous admission budget while a later queued call
// gets a tight deadline — no race between the real FS/log chain and a tiny
// shared TTL. The epoch still delegates to the real store, so adjusting the
// knob never trips the settings-epoch invalidation.
function fakeStoreWithMutableTimeout(base: SettingsStore, initialMs: number) {
	let timeoutMs = initialMs;
	const store = {
		get current() {
			return { ...base.current, approvalTimeoutMs: timeoutMs };
		},
		get epoch() {
			return base.epoch;
		},
		get error() {
			return base.error;
		},
		reload: () => base.reload(),
	};
	return {
		store,
		setTimeoutMs(ms: number) {
			timeoutMs = ms;
		},
	};
}

test("the approval deadline covers the execution-mutex queue wait", async () => {
	const releaseKeepalive = tuiKeepalive();
	writeFileSync(join(WS, "ttl.txt"), "x");
	const h = await makeHarness({ settings: { enabled: true } });
	// The holder enters with a generous finite budget, so its real FS/log
	// admission chain (observed ~99ms worst case) can never flake; the tight
	// 60ms deadline is armed only AFTER the holder provably sits in the
	// executor, so the queued call — and only the queued call — expires.
	const budget = fakeStoreWithMutableTimeout(h.settings, 30_000);
	const gateLocal = new Gate({
		settings: budget.store,
		logs: h.logs,
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval: h.approval,
		epochs: h.epochs,
		dirs: h.dirs,
		host: () => ({}),
	});
	let releaseSlow: (() => void) | undefined;
	const slowRun = async (args: Record<string, unknown>) => {
		h.runs.push(args);
		await new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		return args;
	};
	let firstSettled = false;
	const first = gateLocal.executeGuarded({ tool: "read", args: { path: "ttl.txt" }, requestId: "t1", ctx: h.ctx, run: slowRun });
	first.then(
		() => {
			firstSettled = true;
		},
		() => {
			firstSettled = true;
		},
	);
	try {
		await waitFor(() => h.runs.length === 1); // holder provably reached the executor
		budget.setTimeoutMs(60); // only the NEXT entry gets the tight deadline
		const second = gateLocal.executeGuarded({ tool: "read", args: { path: "ttl.txt" }, requestId: "t2", ctx: h.ctx, run: h.run });
		await assert.rejects(second, /deadline expired while pending/);
		assert.equal(firstSettled, false, "the queued call expired WHILE the holder still held the mutex");
		assert.equal(h.runs.length, 1, "the expired queued call never reaches the executor");
	} finally {
		releaseSlow?.(); // release the holder even if an assertion above failed
		releaseKeepalive();
	}
	await first;
	assert.equal(h.runs.length, 1, "the expired queued call never runs");
});

test("an approved long-running command is NOT killed by the approval deadline", async () => {
	const releaseKeepalive = tuiKeepalive();
	try {
		const h = await makeHarness({ settings: { enabled: true }, answers: ["Allow once"] });
		// Finite TTL comfortably larger than the real admission chain (FS/log +
		// dialog, ~99ms worst case observed) and comfortably smaller than the
		// execution below: approval happens well inside the budget, and the run
		// returning at all proves execution outlived the lapsed pending TTL.
		const TTL_MS = 1_000;
		const budget = fakeStoreWithMutableTimeout(h.settings, TTL_MS);
		const gateLocal = new Gate({
			settings: budget.store,
			logs: h.logs,
			buildEvidence,
			evaluatePolicy,
			reviewer: null,
			approval: new ApprovalManager({ settings: budget.store, epochs: h.epochs }),
			epochs: h.epochs,
			dirs: h.dirs,
			host: () => ({}),
		});
		const startedAt = Date.now();
		let execStarted = false;
		const result = await gateLocal.executeGuarded({
			tool: "bash",
			args: { command: "npm test -- parser" },
			requestId: "long-1",
			ctx: h.ctx,
			run: async (args) => {
				execStarted = true;
				await new Promise((resolve) => setTimeout(resolve, 2_600)); // outlives the 1s TTL
				return { ran: true, args };
			},
		});
		assert.equal((result as { ran: boolean }).ran, true, "execution must outlive the queue+dialog deadline");
		assert.equal(execStarted, true, "execution actually started after approval");
		assert.ok(
			Date.now() - startedAt > TTL_MS,
			"the call returned only AFTER the pending TTL lapsed — execution was not killed by it",
		);
	} finally {
		releaseKeepalive();
	}
});

test("coverage blocks are audited best-effort (actual decision, not silent)", async () => {
	const h = await makeHarness({ settings: { enabled: true } });
	const blocked = await h.gate.coverageHookAsync(
		{ toolName: "codemode", toolCallId: "cov-1", input: { script: "doThing()" } },
		undefined,
	);
	assert.equal(blocked?.block, true);
	const entries = await logEntries(h.logs, h.settings);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.outcome, "block");
	assert.equal(entries[0]?.source, "coverage");
	assert.equal(entries[0]?.action.tool, "codemode");
	assert.deepEqual(entries[0]?.action.args, { script: "doThing()" });
	// Off: no opinion, no log.
	await h.settings.update({ ...h.settings.current, enabled: false });
	h.gate.operatorUpdated();
	const offResult = await h.gate.coverageHookAsync({ toolName: "codemode", toolCallId: "cov-2", input: {} }, undefined);
	assert.equal(offResult, undefined);
	const after = await logEntries(h.logs, h.settings);
	assert.equal(after.length, 1, "Off coverage has no opinion and no log");
});

test("audit records the frozen entry args; invalid args are explicitly not captured", async () => {
	writeFileSync(join(WS, "frozen.txt"), "x");
	const h = await makeHarness({ settings: { enabled: true } });
	const args: Record<string, unknown> = { path: "frozen.txt" };
	await h.gate.executeGuarded({ tool: "read", args, requestId: "fr-1", ctx: h.ctx, run: h.run });
	args.path = "../../etc/passwd"; // post-hoc mutation must not rewrite history
	let entries = await logEntries(h.logs, h.settings);
	assert.equal(entries[0]?.action.args.path, "frozen.txt", "log binds the actual frozen post-hook args");

	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: 42 }, requestId: "fr-2", ctx: h.ctx, run: h.run }),
		/must be a string/,
	);
	entries = await logEntries(h.logs, h.settings);
	const invalid = entries.at(-1);
	assert.deepEqual(invalid?.action.args, {}, "no fabricated args");
	assert.match(String((invalid?.input as { note?: string } | undefined)?.note ?? ""), /not captured/);
});

test("epoch abort propagates into the stock execution signal (best-effort kill, not undo)", async () => {
	writeFileSync(join(WS, "sig.txt"), "x");
	const h = await makeHarness({ settings: { enabled: true } });
	let observed: AbortSignal | undefined;
	const pending = h.gate.executeGuarded({
		tool: "read",
		args: { path: "sig.txt" },
		requestId: "sig-1",
		ctx: h.ctx,
		run: async (args, guard) => {
			observed = guard?.signal;
			await new Promise<void>((resolve) => {
				guard?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return args;
		},
	});
	await waitFor(() => observed !== undefined);
	h.gate.invalidate("session switch");
	await pending;
	assert.equal(observed?.aborted, true, "the helper sees the epoch abort after execution started");
});

// ------------------------------------------------------------------ frozen session cwd scope

test("a session cwd outside the verified workspace blocks BEFORE any shadow upload — no automatic rebind", async () => {
	const endpoint = "https://api.typesafe.ai/v1";
	const h = await askHarness(
		{ disclosureConsent: "approved", disclosureEndpoint: endpoint, disclosureWorkspace: WS },
		endpoint,
	);
	const outside = join(ROOT, "outside-scope");
	mkdirSync(outside, { recursive: true });
	const ctx: GateUiContext = { ...h.ctx, cwd: outside };
	await assert.rejects(
		h.gate.executeGuarded({ tool: "bash", args: { command: "npm test -- scope" }, requestId: "scope-1", ctx, run: h.run }),
		/outside the verified workspace/,
	);
	assert.equal(h.reviewerCalls.length, 0, "no shadow upload under the OLD workspace consent");
	assert.equal(h.runs.length, 0);
	const entries = await logEntries(h.logs, h.settings);
	assert.equal(entries.at(-1)?.outcome, "block");
	assert.equal(entries.at(-1)?.source, "integrity");
});

test("an action PATH outside the workspace still reaches a local Ask when the session cwd is valid", async () => {
	const h = await makeHarness({ settings: { enabled: true }, answers: ["Allow once"] });
	const outsideFile = join(ROOT, "outside-target.txt");
	writeFileSync(outsideFile, "data");
	const result = await h.gate.executeGuarded({
		tool: "read",
		args: { path: outsideFile },
		requestId: "ask-out-1",
		ctx: h.ctx,
		run: h.run,
	});
	assert.equal((result as { ran: boolean }).ran, true);
	assert.equal(h.selectCalls.length, 1, "local Ask still runs for out-of-workspace paths with a valid cwd scope");
});

test("the session cwd is frozen at entry; a late ctx.cwd mutation cannot retarget execution", async () => {
	const child = join(WS, "late-cwd-child");
	mkdirSync(child, { recursive: true });
	const h = await makeHarness({ settings: { enabled: true }, answers: ["wait"] });
	const ctx: GateUiContext = { ...h.ctx, cwd: child };
	let guardCwd: string | undefined;
	const pending = h.gate.executeGuarded({
		tool: "bash",
		args: { command: "npm test -- late-cwd" },
		requestId: "late-cwd-1",
		ctx,
		run: (args, guard) => {
			guardCwd = guard?.cwd;
			return Promise.resolve({ ran: true, args });
		},
	});
	await waitFor(() => h.pendingSelects.length === 1);
	ctx.cwd = ROOT; // post-entry mutation of the shared ctx (would escape the workspace scope)
	h.pendingSelects.shift()?.("Allow once");
	const result = await pending;
	assert.equal((result as { ran: boolean }).ran, true);
	assert.equal(guardCwd, child, "execution resolves against the entry-frozen cwd, not the mutated ctx");
});

test("a session cwd that is a symlink inside the workspace pointing OUTSIDE blocks for read/write/bash", async () => {
	const h = await makeHarness({ settings: { enabled: true }, answers: ["Allow once"] });
	const outside = join(ROOT, "symlink-cwd-target");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "escaped.txt"), "outside");
	const link = join(WS, "cwd-link");
	symlinkSync(outside, link, "dir");
	const ctx: GateUiContext = { ...h.ctx, cwd: link };
	const attempts: Array<{ tool: "read" | "write" | "bash"; args: Record<string, unknown>; requestId: string }> = [
		{ tool: "read", args: { path: "escaped.txt" }, requestId: "sym-cwd-read" },
		{ tool: "write", args: { path: "new.txt", content: "escape" }, requestId: "sym-cwd-write" },
		{ tool: "bash", args: { command: "ls" }, requestId: "sym-cwd-bash" },
	];
	for (const attempt of attempts) {
		await assert.rejects(
			h.gate.executeGuarded({ ...attempt, ctx, run: h.run }),
			/outside the verified workspace/,
			`${attempt.tool} through a symlinked session cwd must block`,
		);
	}
	assert.equal(h.runs.length, 0, "nothing executed");
	assert.equal(h.reviewerCalls.length, 0, "no shadow upload under the old workspace consent");
	assert.equal(h.selectCalls.length, 0, "no Ask dialog under the old scope");
	const entries = await logEntries(h.logs, h.settings);
	assert.equal(entries.filter((e) => e.source === "integrity" && e.outcome === "block").length, 3);
});
