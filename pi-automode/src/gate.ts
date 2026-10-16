import path from "node:path";

import type { Action, ActionEvidence, AutomodeSettings, Decision, DecisionLog } from "./types.js";
import type { ReviewReceipt } from "./reviewer.js";
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
 * The enforcement engine. Owns the final execute boundary for the four
 * wrapped native tools while Automode is on.
 *
 * Fail-closed rules (see IMPLEMENTATION.md):
 * - Off: the gate is never invoked; wrappers delegate to stock execution with
 *   the original args, host-configured shell options, no policy, no logs.
 * - Halted (invalid/drifted config, unsupported platform while enabled):
 *   everything blocks until the operator re-verifies in the panel. Only an
 *   explicit confirmed operator Off removes checks mid-session; an externally
 *   written enabled=false file halts instead of silently opening the gate.
 * - Path translation: raw model paths are resolved with Pi's exact semantics
 *   iterated to a fixpoint, and the RESOLVED absolute path feeds both evidence
 *   and stock execution; read-fallback variants (AM/PM, NFD, curly quote) can
 *   never redirect a reviewed path — the On read delegate enforces the
 *   reviewed literal target at the native access/read/mime-detect IO boundary
 *   (see tools.ts), and a missing read target blocks outright.
 * - Async boundaries: lifecycle epoch, settings epoch and a linked
 *   epoch+turn+deadline signal are captured at executeGuarded ENTRY, before
 *   the mutex. The approval deadline covers the entry/mutex queue, evidence,
 *   shadow review and the approval dialog — and is cancelled before execution
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
 * - Shadow reviewer receipts are recorded in the decision log and never
 *   relax policy; unexpected reviewer failures surface as visible error
 *   receipts/warnings, never as silence and never as an allow.
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
}

export interface GateLogStore {
	append(entry: DecisionLog, settings: AutomodeSettings): Promise<void>;
}

export interface GateReviewer {
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
}

/** Execution-time guarantees the gate hands to the wrapper's run callback. */
export interface GuardExecution {
	/**
	 * Linked lifecycle-epoch + turn abort signal. Propagate to the stock
	 * helper: after execution has started, invalidation kills the helper
	 * best-effort (irreversible effects are NOT undone — this is no sandbox).
	 * The entry deadline is deliberately NOT part of this signal.
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
	/** Run stock execution with the frozen, approved (translated) arguments. */
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
	 * continue to the final execute boundary inside the wrapper. While off,
	 * returns undefined (no opinion, no logging).
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

	/** Serialized managed execution for one wrapped tool call. Never used while Off. */
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
		// scope — block BEFORE evidence/shadow upload rather than acting under
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

		// Ask path. Shadow reviewer runs only with a bound, valid disclosure
		// consent; its receipt is recorded and NEVER relaxes the outcome.
		const receipt = await this.#shadowReview(evidence, current, call, scope);
		this.#assertPendingLive(scope, "shadow review");

		// Record the ask itself before any operator interaction; the resolution
		// is logged separately so the log shows what asked AND what happened.
		await this.#logBestEffort(call, rec, "ask", decision.source, decision.reason, decision.matchedRule, receipt);
		this.#assertPendingLive(scope, "ask logging");

		if (this.#deps.approval.isSuppressed(evidence.fingerprint)) {
			const reason = "identical action was declined; retry stays blocked without a new dialog";
			await this.#logBestEffort(call, rec, "block", "decline-replay", reason, undefined, receipt);
			throw new AutomodeBlockError(reason);
		}

		const outcome = await this.#deps.approval.request(call.ctx, {
			fingerprint: evidence.fingerprint,
			summary: summarizeAction(call.tool, rec),
			detail: renderInspectDetail(evidence, decision),
			evidence,
			decision,
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
				await log("block", "approval-timeout", "approval request expired; not executed");
				throw new AutomodeBlockError("approval expired without an answer");
			}
			case "cancelled": {
				await log("block", "cancelled", `${outcome.reason}; not executed`);
				throw new AutomodeBlockError(`cancelled: ${outcome.reason}`);
			}
			case "unavailable": {
				await log("block", "approval-required", `${outcome.reason}; not executed`);
				throw new AutomodeBlockError(`approval_required: ${outcome.reason}`);
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
				token ? "approval-once" : decision.source,
				token ? "operator approved once" : decision.reason,
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

		// Consume the one-shot approval atomically, exactly once, bound to this
		// request's fingerprint and live epochs.
		if (token !== undefined && !this.#deps.approval.consume(token)) {
			return blocked("invalidated", "approval already consumed or stale; not executed");
		}

		// The entry deadline ends here: an approved long-running command is
		// never killed by the TTL. Execution runs under the linked epoch+turn
		// signal, so later invalidation aborts the helper best-effort.
		scope.cancelDeadline();
		const execSignal = AbortSignal.any(call.turnSignal ? [scope.epochSignal, call.turnSignal] : [scope.epochSignal]);
		const guard: GuardExecution = { signal: execSignal, cwd: rec.cwd };
		if (rec.evidence?.canonicalPath !== undefined) guard.canonicalPath = rec.evidence.canonicalPath;
		return call.run(rec.effectiveArgs, guard);
	}

	/**
	 * Shadow-only native review. Every outcome is a visible receipt recorded
	 * in the decision log: expected skips say why they stayed local, and an
	 * unexpected reviewer failure becomes an error receipt plus a warning —
	 * never silence, and never an allow.
	 */
	async #shadowReview(
		evidence: ActionEvidence,
		settings: AutomodeSettings,
		call: GateCall<unknown>,
		scope: PendingScope,
	): Promise<ReviewReceipt | undefined> {
		const reviewer = this.#deps.reviewer;
		const classifier = settings.classifier;
		if (!reviewer || !classifier) return undefined;
		const source = `native-classifier:${classifier.provider}/${classifier.model}`;
		const skipped = (reason: string): ReviewReceipt => ({ shadow: true, status: "skipped", source, reason, durationMs: 0 });
		const registry = call.ctx.modelRegistry;
		if (!registry) return skipped("model registry unavailable; stayed local");
		const model = findClassifierModel(registry, classifier.provider, classifier.model);
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
			// Shadow only: the receipt is logged as evidence, never consulted.
			return await reviewer.review(evidence, settings, registry, scope.signal);
		} catch (error) {
			const reason = `shadow reviewer failed unexpectedly: ${escapeOneLine(error instanceof Error ? error.message : String(error), 200)}`;
			call.ctx.ui.notify?.(`Automode: ${reason}`, "warning");
			return { shadow: true, status: "error", source, reason, durationMs: Date.now() - started };
		}
	}

	async #logBestEffort(
		call: GateCall<unknown>,
		rec: CallRecord | undefined,
		outcome: DecisionLog["outcome"],
		source: string,
		reason: string,
		matchedRule?: Decision["matchedRule"],
		classifier?: unknown,
	): Promise<void> {
		const settings = this.#deps.settings.current;
		try {
			await this.#appendLog(call, rec, outcome, source, reason, settings, matchedRule, classifier);
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
		classifier?: unknown,
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
		if (classifier !== undefined) entry.classifier = classifier;
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

interface ClassifierModelLike {
	baseUrl?: unknown;
}

function findClassifierModel(registry: unknown, provider: string, modelId: string): ClassifierModelLike | undefined {
	const find = (registry as { findOfType?: unknown } | undefined)?.findOfType;
	if (typeof find !== "function") return undefined;
	try {
		return (find as (t: string, p: string, m: string) => unknown).call(registry, "classifier", provider, modelId) as
			| ClassifierModelLike
			| undefined;
	} catch {
		return undefined;
	}
}

function modelBaseUrl(model: ClassifierModelLike | undefined): string | null {
	return typeof model?.baseUrl === "string" ? model.baseUrl : null;
}
