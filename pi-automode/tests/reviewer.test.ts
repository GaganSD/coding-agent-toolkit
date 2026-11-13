/**
 * Offline tests for the native decision model reviewer. All registry interaction
 * is stubbed structurally; no network, no credentials, no paid calls.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	type DecisionModelLike,
	type DecisionModelRegistryLike,
	type DecisionModelResultLike,
	NativeReviewer,
	normalizeEndpoint,
	type ReviewInput,
	type ReviewerEvidence,
	type ReviewerSettings,
} from "../src/reviewer.js";

const FIXTURES = new URL("fixtures/reviewer/", import.meta.url);

function fixture<T>(relative: string): T {
	return JSON.parse(readFileSync(new URL(relative, FIXTURES), "utf8")) as T;
}

const settingsFixture = (name: string) => fixture<ReviewerSettings>(`settings/${name}.json`);
const evidenceFixture = (name: string) => fixture<ReviewerEvidence>(`evidence/${name}.json`);
const resultFixture = (name: string) => fixture<DecisionModelResultLike>(`results/${name}.json`);

const MODEL: DecisionModelLike = {
	provider: "typesafe",
	id: "jev-1.13.0",
	api: "typesafe-system-one",
	baseUrl: "https://api.typesafe.ai/v1",
	type: "classifier",
	name: "Jev 1.13.0",
	input: ["text"],
};

type ClassifyImpl = (
	model: DecisionModelLike,
	context: ReviewInput,
	options?: { signal?: AbortSignal },
) => Promise<DecisionModelResultLike>;

/** Structural stub of Pi's registry; structurally compatible with ModelRegistry. */
class StubRegistry implements DecisionModelRegistryLike {
	model: DecisionModelLike | undefined = MODEL;
	available: DecisionModelLike[] = [MODEL];
	classifyImpl: ClassifyImpl = async () => resultFixture("valid");
	findCalls = 0;
	availabilityCalls = 0;
	classifyCalls = 0;
	contexts: ReviewInput[] = [];
	maxObservedInClassify = 0;
	#insideClassify = 0;

	findOfType(type: "classifier", provider: string, modelId: string): DecisionModelLike | undefined {
		assert.equal(type, "classifier");
		this.findCalls += 1;
		return this.model && this.model.provider === provider && this.model.id === modelId ? this.model : undefined;
	}

	async getAvailableOfType(
		type: "classifier",
		provider?: string,
		_options?: { signal?: AbortSignal },
	): Promise<readonly DecisionModelLike[]> {
		assert.equal(type, "classifier");
		this.availabilityCalls += 1;
		return this.available.filter((entry) => !provider || entry.provider === provider);
	}

	async classify(
		model: DecisionModelLike,
		context: ReviewInput,
		options?: { signal?: AbortSignal },
	): Promise<DecisionModelResultLike> {
		this.classifyCalls += 1;
		this.contexts.push(context);
		this.#insideClassify += 1;
		this.maxObservedInClassify = Math.max(this.maxObservedInClassify, this.#insideClassify);
		try {
			return await this.classifyImpl(model, context, options);
		} finally {
			this.#insideClassify -= 1;
		}
	}
}

const approved = () => settingsFixture("approved");
const basic = () => evidenceFixture("basic");
const review = (r: NativeReviewer, reg: StubRegistry, settings = approved(), evidence = basic(), signal?: AbortSignal) =>
	r.review(evidence, settings, reg, signal);

/** First captured review input, asserted present (noUncheckedIndexedAccess). */
function firstContext(registry: StubRegistry): ReviewInput {
	const context = registry.contexts[0];
	assert.ok(context, "expected at least one classify call");
	return context;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// --- Consent and selection -------------------------------------------------

test("no consent: skipped locally, registry never touched", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	const receipt = await review(reviewer, registry, settingsFixture("consent-none"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /consent/i);
	assert.equal(registry.findCalls, 0);
	assert.equal(registry.classifyCalls, 0);
});

test("declined consent: skipped locally", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, settingsFixture("declined"));
	assert.equal(receipt.status, "skipped");
	assert.equal(registry.classifyCalls, 0);
});

test("no decision model selected: skipped", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, settingsFixture("unselected"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /no decision model selected/i);
	assert.equal(registry.findCalls, 0);
});

test("approved consent without endpoint/workspace bindings cannot upload", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, settingsFixture("unbound-approved"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /not bound/i);
	assert.equal(registry.classifyCalls, 0);
});

test("old settings file without binding fields cannot upload", async () => {
	const settings = approved() as ReviewerSettings & Record<string, unknown>;
	delete settings.disclosureEndpoint;
	delete settings.disclosureWorkspace;
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, settings);
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /not bound/i);
	assert.equal(registry.classifyCalls, 0);
});

// --- Endpoint and workspace binding drift -----------------------------------

test("same provider/model but endpoint drift: stays local, no request", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, settingsFixture("drift-endpoint"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /endpoint/i);
	assert.equal(registry.classifyCalls, 0);
});

test("same provider/model but workspace drift: stays local, no request", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, settingsFixture("drift-workspace"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /workspace/i);
	assert.equal(registry.findCalls, 0);
	assert.equal(registry.classifyCalls, 0);
});

test("credential-bearing or query endpoints refuse and stay local", async () => {
	for (const baseUrl of [
		"https://user:pass@api.typesafe.ai/v1",
		"https://api.typesafe.ai/v1?key=secret",
		"https://api.typesafe.ai/v1#frag",
		"ftp://api.typesafe.ai/v1",
		"not a url",
	]) {
		const registry = new StubRegistry();
		registry.model = { ...MODEL, baseUrl };
		const settings = { ...approved(), disclosureEndpoint: baseUrl };
		const receipt = await review(new NativeReviewer(), registry, settings);
		assert.equal(receipt.status, "skipped", baseUrl);
		assert.equal(registry.classifyCalls, 0, baseUrl);
	}
});

test("non-string evidence workspace stays local; classify never runs", async () => {
	const registry = new StubRegistry();
	const evidence = { ...basic(), workspace: 42 } as unknown as ReviewerEvidence;
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /workspace/i);
	assert.equal(registry.classifyCalls, 0);
	assert.equal(registry.availabilityCalls, 0);
});

test("normalizeEndpoint: origin + pathname, no userinfo/query/fragment", () => {
	// Exactly the shared core/disclosure.ts scheme.
	assert.equal(normalizeEndpoint("https://api.typesafe.ai/v1/"), "https://api.typesafe.ai/v1/");
	assert.equal(normalizeEndpoint("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
	assert.equal(normalizeEndpoint("http://localhost:11434/"), "http://localhost:11434/");
	assert.equal(normalizeEndpoint("http://169.254.1.1/v1"), "http://169.254.1.1/v1");
	assert.equal(normalizeEndpoint("https://api.typesafe.ai/v1?x=1"), null);
	assert.equal(normalizeEndpoint("https://user@api.typesafe.ai/v1"), null);
	assert.equal(normalizeEndpoint("file:///etc/passwd"), null);
	assert.equal(normalizeEndpoint(undefined), null);
});

// --- Availability / credentials ---------------------------------------------

test("no key: availability empty, unavailable and latched until reset()", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	registry.available = [];
	const first = await review(reviewer, registry);
	assert.equal(first.status, "unavailable");
	assert.match(first.reason ?? "", /credentials/i);
	assert.equal(reviewer.availabilityDisabled, true);
	assert.equal(registry.classifyCalls, 0);

	// Latched: availability is not re-probed until the operator resets.
	const second = await review(reviewer, registry);
	assert.equal(second.status, "unavailable");
	assert.equal(registry.availabilityCalls, 1);

	reviewer.reset();
	registry.available = [MODEL];
	const third = await review(reviewer, registry);
	assert.equal(third.status, "completed");
	assert.equal(registry.availabilityCalls, 2);
});

test("decision model absent from registry: unavailable", async () => {
	const registry = new StubRegistry();
	registry.model = undefined;
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "unavailable");
	assert.match(receipt.reason ?? "", /not in Pi's model registry/i);
	assert.equal(registry.classifyCalls, 0);
});

// --- Happy path -------------------------------------------------------------

test("completed review captures validated typed output, usage, identity, endpoint", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	const receipt = await review(reviewer, registry);
	assert.equal(receipt.status, "completed");
	assert.equal("shadow" in receipt, false, "receipts are typed judgments, not shadow-only records");
	assert.equal(receipt.source, "native-decision-model:typesafe/jev-1.13.0");
	assert.deepEqual(receipt.decisionModel, {
		provider: "typesafe",
		model: "jev-1.13.0",
		endpoint: "https://api.typesafe.ai/v1",
	});
	assert.equal(receipt.output?.safety?.choice, "safe");
	assert.equal(receipt.output?.safety?.probabilities.safe, 0.93);
	assert.equal(receipt.output?.safety?.confidence, 0.925);
	assert.equal(receipt.usage?.input, 328);
	assert.equal(receipt.usage?.cost.total, 0.0000138);
	assert.ok(receipt.input);
	assert.deepEqual(Object.keys(receipt.input.questions), ["safety"]);
	assert.equal(reviewer.requestsUsed, 1);
	assert.equal(reviewer.breakerOpen, false);
});

test("a confident safe answer is inert data until the gate applies its threshold", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "completed");
	for (const key of ["outcome", "decision", "allow", "approved", "clearBlock", "grant", "shadow"]) {
		assert.equal(key in receipt, false, `receipt must not expose ${key}`);
	}
});

test("state sent is bounded and carries the exact bash command under review", async () => {
	const registry = new StubRegistry();
	await review(new NativeReviewer(), registry);
	const state = firstContext(registry).state;
	assert.deepEqual(Object.keys(state).sort(), [
		"action",
		"envelope_version",
		"evidence",
		"question_version",
		"target",
	]);
	const serialized = JSON.stringify(state);
	// The bash command is the action under judgment and is sent byte-exact.
	assert.ok(serialized.includes("npm test -- parser"));
	const action = state.action as Record<string, unknown>;
	assert.deepEqual(Object.keys(action).sort(), ["argument_keys", "command", "cwd", "tool"]);
	assert.deepEqual(action.argument_keys, ["command"]);
	assert.equal(action.command, "npm test -- parser");
	// No environment, credentials, or conversation content is present.
	assert.ok(!serialized.includes(process.env.HOME ?? "no-such-home"));
	const evidenceState = state.evidence as Record<string, unknown>;
	assert.equal("snapshots" in evidenceState, true);
	// evidence.reason embeds raw command tokens and path spellings; like the
	// shell opaque-reason text it never leaves the machine.
	assert.equal("reason" in evidenceState, false);
	assert.ok(!serialized.includes("no rule or approval covers this action"), "evidence.reason is never transmitted");
});

test("shell resolution facts are included; snapshot bodies are not", async () => {
	const registry = new StubRegistry();
	const evidence = {
		...basic(),
		snapshots: [
			{ path: "/workspace/project/a.ts", canonicalPath: "/workspace/project/a.ts", kind: "file", sha256: "abc", size: 12, mtimeMs: 1, nlink: 1 },
		],
		shell: { command: "npm test -- parser", resolvedExecutable: "/usr/local/bin/npm" },
	};
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "completed");
	const evidenceState = firstContext(registry).state.evidence as Record<string, unknown>;
	assert.deepEqual(evidenceState.shell, { resolved_executable: "/usr/local/bin/npm" });
	assert.deepEqual(evidenceState.snapshots, [
		{ path: "/workspace/project/a.ts", canonicalPath: "/workspace/project/a.ts", kind: "file", sha256: "abc", size: 12, mtimeMs: 1, nlink: 1 },
	]);
});

test("opaque shell resolution sends the boolean fact, never the reason text", async () => {
	const registry = new StubRegistry();
	// opaqueReason embeds raw command tokens (here a fake bearer flag); only
	// the boolean fact may leave the machine.
	const evidence = {
		...basic(),
		shell: {
			command: "deploy --flag 'Authorization: Bearer sk-fixture-opaque'",
			opaqueReason: "flag 'Authorization: Bearer sk-fixture-opaque' is not in the verified read-only set for 'deploy'",
		},
	};
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "completed");
	const evidenceState = firstContext(registry).state.evidence as Record<string, unknown>;
	assert.deepEqual(evidenceState.shell, { opaque: true });
	const serialized = JSON.stringify(firstContext(registry).state);
	assert.ok(!serialized.includes("sk-fixture-opaque"));
	assert.ok(!serialized.includes("deploy --flag"));
});

test("snapshot whitelist covers core metadata fields (hashTruncated/dev/ino), never bodies", async () => {
	const registry = new StubRegistry();
	const evidence = {
		...basic(),
		snapshots: [
			{
				path: "/workspace/project/a.ts",
				canonicalPath: "/workspace/project/a.ts",
				kind: "file",
				sha256: "abc",
				hashTruncated: true,
				size: 12,
				mtimeMs: 1,
				nlink: 2,
				dev: 16777234,
				ino: 12345678,
				body: "SECRET FILE BODY NEVER SENT",
			},
		],
	};
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "completed");
	const evidenceState = firstContext(registry).state.evidence as Record<string, unknown>;
	assert.deepEqual(evidenceState.snapshots, [
		{
			path: "/workspace/project/a.ts",
			canonicalPath: "/workspace/project/a.ts",
			kind: "file",
			sha256: "abc",
			hashTruncated: true,
			size: 12,
			mtimeMs: 1,
			nlink: 2,
			dev: 16777234,
			ino: 12345678,
		},
	]);
	assert.ok(!JSON.stringify(firstContext(registry).state).includes("SECRET FILE BODY NEVER SENT"));
});

test("a throwing snapshot getter resolves to an error receipt; review() never rejects", async () => {
	const registry = new StubRegistry();
	const evidence = basic();
	Object.defineProperty(evidence, "snapshots", {
		configurable: true,
		enumerable: true,
		get() {
			throw new Error("hostile snapshot getter");
		},
	});
	// Awaiting the promise directly proves the failure resolves, never rejects.
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "error");
	assert.match(receipt.reason ?? "", /construction failed/i);
	assert.equal(registry.classifyCalls, 0, "malformed evidence never reaches the provider");
});

test("an unsafe judgment is captured as validated typed data", async () => {
	const registry = new StubRegistry();
	registry.classifyImpl = async () => resultFixture("valid-unsafe");
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.output?.safety?.choice, "unsafe");
	assert.equal(receipt.output?.safety?.probabilities.unsafe, 0.95);
	assert.equal("shadow" in receipt, false);
});

test("malformed usage is dropped, not clamped to zero", async () => {
	const registry = new StubRegistry();
	registry.classifyImpl = async () => ({
		...resultFixture("valid"),
		usage: { input: -5, output: 2, totalTokens: 2, cost: { total: 0 } },
	});
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.usage, undefined);
});

// --- Malformed outputs --------------------------------------------------------

for (const name of [
	"malformed-unknown-label",
	"malformed-sum",
	"malformed-confidence",
	"malformed-top-label",
	"malformed-probability-injection",
	"malformed-missing-answer",
]) {
	test(`${name}: rejected as malformed, nothing invented`, async () => {
		const registry = new StubRegistry();
		registry.classifyImpl = async () => resultFixture(name);
		const receipt = await review(new NativeReviewer(), registry);
		assert.equal(receipt.status, "error");
		assert.match(receipt.reason ?? "", /malformed decision model output/i);
		assert.equal(receipt.output, undefined);
		assert.equal(receipt.usage, undefined);
	});
}

test("identity mismatch: provider echoing another model is rejected", async () => {
	const registry = new StubRegistry();
	registry.classifyImpl = async () => resultFixture("identity-mismatch");
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "error");
	assert.match(receipt.reason ?? "", /identity mismatch/i);
});

test("unexpected answer id is rejected", async () => {
	const registry = new StubRegistry();
	const valid = resultFixture("valid");
	registry.classifyImpl = async () => ({
		...valid,
		answers: { ...valid.answers, extra_evil: { type: "choice", choice: "match", probabilities: {}, confidence: 1 } },
	});
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "error");
	assert.match(receipt.reason ?? "", /unexpected answer id/i);
});

// --- Transport failures and breaker -------------------------------------------

test("401: error receipt and breaker opens immediately", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	registry.classifyImpl = async () => resultFixture("error-401");
	const first = await review(reviewer, registry);
	assert.equal(first.status, "error");
	assert.match(first.reason ?? "", /authentication failed/i);
	assert.equal(reviewer.breakerOpen, true);

	const second = await review(reviewer, registry);
	assert.equal(second.status, "unavailable");
	assert.match(second.reason ?? "", /breaker/i);
	assert.equal(registry.classifyCalls, 1);

	reviewer.reset();
	registry.classifyImpl = async () => resultFixture("valid");
	const third = await review(reviewer, registry);
	assert.equal(third.status, "completed");
});

test("429: three consecutive transport failures open the breaker", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	registry.classifyImpl = async () => resultFixture("error-429");
	for (let i = 0; i < 3; i += 1) {
		const receipt = await review(reviewer, registry);
		assert.equal(receipt.status, "error");
		assert.match(receipt.reason ?? "", /429/);
	}
	assert.equal(reviewer.breakerOpen, true);
	const blocked = await review(reviewer, registry);
	assert.equal(blocked.status, "unavailable");
	assert.equal(registry.classifyCalls, 3);
});

test("a success resets the failure streak", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	registry.classifyImpl = async () => resultFixture("error-429");
	await review(reviewer, registry);
	await review(reviewer, registry);
	registry.classifyImpl = async () => resultFixture("valid");
	assert.equal((await review(reviewer, registry)).status, "completed");
	registry.classifyImpl = async () => resultFixture("error-429");
	await review(reviewer, registry);
	await review(reviewer, registry);
	assert.equal(reviewer.breakerOpen, false);
});

test("uncooperative classify that rejects becomes an error receipt", async () => {
	const registry = new StubRegistry();
	registry.classifyImpl = async () => {
		throw new Error("socket exploded");
	};
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "error");
	assert.match(receipt.reason ?? "", /socket exploded|internal error/i);
});

// --- Deadline, abort, late results --------------------------------------------

test("hanging classify hits the outer deadline; late result is ignored", async () => {
	const reviewer = new NativeReviewer({ breakerThreshold: 2 });
	const registry = new StubRegistry();
	const late = deferred<DecisionModelResultLike>();
	registry.classifyImpl = () => late.promise;
	const settings = { ...approved(), reviewTimeoutMs: 50 };
	const started = Date.now();
	const receipt = await review(reviewer, registry, settings);
	assert.equal(receipt.status, "timeout");
	assert.ok(Date.now() - started < 1000, "deadline must bound the wait");
	assert.equal(reviewer.inFlight, 1, "lease is retained while the uncooperative classify still runs");

	// Late completion changes nothing beyond releasing the lease at settle.
	late.resolve(resultFixture("valid"));
	await tick();
	assert.equal(reviewer.inFlight, 0, "slot released only when the underlying call actually settles");
	assert.equal(reviewer.requestsUsed, 1);
	assert.equal(reviewer.breakerOpen, false);

	// The timeout counted as one transport failure toward the breaker.
	registry.classifyImpl = async () => resultFixture("error-429");
	const next = await review(reviewer, registry, settings);
	assert.equal(next.status, "error");
	assert.equal(reviewer.breakerOpen, true);
});

test("uncooperative availability check hits the same outer deadline", async () => {
	const registry = new StubRegistry();
	registry.getAvailableOfType = () => new Promise(() => {});
	const settings = { ...approved(), reviewTimeoutMs: 50 };
	const started = Date.now();
	const receipt = await review(new NativeReviewer(), registry, settings);
	assert.equal(receipt.status, "timeout");
	assert.ok(Date.now() - started < 1000);
});

test("pre-dispatch deadline is not a provider transport failure", async () => {
	// breakerThreshold 1: any counted failure would open the breaker.
	const reviewer = new NativeReviewer({ breakerThreshold: 1 });
	const registry = new StubRegistry();
	registry.getAvailableOfType = () => new Promise(() => {});
	const settings = { ...approved(), reviewTimeoutMs: 50 };
	const receipt = await review(reviewer, registry, settings);
	assert.equal(receipt.status, "timeout");
	assert.equal(reviewer.breakerOpen, false);
	assert.equal(reviewer.requestsUsed, 0);
});

test("post-dispatch deadline counts toward the breaker", async () => {
	const reviewer = new NativeReviewer({ breakerThreshold: 1 });
	const registry = new StubRegistry();
	registry.classifyImpl = () => new Promise(() => {});
	const settings = { ...approved(), reviewTimeoutMs: 50 };
	const receipt = await review(reviewer, registry, settings);
	assert.equal(receipt.status, "timeout");
	assert.equal(reviewer.breakerOpen, true);
});

test("three never-settling classify calls under a lifecycle-only signal open the breaker with timeout status", async () => {
	// The caller signal is a plain lifecycle signal that never fires; only the
	// reviewer's own deadline bounds each call. Three consecutive post-dispatch
	// timeouts (the default threshold) open the breaker.
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	registry.classifyImpl = () => new Promise(() => {});
	const settings = { ...approved(), reviewTimeoutMs: 50 };
	const lifecycleOnly = new AbortController().signal;
	for (let i = 0; i < 3; i++) {
		const receipt = await review(reviewer, registry, settings, basic(), lifecycleOnly);
		assert.equal(receipt.status, "timeout", `review ${i + 1} ends at the reviewer-owned deadline, not the caller signal`);
		assert.equal(lifecycleOnly.aborted, false, "the lifecycle signal is untouched by the deadline");
	}
	assert.equal(reviewer.breakerOpen, true);
	assert.equal(reviewer.requestsUsed, 3);
	assert.equal(registry.classifyCalls, 3);
	// With the breaker open, further reviews stay local without dispatching.
	const fourth = await review(reviewer, registry, settings, basic(), lifecycleOnly);
	assert.equal(fourth.status, "unavailable");
	assert.match(fourth.reason ?? "", /breaker/i);
	assert.equal(registry.classifyCalls, 3);
	assert.equal(reviewer.requestsUsed, 3);
});

test("caller abort is linked into classify and maps to aborted, not failure", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	let observedAbort = false;
	registry.classifyImpl = (_model, _context, options) =>
		new Promise<DecisionModelResultLike>((_resolve, reject) => {
			options?.signal?.addEventListener("abort", () => {
				observedAbort = true;
				reject(options.signal?.reason);
			});
		});
	const controller = new AbortController();
	const pending = review(reviewer, registry, approved(), basic(), controller.signal);
	await tick();
	controller.abort(new Error("operator cancelled"));
	const receipt = await pending;
	assert.equal(receipt.status, "aborted");
	assert.equal(observedAbort, true);
	// Caller abort is lifecycle, not a provider transport failure.
	registry.classifyImpl = async () => resultFixture("valid");
	const next = await review(reviewer, registry);
	assert.equal(next.status, "completed");
});

test("pre-aborted signal returns immediately without registry work", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, approved(), basic(), AbortSignal.abort(new Error("gone")));
	assert.equal(receipt.status, "aborted");
	assert.equal(registry.findCalls, 0);
});

// --- Concurrency, queue, budget ----------------------------------------------

test("concurrency: at most 4 in-flight, queued work shares the deadline", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	registry.classifyImpl = async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
		return resultFixture("valid");
	};
	const pending = Array.from({ length: 6 }, () => review(reviewer, registry));
	await tick();
	assert.equal(registry.classifyCalls, 4);
	assert.equal(reviewer.inFlight, 4);
	assert.equal(reviewer.queued, 2);
	const receipts = await Promise.all(pending);
	assert.ok(receipts.every((receipt) => receipt.status === "completed"));
	assert.equal(registry.classifyCalls, 6);
	assert.equal(registry.maxObservedInClassify, 4);
});

test("queue overflow refuses instead of bypassing review", async () => {
	const reviewer = new NativeReviewer({ maxConcurrent: 1, maxPending: 1 });
	const registry = new StubRegistry();
	registry.classifyImpl = () => new Promise(() => {});
	const settings = { ...approved(), reviewTimeoutMs: 200 };
	const first = review(reviewer, registry, settings);
	const second = review(reviewer, registry, settings);
	const third = await review(reviewer, registry, settings);
	assert.equal(third.status, "unavailable");
	assert.match(third.reason ?? "", /queue is full/i);
	// The two blocked reviews expire at their own deadlines.
	assert.equal((await first).status, "timeout");
	assert.equal((await second).status, "timeout");
});

test("session budget from settings caps semantic requests", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	const settings = { ...approved(), reviewMaxRequests: 2 };
	assert.equal((await review(reviewer, registry, settings)).status, "completed");
	assert.equal((await review(reviewer, registry, settings)).status, "completed");
	const third = await review(reviewer, registry, settings);
	assert.equal(third.status, "unavailable");
	assert.match(third.reason ?? "", /budget/i);
	assert.equal(registry.classifyCalls, 2);
	assert.equal(reviewer.requestsUsed, 2);

	reviewer.reset();
	assert.equal((await review(reviewer, registry, settings)).status, "completed");
});

// --- Privacy -------------------------------------------------------------------

test("sensitive evidence stays local; no request, no truncation fiction", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, approved(), evidenceFixture("sensitive"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /sensitive/i);
	assert.equal(registry.classifyCalls, 0);
});

test("incomplete evidence stays local", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, approved(), evidenceFixture("incomplete"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /incomplete/i);
	assert.equal(registry.classifyCalls, 0);
});

test("protected-target evidence stays local", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, approved(), evidenceFixture("protected"));
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /protected/i);
	assert.equal(registry.classifyCalls, 0);
});

test("secret values inside ordinary argument fields never leave the machine", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, approved(), evidenceFixture("secret-arg"));
	// Metadata omission is the protection, not a scanner: the review proceeds
	// and only the bash command under judgment leaves the machine.
	assert.equal(receipt.status, "completed");
	const action = firstContext(registry).state.action as Record<string, unknown>;
	assert.deepEqual(action.argument_keys, ["api_key", "command"]);
	const serialized = JSON.stringify(firstContext(registry).state);
	assert.equal(action.command, "deploy");
	assert.ok(!serialized.includes("sk-fixture-not-real"));
});

test("write/edit payload bodies (content, old/new text) are never transmitted", async () => {
	const registry = new StubRegistry();
	const writeEvidence = basic();
	writeEvidence.action = {
		requestId: "req-write",
		tool: "write",
		args: { path: "/workspace/project/.env", content: "API_TOKEN=sk-fixture-write-body\n" },
		cwd: "/workspace/project",
	};
	const first = await review(new NativeReviewer(), registry, approved(), writeEvidence);
	assert.equal(first.status, "completed");
	let action = firstContext(registry).state.action as Record<string, unknown>;
	assert.deepEqual(action.argument_keys, ["content", "path"]);
	let serialized = JSON.stringify(firstContext(registry).state);
	assert.ok(!serialized.includes("sk-fixture-write-body"));
	assert.ok(!serialized.includes(".env"));

	const editRegistry = new StubRegistry();
	const editEvidence = basic();
	editEvidence.action = {
		requestId: "req-edit",
		tool: "edit",
		args: {
			path: "/workspace/project/a.ts",
			edits: [{ oldText: "const token = 'sk-fixture-old'", newText: "const token = 'sk-fixture-new'" }],
		},
		cwd: "/workspace/project",
	};
	const second = await review(new NativeReviewer(), editRegistry, approved(), editEvidence);
	assert.equal(second.status, "completed");
	action = firstContext(editRegistry).state.action as Record<string, unknown>;
	assert.deepEqual(action.argument_keys, ["edits", "path"]);
	serialized = JSON.stringify(firstContext(editRegistry).state);
	assert.ok(!serialized.includes("sk-fixture-old"));
	assert.ok(!serialized.includes("sk-fixture-new"));
});

test("oversized evidence skips rather than truncating decisively", async () => {
	const registry = new StubRegistry();
	const evidence = {
		...basic(),
		snapshots: [{ path: `/workspace/project/${"x".repeat(64 * 1024)}`, kind: "missing" }],
	};
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /bounded state budget/i);
	assert.equal(registry.classifyCalls, 0);
});

test("state budget is enforced in UTF-8 bytes, not UTF-16 code units", async () => {
	// 100 Han characters: 100 UTF-16 code units, 300 UTF-8 bytes. A code-unit
	// count would fit the 400-byte budget; the honest byte count does not.
	const evidence = {
		...basic(),
		snapshots: [{ path: `/workspace/project/${"严".repeat(100)}`, kind: "missing" }],
	};
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer({ maxStateBytes: 400 }), registry, approved(), evidence);
	assert.equal(receipt.status, "skipped");
	assert.match(receipt.reason ?? "", /UTF-8 bytes/i);
	assert.equal(registry.classifyCalls, 0);
	// With the default budget the same evidence is reviewed normally.
	const ok = await review(new NativeReviewer(), new StubRegistry(), approved(), evidence);
	assert.equal(ok.status, "completed");
});

// --- Injection and multilingual ------------------------------------------------

test("prototype injection payloads stay local; only inert key names are sent", async () => {
	const registry = new StubRegistry();
	const receipt = await review(new NativeReviewer(), registry, approved(), evidenceFixture("prototype-injection"));
	assert.equal(receipt.status, "completed");
	const action = firstContext(registry).state.action as Record<string, unknown>;
	// Nested payloads (including the __proto__ object) are never transmitted.
	assert.deepEqual(action.argument_keys, ["__proto__", "command", "nested"]);
	assert.equal("arguments" in action, false);
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("multilingual command text is transmitted byte-exact as proposed", async () => {
	const registry = new StubRegistry();
	const evidence = basic();
	evidence.action = {
		requestId: "req-unicode",
		tool: "bash",
		args: { command: "echo 你好世界 🚀" },
		cwd: "/workspace/project",
	};
	const receipt = await review(new NativeReviewer(), registry, approved(), evidence);
	assert.equal(receipt.status, "completed");
	const input = firstContext(registry);
	const serialized = JSON.stringify(input.state);
	assert.ok(serialized.includes("你好世界 🚀"));
	assert.deepEqual(Object.keys(input.questions), ["safety"]);
});

// --- Atomic dispatch gate: budget/breaker re-check at actual dispatch ---------

test("concurrent reviews cannot slip a second dispatch past a budget of one", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	const availability = deferred<readonly DecisionModelLike[]>();
	// Both reviews pass the local fast-path budget check (0 < 1), then wait on
	// availability. The budget must still be enforced at the dispatch point.
	registry.getAvailableOfType = () => availability.promise;
	const settings = { ...approved(), reviewMaxRequests: 1 };
	const first = review(reviewer, registry, settings);
	const second = review(reviewer, registry, settings);
	await tick();
	availability.resolve([MODEL]);
	const [a, b] = await Promise.all([first, second]);
	assert.deepEqual([a.status, b.status].sort(), ["completed", "unavailable"]);
	assert.equal(registry.classifyCalls, 1);
	assert.equal(reviewer.requestsUsed, 1);
});

test("a review queued behind a 401 never dispatches once the breaker is open", async () => {
	const reviewer = new NativeReviewer({ maxConcurrent: 1 });
	const registry = new StubRegistry();
	const first401 = deferred<DecisionModelResultLike>();
	registry.classifyImpl = () => first401.promise;
	const firstPromise = review(reviewer, registry);
	await tick();
	assert.equal(registry.classifyCalls, 1);
	const secondPromise = review(reviewer, registry);
	await tick();
	assert.equal(reviewer.queued, 1);
	// The 401 opens the breaker while the second review is still queued.
	first401.resolve(resultFixture("error-401"));
	const first = await firstPromise;
	assert.equal(first.status, "error");
	assert.equal(reviewer.breakerOpen, true);
	const second = await secondPromise;
	assert.equal(second.status, "unavailable");
	assert.match(second.reason ?? "", /breaker/i);
	assert.equal(registry.classifyCalls, 1, "queued review must not dispatch after the breaker opened");
	assert.equal(reviewer.requestsUsed, 1);
});

// --- Reset generation semantics -------------------------------------------------

test("reset() cancels queued waiters, retains active leases, starts a fresh generation", async () => {
	const reviewer = new NativeReviewer({ maxConcurrent: 1 });
	const registry = new StubRegistry();
	const hung = deferred<DecisionModelResultLike>();
	registry.classifyImpl = () => hung.promise;
	const firstPromise = review(reviewer, registry);
	await tick();
	assert.equal(registry.classifyCalls, 1);
	const secondPromise = review(reviewer, registry);
	await tick();
	assert.equal(reviewer.queued, 1);

	reviewer.reset();
	const second = await secondPromise;
	assert.equal(second.status, "aborted");
	assert.match(second.reason ?? "", /reset/i);
	assert.equal(registry.classifyCalls, 1, "a reset-cancelled waiter never dispatches");
	assert.equal(reviewer.generation, 1);
	// The hung call's lease is retained until the underlying call settles.
	assert.equal(reviewer.inFlight, 1);

	hung.resolve(resultFixture("valid"));
	const first = await firstPromise;
	assert.equal(first.status, "completed");
	await tick();
	assert.equal(reviewer.inFlight, 0);
	// First belongs to the old generation: its debit stayed there and its late
	// success must not touch the fresh generation's counters.
	assert.equal(reviewer.requestsUsed, 0);
	assert.equal(reviewer.breakerOpen, false);
});

test("reset() during the availability wait never dispatches afterwards", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	const availability = deferred<readonly DecisionModelLike[]>();
	const originalAvailability = registry.getAvailableOfType.bind(registry);
	registry.getAvailableOfType = (...args) => {
		originalAvailability(...args);
		return availability.promise;
	};
	const pending = review(reviewer, registry);
	await tick();
	assert.equal(registry.availabilityCalls, 1);
	reviewer.reset();
	// Availability resolves after the reset: the superseded review must not
	// debit the fresh generation's budget or dispatch.
	availability.resolve([MODEL]);
	const receipt = await pending;
	assert.equal(receipt.status, "aborted");
	assert.match(receipt.reason ?? "", /reset/i);
	assert.equal(registry.classifyCalls, 0);
	assert.equal(reviewer.requestsUsed, 0);
});

test("late old-generation failures cannot reopen the fresh breaker after reset()", async () => {
	const reviewer = new NativeReviewer({ breakerThreshold: 1 });
	const registry = new StubRegistry();
	const late = deferred<DecisionModelResultLike>();
	registry.classifyImpl = () => late.promise;
	const pending = review(reviewer, registry);
	await tick();
	assert.equal(registry.classifyCalls, 1);

	reviewer.reset();
	// An old-generation 401 arrives after the reset.
	late.resolve(resultFixture("error-401"));
	const receipt = await pending;
	// The receipt honestly reports the old request's own outcome...
	assert.equal(receipt.status, "error");
	assert.match(receipt.reason ?? "", /authentication failed/i);
	// ...but the fresh generation's breaker and budget are untouched.
	assert.equal(reviewer.breakerOpen, false);
	assert.equal(reviewer.requestsUsed, 0);

	registry.classifyImpl = async () => resultFixture("valid");
	const next = await review(reviewer, registry);
	assert.equal(next.status, "completed");
	assert.equal(reviewer.requestsUsed, 1);
});

// --- Abort never classifies after revoke ----------------------------------------

test("abort during the availability wait never dispatches after revoke", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	const availability = deferred<readonly DecisionModelLike[]>();
	registry.getAvailableOfType = () => availability.promise;
	const controller = new AbortController();
	const pending = review(reviewer, registry, approved(), basic(), controller.signal);
	await tick();
	controller.abort(new Error("policy drift"));
	// Availability resolves after the revoke: classify must never run.
	availability.resolve([MODEL]);
	const receipt = await pending;
	assert.equal(receipt.status, "aborted");
	assert.equal(registry.classifyCalls, 0);
	assert.equal(reviewer.requestsUsed, 0);
});

test("abort while queued cancels the waiter; classify never runs", async () => {
	const reviewer = new NativeReviewer({ maxConcurrent: 1 });
	const registry = new StubRegistry();
	const hung = deferred<DecisionModelResultLike>();
	registry.classifyImpl = () => hung.promise;
	const firstPromise = review(reviewer, registry);
	await tick();
	const controller = new AbortController();
	const secondPromise = review(reviewer, registry, approved(), basic(), controller.signal);
	await tick();
	assert.equal(reviewer.queued, 1);
	controller.abort(new Error("operator cancelled"));
	const second = await secondPromise;
	assert.equal(second.status, "aborted");
	assert.equal(registry.classifyCalls, 1);
	assert.equal(reviewer.requestsUsed, 1);

	hung.resolve(resultFixture("valid"));
	const first = await firstPromise;
	assert.equal(first.status, "completed");
});

// --- Validator specifics ----------------------------------------------------------

test("a probability tie at the top is accepted, never clamped", async () => {
	const registry = new StubRegistry();
	registry.classifyImpl = async () => ({
		provider: MODEL.provider,
		model: MODEL.id,
		stopReason: "stop",
		answers: {
			safety: {
				type: "choice",
				choice: "safe",
				probabilities: { safe: 0.5, unsafe: 0.5, uncertain: 0 },
				confidence: 0.5,
			},
		},
	});
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "completed");
	assert.equal(receipt.output?.safety?.choice, "safe");
});

test("only the exact requested model echo passes; a resolved pin is rejected", async () => {
	const registry = new StubRegistry();
	const valid = resultFixture("valid");
	registry.classifyImpl = async () => ({ ...valid, model: "jev-1.13.0-resolved-2026-01" });
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "error");
	assert.match(receipt.reason ?? "", /identity mismatch/i);
	assert.equal(receipt.output, undefined);
});

test("unknown provider output fields (reasoning/cot) are stripped from receipts", async () => {
	const registry = new StubRegistry();
	const valid = resultFixture("valid");
	registry.classifyImpl = async () => ({
		...valid,
		reasoning: "chain-of-thought-must-never-be-logged",
		answers: Object.fromEntries(
			Object.entries(valid.answers as Record<string, unknown>).map(([id, answer]) => [
				id,
				{ ...(answer as Record<string, unknown>), thinking: "hidden cot" },
			]),
		),
	});
	const receipt = await review(new NativeReviewer(), registry);
	assert.equal(receipt.status, "completed");
	const serialized = JSON.stringify(receipt);
	assert.ok(!serialized.includes("chain-of-thought-must-never-be-logged"));
	assert.ok(!serialized.includes("hidden cot"));
	assert.deepEqual(Object.keys(receipt.output?.safety ?? {}).sort(), [
		"choice",
		"confidence",
		"probabilities",
		"type",
	]);
});

test("stats snapshot exposes session counters for the integrator", async () => {
	const reviewer = new NativeReviewer();
	const registry = new StubRegistry();
	await review(reviewer, registry);
	assert.deepEqual(reviewer.stats, {
		requestsUsed: 1,
		breakerOpen: false,
		availabilityDisabled: false,
		inFlight: 0,
		queued: 0,
		generation: 0,
	});
	reviewer.reset();
	assert.equal(reviewer.stats.generation, 1);
	assert.equal(reviewer.stats.requestsUsed, 0);
});
