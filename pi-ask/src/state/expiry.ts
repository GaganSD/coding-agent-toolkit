/**
 * Expiry rules as pure logic: the countdown clock and the fallback answers.
 *
 * The clock is conservative by construction. It runs only while the form is
 * on screen (and the "question waiting" notification has fired), and it can
 * only ever stop, never restart:
 *
 * - any key the form receives stops it (the user is here);
 * - putting the form away (panel hidden, another form on top) stops it;
 * - once stopped or expired it stays that way.
 *
 * Time and timers are injected, so every rule is tested without waiting.
 */
import type { AskQuestion, AskResult, AskState } from "../types.ts";
import { isAnswerAnswered } from "./answers.ts";
import { toAskResult } from "./result.ts";

/** Why a countdown that had not expired will never fire. */
export type ExpiryStopReason =
	/** The user touched the form (a key, or opening it on purpose). */
	| "interaction"
	/** The form left the screen before it ran out. */
	| "hidden";

export type ExpiryPhase = "pending" | "running" | "stopped" | "expired";

export interface ExpiryView {
	phase: ExpiryPhase;
	/** Whole seconds left; only meaningful while `running`. */
	remainingSeconds: number;
	stopReason?: ExpiryStopReason;
}

export interface ExpiryClock {
	clearTimeout(handle: unknown): void;
	now(): number;
	setTimeout(task: () => void, ms: number): unknown;
}

export const systemClock: ExpiryClock = {
	now: () => Date.now(),
	setTimeout: (task, ms) => {
		const handle = setTimeout(task, ms);
		// A countdown must never keep Pi's process alive.
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ExpiryListener {
	/** The view changed: redraw. At most once per second while running. */
	change?(view: ExpiryView): void;
	/** The limit lapsed. */
	expire?(): void;
	/**
	 * Another listener threw; return true when the error was reported. An
	 * unreported error is rethrown once every listener has run. The timer's
	 * own state is unaffected either way.
	 */
	failed?(error: unknown): boolean | undefined;
	/** The countdown was stopped before it lapsed. */
	stop?(reason: ExpiryStopReason): void;
}

export interface ExpiryTimer {
	/** The "question waiting" notification fired; the clock may now start. */
	arm(): void;
	dispose(): void;
	/** The form is on screen; starts the clock if it is armed. */
	hide(): void;
	/** The user did something with the form. Stops the clock for good. */
	interact(): void;
	show(): void;
	/** Stop for good, with a reason (e.g. the user opened the panel). */
	stop(reason: ExpiryStopReason): void;
	subscribe(listener: ExpiryListener): () => void;
	view(): ExpiryView;
}

/** Hard ceiling for a call's limit: 24 hours. Longer requests are lowered. */
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

/** Shorter requests are raised to the floor, longer ones lowered to the ceiling. */
export function effectiveTimeoutSeconds(
	requested: number | undefined,
	minSeconds: number
): number | undefined {
	if (requested === undefined) {
		return;
	}
	return clampTimeoutSeconds(
		Math.max(Math.ceil(requested), Math.ceil(minSeconds))
	);
}

function clampTimeoutSeconds(seconds: number): number {
	return Math.min(Math.ceil(seconds), MAX_TIMEOUT_SECONDS);
}

export function createExpiryTimer(
	seconds: number,
	clock: ExpiryClock = systemClock
): ExpiryTimer {
	const totalSeconds = clampTimeoutSeconds(seconds);
	const listeners = new Set<ExpiryListener>();
	let phase: ExpiryPhase = "pending";
	let stopReason: ExpiryStopReason | undefined;
	let armed = false;
	let visible = false;
	let deadline = 0;
	let handle: unknown;
	let disposed = false;

	const remaining = () =>
		phase === "running"
			? Math.max(0, Math.ceil((deadline - clock.now()) / 1000))
			: 0;
	const view = (): ExpiryView => ({
		phase,
		remainingSeconds: remaining(),
		...(stopReason ? { stopReason } : {}),
	});
	/** Runs every listener; returns the first error nobody reported. */
	const emit = (call: (listener: ExpiryListener) => void): unknown[] => {
		// One listener's failure never skips the others or undoes a state change.
		const failures: unknown[] = [];
		for (const listener of [...listeners]) {
			try {
				call(listener);
			} catch (error) {
				failures.push(error);
			}
		}
		return failures.filter((error) => {
			let reported = false;
			for (const listener of [...listeners]) {
				try {
					reported = listener.failed?.(error) === true || reported;
				} catch {
					// Reporting is best-effort.
				}
			}
			return !reported;
		});
	};
	/** Surfaces the first unreported listener error after all work is done. */
	const settle = (...unreported: unknown[][]) => {
		const [first] = unreported.flat();
		if (first !== undefined) {
			throw first;
		}
	};
	const cancelTick = () => {
		if (handle !== undefined) {
			clock.clearTimeout(handle);
			handle = undefined;
		}
	};
	const schedule = () => {
		// Wake at the next whole second, or at the deadline if that is sooner.
		const left = deadline - clock.now();
		const toNextSecond = left - (Math.ceil(left / 1000) - 1) * 1000;
		handle = clock.setTimeout(tick, Math.max(1, Math.min(left, toNextSecond)));
	};
	function tick() {
		handle = undefined;
		if (phase !== "running") {
			return;
		}
		if (clock.now() >= deadline) {
			phase = "expired";
			settle(
				emit((listener) => listener.change?.(view())),
				emit((listener) => listener.expire?.())
			);
			return;
		}
		const unreported = emit((listener) => listener.change?.(view()));
		schedule();
		settle(unreported);
	}
	function maybeStart() {
		if (disposed || phase !== "pending" || !(armed && visible)) {
			return;
		}
		phase = "running";
		deadline = clock.now() + totalSeconds * 1000;
		schedule();
		settle(emit((listener) => listener.change?.(view())));
	}
	function stop(reason: ExpiryStopReason) {
		if (phase !== "pending" && phase !== "running") {
			return;
		}
		cancelTick();
		phase = "stopped";
		stopReason = reason;
		settle(
			emit((listener) => listener.stop?.(reason)),
			emit((listener) => listener.change?.(view()))
		);
	}

	return {
		view,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		arm() {
			armed = true;
			maybeStart();
		},
		show() {
			visible = true;
			maybeStart();
		},
		hide() {
			visible = false;
			if (phase === "running") {
				stop("hidden");
			}
		},
		interact() {
			stop("interaction");
		},
		stop,
		dispose() {
			disposed = true;
			cancelTick();
			listeners.clear();
		},
	};
}

/**
 * The fallbacks that apply to `state` when its limit lapses: only questions
 * that declared one, that still have no answer, and that were not skipped.
 * Returns the answers to merge and the ids that received one.
 */
export function applyFallbacks(state: AskState): {
	answers: AskState["answers"];
	applied: string[];
} {
	const answers = { ...state.answers };
	const applied: string[] = [];
	for (const question of state.questions) {
		if (
			!hasDeclaredFallback(question) ||
			isAnswerAnswered(answers[question.id]) ||
			state.skipped?.includes(question.id)
		) {
			continue;
		}
		const index = question.options.findIndex(
			(option) => option.value === question.fallback
		);
		const option = question.options[index];
		if (!option) {
			continue;
		}
		answers[question.id] = {
			...answers[question.id],
			selected: [{ value: option.value, label: option.label, index: index + 1 }],
		};
		applied.push(question.id);
	}
	return { answers, applied };
}

export function hasDeclaredFallback(question: AskQuestion): boolean {
	return question.type !== "text" && !!question.fallback;
}

/** The `expired` result for a form whose limit lapsed. */
export function toExpiredResult(state: AskState): AskResult {
	const { answers, applied } = applyFallbacks(state);
	return {
		...toAskResult({ ...state, answers }, "expired"),
		expired: applied,
	};
}

/**
 * Formats the countdown for the form header. `m:ss` under an hour so the
 * remaining time reads at a glance.
 */
export function formatRemaining(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = String(seconds % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${minutes}:${rest}`;
}
