/**
 * Native classifier reviewer (shadow-only beta).
 *
 * Talks to a classifier-typed model exclusively through Pi's own model
 * registry: `findOfType("classifier", provider, id)`,
 * `getAvailableOfType("classifier", provider)`, and
 * `classify(model, { state, questions }, { signal })`. Pi owns transport,
 * credentials, and provider errors. There is no SDK, no HTTP client, no
 * chat-model review, and no provider cascade or fallback of any kind.
 *
 * SHADOW ONLY: a ReviewReceipt is evidence for logs and future calibration.
 * No receipt — at any status, label, or confidence — authorizes an action,
 * and a classifier result can never clear an unresolved message-rule block.
 * The gate treats receipts as shadow records only.
 *
 * Consent: a request is sent only when settings bind an approved disclosure
 * consent to the exact selected provider/model, the canonical credential-free
 * endpoint (`URL.origin + URL.pathname`; userinfo/query/fragment refuse), and
 * the canonical workspace. Approved-but-unbound consent, endpoint drift, and
 * workspace drift all stay local. Sensitive, incomplete, opaque, oversized,
 * or secret-bearing evidence stays local with no truncation fiction.
 *
 * Bounds: an outer end-to-end deadline (settings.reviewTimeoutMs) covers
 * availability, queue wait, and classification even when the registry is
 * uncooperative; caller aborts are linked and late results are ignored.
 * Concurrency is capped (default 4 in-flight, 32 pending): a slot lease is
 * held until the underlying provider call actually settles, so timed-out or
 * cancelled reviews with an uncooperative classifier still count against
 * the real concurrency ceiling. The session request budget comes from
 * settings.reviewMaxRequests and is debited atomically at the actual
 * dispatch point (after availability and queue wait), together with a
 * re-check of breaker, availability latch, generation, and abort — a
 * concurrent review can never slip a second dispatch past a budget of one,
 * and a review queued behind a 401 never dispatches. 3 consecutive
 * transport failures (or one authentication failure) open a session breaker.
 * `reset()` is the documented explicit operator "Retry classifier" action:
 * it starts a new generation, cancels queued waiters, and retains active
 * leases until their underlying calls settle; results or errors from an old
 * generation never touch the fresh budget, streak, latch, or breaker.
 *
 * Receipts capture the real typed classifier output. They never contain
 * invented model reasoning; `reason` describes this adapter's own outcome.
 */
import type {
	ClassifierModelLike,
	ClassifierRegistryLike,
	ClassifierUsage,
	ReviewInput,
	ReviewerEvidence,
	ReviewerSettings,
	ValidatedChoiceAnswer,
} from "./classifier/contract.js";
import { buildReviewInput, type EnvelopeResult } from "./classifier/envelope.js";
import { sanitizeReason, validateAnswers, validateIdentity, validateUsage } from "./classifier/validate.js";

export type {
	ClassifierModelLike,
	ClassifierRegistryLike,
	ClassifierResultLike,
	ClassifierUsage,
	ReviewInput,
	ReviewerAction,
	ReviewerEvidence,
	ReviewerSettings,
	Rule,
	ValidatedChoiceAnswer,
} from "./classifier/contract.js";
export { ALLOW_QUESTION_ID, BLOCK_QUESTION_ID, QUESTION_VERSION } from "./classifier/questions.js";
export { ENVELOPE_VERSION } from "./classifier/envelope.js";

export type ReviewStatus =
	| "completed"
	| "skipped"
	| "unavailable"
	| "error"
	| "timeout"
	| "aborted";

/**
 * Shadow evidence of one review attempt. `shadow` is always true: this record
 * cannot authorize an action and cannot clear an unresolved block.
 */
export interface ReviewReceipt {
	readonly shadow: true;
	readonly status: ReviewStatus;
	/** `native-classifier:<provider>/<model>` when a classifier is selected. */
	readonly source: string;
	/** This adapter's own outcome description — never model "reasoning". */
	readonly reason?: string;
	/** Selected identity and the canonical credential-free endpoint used. */
	readonly classifier?: { provider: string; model: string; endpoint: string };
	/** The exact bounded input sent, when a request was attempted. */
	readonly input?: ReviewInput;
	/** The validated typed answers, only when they passed full validation. */
	readonly output?: Record<string, ValidatedChoiceAnswer>;
	/** Validated usage accounting; absent means unknown, never zero-cost. */
	readonly usage?: ClassifierUsage;
	readonly durationMs: number;
}

export interface NativeReviewerOptions {
	/** In-flight classify calls ceiling. Default 4. */
	maxConcurrent?: number;
	/** Pending (queued) reviews ceiling; overload refuses, never bypasses. Default 32. */
	maxPending?: number;
	/** Consecutive transport failures that open the session breaker. Default 3. */
	breakerThreshold?: number;
	/** Serialized-state byte budget for the envelope. Default 16_000. */
	maxStateBytes?: number;
	/** Clock for testing. Default Date.now. */
	now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_REQUESTS = 100;

class DeadlineError extends Error {
	override readonly name = "DeadlineError";
}

class OverloadedError extends Error {
	override readonly name = "OverloadedError";
}

/** Queued waiters of a superseded generation are denied with this. */
class ResetError extends Error {
	override readonly name = "ResetError";
}

/** Authentication/authorization failure: disables the classifier at once. */
const AUTH_ERROR = /\b(401|403)\b|unauthorized|forbidden|no api key|invalid (api )?key/i;

/**
 * Canonical consent binding for an endpoint: `URL.origin + URL.pathname`,
 * http/https only, never userinfo/query/fragment. This is exactly the shared
 * scheme of `core/disclosure.ts` (`normalizeDisclosureEndpoint`) so the
 * UI-stored binding and this comparison can never diverge; vendored here to
 * keep this module free of cross-worker imports during parallel development.
 * Credential-bearing or malformed endpoints stay local rather than leak.
 */
export function normalizeEndpoint(baseUrl: unknown): string | null {
	if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username !== "" || url.password !== "") return null;
	if (url.search !== "" || url.hash !== "") return null;
	return `${url.origin}${url.pathname}`;
}

function sanePositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Resolve a promise against a linked abort/deadline signal. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export class NativeReviewer {
	readonly #maxConcurrent: number;
	readonly #maxPending: number;
	readonly #breakerThreshold: number;
	readonly #maxStateBytes: number;
	readonly #now: () => number;

	#inFlight = 0;
	#queued = 0;
	readonly #waiters: { grant: () => void; deny: (error: unknown) => void }[] = [];
	#requestsUsed = 0;
	#failureStreak = 0;
	#breakerOpen = false;
	/** Sticky "missing auth/configuration disables Jev immediately" latch. */
	#availabilityDisabled = false;
	/**
	 * Session generation, bumped by reset(). Late results, failures, and
	 * latch/breaker mutations from an older generation are discarded so they
	 * cannot touch fresh session state.
	 */
	#generation = 0;

	constructor(options?: NativeReviewerOptions) {
		this.#maxConcurrent = options?.maxConcurrent ?? 4;
		this.#maxPending = options?.maxPending ?? 32;
		this.#breakerThreshold = options?.breakerThreshold ?? 3;
		this.#maxStateBytes = options?.maxStateBytes ?? 16_000;
		this.#now = options?.now ?? Date.now;
	}

	/** Semantic requests dispatched this session (budget accounting). */
	get requestsUsed(): number {
		return this.#requestsUsed;
	}
	/** Session breaker: open after repeated transport failures or one auth failure. */
	get breakerOpen(): boolean {
		return this.#breakerOpen;
	}
	/** Sticky availability/auth latch, cleared only by `reset()`. */
	get availabilityDisabled(): boolean {
		return this.#availabilityDisabled;
	}
	/** Active underlying provider calls (leases held until actual settle). */
	get inFlight(): number {
		return this.#inFlight;
	}
	get queued(): number {
		return this.#queued;
	}
	/** Current session generation (bumped by every reset()). */
	get generation(): number {
		return this.#generation;
	}
	/** Point-in-time session snapshot for the operator/integrator. */
	get stats(): {
		requestsUsed: number;
		breakerOpen: boolean;
		availabilityDisabled: boolean;
		inFlight: number;
		queued: number;
		generation: number;
	} {
		return {
			requestsUsed: this.#requestsUsed,
			breakerOpen: this.#breakerOpen,
			availabilityDisabled: this.#availabilityDisabled,
			inFlight: this.#inFlight,
			queued: this.#queued,
			generation: this.#generation,
		};
	}

	/**
	 * Explicit operator "Retry classifier" action: starts a new generation —
	 * clears the breaker, the failure streak, the availability/auth latch, and
	 * the session request counter, and cancels all queued waiters of the old
	 * generation. Active leases are retained until their underlying provider
	 * calls actually settle, and late results/errors from an old generation
	 * never mutate the fresh budget, streak, latch, or breaker. Call only
	 * after the operator has re-checked the classifier selection, endpoint,
	 * and credentials. It never changes consent.
	 */
	reset(): void {
		this.#generation += 1;
		this.#requestsUsed = 0;
		this.#failureStreak = 0;
		this.#breakerOpen = false;
		this.#availabilityDisabled = false;
		const cancelled = this.#waiters.splice(0);
		for (const waiter of cancelled) {
			waiter.deny(new ResetError("operator reset cancelled the queued review"));
		}
	}

	/** Session-state mutations are generation-scoped: stale writes are dropped. */
	#noteFailure(generation: number): void {
		if (generation !== this.#generation) return;
		this.#failureStreak += 1;
		if (this.#failureStreak >= this.#breakerThreshold) this.#breakerOpen = true;
	}

	#noteSuccess(generation: number): void {
		if (generation !== this.#generation) return;
		this.#failureStreak = 0;
	}

	#openBreakerForAuth(generation: number): void {
		if (generation !== this.#generation) return;
		this.#breakerOpen = true;
	}

	#latchUnavailable(generation: number): void {
		if (generation !== this.#generation) return;
		this.#availabilityDisabled = true;
	}

	#release(): void {
		this.#inFlight -= 1;
		const next = this.#waiters.shift();
		next?.grant();
	}

	/**
	 * FIFO slot acquisition; queue wait shares the caller's deadline signal.
	 * The returned release MUST be invoked exactly once: either immediately on
	 * a pre-dispatch refusal, or when the underlying provider call settles.
	 */
	#acquire(signal: AbortSignal): Promise<() => void> {
		if (this.#inFlight < this.#maxConcurrent) {
			this.#inFlight += 1;
			return Promise.resolve(() => this.#release());
		}
		if (this.#queued >= this.#maxPending) {
			return Promise.reject(new OverloadedError("review queue full"));
		}
		this.#queued += 1;
		return new Promise<() => void>((resolve, reject) => {
			const waiter = {
				grant: () => {
					signal.removeEventListener("abort", onAbort);
					this.#inFlight += 1;
					resolve(() => this.#release());
				},
				deny: (error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			const onAbort = () => {
				const index = this.#waiters.indexOf(waiter);
				if (index >= 0) {
					this.#waiters.splice(index, 1);
					waiter.deny(signal.reason);
				}
			};
			this.#waiters.push(waiter);
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}).finally(() => {
			this.#queued -= 1;
		});
	}

	/**
	 * Shadow-review one action. Never throws; never authorizes.
	 *
	 * @param evidence  Canonical action evidence (shared ActionEvidence shape).
	 * @param settings  Current operator settings (shared AutomodeSettings shape).
	 * @param registry  Pi's model registry (structural subset is sufficient).
	 * @param signal    Caller cancellation (policy drift, Off, abort, shutdown).
	 */
	async review(
		evidence: ReviewerEvidence,
		settings: ReviewerSettings,
		registry: ClassifierRegistryLike,
		signal?: AbortSignal,
	): Promise<ReviewReceipt> {
		const startedAt = this.#now();
		const done = (
			status: ReviewStatus,
			fields: {
				reason?: string;
				source?: string;
				classifier?: ReviewReceipt["classifier"];
				input?: ReviewInput;
				output?: Record<string, ValidatedChoiceAnswer>;
				usage?: ClassifierUsage;
			} = {},
		): ReviewReceipt => ({
			shadow: true,
			status,
			source: fields.source ?? "native-classifier:none",
			...(fields.reason !== undefined ? { reason: fields.reason } : {}),
			...(fields.classifier !== undefined ? { classifier: fields.classifier } : {}),
			...(fields.input !== undefined ? { input: fields.input } : {}),
			...(fields.output !== undefined ? { output: fields.output } : {}),
			...(fields.usage !== undefined ? { usage: fields.usage } : {}),
			durationMs: Math.max(0, this.#now() - startedAt),
		});

		if (signal?.aborted) return done("aborted", { reason: "aborted before review started" });

		// --- Consent and selection (local checks, no I/O) ---
		const selection = settings.classifier;
		if (!selection) return done("skipped", { reason: "no classifier selected" });
		const source = `native-classifier:${selection.provider}/${selection.model}`;
		if (settings.disclosureConsent !== "approved") {
			return done("skipped", { source, reason: "disclosure consent is not approved; review stays local" });
		}

		// The workspace is serialized into the sent state and compared against
		// the consent binding; a missing/non-string value can never upload.
		if (typeof evidence.workspace !== "string" || evidence.workspace.length === 0) {
			return done("skipped", { source, reason: "evidence workspace is missing; review stays local" });
		}

		// --- Privacy gates on the evidence itself (local) ---
		// Envelope construction walks operator/evidence data; a hostile or
		// malformed shape must surface as an error receipt, never a throw.
		let built: EnvelopeResult;
		try {
			built = buildReviewInput(evidence, settings, { maxStateBytes: this.#maxStateBytes });
		} catch (error) {
			return done("error", {
				source,
				reason: `review input construction failed: ${sanitizeReason(error instanceof Error ? error.message : String(error))}`,
			});
		}
		if (!built.ok) return done("skipped", { source, reason: built.reason });

		// --- Consent bindings: approved-but-unbound never uploads ---
		const boundProvider = settings.disclosureProvider ?? null;
		const boundModel = settings.disclosureModel ?? null;
		const boundEndpoint = settings.disclosureEndpoint ?? null;
		const boundWorkspace = settings.disclosureWorkspace ?? null;
		if (!boundProvider || !boundModel || !boundEndpoint || !boundWorkspace) {
			return done("skipped", {
				source,
				reason: "consent is not bound to a provider, model, endpoint and workspace; review stays local",
			});
		}
		if (boundProvider !== selection.provider || boundModel !== selection.model) {
			return done("skipped", {
				source,
				reason: "selected classifier differs from the consented provider/model binding; review stays local",
			});
		}
		// evidence.workspace is the canonical realpath supplied by the evidence worker.
		if (evidence.workspace !== boundWorkspace) {
			return done("skipped", {
				source,
				reason: "workspace differs from the consented binding; review stays local",
			});
		}

		// --- Session bounds (local fast-path; re-checked atomically at dispatch) ---
		if (this.#breakerOpen) {
			return done("unavailable", { source, reason: "classifier breaker is open; operator reset() is required" });
		}
		if (this.#availabilityDisabled) {
			return done("unavailable", {
				source,
				reason: "classifier availability/credentials failed; operator reset() is required after re-checks",
			});
		}
		const maxRequests = sanePositiveInt(settings.reviewMaxRequests, DEFAULT_MAX_REQUESTS);
		if (this.#requestsUsed >= maxRequests) {
			return done("unavailable", {
				source,
				reason: `session semantic request budget exhausted (${maxRequests}); Rules mode continues locally`,
			});
		}

		// All session-state mutations by this review are attributed to the
		// generation at entry; a reset() mid-review makes them no-ops.
		const generation = this.#generation;

		// --- Outer end-to-end deadline + linked caller abort ---
		const timeoutMs = sanePositiveInt(settings.reviewTimeoutMs, DEFAULT_TIMEOUT_MS);
		const controller = new AbortController();
		const onCallerAbort = () => controller.abort(signal?.reason);
		if (signal) signal.addEventListener("abort", onCallerAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new DeadlineError("review deadline exceeded")), timeoutMs);
		// Only a deadline after the request was dispatched counts as a provider
		// transport failure; a deadline during availability/queue wait is local.
		let dispatched = false;

		try {
			// --- Resolve the selected classifier through the native registry only ---
			let model: ClassifierModelLike | undefined;
			try {
				model = registry.findOfType("classifier", selection.provider, selection.model);
			} catch (error) {
				this.#latchUnavailable(generation);
				return done("unavailable", {
					source,
					reason: `registry lookup failed: ${sanitizeReason(error instanceof Error ? error.message : String(error))}`,
				});
			}
			if (!model) {
				return done("unavailable", { source, reason: "selected classifier is not in Pi's model registry" });
			}
			if (model.provider !== selection.provider || model.id !== selection.model) {
				return done("unavailable", { source, reason: "registry returned a different model than selected" });
			}
			const endpoint = normalizeEndpoint(model.baseUrl);
			if (!endpoint) {
				return done("skipped", {
					source,
					reason: "selected endpoint cannot be bound to consent (unparseable or credential-bearing); review stays local",
				});
			}
			const classifier = { provider: model.provider, model: model.id, endpoint };
			if (endpoint !== boundEndpoint) {
				return done("skipped", {
					source,
					classifier,
					reason: "endpoint differs from the consented binding; review stays local",
				});
			}

			// --- Availability (credentials) under the same outer deadline ---
			let available: readonly ClassifierModelLike[];
			try {
				available = await raceWithSignal(
					Promise.resolve(registry.getAvailableOfType("classifier", selection.provider, { signal: controller.signal })),
					controller.signal,
				);
			} catch (error) {
				if (controller.signal.aborted) throw controller.signal.reason;
				this.#latchUnavailable(generation);
				return done("unavailable", {
					source,
					classifier,
					reason: `availability check failed: ${sanitizeReason(error instanceof Error ? error.message : String(error))}`,
				});
			}
			if (!available.some((entry) => entry && entry.provider === selection.provider && entry.id === selection.model)) {
				this.#latchUnavailable(generation);
				return done("unavailable", {
					source,
					classifier,
					reason: "no working credentials for the selected classifier; availability failed",
				});
			}

			// --- Concurrency slot; queue wait shares the deadline ---
			let release: () => void;
			try {
				release = await this.#acquire(controller.signal);
			} catch (error) {
				if (error instanceof OverloadedError) {
					return done("unavailable", { source, classifier, reason: "review queue is full; unresolved work asks locally" });
				}
				if (error instanceof ResetError) {
					return done("aborted", { source, classifier, reason: "operator reset cancelled the queued review" });
				}
				throw error;
			}

			// --- Atomic dispatch gate ---
			// No await separates these re-checks from the budget debit and the
			// dispatch: a review that passed the fast-path bounds may have been
			// overtaken while awaiting availability or a slot (budget spent by a
			// concurrent review, breaker opened by a 401, latch tripped, caller
			// aborted, operator reset). The grant never survives revocation.
			if (controller.signal.aborted) {
				release();
				throw controller.signal.reason;
			}
			// A reset() during the availability/queue wait started a new
			// generation with a fresh budget and consent re-checks: this review
			// must never debit or dispatch against the fresh generation.
			if (generation !== this.#generation) {
				release();
				return done("aborted", { source, classifier, reason: "operator reset superseded this review before dispatch" });
			}
			if (this.#breakerOpen) {
				release();
				return done("unavailable", { source, classifier, reason: "classifier breaker is open; operator reset() is required" });
			}
			if (this.#availabilityDisabled) {
				release();
				return done("unavailable", {
					source,
					classifier,
					reason: "classifier availability/credentials failed; operator reset() is required after re-checks",
				});
			}
			if (this.#requestsUsed >= maxRequests) {
				release();
				return done("unavailable", {
					source,
					classifier,
					reason: `session semantic request budget exhausted (${maxRequests}); Rules mode continues locally`,
				});
			}
			this.#requestsUsed += 1;
			dispatched = true;

			const call = Promise.resolve().then(() => {
				// Never classify after the grant was revoked between slot grant
				// and this dispatch microtask (caller abort or deadline).
				if (controller.signal.aborted) throw controller.signal.reason;
				return registry.classify(model, built.input, { signal: controller.signal });
			});
			// Late results are ignored: observe rejections so nothing is
			// unhandled. The lease tracks the REAL underlying work — the slot
			// is released only when the provider call actually settles, so an
			// uncooperative classifier keeps counting against the concurrency
			// ceiling even after this review timed out or was cancelled.
			const settled = call.then(
				() => undefined,
				() => undefined,
			);
			void settled.then(() => release());
			const result = await raceWithSignal(call, controller.signal);

			// --- Identity echo (never a pinning claim) ---
			const identityError = validateIdentity(result, model);
			if (identityError) {
				this.#noteFailure(generation);
				return done("error", { source, classifier, input: built.input, reason: identityError });
			}

			if (result.stopReason === "aborted") {
				if (signal?.aborted) return done("aborted", { source, classifier, input: built.input, reason: "aborted by caller" });
				if (controller.signal.aborted) {
					this.#noteFailure(generation);
					return done("timeout", { source, classifier, input: built.input, reason: "review deadline exceeded" });
				}
				this.#noteFailure(generation);
				return done("error", { source, classifier, input: built.input, reason: "classifier reported aborted without cancellation" });
			}
			if (result.stopReason !== "stop") {
				const message = sanitizeReason(result.errorMessage) || `classifier stopReason ${sanitizeReason(result.stopReason)}`;
				if (result.stopReason === "error" && AUTH_ERROR.test(message)) {
					this.#openBreakerForAuth(generation);
					return done("error", {
						source,
						classifier,
						input: built.input,
						reason: `classifier authentication failed, breaker open: ${message}`,
					});
				}
				this.#noteFailure(generation);
				return done("error", { source, classifier, input: built.input, reason: `classifier error: ${message}` });
			}

			// --- Exact typed-output validation; malformed is rejected, not clamped.
			// Only the validated {type, choice, probabilities, confidence} fields
			// are captured; any unknown provider output fields ("reasoning", chain
			// of thought, etc.) are stripped here and never logged. ---
			const validation = validateAnswers(built.input.questions, result.answers);
			if (!validation.ok) {
				this.#noteFailure(generation);
				return done("error", {
					source,
					classifier,
					input: built.input,
					reason: `malformed classifier output: ${validation.reason}`,
				});
			}

			this.#noteSuccess(generation);
			const usage = validateUsage(result.usage);
			// The lease is released by the settle observer above, not by this
			// return: an uncooperative classifier keeps its slot until settle.
			return done("completed", {
				source,
				classifier,
				input: built.input,
				output: validation.answers,
				...(usage !== undefined ? { usage } : {}),
			});
		} catch (error) {
			if (signal?.aborted) return done("aborted", { source, reason: "aborted by caller" });
			if (controller.signal.aborted || error instanceof DeadlineError) {
				if (dispatched) this.#noteFailure(generation);
				return done("timeout", { source, reason: "review deadline exceeded; late result ignored" });
			}
			this.#noteFailure(generation);
			return done("error", {
				source,
				reason: `reviewer internal error: ${sanitizeReason(error instanceof Error ? error.message : String(error))}`,
			});
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onCallerAbort);
		}
	}
}
