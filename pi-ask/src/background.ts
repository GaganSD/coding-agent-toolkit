/**
 * Forms whose tool call is not waiting for them: background calls, forms the
 * user deferred, and forms left open when Pi last stopped. They share one
 * queue in request order, one panel above the editor, and one way back to
 * the agent (a follow-up message, see `delivery.ts`).
 *
 * Everything is rebuilt from the active session branch, so a reload, resume,
 * fork or tree move shows exactly what that branch asked. This file is the
 * wiring; the rules live in `state/panel.ts` and `state/outbox.ts`.
 */
import type {
	BoundaryResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";
import { DEFAULT_ASK_CONFIG } from "./config/defaults.ts";
import type { AskConfig } from "./config/schema.ts";
import { getAskConfigStore } from "./config/store.ts";
import { getGlobalBindings, matchesBinding } from "./constants/keymaps.ts";
import {
	type AskBoundaryEvent,
	createAskDelivery,
	renderAskAnswerMessage,
} from "./delivery.ts";
import { askStrings } from "./i18n.ts";
import {
	ASK_ANSWER_MESSAGE_TYPE,
	type AskFormSnapshot,
} from "./journal/entries.ts";
import { AskJournalWriteError, readAskJournal } from "./journal/journal.ts";
import {
	type AskJournalRecord,
	getRecord,
	isOpen,
	pendingForms,
	reopenableForms,
} from "./journal/replay.ts";
import type { AskRuntime } from "./runtime.ts";
import { createInitialState } from "./state/create.ts";
import {
	applyDraftSnapshot,
	draftContentKey,
	toDraftSnapshot,
} from "./state/draft.ts";
import {
	createExpiryTimer,
	type ExpiryTimer,
	toExpiredResult,
} from "./state/expiry.ts";
import {
	type AskPanelEvent,
	EMPTY_PANEL,
	panelTakesFocusKey,
	panelView,
	reducePanel,
} from "./state/panel.ts";
import { toAskResult } from "./state/result.ts";
import type { AskParams, AskResult, AskState } from "./types.ts";
import { type AskPanel, createAskPanel } from "./ui/panel.ts";

export const ASK_PENDING_WIDGET_KEY = "pi-ask:pending";

/**
 * How long an expired form is offered for a late correction: it shows in the
 * pending indicator and `/ask-panel`, measured from the expiry. After that
 * the agent's result stands and nothing nags.
 */
export const EXPIRED_OFFER_MS = 60 * 60 * 1000;

export interface AskBackgroundDeps {
	/** Runs `task` after the current lifecycle dispatch has finished. */
	defer?: (task: () => void) => void;
	/** Clock for the countdown of queued forms; tests inject their own. */
	newTimer?: (seconds: number) => ExpiryTimer;
	/** Epoch milliseconds; used for the late-override offer window. */
	now?: () => number;
}

export interface AskBackground {
	/** The session started, or the tree moved: rebuild from the branch. */
	attach(ctx: ExtensionContext): void;
	/** `turn_end` / `agent_before_settle`: pending answers join the run. */
	boundary(
		ctx: ExtensionContext,
		event: AskBoundaryEvent
	): BoundaryResult | undefined;
	/** Stop for good: the runtime this belongs to is going away. */
	dispose(): void;
	/**
	 * `requestId` was journalled as a background or deferred form. Returns
	 * how many forms are now waiting.
	 */
	enqueue(
		ctx: ExtensionContext,
		requestId: string,
		origin: "background" | "deferred",
		options?: { timeoutSeconds?: number }
	): number;
	/**
	 * Runs a blocking form. It owns the keyboard: the panel is off screen
	 * until `run` settles, then returns with the focus it had.
	 */
	foreground<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T>;
	/**
	 * A blocking form just got its outcome (e.g. it expired): refresh the
	 * queue and the late-override offer.
	 */
	formEnded(ctx: ExtensionContext): void;
	/** Pi may have become idle without a run settling: deliver if so. */
	poke(ctx: ExtensionContext): void;
	/** `/ask-panel`: show the panel and give it the keyboard. */
	reopen(ctx: ExtensionContext): void;
	/** The agent run is over; `aborted` when the user stopped it. */
	settled(ctx: ExtensionContext, aborted?: boolean): void;
	/** A run started: sends that never reached the branch are retried. */
	started(): void;
}

export function registerAskBackground(
	pi: ExtensionAPI,
	runtime: AskRuntime,
	deps: AskBackgroundDeps = {}
): AskBackground {
	const background = createAskBackground(pi, runtime, deps);
	runtime.background = background;
	pi.on("session_start", (_event, ctx) => background.attach(ctx));
	pi.on("session_tree", (_event, ctx) => background.attach(ctx));
	pi.on("session_shutdown", () => background.dispose());
	pi.on("agent_start", () => background.started());
	pi.on("turn_end", (event, ctx) => background.boundary(ctx, event));
	pi.on(
		"agent_before_settle",
		(event, ctx) => background.boundary(ctx, event)
	);
	pi.on("agent_settled", (event, ctx) =>
		background.settled(ctx, event.aborted)
	);
	// A manual compaction keeps Pi busy without a run; pick up afterwards.
	pi.on("session_compact", (_event, ctx) => background.poke(ctx));
	pi.registerMessageRenderer?.(
		ASK_ANSWER_MESSAGE_TYPE,
		renderAskAnswerMessage
	);
	pi.registerCommand?.("ask-panel", {
		description: "Show waiting ask_user questions",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			background.reopen(ctx);
		},
	});
	return background;
}

export function createAskBackground(
	pi: Pick<ExtensionAPI, "sendMessage">,
	{ clock, flushers, journal, live }: AskRuntime,
	deps: AskBackgroundDeps = {}
): AskBackground {
	const defer = deps.defer ?? ((task) => setTimeout(task, 0));
	const now = deps.now ?? clock?.now ?? Date.now;
	const newTimer =
		deps.newTimer ?? ((seconds) => createExpiryTimer(seconds, clock));
	const delivery = createAskDelivery(pi);
	const recorders = new Map<string, (state: AskState) => void>();
	// Content key of the draft each loaded form last started from or wrote,
	// to tell whether a re-read branch still agrees with what is on screen.
	const shown = new Map<string, string>();
	// Forms put on screen at least once here: their user was already told.
	const seen = new Set<string>();
	// Countdowns of background forms created in THIS process. A form from an
	// earlier process (restart, resume, fork, reload) never has one: the user
	// had no fair chance to see its clock, so it waits like a normal form.
	const timers = new Map<string, ExpiryTimer>();
	// Expired forms the user asked to reopen, and those still on offer.
	const reopened = new Set<string>();
	let offers: string[] = [];
	// Recovered forms announced in this process.
	const announced = new Set<string>();
	let state = EMPTY_PANEL;
	let records = new Map<string, AskJournalRecord>();
	let ctx: ExtensionContext | undefined;
	let config: AskConfig = DEFAULT_ASK_CONFIG;
	let configLoaded = false;
	let disposed = false;
	let indicator: string | undefined;
	let focusWarned = false;
	let unbindInput: (() => void) | undefined;
	let boundUi: ExtensionContext["ui"] | undefined;
	const unsubscribeConfig = getAskConfigStore().subscribe((next) => {
		config = next;
		indicator = undefined;
		render();
	});

	const panel: AskPanel = createAskPanel({
		// The host moved focus itself: follow it, without touching the screen.
		onBlur() {
			state = reducePanel(state, { type: "blurred" });
			updateIndicator();
		},
		onFocus() {
			state = reducePanel(state, { type: "refocused" });
			updateIndicator();
		},
		onHide(requestId) {
			if (!isQueued(requestId)) {
				return;
			}
			journal.recordPanel(true, requestId);
			dispatch({ type: "hide" });
		},
		onDone: complete,
		onStateChange(requestId, formState) {
			if (!isQueued(requestId)) {
				return;
			}
			recorderFor(requestId)(formState);
			shown.set(requestId, draftContentKey(toDraftSnapshot(formState)));
			updateIndicator();
		},
	});

	/** On the active branch and waiting, as of the last rebuild. */
	function isQueued(requestId: string): boolean {
		return !disposed && state.queue.includes(requestId);
	}

	function recorderFor(requestId: string) {
		let recorder = recorders.get(requestId);
		if (!recorder) {
			recorder = journal.draftRecorder(requestId, records.get(requestId)?.draft);
			recorders.set(requestId, recorder);
		}
		return recorder;
	}

	function readQueue(current: ExtensionContext) {
		const journalState = readAskJournal(current);
		const pending = pendingForms(journalState, live, reopened);
		records = new Map(pending.map((record) => [record.requestId, record]));
		for (const requestId of recorders.keys()) {
			if (!records.has(requestId)) {
				recorders.delete(requestId);
			}
		}
		for (const requestId of [...reopened]) {
			if (!records.has(requestId)) {
				reopened.delete(requestId);
			}
		}
		for (const [requestId, timer] of [...timers]) {
			// Gone from this branch: nothing is left to count down.
			if (!records.has(requestId)) {
				releaseTimer(requestId, timer);
			}
		}
		offers = reopenableForms(journalState, {
			now: now(),
			maxAgeMs: EXPIRED_OFFER_MS,
		})
			.map((record) => record.requestId)
			.filter((requestId) => !reopened.has(requestId));
		return {
			queue: pending.map((record) => record.requestId),
			hidden: journalState.panelHidden,
		};
	}

	/**
	 * The session moved (resume, tree jump): the journal of the new branch
	 * is the truth. A form kept on screen from the old branch is rebuilt from
	 * it when its draft differs, so answers rolled back are not shown or sent.
	 */
	function reconcileBranch(current: ExtensionContext) {
		try {
			recorders.clear();
			readQueue(current);
			for (const requestId of [...shown.keys()]) {
				const record = records.get(requestId);
				const branchKey = record
					? draftContentKey(record.draft ?? { answers: {} })
					: undefined;
				if (branchKey === shown.get(requestId)) {
					continue;
				}
				shown.delete(requestId);
				panel.drop(requestId);
			}
		} catch {
			// A stale context: the next lifecycle event rebuilds.
		}
	}

	function releaseTimer(requestId: string, timer = timers.get(requestId)) {
		timer?.dispose();
		timers.delete(requestId);
	}

	/** A form counts down only while it is the one on screen. */
	function syncTimers() {
		const view = panelView(state);
		for (const [requestId, timer] of timers) {
			// A stop the journal recorded is final, even if a timer somehow
			// survived the rebuild that read it.
			const stopped = records.get(requestId)?.clockStopped === true;
			if (!stopped && view.visible && view.formId === requestId) {
				timer.show();
			} else {
				timer.hide();
			}
		}
	}

	/** The limit lapsed with the form still on screen, untouched. */
	function expire(requestId: string) {
		const record = records.get(requestId);
		if (!(record && isQueued(requestId))) {
			return;
		}
		const formState =
			panel.state(requestId) ??
			applyDraftSnapshot(
				createInitialState(formToParams(record.form)),
				record.draft
			);
		try {
			complete(requestId, toExpiredResult(formState));
		} catch (error) {
			if (!(error instanceof AskJournalWriteError)) {
				throw error;
			}
			ctx?.ui.notify(error.message, "error");
		}
	}

	function dispatch(event: AskPanelEvent) {
		state = reducePanel(state, event);
		render();
	}

	/** Re-read the branch, then apply `toEvent` to the fresh queue. */
	function refresh(
		toEvent: (queue: string[], hidden: boolean) => AskPanelEvent
	) {
		if (disposed || !ctx) {
			return;
		}
		try {
			const { queue, hidden } = readQueue(ctx);
			dispatch(toEvent(queue, hidden));
		} catch {
			// A stale context: the next lifecycle event rebuilds.
		}
	}

	function render() {
		if (disposed || !ctx) {
			return;
		}
		try {
			panel.retain(state.queue);
			const focusedOk = panel.apply(ctx, panelView(state), loadForm);
			syncTimers();
			if (!focusedOk) {
				state = reducePanel(state, { type: "blurred" });
				if (!focusWarned) {
					focusWarned = true;
					ctx.ui.notify(askStrings().panelFocusUnsupported, "warning");
				}
			}
			updateIndicator();
		} catch {
			// The UI is gone or not ready; the journal still has everything.
		}
	}

	function loadForm(requestId: string) {
		const record = records.get(requestId);
		if (!(record && ctx)) {
			return;
		}
		if (
			record.mode === "foreground" &&
			!record.deferred &&
			!announced.has(requestId)
		) {
			announced.add(requestId);
			ctx.ui.notify(askStrings().recoveredNotice, "info");
		}
		const expired = record.outcome?.result.status === "expired";
		shown.set(requestId, draftContentKey(record.draft ?? { answers: {} }));
		const rebuilt = seen.has(requestId);
		seen.add(requestId);
		return {
			rebuilt,
			requestId,
			config,
			draft: record.draft,
			params: formToParams(record.form),
			expiry: timers.get(requestId),
			...(expired ? { banner: askStrings().lateOverrideBanner } : {}),
		};
	}

	function updateIndicator() {
		if (disposed || !ctx) {
			return;
		}
		const forms = state.queue.length;
		const lines = [
			forms === 0
				? undefined
				: askStrings().pendingIndicator({
						forms,
						questions: state.queue.reduce(
							(sum, requestId) => sum + unansweredCount(requestId),
							0
						),
						key: getGlobalBindings(config).panelFocus.label,
						focused: panelView(state).focused,
					}),
			offers.length === 0
				? undefined
				: askStrings().expiredIndicator(offers.length),
		].filter((line): line is string => line !== undefined);
		const text = lines.length === 0 ? undefined : lines.join("\n");
		if (text === indicator) {
			return;
		}
		indicator = text;
		ctx.ui.setWidget(
			ASK_PENDING_WIDGET_KEY,
			text === undefined
				? undefined
				: lines.map((line) => ctx?.ui.theme.fg("dim", line) ?? line),
			{ placement: "belowEditor" }
		);
	}

	function unansweredCount(requestId: string): number {
		const record = records.get(requestId);
		if (!record) {
			return 0;
		}
		const formState =
			panel.state(requestId) ??
			applyDraftSnapshot(
				createInitialState(formToParams(record.form)),
				record.draft
			);
		return toAskResult(formState).unanswered.length;
	}

	/** The panel's form was submitted or cancelled. */
	function complete(requestId: string, result: AskResult) {
		const current = ctx;
		if (disposed || !current) {
			return;
		}
		try {
			// The journal, not memory, says whether this branch still waits for
			// this form: a form from another branch writes nothing here.
			const record = getRecord(readAskJournal(current), requestId);
			// A reopened expired form is open to one correction.
			const expiredOutcome =
				record && reopened.has(requestId) && !record.offerDismissed
					? record.outcome
					: undefined;
			const correcting = expiredOutcome?.result.status === "expired";
			if (
				record &&
				(isOpen(record) || correcting) &&
				isQueued(requestId) &&
				result.status !== "unavailable"
			) {
				if (correcting && result.status === "cancelled" && !result.comment) {
					// Closing it without a word leaves the agent's result as it is.
					journal.recordDismiss(requestId);
				} else {
					journal.recordOutcome(
						requestId,
						result,
						"message",
						correcting ? expiredOutcome?.outcomeId : undefined
					);
					delivery.post();
					delivery.pump(current);
				}
			}
		} catch (error) {
			if (error instanceof AskJournalWriteError) {
				// The input boundary reports this and keeps the form open to retry.
				throw error;
			}
			// A stale context: nothing is written.
		}
		releaseTimer(requestId);
		reopened.delete(requestId);
		refresh((queue) => ({ type: "removed", queue }));
	}

	function bindInput(current: ExtensionContext) {
		if (boundUi === current.ui) {
			return;
		}
		unbindInput?.();
		boundUi = current.ui;
		unbindInput = current.ui.onTerminalInput?.((data) => {
			if (
				disposed ||
				isKeyRelease(data) ||
				!panelTakesFocusKey(state) ||
				!matchesBinding(data, getGlobalBindings(config).panelFocus)
			) {
				return;
			}
			toggleFocus();
			return { consume: true };
		});
	}

	/** The user opened or focused the panel on purpose: they are here. */
	function userEngaged() {
		const head = state.queue[0];
		if (head !== undefined) {
			timers.get(head)?.stop("interaction");
		}
	}

	function toggleFocus() {
		userEngaged();
		if (state.hidden) {
			journal.recordPanel(false, state.queue[0]);
		}
		dispatch({ type: "toggleFocus" });
	}

	function loadConfig() {
		if (configLoaded) {
			return;
		}
		configLoaded = true;
		getAskConfigStore()
			.ensureLoaded()
			.then(({ config: loaded }) => {
				config = loaded;
				indicator = undefined;
				render();
			})
			.catch(() => {
				// Defaults stay in effect.
			});
	}

	function poke(next: ExtensionContext) {
		// Starting a turn from inside a lifecycle dispatch is too early.
		defer(() => {
			if (disposed) {
				return;
			}
			try {
				delivery.pump(next);
			} catch {
				// A stale context: the next event tries again.
			}
		});
	}

	function adopt(next: ExtensionContext): boolean {
		if (disposed || next.mode !== "tui") {
			return false;
		}
		ctx = next;
		bindInput(next);
		loadConfig();
		return true;
	}

	return {
		attach(next) {
			if (!adopt(next)) {
				return;
			}
			reconcileBranch(next);
			refresh((queue, hidden) => ({ type: "sync", queue, hidden }));
			delivery.attach(next);
			poke(next);
		},
		poke,
		formEnded(next) {
			if (adopt(next)) {
				refresh((queue) => ({ type: "removed", queue }));
			}
		},
		enqueue(next, requestId, origin, options = {}) {
			if (!adopt(next)) {
				return 0;
			}
			if (origin === "background" && options.timeoutSeconds !== undefined) {
				const timer = newTimer(options.timeoutSeconds);
				timer.subscribe({
					stop: (reason) => journal.recordExpiryStop(requestId, reason),
					expire: () => expire(requestId),
				});
				timers.set(requestId, timer);
			}
			if (origin === "deferred") {
				// "Later" means the keyboard goes back to the input.
				state = reducePanel(state, { type: "blurred" });
			}
			const focus = origin === "background" && editorIsEmpty(next);
			refresh((queue) => ({ type: "arrived", queue, focus }));
			if (state.hidden && origin === "background") {
				next.ui.notify(askStrings().queuedHiddenNotice, "info");
			}
			return state.queue.includes(requestId) ? state.queue.length : 0;
		},
		async foreground(next, run) {
			const adopted = adopt(next);
			if (adopted) {
				dispatch({ type: "foregroundOpened" });
			}
			try {
				return await run();
			} finally {
				if (adopted) {
					state = reducePanel(state, { type: "foregroundClosed" });
					refresh((queue) => ({ type: "removed", queue }));
				}
			}
		},
		reopen(next) {
			if (!adopt(next)) {
				next.ui.notify(askStrings().panelNeedsTui, "error");
				return;
			}
			// Timed-out forms the agent has already moved past come back here,
			// on request only. Read the branch first: the offers may be new.
			refresh((queue) => ({ type: "removed", queue }));
			for (const requestId of offers) {
				reopened.add(requestId);
			}
			refresh((queue) => ({ type: "removed", queue }));
			if (state.queue.length === 0) {
				next.ui.notify(askStrings().nothingPending, "info");
				return;
			}
			userEngaged();
			if (state.hidden) {
				journal.recordPanel(false, state.queue[0]);
			}
			dispatch({ type: "reopen" });
		},
		boundary(next, event) {
			if (disposed) {
				return;
			}
			try {
				return delivery.boundary(next, event);
			} catch {
				return;
			}
		},
		settled(next, aborted) {
			if (disposed) {
				return;
			}
			try {
				delivery.pump(next, { trigger: "settled", aborted });
			} catch {
				// A stale context: the next event tries again.
			}
		},
		started() {
			if (!disposed) {
				delivery.started();
			}
		},
		dispose() {
			if (disposed) {
				return;
			}
			// Blocking forms are not in the panel: report their typing first.
			for (const flush of [...flushers]) {
				try {
					flush();
				} catch {
					// The journal is gone; nothing more can be kept.
				}
			}
			try {
				panel.discard();
				ctx?.ui.setWidget(ASK_PENDING_WIDGET_KEY, undefined);
			} catch {
				// The UI is already gone.
			}
			disposed = true;
			for (const [requestId, timer] of [...timers]) {
				releaseTimer(requestId, timer);
			}
			ctx = undefined;
			unbindInput?.();
			unsubscribeConfig();
		},
	};
}

/** A new form may take the keyboard only if no message is being written. */
function editorIsEmpty(ctx: ExtensionContext): boolean {
	try {
		return ctx.ui.getEditorText().trim().length === 0;
	} catch {
		return false;
	}
}

export function formToParams(form: AskFormSnapshot): AskParams {
	return {
		title: form.title,
		questions: form.questions,
		...(form.timeoutSeconds === undefined
			? {}
			: { timeoutSeconds: form.timeoutSeconds }),
	};
}
