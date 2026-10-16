import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWrappedTools, type StockToolDefinition, type StockToolFactories } from "../src/tools.js";
import { Gate, AutomodeBlockError, type GateCall, type GateUiContext } from "../src/gate.js";
import { ApprovalManager } from "../src/approval.js";
import { EpochController } from "../src/runtime/epoch.js";
import { SettingsStore } from "../src/settings.js";
import { LogStore } from "../src/logs.js";
import { buildEvidence } from "../src/evidence.js";
import { evaluatePolicy } from "../src/policy.js";
import type { HostShellOptions } from "../src/runtime/host.js";

// ------------------------------------------------------------------ fake stock factories

interface FakeDefCall {
	params: unknown;
}

function fakeFactories(record: { options: Record<string, unknown>[]; calls: FakeDefCall[] }) {
	const make =
		(name: string) =>
		(cwd: string, options?: Record<string, unknown>): StockToolDefinition => {
			record.options.push({ name, cwd, ...(options ?? {}) });
			return {
				name,
				label: name,
				description: `fake ${name}`,
				parameters: {},
				async execute(_id: string, params: never) {
					record.calls.push({ params });
					return { content: [{ type: "text", text: `ran ${name}` }], details: undefined };
				},
			} as unknown as StockToolDefinition;
		};
	const factories: StockToolFactories = {
		read: make("read"),
		edit: make("edit"),
		write: make("write"),
		bash: make("bash"),
	};
	return factories;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

const FAKE_SESSION = {
	sessionManager: {
		getSessionId: () => "test-session",
		getSessionFile: () => undefined,
	},
	model: undefined,
	thinkingLevel: undefined,
};

const TOOL_CTX = {
	mode: "tui",
	hasUI: true,
	cwd: "/work",
	ui: { async select() { return undefined; }, notify() {} },
	...FAKE_SESSION,
};

// ------------------------------------------------------------------ delegation with a fake gate

test("wrappers replace the four builtins by name", () => {
	const record = { options: [] as Record<string, unknown>[], calls: [] as FakeDefCall[] };
	const gate = { state: "off" } as unknown as Gate;
	const defs = createWrappedTools({ cwd: "/work", gate, factories: fakeFactories(record), host: () => ({}) });
	assert.deepEqual(defs.map((d) => d.name), ["read", "edit", "write", "bash"]);
});

test("Off delegates to stock execution with original args, host options, no gate, no logs", async () => {
	const record = { options: [] as Record<string, unknown>[], calls: [] as FakeDefCall[] };
	const gate = {
		state: "off",
		executeGuarded: () => {
			throw new Error("gate must not run while Off");
		},
	} as unknown as Gate;
	const host: HostShellOptions = { shellCommandPrefix: "source ~/.profile", shellPath: "/bin/zsh", imageAutoResize: false };
	const defs = createWrappedTools({ cwd: "/work", gate, factories: fakeFactories(record), host: () => host });
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	const args = { command: "ls -la" };
	const result = await bash.execute("t1", args as never, undefined, undefined, TOOL_CTX);
	assert.equal((result as { content: { text: string }[] }).content[0]?.text, "ran bash");
	assert.equal(record.calls[0]?.params, args, "Off passes the original args object through unchanged");
	const bashOff = record.options.find((o) => o.name === "bash" && "commandPrefix" in o);
	assert.equal(bashOff?.commandPrefix, "source ~/.profile", "Off uses the host-configured prefix exactly like stock");
	assert.equal(bashOff?.shellPath, "/bin/zsh");
});

test("On routes through the gate and plain factories never see shell customization", async () => {
	const record = { options: [] as Record<string, unknown>[], calls: [] as FakeDefCall[] };
	const gated: GateCall<unknown>[] = [];
	const gate = {
		state: "on",
		async executeGuarded(call: GateCall<unknown>) {
			gated.push(call);
			return call.run(call.args as Record<string, unknown>);
		},
	} as unknown as Gate;
	const host: HostShellOptions = { shellCommandPrefix: "source ~/.profile", shellPath: "/bin/zsh" };
	const defs = createWrappedTools({ cwd: "/work", gate, factories: fakeFactories(record), host: () => host });
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	await bash.execute("t2", { command: "npm test" } as never, undefined, undefined, TOOL_CTX);
	assert.equal(gated.length, 1);
	assert.equal(gated[0]?.tool, "bash");
	assert.deepEqual(gated[0]?.args, { command: "npm test" });
	const bashOn = record.options.find((o) => o.name === "bash" && !("commandPrefix" in o));
	assert.ok(bashOn, "On bash factory got no commandPrefix/shellPath");
	assert.ok(!record.options.some((o) => o.name === "bash" && "commandPrefix" in o && gated.length > 0));
});

test("a gate block throws and stock execute never runs", async () => {
	const record = { options: [] as Record<string, unknown>[], calls: [] as FakeDefCall[] };
	const gate = {
		state: "on",
		async executeGuarded(): Promise<never> {
			throw new AutomodeBlockError("policy says no");
		},
	} as unknown as Gate;
	const defs = createWrappedTools({ cwd: "/work", gate, factories: fakeFactories(record), host: () => ({}) });
	const write = defs.find((d) => d.name === "write") as StockToolDefinition;
	await assert.rejects(write.execute("t3", { path: "x", content: "y" } as never, undefined, undefined, TOOL_CTX), /policy says no/);
	assert.equal(record.calls.length, 0, "blocked calls invoke no executor");
});

// ------------------------------------------------------------------ real wiring: real gate + real core + real Pi definitions

let REAL: string;
let REAL_WS: string;
let REAL_HOME: string;

before(() => {
	REAL = realpathSync(mkdtempSync(join(tmpdir(), "automode-tools-")));
	REAL_WS = join(REAL, "ws");
	REAL_HOME = join(REAL, "home");
	mkdirSync(REAL_WS, { recursive: true });
	mkdirSync(REAL_HOME, { recursive: true });
});

after(() => {
	rmSync(REAL, { recursive: true, force: true });
});

async function realWiring() {
	// Real Pi tool factories: the actual helpers that would execute.
	const pi = await import("@earendil-works/pi-coding-agent");
	const factories: StockToolFactories = {
		read: (cwd, opts) => pi.createReadToolDefinition(cwd, opts) as unknown as StockToolDefinition,
		edit: (cwd) => pi.createEditToolDefinition(cwd) as unknown as StockToolDefinition,
		write: (cwd) => pi.createWriteToolDefinition(cwd) as unknown as StockToolDefinition,
		bash: (cwd, opts) => pi.createBashToolDefinition(cwd, opts) as unknown as StockToolDefinition,
	};
	const agentDir = join(REAL, `agent-${Math.random().toString(36).slice(2)}`);
	mkdirSync(agentDir, { recursive: true });
	const settings = new SettingsStore(join(agentDir, "automode.json"));
	await settings.load();
	await settings.update({ ...settings.current, enabled: true });
	const logs = new LogStore(join(agentDir, "automode-logs.json"));
	const epochs = new EpochController();
	const approval = new ApprovalManager({ settings, epochs });
	const gate = new Gate({
		settings,
		logs,
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval,
		epochs,
		dirs: { workspace: REAL_WS, agentDir, extensionDir: join(REAL, "ext"), homeDir: REAL_HOME },
		host: () => ({}),
	});
	const defs = createWrappedTools({ cwd: REAL_WS, gate, factories, host: () => ({}), detectImageMimeType: pi.detectSupportedImageMimeTypeFromFile });
	const ctx = {
		mode: "print",
		hasUI: false,
		ui: { async select() { return undefined; } },
		cwd: REAL_WS,
		...FAKE_SESSION,
	} as unknown as GateUiContext;
	return { defs, gate, settings, logs, agentDir, ctx };
}

test("real wiring: floor-allowed read returns real file contents through the stock helper", async () => {
	writeFileSync(join(REAL_WS, "real.txt"), "real-contents");
	const { defs, ctx } = await realWiring();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	const result = (await read.execute("w1", { path: "real.txt" } as never, undefined, undefined, ctx)) as {
		content: { text?: string }[];
	};
	assert.match(String(result.content[0]?.text ?? result.content), /real-contents/);
});

test("real wiring: @-prefixed write at the protected store is blocked and the file is untouched", async () => {
	const { defs, agentDir, ctx } = await realWiring();
	const target = join(agentDir, "automode.json");
	const beforeContent = readFileSync(target, "utf8");
	const write = defs.find((d) => d.name === "write") as StockToolDefinition;
	await assert.rejects(
		write.execute("w2", { path: `@${target}`, content: "tampered" } as never, undefined, undefined, ctx),
		AutomodeBlockError,
	);
	assert.equal(readFileSync(target, "utf8"), beforeContent);
});

test("real wiring: tilde read of a home secret does not return its contents while On", async () => {
	mkdirSync(join(REAL_HOME, ".ssh"), { recursive: true });
	writeFileSync(join(REAL_HOME, ".ssh", "id_rsa"), "SECRET-KEY-MATERIAL");
	const { defs, ctx } = await realWiring();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	// print mode: sensitive ask cannot be approved → blocked, helper never ran.
	await assert.rejects(
		read.execute("w3", { path: "~/.ssh/id_rsa" } as never, undefined, undefined, ctx),
		AutomodeBlockError,
	);
});

test("real wiring: unicode-space path reads the same file that was reviewed", async () => {
	writeFileSync(join(REAL_WS, "uni name.txt"), "uni-contents");
	const { defs, ctx } = await realWiring();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	const result = (await read.execute("w4", { path: "uni name.txt" } as never, undefined, undefined, ctx)) as {
		content: { text?: string }[];
	};
	assert.match(String(result.content[0]?.text ?? result.content), /uni-contents/);
});

test("real wiring: missing read target blocks instead of hitting helper fallback variants", async () => {
	const { defs, ctx } = await realWiring();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	await assert.rejects(
		read.execute("w5", { path: "definitely-missing.txt" } as never, undefined, undefined, ctx),
		/fallback path variants/,
	);
});

test("real wiring: Off delegates to stock bash and actually runs the command", async () => {
	const { defs, settings, gate, ctx } = await realWiring();
	await settings.update({ ...settings.current, enabled: false });
	gate.operatorUpdated();
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	const result = (await bash.execute(
		"w6",
		{ command: "echo off-mode-works" } as never,
		undefined,
		undefined,
		ctx,
	)) as { content: { text?: string }[]; details?: { exitCode?: number } };
	const text = result.content.map((c) => c.text ?? "").join("\n");
	assert.match(text, /off-mode-works/);
});

// ------------------------------------------------------------------ IO-boundary read enforcement (real Pi helper)

test("real wiring: a post-review fallback variant redirect is blocked at the read IO boundary", async () => {
	// The reviewed exact target exists at evidence time, then vanishes before
	// the helper reads (deletion window); Pi's helper would silently fall back
	// to the AM/PM narrow-no-break-space variant — a file that was NEVER
	// reviewed. The On read operations must refuse it at access/read/mime.
	const exact = join(REAL_WS, "shot PM.txt");
	const variant = join(REAL_WS, "shot PM.txt"); // narrow no-break space
	writeFileSync(exact, "reviewed-content");
	const { ctx } = await realWiring();
	const pi = await import("@earendil-works/pi-coding-agent");
	const riggedFactories: StockToolFactories = {
		read: (cwd, opts) => {
			const def = pi.createReadToolDefinition(cwd, opts) as unknown as StockToolDefinition;
			return {
				...def,
				execute: async (id: string, params: never, sig: AbortSignal | undefined, upd: unknown, c: unknown) => {
					// Simulate the deletion window: exact reviewed target disappears
					// and an unreviewed fallback variant appears, post-approval.
					rmSync(exact, { force: true });
					writeFileSync(variant, "fallback-secret");
					return def.execute(id, params, sig, upd, c);
				},
			} as StockToolDefinition;
		},
		edit: (cwd) => pi.createEditToolDefinition(cwd) as unknown as StockToolDefinition,
		write: (cwd) => pi.createWriteToolDefinition(cwd) as unknown as StockToolDefinition,
		bash: (cwd, opts) => pi.createBashToolDefinition(cwd, opts) as unknown as StockToolDefinition,
	};
	const agentDir2 = join(REAL, `agent-${Math.random().toString(36).slice(2)}`);
	mkdirSync(agentDir2, { recursive: true });
	const settings = new SettingsStore(join(agentDir2, "automode.json"));
	await settings.load();
	await settings.update({ ...settings.current, enabled: true });
	const logs = new LogStore(join(agentDir2, "automode-logs.json"));
	const epochs = new EpochController();
	const gate = new Gate({
		settings,
		logs,
		buildEvidence,
		evaluatePolicy,
		reviewer: null,
		approval: new ApprovalManager({ settings, epochs }),
		epochs,
		dirs: { workspace: REAL_WS, agentDir: agentDir2, extensionDir: join(REAL, "ext"), homeDir: REAL_HOME },
		host: () => ({}),
	});
	const riggedDefs = createWrappedTools({
		cwd: REAL_WS,
		gate,
		factories: riggedFactories,
		host: () => ({}),
		detectImageMimeType: pi.detectSupportedImageMimeTypeFromFile,
	});
	const read = riggedDefs.find((d) => d.name === "read") as StockToolDefinition;
	try {
		await assert.rejects(
			read.execute("io-1", { path: "shot PM.txt" } as never, undefined, undefined, ctx),
			/never reviewed|fallback path variants/,
		);
	} finally {
		rmSync(variant, { force: true });
		rmSync(exact, { force: true });
	}
});

test("real wiring: Off keeps the stock read fallback variants (deliberate stock behavior)", async () => {
	// Exact target missing, narrow-no-break-space variant present: stock Pi
	// reads the variant. While Off the wrapper must not interfere.
	const variant = join(REAL_WS, "shot AM.txt"); // narrow no-break space
	writeFileSync(variant, "stock-variant-content");
	const { defs, settings, gate, ctx } = await realWiring();
	await settings.update({ ...settings.current, enabled: false });
	gate.operatorUpdated();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	try {
		const result = (await read.execute("io-2", { path: "shot AM.txt" } as never, undefined, undefined, ctx)) as {
			content: { text?: string }[];
		};
		assert.match(result.content.map((c) => c.text ?? "").join("\n"), /stock-variant-content/);
	} finally {
		rmSync(variant, { force: true });
	}
});

test("real wiring: On preserves native image reads at the reviewed target", async () => {
	// 1x1 transparent PNG.
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
	writeFileSync(join(REAL_WS, "pixel.png"), png);
	const { defs, ctx } = await realWiring();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	const result = (await read.execute("io-3", { path: "pixel.png" } as never, undefined, undefined, ctx)) as {
		content: ({ type: string; text?: string } | undefined)[];
	};
	const text = result.content.map((c) => c?.text ?? "").join("\n");
	const hasImageBlock = result.content.some((c) => c?.type === "image");
	assert.ok(hasImageBlock || /image\/png/.test(text), `native image behavior must be preserved while On, got: ${text}`);
});

// ------------------------------------------------------------------ frozen session cwd routing

test("Off and On delegates build stock tools with the frozen session cwd, not the registration cwd", async () => {
	const record = { options: [] as Record<string, unknown>[], calls: [] as FakeDefCall[] };
	let state: "off" | "on" = "off";
	const gated: GateCall<unknown>[] = [];
	const gate = {
		get state() {
			return state;
		},
		async executeGuarded(call: GateCall<unknown>) {
			gated.push(call);
			const frozenCwd = typeof call.ctx.cwd === "string" && call.ctx.cwd.length > 0 ? call.ctx.cwd : undefined;
			return call.run(call.args as Record<string, unknown>, frozenCwd !== undefined ? { cwd: frozenCwd } : undefined);
		},
	} as unknown as Gate;
	const defs = createWrappedTools({ cwd: "/work", gate, factories: fakeFactories(record), host: () => ({}) });
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	const childCtx = { ...TOOL_CTX, cwd: "/work/child" };
	await bash.execute("cwd-off", { command: "ls" } as never, undefined, undefined, childCtx);
	assert.equal(
		record.options.filter((o) => o.name === "bash").at(-1)?.cwd,
		"/work/child",
		"Off stock helper resolves against the session cwd",
	);
	state = "on";
	await bash.execute("cwd-on", { command: "ls" } as never, undefined, undefined, childCtx);
	assert.equal(gated[0]?.ctx.cwd, "/work/child", "the gate reviews against the frozen session cwd");
	assert.equal(
		record.options.filter((o) => o.name === "bash" && !("commandPrefix" in o)).at(-1)?.cwd,
		"/work/child",
		"On reviewed execution runs in the same frozen cwd that was reviewed",
	);
});

test("real wiring: On bash reviews and executes in the frozen session cwd (root/child same filename)", async () => {
	const child = join(REAL_WS, "child");
	mkdirSync(child, { recursive: true });
	writeFileSync(join(REAL_WS, "marker.txt"), "ROOT-MARKER");
	writeFileSync(join(child, "marker.txt"), "CHILD-MARKER");
	const { defs } = await realWiring();
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	// Fake TUI confirm: exact read-only command, approved once.
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { async select() { return "Allow once"; }, notify() {} },
		cwd: child,
		...FAKE_SESSION,
	} as unknown as GateUiContext;
	const result = (await bash.execute("cwd-1", { command: "cat marker.txt" } as never, undefined, undefined, ctx)) as {
		content: { text?: string }[];
	};
	const text = result.content.map((c) => c.text ?? "").join("\n");
	assert.match(text, /CHILD-MARKER/);
	assert.doesNotMatch(text, /ROOT-MARKER/, "review and native execution must use the same frozen cwd");
});

test("real wiring: On read resolves the literal target in the frozen session cwd, not the registration cwd", async () => {
	writeFileSync(join(REAL_WS, "marker.txt"), "ROOT-MARKER");
	const child = join(REAL_WS, "child-read");
	mkdirSync(child, { recursive: true });
	writeFileSync(join(child, "marker.txt"), "CHILD-READ-MARKER");
	const { defs } = await realWiring();
	const read = defs.find((d) => d.name === "read") as StockToolDefinition;
	// Exact read-only floor allow in print mode: no dialog needed.
	const ctx = {
		mode: "print",
		hasUI: false,
		ui: { async select() { return undefined; } },
		cwd: child,
		...FAKE_SESSION,
	} as unknown as GateUiContext;
	const result = (await read.execute("cwd-2", { path: "marker.txt" } as never, undefined, undefined, ctx)) as {
		content: { text?: string }[];
	};
	const text = result.content.map((c) => c.text ?? "").join("\n");
	assert.match(text, /CHILD-READ-MARKER/);
	assert.doesNotMatch(text, /ROOT-MARKER/, "the per-call cwd, not the registration cwd, is enforced at the read IO boundary");
});

test("real wiring: On bash passes a frozen ctx copy — a late ctx.cwd mutation cannot retarget the helper", async () => {
	// Pi's stock bash helper resolves against ctx?.cwd AT EXECUTION TIME. The
	// On run callback must hand it a frozen copy pinned to the reviewed cwd,
	// never the mutable shared ctx object.
	const child = join(REAL_WS, "child-frozen-ctx");
	mkdirSync(child, { recursive: true });
	writeFileSync(join(REAL_WS, "ctxmarker.txt"), "ROOT-CTX-MARKER");
	writeFileSync(join(child, "ctxmarker.txt"), "CHILD-CTX-MARKER");
	const { defs } = await realWiring();
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	let approve: (() => void) | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			select() {
				return new Promise<string | undefined>((resolve) => {
					approve = () => resolve("Allow once");
				});
			},
			notify() {},
		},
		cwd: child,
		...FAKE_SESSION,
	} as unknown as GateUiContext;
	const pending = bash.execute("cwd-mut-1", { command: "cat ctxmarker.txt" } as never, undefined, undefined, ctx) as Promise<{
		content: { text?: string }[];
	}>;
	await waitFor(() => approve !== undefined); // approval dialog open
	(ctx as { cwd: string }).cwd = REAL_WS; // late mutation of the shared mutable ctx
	approve?.();
	const result = await pending;
	const text = result.content.map((c) => c.text ?? "").join("\n");
	assert.match(text, /CHILD-CTX-MARKER/);
	assert.doesNotMatch(text, /ROOT-CTX-MARKER/, "the helper must resolve against the reviewed cwd, not the mutated ctx.cwd");
});

test("real wiring: a session cwd outside the workspace blocks before any execution or upload", async () => {
	const outside = join(REAL, "outside-ws");
	mkdirSync(outside, { recursive: true });
	const { defs } = await realWiring();
	const bash = defs.find((d) => d.name === "bash") as StockToolDefinition;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { async select() { return "Allow once"; }, notify() {} },
		cwd: outside,
		...FAKE_SESSION,
	} as unknown as GateUiContext;
	await assert.rejects(
		bash.execute("cwd-3", { command: "cat marker.txt" } as never, undefined, undefined, ctx),
		/outside the verified workspace/,
	);
});
