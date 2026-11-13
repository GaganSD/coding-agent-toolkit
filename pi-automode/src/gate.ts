import path from "node:path";

import type { Action, ActionEvidence, AutomodeSettings, Decision, DecisionLog } from "./types.js";
import type { ReviewReceipt } from "./reviewer.js";
import { patternCandidates, patternQuestions } from "./decision-model/patterns.js";
import { matchCommandRule } from "./core/rules.js";
import { buildQuestions } from "./decision-model/questions.js";
import { buildReviewInput } from "./decision-model/envelope.js";
import { validateAnswers } from "./decision-model/validate.js";
import { isWithinOrEqual, realpathNearest } from "./core/paths.js";
import { renderInspectDetail, type ApprovalContext, type ApprovalManager, type ApprovalOutcome, type ApprovalToken } from "./approval.js";
import type { EpochController } from "./runtime/epoch.js";
import { AsyncMutex } from "./runtime/mutex.js";
import { freezeCopy, validateToolArgs, isSupportedTool } from "./runtime/freeze.js";
import { effectiveToolArgs } from "./runtime/pi-paths.js";
import { ambientShellCustomizations, type HostShellOptions } from "./runtime/host.js";
import { checkDisclosureConsent } from "./core/disclosure.js";
import type { EvidenceContext } from "./evidence.js";
import { escapeOneLine } from "./runtime/escape.js";

/**
 * The enforcement engine. The ordinary extension reviews every
 * read/edit/write/bash tool call at Pi's `tool_call` hook, before the host
 * executes it, and writes the approved arguments back into the event input at
 * the final boundary. The verified launcher additionally isolates the loaded
 * resource set to this gate and the four native tools.
 *
 * Fail-closed rules (see IMPLEMENTATION.md):
 * - Off: the hook has no opinion; Pi executes its stock tools with the
 *   original args, host-configured shell options, no policy, no logs.
 * - Halted (invalid/drifted config, unsupported platform while enabled):
 *   everything blocks until the operator re-verifies in the panel. Only an
 *   explicit confirmed operator Off removes checks mid-session; an externally
 *   written enabled=false file halts instead of silently opening the gate.
 * - Path translation: raw model paths are resolved with Pi's exact semantics
 *   iterated to a fixpoint, and the RESOLVED absolute path is written back
 *   into the tool-call input so the host executes the reviewed target; a
 *   missing read target blocks outright because Pi's read fallback variants
 *   (AM/PM, NFD, curly quote) were never reviewed.
 * - Async boundaries: lifecycle epoch, settings epoch and a linked
 *   epoch+turn+deadline signal are captured at executeGuarded ENTRY, before
 *   the mutex. The approval deadline covers the entry/mutex queue, evidence,
 *   model review and the approval dialog — and is cancelled before execution
 *   starts, so an approved long-running bash is never killed by the TTL.
 *   After every long await (and particularly the FINAL allow-log await) the
 *   state/epoch/settings-epoch/signal are re-checked, disk settings are
 *   freshly reloaded (external drift, including enabled=false, halts even
 *   before another Gate call), full evidence is rebuilt (dev/ino/nlink and
 *   content are fingerprinted) and policy is re-evaluated. No unchecked await
 *   intervenes between the last check and execution. Off→On never revives an
 *   old queued call: invalidation aborts its entry signal.
 * - Ask: one-shot local TUI approval bound to the exact evidence fingerprint;
 *   consumed atomically once. Decline replays never re-ask automatically.
 * - Validated, consented safe judgments can settle eligible Asks above the
 *   configured thresholds. Unexpected failures remain local. Blocks are final.
 * - A decision-log failure on an allow path blocks execution: logging errors
 *   must not silently become permission.
 */

export class AutomodeBlockError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`Automode: ${reason}`);
		this.name = "AutomodeBlockError";
		this.reason = reason;
	}
}

/** Pending managed calls (in-flight + waiting on the execution mutex). */
export const MAX_PENDING_CALLS = 32;

const DEADLINE_MESSAGE = "approval deadline expired while pending";

export interface GateSettingsStore {
	readonly current: AutomodeSettings;
	readonly epoch: number;
	readonly error: string | null;
	reload(): Promise<boolean>;
	update?(next: AutomodeSettings, options?: { authorize?: () => boolean }): Promise<void>;
}

export interface GateLogStore {
	append(entry: DecisionLog, settings: AutomodeSettings): Promise<void>;
}

export interface GateReviewer {
	propose?(evidence: ActionEvidence, settings: AutomodeSettings, registry: unknown, signal?: AbortSignal): Promise<ReviewReceipt>;
	review(
		evidence: ActionEvidence,
		settings: AutomodeSettings,
		registry: unknown,
		signal?: AbortSignal,
	): Promise<ReviewReceipt>;
}

export type EvidenceDirs = EvidenceContext;

export type BuildEvidenceFn = (action: Action, dirs: EvidenceContext) => Promise<ActionEvidence>;
export type EvaluatePolicyFn = (evidence: ActionEvidence, settings: AutomodeSettings) => Decision;

export interface GateUiContext extends ApprovalContext {
	modelRegistry?: unknown;
	/** Session cwd the stock helper resolves against (ctx.cwd); defaults to the workspace. */
	cwd?: unknown;
	/** Current turn abort signal from the host context, when streaming. */
	signal?: AbortSignal;
}

/** The host's mutable tool_call event, narrowed to what the gate needs. */
export interface GateToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
	toolCallId: string;
	parentToolCallId?: string;
}

/** Final-boundary guarantees the gate hands to the caller's run callback. */
export interface GuardExecution {
	/**
	 * Linked lifecycle-epoch + turn abort signal for a caller that owns the
	 * execution. The hook path cannot cancel host execution after it starts;
	 * it reviews immediately before returning, and later invalidation is
	 * best-effort only (irreversible effects are NOT undone — this is no
	 * sandbox). The entry deadline is deliberately NOT part of this signal.
	 */
	signal?: AbortSignal;
	/** Canonical (realpath) target from the reviewed evidence, when known. */
	canonicalPath?: string;
	/**
	 * Session cwd FROZEN at executeGuarded entry. Evidence review resolved
	 * relative arguments against exactly this directory; stock execution must
	 * resolve against the same frozen value — never a late-mutated ctx.cwd.
	 */
	cwd?: string;
}

export interface GateCall<T> {
	tool: string;
	/** Post-hook arguments as delivered to execute(); validated and frozen by the gate. */
	args: unknown;
	requestId: string;
	ctx: GateUiContext;
	turnSignal?: AbortSignal;
	/**
	 * Run stock execution with the frozen, approved (translated) arguments.
	 * The hook path captures them and writes them back into the host event;
	 * an executor-owned caller may run the tool directly.
	 */
	run: (frozenArgs: Record<string, unknown>, guard?: GuardExecution) => Promise<T>;
}

export interface GateDeps {
	settings: GateSettingsStore;
	logs: GateLogStore;
	buildEvidence: BuildEvidenceFn;
	evaluatePolicy: EvaluatePolicyFn;
	reviewer?: GateReviewer | null;
	approval: ApprovalManager;
	epochs: EpochController;
	dirs: EvidenceContext;
	host: () => HostShellOptions;
	now?: () => number;
	newId?: () => string;
	/**
	 * Environment problems (e.g. unsupported platform) that fail guarded
	 * operation closed while enabled. Off stays a deliberate no-check state.
	 */
	environmentError?: () => string | null;
}

export type GateState = "off" | "on" | "halted";

/** Per-call record threaded through decision + logging. */
interface CallRecord {
	tool: string;
	requestId: string;
	/**
	 * Actual post-hook arguments, validated and frozen AT ENTRY. The audit
	 * log always records these immutable bytes — never a re-read of the
	 * mutable shared object at log time.
	 */
	rawArgs: Record<string, unknown>;
	/** False when entry validation failed: the log says "not captured" instead of pretending empty args. */
	argsCaptured: boolean;
	/** Args actually reviewed and executed (Pi-resolved absolute path, fixpoint-stable). */
	effectiveArgs: Record<string, unknown>;
	translated: boolean;
	cwd: string;
	evidence?: ActionEvidence;
}

/** Entry-captured lifecycle/settings snapshot and linked pending signal. */
interface PendingScope {
	epochSnap: number;
	epochSignal: AbortSignal;
	settingsEpoch: number;
	/** epoch + turn + entry deadline; covers everything UP TO execution start. */
	signal: AbortSignal;
	deadlineSignal: AbortSignal;
	turnSignal?: AbortSignal;
	cancelDeadline(): void;
}

let fallbackLogId = 0;

export class Gate {
	readonly #deps: GateDeps;
	readonly #execMutex = new AsyncMutex();
	#haltedReason: string | null = null;
	#pendingCalls = 0;

	constructor(deps: GateDeps) {
		this.#deps = deps;
	}

	get state(): GateState {
		if (this.#haltedReason) return "halted";
		const settings = this.#deps.settings;
		// A discovered configuration error never silently passes as Off: guarded
		// operation halts visibly until the operator re-verifies or explicitly
		// confirms Off.
		if (settings.error !== null) return "halted";
		if (!settings.current.enabled) return "off";
		// Fail closed while On in an unverified environment; Off stays deliberate.
		if (this.#deps.environmentError?.() != null) return "halted";
		return "on";
	}

	get haltReason(): string | null {
		if (this.#haltedReason) return this.#haltedReason;
		const error = this.#deps.settings.error;
		if (error !== null) return `configuration error: ${error}`;
		const envError = this.#deps.settings.current.enabled ? (this.#deps.environmentError?.() ?? null) : null;
		if (envError !== null) return envError;
		return null;
	}

	/** Pending managed calls (waiting on the execution mutex + in flight). */
	get pendingManaged(): number {
		return this.#pendingCalls;
	}

	/** Lifecycle invalidation: Off transition, reload, switch, tree, fork, shutdown. */
	invalidate(reason: string): void {
		this.#deps.epochs.invalidate(reason);
	}

	/** Called after a confirmed operator settings mutation (toggle, re-verify save). */
	operatorUpdated(): void {
		this.#haltedReason = null;
		this.#deps.epochs.invalidate("operator settings update");
	}

	/** Operator-confirmed re-verification of on-disk configuration after drift. */
	async reverify(): Promise<{ ok: boolean; error?: string }> {
		try {
			await this.#deps.settings.reload();
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (this.#deps.settings.error !== null) return { ok: false, error: this.#deps.settings.error };
		this.#haltedReason = null;
		this.#deps.epochs.invalidate("operator re-verified configuration");
		return { ok: true };
	}

	/**
	 * Coverage decision for the tool_call event (synchronous, no logging).
	 * While on, unsupported tools and nested calls block here; supported tools
	 * continue to reviewToolCall. While off, returns undefined (no opinion, no
	 * logging).
	 */
	coverageHook(event: { toolName: string; parentToolCallId?: string }): { block: true; reason: string } | undefined {
		const state = this.state;
		if (state === "off") return undefined;
		if (state === "halted") {
			return { block: true, reason: `Automode halted (${this.haltReason ?? "unknown"}) — re-verify in /automode` };
		}
		if (event.parentToolCallId) {
			return { block: true, reason: "nested tool calls are not a verified Automode route" };
		}
		if (!isSupportedTool(event.toolName)) {
			return {
				block: true,
				reason: `tool "${event.toolName}" has no verified Automode route; blocked while Automode is on`,
			};
		}
		return undefined;
	}

	/**
	 * Async coverage hook for the tool_call event: same enforcement as
	 * coverageHook (the host awaits tool_call handlers), plus a best-effort
	 * audit record of the actual block decision. A logging failure here never
	 * weakens enforcement — the block is returned regardless.
	 */
	async coverageHookAsync(
		event: { toolName: string; parentToolCallId?: string; toolCallId?: string; input?: unknown },
		ctx?: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
	): Promise<{ block: true; reason: string } | undefined> {
		const decision = this.coverageHook(event);
		if (decision === undefined) return undefined;
		const logCall: GateCall<unknown> = {
			tool: event.toolName,
			args: event.input ?? {},
			requestId: event.toolCallId ?? `coverage-${++fallbackLogId}`,
			ctx: {
				mode: "unknown",
				hasUI: false,
				ui: {
					select: () => Promise.resolve(undefined),
					...(ctx?.ui?.notify ? { notify: ctx.ui.notify } : {}),
				},
			},
			run: () => Promise.reject(new AutomodeBlockError(decision.reason)),
		};
		await this.#logBestEffort(logCall, undefined, "block", "coverage", decision.reason);
		return decision;
	}

	/**
	 * Enforcement point for the ordinary extension: Pi's tool_call hook.
	 * Coverage (halted, nested, unsupported) is decided first; supported calls
	 * run the full guarded decision and, on allow, the reviewed arguments are
	 * written back into `event.input` so the host executes the reviewed target.
	 * Returns a block result instead of throwing so the host fails closed with
	 * a visible reason. While Off this returns undefined and logs nothing.
	 */
	async reviewToolCall(
		event: GateToolCallEvent,
		ctx: GateUiContext,
	): Promise<{ block: true; reason: string } | undefined> {
		// Off is deliberate: no opinion, no logging, original args untouched.
		if (this.state === "off") return undefined;
		const coverage = await this.coverageHookAsync(event, ctx);
		if (coverage !== undefined) return coverage;
		let reviewed: Record<string, unknown> | undefined;
		try {
			await this.executeGuarded({
				tool: event.toolName,
				args: event.input,
				requestId: event.toolCallId,
				ctx,
				...(ctx.signal !== undefined ? { turnSignal: ctx.signal } : {}),
				run: (frozenArgs) => {
					reviewed = frozenArgs;
					return Promise.resolve();
				},
			});
		} catch (error) {
			if (error instanceof AutomodeBlockError) return { block: true, reason: error.reason };
			return {
				block: true,
				reason: `Automode internal error: ${escapeOneLine(error instanceof Error ? error.message : String(error), 200)}`,
			};
		}
		if (reviewed !== undefined) applyReviewedArgs(event.input, reviewed);
		return undefined;
	}

	/** Serialized managed execution for one supported tool call. Never used while Off. */
	async executeGuarded<T>(call: GateCall<T>): Promise<T> {
		// Validate + freeze SYNCHRONOUSLY at entry: the args object is mutable
		// and shared with earlier hooks, so no await may precede the freeze.
		const validation = validateToolArgs(call.tool, call.args);
		const rec: CallRecord = {
			tool: call.tool,
			requestId: call.requestId,
			rawArgs: validation.ok ? validation.args : {},
			argsCaptured: validation.ok,
			effectiveArgs: validation.ok ? validation.args : {},
			translated: false,
			cwd: typeof call.ctx.cwd === "string" && call.ctx.cwd.length > 0 ? call.ctx.cwd : this.#deps.dirs.workspace,
		};
		if (!validation.ok) {
			await this.#logBestEffort(call, rec, "block", "integrity", validation.reason);
			throw new AutomodeBlockError(validation.reason);
		}

		// Entry capture, before the mutex: lifecycle epoch, settings epoch, and
		// the linked pending signal (epoch invalidation + turn abort + entry
		// deadline). The deadline bounds queue+decision time only; it is
		// cancelled before execution starts.
		const scope = this.#entryScope(call);

		if (this.#pendingCalls >= MAX_PENDING_CALLS) {
			scope.cancelDeadline();
			const reason = `too many pending guarded actions (max ${MAX_PENDING_CALLS}); refusing to queue`;
			await this.#logBestEffort(call, rec, "block", "overload", reason);
			throw new AutomodeBlockError(reason);
		}
		this.#pendingCalls += 1;
		try {
			this.#assertPendingLive(scope, "action entry");
			const release = await this.#execMutex.acquire(scope.signal);
			if (!release) {
				throw new AutomodeBlockError(this.#pendingAbortReason(scope, "queued behind another guarded action"));
			}
			try {
				return await this.#decideAndRun(call, rec, scope);
			} finally {
				release();
			}
		} finally {
			scope.cancelDeadline();
			this.#pendingCalls -= 1;
		}
	}

	#entryScope<T>(call: GateCall<T>): PendingScope {
		const epochs = this.#deps.epochs;
		const epochSnap = epochs.epoch;
		const epochSignal = epochs.signal;
		const settingsEpoch = this.#deps.settings.epoch;
		const timeoutMs = this.#deps.settings.current.approvalTimeoutMs;
		const deadline = new AbortController();
		// Manual (cancellable) timer: covers queue wait + review + dialog, and
		// is cancelled at the final execution boundary so an already-approved
		// long-running bash is never killed by the TTL.
		const timer = setTimeout(() => deadline.abort(new Error(DEADLINE_MESSAGE)), timeoutMs);
		timer.unref?.();
		const signals = [epochSignal, deadline.signal];
		if (call.turnSignal) signals.push(call.turnSignal);
		return {
			epochSnap,
			epochSignal,
			settingsEpoch,
			deadlineSignal: deadline.signal,
			signal: AbortSignal.any(signals),
			...(call.turnSignal ? { turnSignal: call.turnSignal } : {}),
			cancelDeadline: () => clearTimeout(timer),
		};
	}

	#pendingAbortReason(scope: PendingScope, what: string): string {
		if (scope.turnSignal?.aborted) return `${what}: turn aborted`;
		if (scope.deadlineSignal.aborted) return `${what}: ${DEADLINE_MESSAGE}`;
		return `${what}: ${this.#deps.epochs.invalidatedReason ?? "session invalidated"}`;
	}

	/**
	 * Synchronous liveness check used after every long await. Anything that
	 * entered under a different lifecycle/settings epoch, an aborted
	 * signal, a fired deadline, a halt, or an Off transition never proceeds.
	 */
	#assertPendingLive(scope: PendingScope, what: string): void {
		if (scope.signal.aborted) {
			throw new AutomodeBlockError(this.#pendingAbortReason(scope, what));
		}
		if (!this.#deps.epochs.check(scope.epochSnap)) {
			throw new AutomodeBlockError(`${what}: ${this.#deps.epochs.invalidatedReason ?? "session invalidated"}`);
		}
		if (this.#deps.settings.epoch !== scope.settingsEpoch) {
			throw new AutomodeBlockError(`${what}: policy or session changed while pending`);
		}
		const state = this.state;
		if (state === "halted") {
			throw new AutomodeBlockError(`halted (${this.haltReason ?? "unknown"}) — re-verify in /automode`);
		}
		if (state === "off") {
			throw new AutomodeBlockError("Automode was turned off while this action was pending; not executed");
		}
	}

	async #decideAndRun<T>(call: GateCall<T>, rec: CallRecord, scope: PendingScope): Promise<T> {
		const { settings } = this.#deps;
		const state = this.state;
		if (state === "halted") {
			throw new AutomodeBlockError(`halted (${this.haltReason ?? "unknown"}) — re-verify in /automode`);
		}
		if (state === "off") {
			// Off-mid-flight: an action that entered the gate under On never gets
			// released into execution by the state change.
			throw new AutomodeBlockError("Automode was turned off while this action was pending; not executed");
		}

		// External settings drift detection at the execution boundary. An
		// externally changed file — including one writing enabled=false — halts
		// guarded operation until the operator re-verifies. Our own confirmed
		// update() is known to the store and does not report as drift.
		let drifted: boolean;
		try {
			drifted = await settings.reload();
		} catch (error) {
			this.#haltedReason = `settings unreadable: ${error instanceof Error ? error.message : String(error)}`;
			this.#deps.epochs.invalidate("settings unreadable");
			throw new AutomodeBlockError(this.#haltedReason);
		}
		if (drifted) {
			this.#haltedReason = "automode.json changed on disk; halting until re-verified in /automode";
			this.#deps.epochs.invalidate("settings drift");
			throw new AutomodeBlockError(this.#haltedReason);
		}
		if (settings.error !== null) {
			this.#haltedReason = `configuration error: ${settings.error}`;
			throw new AutomodeBlockError(this.#haltedReason);
		}
		const current = settings.current;
		if (!current.enabled) {
			throw new AutomodeBlockError("Automode is not enabled");
		}
		this.#assertPendingLive(scope, "queued action");

		// Frozen cwd scope: the session cwd captured at entry must stay inside
		// the verified workspace. A rebound session root outside it is a NEW
		// scope — block BEFORE evidence/model upload rather than acting under
		// the old workspace consent; a fresh verified scope is required, never
		// an automatic rebind. (An action PATH outside the workspace with a
		// valid session cwd is a separate, still-reviewable local Ask case —
		// do not conflate the two.)
		// Canonicalize BOTH sides (realpathNearest, same as evidence) before the
		// containment test: a session cwd that is a symlink inside the workspace
		// pointing OUTSIDE would pass a purely lexical resolve. Canonicalization
		// failure fails closed.
		let workspaceRoot: string;
		let frozenCwd: string;
		try {
			workspaceRoot = await realpathNearest(path.resolve(this.#deps.dirs.workspace));
			frozenCwd = await realpathNearest(path.resolve(workspaceRoot, rec.cwd));
		} catch (error) {
			const reason = `workspace/session cwd could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`;
			await this.#logBestEffort(call, rec, "block", "integrity", reason);
			throw new AutomodeBlockError(reason);
		}
		if (!isWithinOrEqual(workspaceRoot, frozenCwd)) {
			const reason = `session cwd "${rec.cwd}" is outside the verified workspace; a fresh verified scope is required before acting`;
			await this.#logBestEffort(call, rec, "block", "integrity", reason);
			throw new AutomodeBlockError(reason);
		}

		// While On there is no shell prefix/spawn customization; ambient startup
		// shell configuration makes deterministic shell autorun impossible.
		if (call.tool === "bash") {
			const ambient = ambientShellCustomizations(this.#deps.host());
			if (ambient.length > 0) {
				const reason = `ambient shell customization (${ambient.join(", ")}) is incompatible with reviewed shell execution`;
				await this.#logBestEffort(call, rec, "block", "integrity", reason);
				throw new AutomodeBlockError(reason);
			}
		}

		// Review and execute the SAME resolved target: translate the raw path
		// with Pi's exact semantics (iterated to a fixpoint stable under the
		// helper's second normalization) and hand the resolved absolute path to
		// both evidence and stock execution. The helper cannot reinterpret it.
		const resolved = effectiveToolArgs(call.tool, rec.rawArgs, rec.cwd, this.#deps.dirs.homeDir);
		if (!resolved.ok) {
			await this.#logBestEffort(call, rec, "block", "integrity", resolved.reason);
			throw new AutomodeBlockError(resolved.reason);
		}
		rec.effectiveArgs = resolved.args;
		rec.translated = resolved.translated;

		const effectiveAction: Action = {
			requestId: call.requestId,
			tool: call.tool,
			args: rec.effectiveArgs,
			cwd: rec.cwd,
		};

		let evidence: ActionEvidence;
		try {
			evidence = await this.#deps.buildEvidence(effectiveAction, this.#deps.dirs);
		} catch (error) {
			const reason = `evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
			await this.#logBestEffort(call, rec, "block", "integrity", reason);
			throw new AutomodeBlockError(reason);
		}
		rec.evidence = evidence;
		this.#assertPendingLive(scope, "evidence gathering");

		// Read-fallback pre-check: Pi's read helper tries AM/PM, NFD and
		// curly-quote variants when the exact target is missing — none of those
		// files was reviewed. While On, a missing read target blocks outright.
		if (call.tool === "read" && evidence.snapshots[0]?.kind === "missing") {
			const reason = "read target does not exist; Pi's fallback path variants are not reviewable while Automode is on";
			await this.#logBestEffort(call, rec, "block", "integrity", reason);
			throw new AutomodeBlockError(reason);
		}

		let decision: Decision;
		try {
			decision = this.#deps.evaluatePolicy(evidence, current);
		} catch (error) {
			const reason = `policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.#logBestEffort(call, rec, "block", "integrity", reason);
			throw new AutomodeBlockError(reason);
		}

		if (decision.outcome === "block") {
			await this.#logBestEffort(call, rec, "block", decision.source, decision.reason, decision.matchedRule);
			throw new AutomodeBlockError(decision.reason);
		}

		if (decision.outcome === "allow") {
			return this.#finalizeExecution(call, rec, scope, effectiveAction, decision, current, undefined, undefined);
		}

		// A previous explicit decline takes priority over automatic model permission.
		if (this.#deps.approval.isSuppressed(evidence.fingerprint)) {
			const reason = "identical action was declined; retry stays blocked without a new dialog";
			await this.#logBestEffort(call, rec, "block", "decline-replay", reason);
			throw new AutomodeBlockError(reason);
		}
		const receipt = await this.#review(evidence, current, call, scope);
		this.#assertPendingLive(scope, "safety review");
		if (authorizesReview(receipt, evidence, current)) {
			return this.#finalizeExecution(call, rec, scope, effectiveAction, decision, current, receipt, undefined, true);
		}

		// Record the ask itself before any operator interaction; the resolution
		// is logged separately so the log shows what asked AND what happened.
		await this.#logBestEffort(call, rec, "ask", decision.source, decision.reason, decision.matchedRule, receipt);
		this.#assertPendingLive(scope, "ask logging");

		if (this.#deps.approval.isSuppressed(evidence.fingerprint)) {
			const reason = "identical action was declined; retry stays blocked without a new dialog";
			await this.#logBestEffort(call, rec, "block", "decline-replay", reason, undefined, receipt);
			throw new AutomodeBlockError(reason);
		}

		const registry = call.ctx.modelRegistry;
		const decisionModel = current.decisionModel;
		const liveModel = decisionModel ? findDecisionModel(registry, decisionModel.provider, decisionModel.model) : undefined;
		const liveConsent = checkDisclosureConsent(current, {
			endpoint: modelBaseUrl(liveModel),
			workspace: evidence.workspace,
		});
		const outcome = await this.#deps.approval.request(call.ctx, {
			fingerprint: evidence.fingerprint,
			summary: summarizeAction(call.tool, rec),
			detail: renderInspectDetail(evidence, decision),
			evidence,
			decision,
			allowAlways: Boolean(liveConsent.consented && registry && liveModel
				&& this.#deps.reviewer?.propose && this.#deps.settings.update && decisionModel && patternCandidates(evidence).length > 0),
			signal: scope.signal,
			...(call.turnSignal ? { turnSignal: call.turnSignal } : {}),
		});

		return this.#resolveApproval(outcome, call, rec, scope, effectiveAction, current, decision, receipt);
	}

	async #resolveApproval<T>(
		outcome: ApprovalOutcome,
		call: GateCall<T>,
		rec: CallRecord,
		scope: PendingScope,
		effectiveAction: Action,
		settings: AutomodeSettings,
		decision: Decision,
		receipt: ReviewReceipt | undefined,
	): Promise<T> {
		const log = (kind: DecisionLog["outcome"], source: string, reason: string) =>
			this.#logBestEffort(call, rec, kind, source, reason, decision.matchedRule, receipt);

		switch (outcome.kind) {
			case "declined": {
				await log("block", outcome.replay ? "decline-replay" : "operator-decline", "declined by operator; not executed");
				throw new AutomodeBlockError("declined by operator");
			}
			case "expired": {
				// Only an unanswered, expired local approval may use the lower
				// probability threshold. Never revive a cancelled turn, Off epoch,
				// explicit decline, or an action that expired in the execution queue.
				if (rec.evidence && authorizesReview(receipt, rec.evidence, settings, true)) {
					scope.cancelDeadline();
					const fallbackScope: PendingScope = {
						...scope,
						deadlineSignal: new AbortController().signal,
						signal: AbortSignal.any(scope.turnSignal ? [scope.epochSignal, scope.turnSignal] : [scope.epochSignal]),
					};
					this.#assertPendingLive(fallbackScope, "timeout model fallback");
					return this.#finalizeExecution(call, rec, fallbackScope, effectiveAction, decision, settings, receipt, undefined, true, "approval-once", true);
				}
				await log("block", "approval-timeout", "approval expired; no eligible safe > 50% judgment meeting the confidence guard; not executed");
				throw new AutomodeBlockError("approval expired without a qualifying model judgment; action declined, try another approach");
			}
			case "cancelled": {
				await log("block", "cancelled", `${outcome.reason}; not executed`);
				throw new AutomodeBlockError(`cancelled: ${outcome.reason}`);
			}
			case "unavailable": {
				await log("block", "approval-required", `${outcome.reason}; not executed`);
				throw new AutomodeBlockError(`approval_required: ${outcome.reason}`);
			}
			case "always-allow":
				try {
					return await this.#saveReusablePermission(outcome.token, call, rec, scope, effectiveAction, settings);
				} catch (error) {
					await log("block", "approval-always-refused", error instanceof Error ? error.message : String(error));
					throw error;
				}
			case "allow-once":
				break;
		}

		if (outcome.token.fingerprint !== rec.evidence?.fingerprint) {
			await log("block", "invalidated", "approval token mismatch; not executed");
			throw new AutomodeBlockError("approval token mismatch");
		}
		return this.#finalizeExecution(call, rec, scope, effectiveAction, decision, settings, receipt, outcome.token);
	}

	async #saveReusablePermission<T>(
		token: ApprovalToken, call: GateCall<T>, rec: CallRecord, scope: PendingScope,
		action: Action, settingsAtDecision: AutomodeSettings,
	): Promise<T> {
		this.#assertPendingLive(scope, "reusable permission entry");
		const evidence = rec.evidence!;
		if (token.fingerprint !== evidence.fingerprint || token.epoch !== scope.epochSnap || token.settingsEpoch !== scope.settingsEpoch) {
			throw new AutomodeBlockError("stale reusable permission token");
		}
		const candidates = patternCandidates(evidence);
		const proposal = await this.#review(evidence, settingsAtDecision, call, scope, "pattern");
		this.#assertPendingLive(scope, "pattern proposal");
		await this.#logBestEffort(call, rec, "ask", "approval-always-proposal", "reusable permission proposal received", undefined, proposal);
		this.#assertPendingLive(scope, "pattern proposal logging");
		const validated = validateAnswers(patternQuestions(candidates), proposal?.output);
		const answer = validated.ok ? validated.answers.permission_pattern : undefined;
		const candidate = candidates.find((entry) => entry.id === answer?.choice);
		const identity = proposal?.decisionModel;
		if (proposal?.status !== "completed" || !candidate || !answer || !identity
			|| identity.provider !== settingsAtDecision.decisionModel?.provider || identity.model !== settingsAtDecision.decisionModel.model
			|| identity.endpoint !== settingsAtDecision.disclosureEndpoint
			|| (answer.probabilities[answer.choice] ?? 0) < settingsAtDecision.reviewSafeThreshold
			|| answer.confidence < settingsAtDecision.reviewConfidenceThreshold) {
			throw new AutomodeBlockError("no sufficiently confident suitable generalized pattern; nothing saved or executed");
		}
		const subject = call.tool === "bash" ? rec.effectiveArgs.command : evidence.canonicalPath;
		if (typeof subject !== "string" || !matchCommandRule(candidate.rules, subject, call.tool)
			|| !buildReviewInput(evidence, { purpose: "pattern" }).ok) {
			throw new AutomodeBlockError("proposed permission does not cover the reviewed action; nothing saved");
		}
		if (call.ctx.mode !== "tui" || !call.ctx.hasUI) throw new AutomodeBlockError("reusable permission requires local TUI confirmation");
		const text = candidate.rules.map((rule) => `${rule.tool ?? "bash"}/${rule.mode ?? "glob"}: ${escapeOneLine(rule.text, 5000)}`).join("\n");
		const confirmed = await call.ctx.ui.select(`Save reusable allowlist permission?\n\n${text}\n\nThis scope applies to future matching calls. Protected targets and hard blocks remain final.`,
			["Cancel", "Save and allow"], { signal: scope.signal });
		this.#assertPendingLive(scope, "pattern confirmation");
		if (confirmed !== "Save and allow") throw new AutomodeBlockError("reusable permission cancelled; nothing saved or executed");
		const store = this.#deps.settings;
		await store.reload();
		this.#assertPendingLive(scope, "pattern settings check");
		const fresh = await this.#deps.buildEvidence(action, this.#deps.dirs);
		this.#assertPendingLive(scope, "pattern evidence check");
		if (fresh.fingerprint !== evidence.fingerprint || this.#deps.evaluatePolicy(fresh, store.current).outcome === "block") {
			throw new AutomodeBlockError("action changed before permission save; nothing saved");
		}
		// An authority-changing save needs a durable audit record too.
		await this.#appendLog(call, rec, "ask", "approval-always-rule", `operator confirmed reusable scope: ${text}`, store.current, undefined, proposal);
		this.#assertPendingLive(scope, "pattern audit");
		if (!store.update) throw new AutomodeBlockError("settings persistence unavailable; nothing saved");
		const previousEpoch = store.epoch;
		const rules = candidate.rules.filter((rule) => !store.current.allowlist.some((existing) => JSON.stringify(existing) === JSON.stringify(rule)));
		await store.update({ ...store.current, allowlist: [...store.current.allowlist, ...rules] }, {
			authorize: () => !scope.signal.aborted && this.#deps.epochs.check(scope.epochSnap)
				&& store.epoch === previousEpoch && this.state === "on",
		});
		// Only this explicitly confirmed mutation may rebase this call. Other
		// queued calls retain their old settings epoch and fail closed.
		if (scope.signal.aborted || !this.#deps.epochs.check(scope.epochSnap) || store.epoch !== previousEpoch + 1) {
			throw new AutomodeBlockError("session or policy changed during permission save; action not executed");
		}
		scope.settingsEpoch = store.epoch;
		this.#assertPendingLive(scope, "saved permission");
		const decision = this.#deps.evaluatePolicy(fresh, store.current);
		if (decision.outcome !== "allow") throw new AutomodeBlockError("saved scope does not authorize this action; not executed");
		const reboundToken = { ...token, settingsEpoch: store.epoch };
		return this.#finalizeExecution(call, rec, scope, action, decision, store.current, proposal, reboundToken, false, "approval-always");
	}

	/**
	 * Final pre-execution boundary shared by the deterministic-allow and the
	 * approved-once paths. Rebuilds full evidence (dev/ino/nlink/content are
	 * fingerprinted), writes the allow audit record, freshly reloads disk
	 * settings AFTER that await, then rebuilds evidence ONE more time as the
	 * last await before the sync chain — a target swapped during the
	 * allow-log/reload window (e.g. replaced by a symlink to a protected file)
	 * changes the fingerprint and blocks here. After that: state/epochs/signal
	 * re-checks and policy re-evaluation, all synchronously, with no unchecked
	 * await between the last check and execution.
	 */
	async #finalizeExecution<T>(
		call: GateCall<T>,
		rec: CallRecord,
		scope: PendingScope,
		effectiveAction: Action,
		decision: Decision,
		settingsAtDecision: AutomodeSettings,
		receipt: ReviewReceipt | undefined,
		token: ApprovalToken | undefined,
		modelApproved = false,
		approvalSource = "approval-once",
		timeoutModelApproval = false,
	): Promise<T> {
		const { settings } = this.#deps;
		const log = (kind: DecisionLog["outcome"], source: string, reason: string) =>
			this.#logBestEffort(call, rec, kind, source, reason, decision.matchedRule, receipt);
		const blocked = async (source: string, reason: string): Promise<never> => {
			await log("block", source, reason);
			throw new AutomodeBlockError(reason);
		};

		// Identity: full fresh evidence of the exact effective action.
		let fresh: ActionEvidence;
		try {
			fresh = await this.#deps.buildEvidence(effectiveAction, this.#deps.dirs);
		} catch {
			return blocked("invalidated", "evidence unavailable at revalidation; not executed");
		}
		if (fresh.fingerprint !== rec.evidence?.fingerprint) {
			return blocked("invalidated", "action or target changed while awaiting approval; not executed");
		}

		// The allow audit is written BEFORE execution; a log failure blocks.
		try {
			await this.#appendLog(
				call,
				rec,
				"allow",
				token ? approvalSource : timeoutModelApproval ? "approval-timeout-model" : modelApproved ? receipt!.source : decision.source,
				token ? (approvalSource === "approval-always" ? "operator confirmed reusable permission" : "operator approved once") : timeoutModelApproval ? "unanswered approval expired; validated safe probability > 0.50 meets confidence guard" : modelApproved ? "validated safe judgment meets probability and confidence thresholds" : decision.reason,
				settingsAtDecision,
				decision.matchedRule,
				receipt,
			);
		} catch {
			throw new AutomodeBlockError("decision log unavailable; refusing to execute without an audit record");
		}

		// After the FINAL allow-log await: external disk drift (including an
		// externally written enabled=false) halts here, even before another
		// Gate call. (Not the last await on the success path — the final
		// buildEvidence revalidation below is.)
		let drifted: boolean;
		try {
			drifted = await settings.reload();
		} catch (error) {
			this.#haltedReason = `settings unreadable: ${error instanceof Error ? error.message : String(error)}`;
			this.#deps.epochs.invalidate("settings unreadable");
			return blocked("invalidated", `${this.#haltedReason}; not executed`);
		}
		if (drifted) {
			this.#haltedReason = "automode.json changed on disk; halting until re-verified in /automode";
			this.#deps.epochs.invalidate("settings drift");
			return blocked("invalidated", "settings changed on disk while the action was pending; not executed");
		}
		if (settings.error !== null) {
			this.#haltedReason = `configuration error: ${settings.error}`;
			return blocked("invalidated", `${this.#haltedReason}; not executed`);
		}

		// Final identity revalidation AFTER the last settings await: rebuild
		// full evidence once more and bind the fingerprint, so a target swapped
		// during the allow-log/reload window can never execute. This rebuild is
		// the LAST await before the sync chain.
		let finalEvidence: ActionEvidence;
		try {
			finalEvidence = await this.#deps.buildEvidence(effectiveAction, this.#deps.dirs);
		} catch {
			return blocked("invalidated", "evidence unavailable at revalidation; not executed");
		}
		if (finalEvidence.fingerprint !== rec.evidence?.fingerprint) {
			return blocked("invalidated", "action or target changed while awaiting approval; not executed");
		}

		// SYNC chain — no awaits between here and execution.
		try {
			this.#assertPendingLive(scope, "final pre-execution check");
		} catch (error) {
			await log("block", "invalidated", `${error instanceof Error ? error.message : String(error)}; not executed`);
			throw error;
		}
		// Fresh policy on the fresh evidence with the freshly reloaded settings:
		// a fresh Block is respected even when the fingerprint is unchanged, and
		// any outcome flip stops execution instead of silently re-deciding.
		let freshDecision: Decision;
		try {
			freshDecision = this.#deps.evaluatePolicy(finalEvidence, settings.current);
		} catch (error) {
			return blocked("integrity", `policy re-evaluation failed: ${error instanceof Error ? error.message : String(error)}; not executed`);
		}
		if (freshDecision.outcome === "block") {
			return blocked(freshDecision.source, `policy re-check blocks: ${freshDecision.reason}`);
		}
		if (freshDecision.outcome !== decision.outcome) {
			return blocked("invalidated", "policy outcome changed while the action was pending; not executed");
		}

		if (modelApproved && !authorizesReview(receipt, finalEvidence, settings.current, timeoutModelApproval)) {
			return blocked("invalidated", "model permission is no longer valid; not executed");
		}

		// Consume the one-shot approval atomically, exactly once, bound to this
		// request's fingerprint and live epochs.
		if (token !== undefined && !this.#deps.approval.consume(token)) {
			return blocked("invalidated", "approval already consumed or stale; not executed");
		}

		// The entry deadline ends here: an approved long-running command is
		// never killed by the TTL. The caller receives the linked epoch+turn
		// signal at this final boundary; a caller that owns execution may
		// propagate it, while the hook path reviews immediately before return.
		scope.cancelDeadline();
		const execSignal = AbortSignal.any(call.turnSignal ? [scope.epochSignal, call.turnSignal] : [scope.epochSignal]);
		const guard: GuardExecution = { signal: execSignal, cwd: rec.cwd };
		if (rec.evidence?.canonicalPath !== undefined) guard.canonicalPath = rec.evidence.canonicalPath;
		return call.run(rec.effectiveArgs, guard);
	}

	/**
	 * Consented native review. Every outcome is a visible receipt recorded
	 * in the decision log: expected skips say why they stayed local, and an
	 * unexpected reviewer failure becomes an error receipt plus a warning —
	 * never silence or an implicit allow.
	 */
	async #review(
		evidence: ActionEvidence,
		settings: AutomodeSettings,
		call: GateCall<unknown>,
		scope: PendingScope,
		purpose: "safety" | "pattern" = "safety",
	): Promise<ReviewReceipt | undefined> {
		const reviewer = this.#deps.reviewer;
		const decisionModel = settings.decisionModel;
		if (!reviewer || !decisionModel) return undefined;
		const source = `native-decision-model:${decisionModel.provider}/${decisionModel.model}`;
		const skipped = (reason: string): ReviewReceipt => ({ status: "skipped", source, reason, durationMs: 0 });
		const registry = call.ctx.modelRegistry;
		if (!registry) return skipped("model registry unavailable; stayed local");
		const model = findDecisionModel(registry, decisionModel.provider, decisionModel.model);
		// Consent is upload authority only when bound to the exact selected
		// endpoint and the canonical workspace; otherwise stay local.
		const consent = checkDisclosureConsent(settings, {
			endpoint: modelBaseUrl(model),
			workspace: evidence.workspace,
		});
		if (!consent.consented) return skipped(consent.reason);
		// No gate-level review timeout: the reviewer's own outer deadline
		// (settings.reviewTimeoutMs) owns timeout/breaker accounting. Mixing an
		// equal gate timeout races that deadline and misreports the outcome as
		// aborted-by-caller, so the reviewer's failure/breaker bookkeeping
		// would never run. Only the scope/lifecycle signal is passed.
		const started = Date.now();
		try {
			// The gate independently validates a completed safe answer before authority.
			return purpose === "pattern"
				? await reviewer.propose?.(evidence, settings, registry, scope.signal)
				: await reviewer.review(evidence, settings, registry, scope.signal);
		} catch (error) {
			const reason = `decision reviewer failed unexpectedly: ${escapeOneLine(error instanceof Error ? error.message : String(error), 200)}`;
			call.ctx.ui.notify?.(`Automode: ${reason}`, "warning");
			return { status: "error", source, reason, durationMs: Date.now() - started };
		}
	}

	async #logBestEffort(
		call: GateCall<unknown>,
		rec: CallRecord | undefined,
		outcome: DecisionLog["outcome"],
		source: string,
		reason: string,
		matchedRule?: Decision["matchedRule"],
		decisionModel?: unknown,
	): Promise<void> {
		const settings = this.#deps.settings.current;
		try {
			await this.#appendLog(call, rec, outcome, source, reason, settings, matchedRule, decisionModel);
		} catch {
			call.ctx.ui.notify?.("Automode: decision log write failed", "error");
		}
	}

	async #appendLog(
		call: GateCall<unknown>,
		rec: CallRecord | undefined,
		outcome: DecisionLog["outcome"],
		source: string,
		reason: string,
		settings: AutomodeSettings,
		matchedRule?: Decision["matchedRule"],
		decisionModel?: unknown,
	): Promise<void> {
		// The log records the ACTUAL post-hook arguments frozen at entry. When
		// they failed validation (or an uncovered route is audited), the record
		// says "not captured" explicitly instead of pretending empty args.
		let rawArgs: Record<string, unknown> = {};
		let captured = false;
		if (rec !== undefined) {
			rawArgs = rec.rawArgs;
			captured = rec.argsCaptured;
		} else {
			try {
				const copy = freezeCopy(call.args);
				if (copy !== null && typeof copy === "object" && !Array.isArray(copy)) {
					rawArgs = copy as Record<string, unknown>;
					captured = true;
				}
			} catch {
				/* not reviewable bytes; recorded as not captured */
			}
		}
		const entry: DecisionLog = {
			id: this.#deps.newId?.() ?? `log-${++fallbackLogId}`,
			time: new Date(this.#deps.now?.() ?? Date.now()).toISOString(),
			action: {
				requestId: call.requestId,
				tool: call.tool,
				args: rawArgs,
				cwd: rec?.cwd ?? this.#deps.dirs.workspace,
			},
			outcome,
			source,
			reason,
		};
		if (matchedRule) entry.matchedRule = matchedRule;
		if (decisionModel !== undefined) entry.decisionModel = decisionModel;
		if (!captured) {
			entry.input = { note: "post-hook arguments failed validation or are not reviewable; not captured" };
		} else if (rec?.translated) {
			entry.input = {
				note: "path resolved with Pi semantics; this resolved target was the review target",
				resolvedArgs: rec.effectiveArgs,
				...(rec.evidence?.canonicalPath !== undefined ? { canonicalPath: rec.evidence.canonicalPath } : {}),
			};
		}
		await this.#deps.logs.append(entry, settings);
	}
}

/** Independently validate eligibility, identity, consent, answer shape,
 * probability and confidence before treating a model receipt as permission. */
function authorizesReview(receipt: ReviewReceipt | undefined, evidence: ActionEvidence, settings: AutomodeSettings, timeoutFallback = false): boolean {
	if (receipt?.status !== "completed" || !settings.decisionModel || !buildReviewInput(evidence).ok) return false;
	const identity = receipt.decisionModel;
	if (!identity || identity.provider !== settings.decisionModel.provider || identity.model !== settings.decisionModel.model
		|| identity.endpoint !== settings.disclosureEndpoint) return false;
	const consent = checkDisclosureConsent(settings, { endpoint: identity.endpoint, workspace: evidence.workspace });
	if (!consent.consented) return false;
	const validated = validateAnswers(buildQuestions(), receipt.output);
	if (!validated.ok) return false;
	const answer = validated.answers.safety;
	return answer?.choice === "safe"
		&& (timeoutFallback ? (answer.probabilities.safe ?? 0) > 0.50 : (answer.probabilities.safe ?? 0) >= settings.reviewSafeThreshold)
		&& answer.confidence >= settings.reviewConfidenceThreshold;
}

/** Write reviewed bytes back at the final boundary, preserving host object identity. */
function applyReviewedArgs(input: Record<string, unknown>, reviewed: Record<string, unknown>): void {
	for (const key of Object.keys(input)) {
		if (!Object.hasOwn(reviewed, key)) delete input[key];
	}
	for (const [key, value] of Object.entries(reviewed)) {
		input[key] = value;
	}
}

function summarizeAction(tool: string, rec: CallRecord): string {
	const args = rec.effectiveArgs;
	const translatedNote = rec.translated ? " (resolved target)" : "";
	switch (tool) {
		case "bash":
			return `$ ${escapeOneLine(String(args.command ?? ""), 400)}`;
		case "read":
			return `read ${escapeOneLine(String(args.path ?? ""), 400)}${translatedNote}`;
		case "write":
			return `write ${escapeOneLine(String(args.path ?? ""), 400)} (${String(args.content ?? "").length} bytes)${translatedNote}`;
		case "edit":
			return `edit ${escapeOneLine(String(args.path ?? ""), 400)} (${Array.isArray(args.edits) ? args.edits.length : 0} edits)${translatedNote}`;
		default:
			return escapeOneLine(`${tool} ${JSON.stringify(args)}`, 400);
	}
}

interface DecisionModelLike {
	baseUrl?: unknown;
}

function findDecisionModel(registry: unknown, provider: string, modelId: string): DecisionModelLike | undefined {
	const find = (registry as { findOfType?: unknown } | undefined)?.findOfType;
	if (typeof find !== "function") return undefined;
	try {
		return (find as (t: string, p: string, m: string) => unknown).call(registry, "classifier", provider, modelId) as
			| DecisionModelLike
			| undefined;
	} catch {
		return undefined;
	}
}

function modelBaseUrl(model: DecisionModelLike | undefined): string | null {
	return typeof model?.baseUrl === "string" ? model.baseUrl : null;
}
