import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { showInspect } from "./inspect.js";
import { showPermissionDialog } from "./permission-dialog.js";
import type { ActionEvidence, AutomodeSettings, Decision } from "./types.js";
import type { EpochController } from "./runtime/epoch.js";
import { AsyncMutex } from "./runtime/mutex.js";
import { escapeTerminal } from "./runtime/escape.js";

/**
 * Serialized, host-owned local approval dialogs.
 *
 * Invariants enforced here:
 * - One dialog at a time; at most MAX_PENDING requests queued (32). Overflow
 *   never executes.
 * - The approval deadline covers queue wait AND the open dialog.
 * - Decline is the default: Escape, timeout, abort, errors and no answer all
 *   mean "not executed".
 * - Explicit declines suppress identical replays (same evidence fingerprint)
 *   without another dialog.
 * - Approvals only exist in a live local TUI: ctx.mode === "tui" && hasUI.
 *   RPC-forwarded dialogs (hasUI alone) are NOT approval authority.
 * - Allow-once tokens bind the exact evidence fingerprint, the lifecycle
 *   epoch and the settings epoch, and are consumed atomically exactly once.
 */

export const MAX_PENDING_APPROVALS = 32;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60 * 1000;

const CHOICE_DECLINE = "Decline";
const CHOICE_ALLOW_ONCE = "Allow once";
const CHOICE_ALWAYS = "Always Allow";
const CHOICE_INSPECT = "Inspect details";

/** Minimal dialog surface; implemented by ctx.ui in TUI mode. */
export interface ApprovalUi {
	custom?: ExtensionUIContext["custom"];
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ApprovalContext {
	mode: string;
	hasUI: boolean;
	ui: ApprovalUi;
}

export interface ApprovalRequest {
	/** Evidence fingerprint binding this request to exact args/cwd/targets. */
	fingerprint: string;
	/** Human-readable one-line action summary (already escaped by the gate). */
	summary: string;
	/** Multi-line inspect detail (already escaped by the gate). */
	detail: string;
	evidence: ActionEvidence;
	decision: Decision;
	allowAlways?: boolean;
	turnSignal?: AbortSignal;
	/**
	 * Gate-linked pending signal (lifecycle epoch + turn + entry deadline).
	 * Covers queue wait + dialog only; never reaches post-approval execution.
	 */
	signal?: AbortSignal;
}

export interface ApprovalToken {
	readonly id: string;
	readonly fingerprint: string;
	readonly epoch: number;
	readonly settingsEpoch: number;
	consumed: boolean;
}

export type ApprovalOutcome =
	| { kind: "allow-once" | "always-allow"; token: ApprovalToken }
	| { kind: "declined"; replay: boolean }
	| { kind: "expired" }
	| { kind: "cancelled"; reason: string }
	| { kind: "unavailable"; reason: string };

export interface ApprovalSettings {
	readonly current: AutomodeSettings | null;
	readonly epoch: number;
}

export interface ApprovalDeps {
	settings: ApprovalSettings;
	epochs: EpochController;
	now?: () => number;
	newId?: () => string;
}

let fallbackId = 0;

export class ApprovalManager {
	readonly #deps: ApprovalDeps;
	readonly #dialogMutex = new AsyncMutex();
	readonly #suppressed = new Set<string>();
	#pending = 0;

	constructor(deps: ApprovalDeps) {
		this.#deps = deps;
	}

	get pendingCount(): number {
		return this.#pending;
	}

	isSuppressed(fingerprint: string): boolean {
		return this.#suppressed.has(fingerprint);
	}

	/**
	 * Session boundary: decline-replay suppression is per-session identity.
	 * Called by the extension only when session_start reports a genuinely
	 * different session id (never on tree navigation or policy edits, so a
	 * same-session identical retry stays suppressed and never re-asks).
	 */
	resetSession(): void {
		this.#suppressed.clear();
	}

	/**
	 * Consume a one-shot token atomically. Returns false when the token was
	 * already consumed or no longer matches live epochs; the caller must not
	 * execute in that case.
	 */
	consume(token: ApprovalToken): boolean {
		if (token.consumed) return false;
		if (!this.#deps.epochs.check(token.epoch)) return false;
		if (this.#deps.settings.epoch !== token.settingsEpoch) return false;
		token.consumed = true;
		return true;
	}

	async request(ctx: ApprovalContext, req: ApprovalRequest): Promise<ApprovalOutcome> {
		if (this.#suppressed.has(req.fingerprint)) {
			return { kind: "declined", replay: true };
		}
		if (this.#pending >= MAX_PENDING_APPROVALS) {
			return { kind: "unavailable", reason: "approval queue full" };
		}
		// RPC hasUI=true is not approval authority; only a live local TUI is.
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			return { kind: "unavailable", reason: "approval requires the interactive terminal" };
		}

		const settings = this.#deps.settings.current;
		const timeoutMs = settings?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
		const now = this.#deps.now ?? (() => Date.now());
		const started = now();
		const remaining = () => Math.max(0, timeoutMs - (now() - started));

		const epochSnap = this.#deps.epochs.epoch;
		const settingsEpoch = this.#deps.settings.epoch;
		const epochSignal = this.#deps.epochs.signal;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signals = [epochSignal, timeoutSignal];
		if (req.turnSignal) signals.push(req.turnSignal);
		if (req.signal) signals.push(req.signal);
		const combined = AbortSignal.any(signals);
		const classifyAbort = (): ApprovalOutcome => {
			if (timeoutSignal.aborted) return { kind: "expired" };
			// The gate's entry deadline maps to an expiry, not a session cancel.
			if (req.signal?.aborted && String(req.signal.reason).includes("deadline")) return { kind: "expired" };
			if (req.turnSignal?.aborted) return { kind: "cancelled", reason: "turn aborted" };
			const reason = this.#deps.epochs.invalidatedReason ?? "aborted";
			return { kind: "cancelled", reason };
		};
		if (combined.aborted) return classifyAbort();

		this.#pending += 1;
		try {
			const release = await this.#dialogMutex.acquire(combined);
			if (!release) return classifyAbort();
			try {
				if (combined.aborted) return classifyAbort();
				for (;;) {
					const title = `Needs your permission\n\n${req.summary}`;
					const options = [CHOICE_DECLINE, CHOICE_ALLOW_ONCE, ...(req.allowAlways ? [CHOICE_ALWAYS] : []), CHOICE_INSPECT];
					const choice = ctx.ui.custom
						? await showPermissionDialog({ custom: ctx.ui.custom.bind(ctx.ui) }, req.summary, options, combined, remaining())
						: await ctx.ui.select(title, options, { signal: combined, timeout: remaining() });
					if (combined.aborted) return classifyAbort();
					if (choice === CHOICE_ALLOW_ONCE || (choice === CHOICE_ALWAYS && req.allowAlways)) {
						// Token creation requires the epochs that gate revalidation re-checks.
						if (!this.#deps.epochs.check(epochSnap) || this.#deps.settings.epoch !== settingsEpoch) {
							return { kind: "cancelled", reason: "policy or session changed while awaiting approval" };
						}
						const id = this.#deps.newId?.() ?? `approval-${++fallbackId}`;
						return {
							kind: choice === CHOICE_ALWAYS ? "always-allow" : "allow-once",
							token: { id, fingerprint: req.fingerprint, epoch: epochSnap, settingsEpoch, consumed: false },
						};
					}
					if (choice === CHOICE_INSPECT) {
						if (ctx.ui.custom) {
							await showInspect({ custom: ctx.ui.custom.bind(ctx.ui) }, req.detail, combined);
						} else {
							await ctx.ui.select(`Inspect — exact action (control characters escaped)\n\n${req.detail}\n\nEsc close`, [], {
								signal: combined,
								timeout: remaining(),
							});
						}
						if (combined.aborted) return classifyAbort();
						continue;
					}
					// Decline, Escape, dialog dismissal: no execution. Only an
					// explicit Decline suppresses identical replays.
					if (choice === CHOICE_DECLINE) {
						this.#suppressed.add(req.fingerprint);
					}
					return { kind: "declined", replay: false };
				}
			} finally {
				release();
			}
		} catch {
			// A dialog failure must never become permission.
			return { kind: "unavailable", reason: "approval dialog failed" };
		} finally {
			this.#pending -= 1;
		}
	}
}

/** Render the multi-line inspect body for an evidence object (escaped, local only). */
export function renderInspectDetail(evidence: ActionEvidence, decision: Decision): string {
	const lines = [
		`tool: ${evidence.action.tool}`,
		`args: ${escapeTerminal(JSON.stringify(evidence.action.args, null, 2) ?? "unavailable", { multiline: true })}`,
		`cwd: ${escapeTerminal(evidence.action.cwd)}`,
		`workspace: ${escapeTerminal(evidence.workspace)}`,
	];
	if (evidence.canonicalPath) lines.push(`canonical target: ${escapeTerminal(evidence.canonicalPath)}`);
	if (evidence.protectedReason) lines.push(`protected: ${escapeTerminal(evidence.protectedReason)}`);
	lines.push(`sensitive: ${evidence.sensitive ? "yes" : "no"}`);
	lines.push(`evidence complete: ${evidence.complete ? "yes" : "NO — incomplete evidence"}`);
	lines.push(`fingerprint: ${escapeTerminal(evidence.fingerprint)}`);
	lines.push(`decision: ${decision.outcome} · ${escapeTerminal(decision.source)} · ${escapeTerminal(decision.reason)}`);
	return lines.join("\n");
}
