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
	type AskBoundaryResult,
	createAskDelivery,
	renderAskAnswerMessage,
} from "./delivery.ts";
import { askStrings } from "./i18n.ts";
import {
	ASK_ANSWER_MESSAGE_TYPE,
	type AskFormSnapshot,
} from "./journal/entries.ts";
import { readAskJournal } from "./journal/journal.ts";
import {
	type AskJournalRecord,
	getRecord,
	isOpen,
	pendingForms,
} from "./journal/replay.ts";
import type { AskRuntime } from "./runtime.ts";
import { createInitialState } from "./state/create.ts";
import { applyDraftSnapshot } from "./state/draft.ts";
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

export interface AskBackgroundDeps {
	/** Runs `task` after the current lifecycle dispatch has finished. */
	defer?: (task: () => void) => void;
}

export interface AskBackground {
	/** The session started, or the tree moved: rebuild from the branch. */
	attach(ctx: ExtensionContext): void;
	/** `turn_end` / `agent_before_settle`: pending answers join the run. */
	boundary(
		ctx: ExtensionContext,
		event: AskBoundaryEvent
	): AskBoundaryResult | undefined;
	/** Stop for good: the runtime this belongs to is going away. */
	dispose(): void;
	/**
	 * `requestId` was journalled as a background or deferred form. Returns
	 * how many forms are now waiting.
	 */
	enqueue(
		ctx: ExtensionContext,
		requestId: string,
		origin: "background" | "deferred"
	): number;
	/**
	 * Runs a blocking form. It owns the keyboard: the panel is off screen
	 * until `run` settles, then returns with the focus it had.
	 */
	foreground<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T>;
	/** Pi may have become idle without a run settling: deliver if so. */
	poke(ctx: ExtensionContext): void;
	/** `/ask-panel`: show the panel and give it the keyboard. */
	reopen(ctx: ExtensionContext): void;
	/** The agent run is over; `aborted` when the user stopped it. */
	settled(ctx: ExtensionContext, aborted?: boolean): void;
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
	pi.on("turn_end", (event, ctx) => background.boundary(ctx, event) as never);
	pi.on(
		"agent_before_settle",
		(event, ctx) => background.boundary(ctx, event) as never
	);
	pi.on("agent_settled", (event, ctx) =>
		background.settled(ctx, event.aborted)
	);
	// A manual compaction keeps Pi busy without a run; pick up afterwards.
	pi.on("session_compact", (_event, ctx) => background.poke(ctx));
	pi.registerMessageRenderer?.(
		ASK_ANSWER_MESSAGE_TYPE,
		renderAskAnswerMessage as never
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
	{ journal, live }: AskRuntime,
	deps: AskBackgroundDeps = {}
): AskBackground {
	const defer = deps.defer ?? ((task) => setTimeout(task, 0));
	const delivery = createAskDelivery(pi);
	const recorders = new Map<string, (state: AskState) => void>();
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
		const pending = pendingForms(journalState, live);
		records = new Map(pending.map((record) => [record.requestId, record]));
		for (const requestId of recorders.keys()) {
			if (!records.has(requestId)) {
				recorders.delete(requestId);
			}
		}
		return {
			queue: pending.map((record) => record.requestId),
			hidden: journalState.panelHidden,
		};
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
		return {
			requestId,
			config,
			draft: record.draft,
			params: formToParams(record.form),
		};
	}

	function updateIndicator() {
		if (disposed || !ctx) {
			return;
		}
		const forms = state.queue.length;
		const text =
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
					});
		if (text === indicator) {
			return;
		}
		indicator = text;
		ctx.ui.setWidget(
			ASK_PENDING_WIDGET_KEY,
			text === undefined ? undefined : [ctx.ui.theme.fg("dim", text)],
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
			if (
				record &&
				isOpen(record) &&
				isQueued(requestId) &&
				result.status !== "unavailable"
			) {
				journal.recordOutcome(requestId, result, "message");
				delivery.post();
				delivery.pump(current);
			}
		} catch {
			// A stale context: nothing is written.
		}
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

	function toggleFocus() {
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
			refresh((queue, hidden) => ({ type: "sync", queue, hidden }));
			delivery.post();
			poke(next);
		},
		poke,
		enqueue(next, requestId, origin) {
			if (!adopt(next)) {
				return 0;
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
			refresh((queue) => ({ type: "removed", queue }));
			if (state.queue.length === 0) {
				next.ui.notify(askStrings().nothingPending, "info");
				return;
			}
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
		dispose() {
			if (disposed) {
				return;
			}
			try {
				panel.discard();
				ctx?.ui.setWidget(ASK_PENDING_WIDGET_KEY, undefined);
			} catch {
				// The UI is already gone.
			}
			disposed = true;
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
