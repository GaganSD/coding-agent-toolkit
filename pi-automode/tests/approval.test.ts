import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager, MAX_PENDING_APPROVALS, type ApprovalRequest } from "../src/approval.js";
import { EpochController } from "../src/runtime/epoch.js";

// ------------------------------------------------------------------ fakes

type ScriptEntry = string | "wait" | ((title: string, options: string[]) => string | "wait");

interface SelectCall {
	title: string;
	options: string[];
	hadTimeout: boolean;
}

function fakeUi(script: ScriptEntry[]) {
	const calls: SelectCall[] = [];
	const notifications: string[] = [];
	return {
		calls,
		notifications,
		ui: {
			async select(
				title: string,
				options: string[],
				opts?: { signal?: AbortSignal; timeout?: number },
			): Promise<string | undefined> {
				calls.push({ title, options, hadTimeout: typeof opts?.timeout === "number" });
				const entry: ScriptEntry = script.length > 0 ? (script.shift() as ScriptEntry) : "wait";
				const answer = typeof entry === "function" ? entry(title, options) : entry;
				if (answer !== "wait") return answer;
				return new Promise<string | undefined>((resolve) => {
					const signal = opts?.signal;
					if (!signal) return resolve(undefined);
					if (signal.aborted) return resolve(undefined);
					signal.addEventListener("abort", () => resolve(undefined), { once: true });
				});
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	};
}

function fakeSettings(overrides: Record<string, unknown> = {}) {
	return {
		current: {
			version: 1,
			enabled: true,
			classifier: null,
			disclosureConsent: "none",
			disclosureEndpoint: null,
			disclosureWorkspace: null,
			allowlist: [],
			blocklist: [],
			logRetentionDays: 7,
			logMaxEntries: 500,
			reviewTimeoutMs: 2000,
			reviewMaxRequests: 100,
			approvalTimeoutMs: 60_000,
			...overrides,
		},
		epoch: 1,
	} as never;
}

function makeRequest(fingerprint = "fp-1"): ApprovalRequest {
	return {
		fingerprint,
		summary: "$ git push origin feature/parser",
		detail: "tool: bash\nargs: {...}",
		evidence: { fingerprint } as never,
		decision: { outcome: "ask", source: "policy", reason: "remote mutation needs approval" },
	};
}

const TUI = { mode: "tui", hasUI: true };

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

// ------------------------------------------------------------------ tests

test("allow-once issues a token consumable exactly once", async () => {
	const epochs = new EpochController();
	const settings = fakeSettings();
	const manager = new ApprovalManager({ settings, epochs });
	const { ui } = fakeUi(["Allow once"]);

	const outcome = await manager.request({ ...TUI, ui }, makeRequest());
	assert.equal(outcome.kind, "allow-once");
	if (outcome.kind !== "allow-once") return;
	assert.equal(outcome.token.fingerprint, "fp-1");
	assert.equal(manager.consume(outcome.token), true);
	assert.equal(manager.consume(outcome.token), false, "second consume must fail");
});

test("decline suppresses identical replays without a new dialog", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["Decline"]);

	const first = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.deepEqual(first, { kind: "declined", replay: false });
	assert.equal(fake.calls.length, 1);

	const second = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.deepEqual(second, { kind: "declined", replay: true });
	assert.equal(fake.calls.length, 1, "no new dialog for a declined replay");

	// A genuinely different action still asks.
	const third = await manager.request({ ...TUI, ui: fakeUi(["Decline"]).ui }, makeRequest("fp-other"));
	assert.equal(third.kind, "declined");
});

test("escape/undefined means declined but does NOT suppress replays", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi([undefined as never as string, "Allow once"]);
	// First dialog: simulate Escape (undefined). Second: allow.
	const first = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.equal(first.kind, "declined");
	assert.equal((first as { replay: boolean }).replay, false);
	assert.equal(manager.isSuppressed("fp-1"), false);
	const second = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.equal(second.kind, "allow-once");
});

test("dialogs are strictly serialized", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const order: string[] = [];
	const fake = fakeUi([
		() => {
			order.push("first-open");
			return "Decline";
		},
		() => {
			order.push("second-open");
			return "Allow once";
		},
	]);
	const first = manager.request({ ...TUI, ui: fake.ui }, makeRequest("fp-a"));
	const second = manager.request({ ...TUI, ui: fake.ui }, makeRequest("fp-b"));
	const [a, b] = await Promise.all([first, second]);
	assert.deepEqual(order, ["first-open", "second-open"]);
	assert.equal(a.kind, "declined");
	assert.equal(b.kind, "allow-once");
});

test("deadline covers queue wait plus dialog and expires without executing", async () => {
	const releaseKeepalive = tuiKeepalive();
	try {
		const epochs = new EpochController();
		const manager = new ApprovalManager({ settings: fakeSettings({ approvalTimeoutMs: 40 }), epochs });
		const fake = fakeUi(["wait", "wait"]);
		const first = await manager.request({ ...TUI, ui: fake.ui }, makeRequest("fp-a"));
		assert.equal(first.kind, "expired");
		const second = await manager.request({ ...TUI, ui: fake.ui }, makeRequest("fp-b"));
		assert.equal(second.kind, "expired");
	} finally {
		releaseKeepalive();
	}
});

test("epoch invalidation (Off/reload/switch/shutdown) cancels a held dialog", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["wait"]);
	const pending = manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(manager.pendingCount, 1);
	epochs.invalidate("turned off");
	const outcome = await pending;
	assert.equal(outcome.kind, "cancelled");
	assert.equal((outcome as { reason: string }).reason, "turned off");
	assert.equal(manager.pendingCount, 0);
});

test("aborted turn signal cancels the request", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["wait"]);
	const turn = new AbortController();
	const pending = manager.request({ ...TUI, ui: fake.ui }, { ...makeRequest(), turnSignal: turn.signal });
	await new Promise((resolve) => setImmediate(resolve));
	turn.abort();
	const outcome = await pending;
	assert.equal(outcome.kind, "cancelled");
});

test("queue overflow beyond 32 pending never waits and never executes", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi([]);
	const waiters = [];
	for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) {
		waiters.push(manager.request({ ...TUI, ui: fake.ui }, makeRequest(`fp-${i}`)));
	}
	await new Promise((resolve) => setImmediate(resolve));
	const overflow = await manager.request({ ...TUI, ui: fake.ui }, makeRequest("fp-overflow"));
	assert.equal(overflow.kind, "unavailable");
	epochs.invalidate("test cleanup");
	await Promise.all(waiters);
});

test("no local TUI means no approval: rpc hasUI is not authority", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["Allow once"]);
	for (const ctx of [
		{ mode: "rpc", hasUI: true },
		{ mode: "json", hasUI: false },
		{ mode: "print", hasUI: false },
		{ mode: "tui", hasUI: false },
	]) {
		const outcome = await manager.request({ ...ctx, ui: fake.ui }, makeRequest(`fp-${ctx.mode}-${ctx.hasUI}`));
		assert.equal(outcome.kind, "unavailable", `mode=${ctx.mode} hasUI=${ctx.hasUI}`);
	}
	assert.equal(fake.calls.length, 0, "no dialog ever shown outside a live local TUI");
});

test("inspect shows escaped detail and returns to the dialog", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["Inspect details", "Back", "Allow once"]);
	const outcome = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.equal(outcome.kind, "allow-once");
	assert.equal(fake.calls.length, 3);
	assert.match(fake.calls[1]?.title ?? "", /Inspect/);
	assert.deepEqual(fake.calls[1]?.options, ["Back"]);
});

test("decline is the default option, never allow", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["Decline"]);
	await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.equal(fake.calls[0]?.options[0], "Decline");
	assert.ok(fake.calls[0]?.hadTimeout, "dialog carries the deadline for countdown display");
});

test("token creation after a mid-dialog policy epoch change is refused", async () => {
	const epochs = new EpochController();
	const settings = fakeSettings() as { current: unknown; epoch: number };
	const manager = new ApprovalManager({ settings: settings as never, epochs });
	const fake = fakeUi([
		() => {
			settings.epoch += 1; // policy changed while the dialog was open
			return "Allow once";
		},
	]);
	const outcome = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.equal(outcome.kind, "cancelled");
});

test("the gate-linked pending signal maps its deadline to expired", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["wait"]);
	const gateScope = new AbortController();
	const pending = manager.request({ ...TUI, ui: fake.ui }, { ...makeRequest("fp-linked"), signal: gateScope.signal });
	await new Promise((resolve) => setImmediate(resolve));
	gateScope.abort(new Error("approval deadline expired while pending"));
	const outcome = await pending;
	assert.equal(outcome.kind, "expired");
});

test("the gate-linked pending signal maps epoch loss to cancelled", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["wait"]);
	const gateScope = new AbortController();
	const pending = manager.request({ ...TUI, ui: fake.ui }, { ...makeRequest("fp-linked-2"), signal: gateScope.signal });
	await new Promise((resolve) => setImmediate(resolve));
	gateScope.abort(new Error("operator settings update"));
	const outcome = await pending;
	assert.equal(outcome.kind, "cancelled");
});

test("decline suppression clears only on an explicit session reset", async () => {
	const epochs = new EpochController();
	const manager = new ApprovalManager({ settings: fakeSettings(), epochs });
	const fake = fakeUi(["Decline"]);
	await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	const replay = await manager.request({ ...TUI, ui: fake.ui }, makeRequest());
	assert.equal(replay.kind, "declined");
	assert.equal((replay as { replay: boolean }).replay, true, "same-session identical retry stays suppressed");
	manager.resetSession(); // new session identity (extension calls this on session_start id change)
	const third = await manager.request({ ...TUI, ui: fakeUi(["Allow once"]).ui }, makeRequest());
	assert.equal(third.kind, "allow-once", "a new session may re-ask");
});
