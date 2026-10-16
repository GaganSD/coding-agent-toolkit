/**
 * Offline unit tests for the launcher: argument parsing, health evaluation,
 * and the supervision wrapper (fake `pi`, no SDK session).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateHealth,
	GateSupervisor,
	GUARDED_TOOLS,
	parseArgs,
	type AutomodeHealth,
	type LauncherDeps,
} from "../src/launcher.js";

const goodHealth: AutomodeHealth = {
	initialized: true,
	guardedTools: [...GUARDED_TOOLS],
	enabled: true,
};

test("parseArgs: help, check, tui, unknown", () => {
	assert.deepEqual(parseArgs(["--help"]), { kind: "help" });
	assert.deepEqual(parseArgs(["-h"]), { kind: "help" });
	assert.deepEqual(parseArgs(["--check"]), { kind: "check" });
	assert.deepEqual(parseArgs([]), { kind: "tui" });
	assert.deepEqual(parseArgs(["--check", "--help"]), { kind: "help" });
	assert.equal(parseArgs(["--bogus"]).kind, "error");
	assert.equal(parseArgs(["foo"]).kind, "error");
});

test("evaluateHealth: accepts a valid receipt, enabled on or off", () => {
	assert.deepEqual(evaluateHealth(goodHealth), []);
	assert.deepEqual(evaluateHealth({ ...goodHealth, enabled: false }), []);
});

test("evaluateHealth: rejects missing, uninitialized, errored, and partial receipts", () => {
	assert.deepEqual(evaluateHealth(undefined), ["gate did not report a health receipt"]);
	assert.ok(evaluateHealth({ ...goodHealth, initialized: false }).some((p) => p.includes("initialized=false")));
	assert.ok(evaluateHealth({ ...goodHealth, error: "boom" }).some((p) => p.includes("boom")));
	const missing = evaluateHealth({ ...goodHealth, guardedTools: ["read", "bash", "edit"] });
	assert.ok(missing.some((p) => p.includes('"write"')));
	assert.ok(
		evaluateHealth({ initialized: "yes", guardedTools: [], enabled: true } as unknown as AutomodeHealth).some((p) =>
			p.includes("invalid shape"),
		),
	);
});

interface FakePi {
	handlers: Map<string, Array<() => unknown>>;
}

function fakePi(): FakePi & { on: (event: string, handler: () => unknown) => void; emit: (event: string) => Promise<void> } {
	const handlers = new Map<string, Array<() => unknown>>();
	return {
		handlers,
		on: (event, handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		emit: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler();
		},
	};
}

function supervisorDeps(overrides: Partial<LauncherDeps> = {}): { deps: LauncherDeps; fatals: string[] } {
	const fatals: string[] = [];
	const deps: LauncherDeps = {
		agentDir: "/tmp/nonexistent-agent",
		createAutomodeExtension: () => () => {},
		...overrides,
	};
	return { deps: { ...deps, onFatal: (message) => fatals.push(message) }, fatals };
}

test("supervisor: healthy gate passes load and session_start verification", async () => {
	const { deps, fatals } = supervisorDeps({
		createAutomodeExtension:
			(options) =>
			(_pi: unknown) => {
				// gate would register handlers here
				options.onHealth(goodHealth);
			},
	});
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const pi = fakePi();
	await (supervisor.inlineExtension() as { factory: (p: unknown) => Promise<void> }).factory(pi);
	const load = supervisor.verifyLoad({
		extensions: [{ path: "<inline:automode>", tools: new Map(), handlers: new Map([["tool_call", [() => undefined]]]) }],
		errors: [],
	});
	assert.equal(load.ok, true, load.problems.join("; "));
	await pi.emit("session_start");
	assert.equal(supervisor.verifySessionStart().ok, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(fatals, []);
});

test("supervisor: factory throw is recorded and escalates to fatal", async () => {
	const { deps, fatals } = supervisorDeps({
		createAutomodeExtension: () => () => {
			throw new Error("deliberate load failure");
		},
	});
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const pi = fakePi();
	await assert.rejects((supervisor.inlineExtension() as { factory: (p: unknown) => Promise<void> }).factory(pi));
	const load = supervisor.verifyLoad({ extensions: [], errors: [{ path: "<inline:automode>", error: "deliberate load failure" }] });
	assert.equal(load.ok, false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fatals.length, 1);
	assert.ok(fatals[0]!.includes("deliberate load failure"));
});

test("supervisor: provider construction throw is recorded and escalates to fatal", async () => {
	// Regression: a provider that throws while CONSTRUCTING the factory (not
	// inside factory execution) hit the same unguarded path because the
	// construction call sat outside the try/catch.
	const { deps, fatals } = supervisorDeps({
		createAutomodeExtension: () => {
			throw new Error("inert provider construction failure");
		},
	});
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const pi = fakePi();
	await assert.rejects((supervisor.inlineExtension() as { factory: (p: unknown) => Promise<void> }).factory(pi));
	const load = supervisor.verifyLoad({ extensions: [], errors: [] });
	assert.equal(load.ok, false);
	assert.ok(load.problems.some((p) => p.includes("inert provider construction failure")));
	const start = supervisor.verifySessionStart();
	assert.equal(start.ok, false);
	assert.ok(start.problems.some((p) => p.includes("inert provider construction failure")));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fatals.length, 1);
	assert.ok(fatals[0]!.includes("inert provider construction failure"));
});

test("supervisor: a valid health receipt before a factory throw is not healthy", async () => {
	// Regression: verifySessionStart must reject a recorded factoryError even
	// when a partial valid health receipt was already sent for that
	// generation; a failed generation is never healthy.
	const { deps, fatals } = supervisorDeps({
		createAutomodeExtension:
			(options) =>
			async (): Promise<void> => {
				options.onHealth(goodHealth);
				throw new Error("late factory failure after health receipt");
			},
	});
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const pi = fakePi();
	await assert.rejects((supervisor.inlineExtension() as { factory: (p: unknown) => Promise<void> }).factory(pi));
	const start = supervisor.verifySessionStart();
	assert.equal(start.ok, false, "failed generation must not verify as healthy");
	assert.ok(start.problems.some((p) => p.includes("late factory failure after health receipt")));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fatals.length, 1);
	assert.ok(fatals[0]!.includes("late factory failure after health receipt"));
});

test("supervisor: missing health receipt at session_start escalates to fatal", async () => {
	const { deps, fatals } = supervisorDeps({
		createAutomodeExtension: () => () => {}, // never calls onHealth
	});
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const pi = fakePi();
	await (supervisor.inlineExtension() as { factory: (p: unknown) => Promise<void> }).factory(pi);
	await pi.emit("session_start");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fatals.length, 1);
	assert.ok(fatals[0]!.includes("health"));
});

test("supervisor: verifyLoad reports a missing gate and a missing enforcement hook", () => {
	const { deps, fatals } = supervisorDeps();
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const noGate = supervisor.verifyLoad({ extensions: [], errors: [] });
	assert.ok(noGate.problems.some((p) => p.includes("not loaded")));
	const noHook = supervisor.verifyLoad({
		extensions: [{ path: "<inline:automode>", tools: new Map(), handlers: new Map() }],
		errors: [],
	});
	assert.ok(noHook.problems.some((p) => p.includes("tool_call")), noHook.problems.join("; "));
});

test("supervisor: fatal fires at most once", async () => {
	const { deps, fatals } = supervisorDeps({
		createAutomodeExtension: () => () => {
			throw new Error("again");
		},
	});
	const supervisor = new GateSupervisor(deps, (message) => fatals.push(message));
	const pi = fakePi();
	const entry = supervisor.inlineExtension() as { factory: (p: unknown) => Promise<void> };
	await assert.rejects(entry.factory(pi));
	await assert.rejects(entry.factory(pi));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fatals.length, 1);
});
