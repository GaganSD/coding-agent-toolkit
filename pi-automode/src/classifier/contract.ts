/**
 * Structural mirrors of the shared pi-automode contracts (IMPLEMENTATION.md).
 *
 * These interfaces deliberately mirror the shared `Rule` / `AutomodeSettings` /
 * `ActionEvidence` shapes owned by other workers. They are structurally
 * compatible supertypes/subsets: the runtime passes its own validated types and
 * TypeScript assigns them structurally. This module must not import Pi at
 * runtime; the registry interface below is a structural subset of Pi 1.1.0's
 * `ModelRegistry` (`findOfType` / `getAvailableOfType` / `classify`).
 */

export interface Rule {
	type: "message" | "command";
	text: string;
	enabled?: boolean;
}

export type DisclosureConsent = "none" | "approved" | "declined";

/**
 * Subset of the shared `AutomodeSettings` the reviewer reads.
 *
 * Consent is four-way bound by the settings/UI workers: `disclosureConsent`
 * is `"approved"` only alongside `disclosureProvider`/`disclosureModel` (the
 * exact selected pair), `disclosureEndpoint` (the credential-free canonical
 * `URL.origin + URL.pathname` of the selected model's `baseUrl`, http/https
 * only, never userinfo/query/fragment — the exact shared scheme of
 * `core/disclosure.ts`) and `disclosureWorkspace` (the canonical workspace
 * realpath). Old files may omit the bindings; they normalize to `null`, and
 * an unbound "approved" must never upload. Changing the picker selection
 * resets consent and all bindings.
 */
export interface ReviewerSettings {
	classifier: { provider: string; model: string } | null;
	disclosureConsent: DisclosureConsent;
	/** Bound provider id; older/invalid files normalize to `null`. */
	disclosureProvider?: string | null;
	/** Bound model id; older/invalid files normalize to `null`. */
	disclosureModel?: string | null;
	/** Canonical endpoint binding; older/invalid files normalize to `null`. */
	disclosureEndpoint?: string | null;
	/** Canonical workspace binding; older/invalid files normalize to `null`. */
	disclosureWorkspace?: string | null;
	allowlist: readonly Rule[];
	blocklist: readonly Rule[];
	reviewTimeoutMs: number;
	reviewMaxRequests: number;
}

export interface ReviewerAction {
	requestId: string;
	tool: string;
	args: Record<string, unknown>;
	cwd: string;
}

/** Structural mirror of the shared `ShellResolution`. */
export interface ShellResolutionLike {
	command: string;
	resolvedExecutable?: string;
	opaqueReason?: string;
}

/** Structural mirror of the shared `ActionEvidence`. */
export interface ReviewerEvidence {
	action: ReviewerAction;
	/** Canonical workspace realpath, supplied by the evidence worker. */
	workspace: string;
	canonicalPath?: string;
	protectedReason?: string;
	sensitive: boolean;
	complete: boolean;
	fingerprint: string;
	reason?: string;
	/** FileSnapshot is owned by the core worker; treated as opaque metadata. */
	snapshots: readonly unknown[];
	/** Bash executable resolution facts, when the evidence worker resolved them. */
	shell?: ShellResolutionLike;
}

/** Minimal structural shape of Pi's `ClassifierModel`. */
export interface ClassifierModelLike {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	type?: string;
	name?: string;
	input?: readonly unknown[];
}

export interface ClassifierChoiceQuestionLike {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

/** JSON-shaped value, structurally identical to Pi's `JsonValue`. */
export type JsonValueLike = null | boolean | number | string | JsonValueLike[] | { [key: string]: JsonValueLike };

/**
 * Exactly what this adapter sends: bounded state plus narrow choice questions.
 * `state` is JSON-shaped so Pi's `ClassifierContext` accepts it directly.
 */
export interface ReviewInput {
	state: { [key: string]: JsonValueLike };
	questions: Record<string, ClassifierChoiceQuestionLike>;
}

/** Minimal structural shape of Pi's `ClassifierResult` (never rejects). */
export interface ClassifierResultLike {
	provider: string;
	model: string;
	answers: Record<string, unknown>;
	usage?: unknown;
	stopReason: string;
	errorMessage?: string;
}

/**
 * Structural subset of Pi 1.1.0 `ModelRegistry` used by the reviewer. No SDK,
 * no HTTP, no chat-model or provider cascade: this is the only transport.
 */
export interface ClassifierRegistryLike {
	findOfType(type: "classifier", provider: string, modelId: string): ClassifierModelLike | undefined;
	getAvailableOfType(
		type: "classifier",
		provider?: string,
		options?: { signal?: AbortSignal },
	): Promise<readonly ClassifierModelLike[]>;
	classify(
		model: ClassifierModelLike,
		context: ReviewInput,
		options?: { signal?: AbortSignal },
	): Promise<ClassifierResultLike>;
}

/** Validated, bounded usage accounting. Absent means unknown, never zero-cost. */
export interface ClassifierUsage {
	input: number;
	output: number;
	totalTokens: number;
	cost: { total: number };
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
}

/** A choice answer that passed full structural validation. */
export interface ValidatedChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}
