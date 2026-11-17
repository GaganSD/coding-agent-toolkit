/**
 * Interrupted-form recovery. A foreground form that was open when Pi quit or
 * crashed has a form entry and no outcome on the active branch. In TUI mode
 * it is reopened with its draft; the original tool call's promise is gone,
 * so the result goes to the agent as a follow-up message.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { deliverAskOutcome } from "./delivery.ts";
import { askStrings } from "./i18n.ts";
import type { AskFormSnapshot } from "./journal/entries.ts";
import { readAskJournal } from "./journal/journal.ts";
import {
	getRecord,
	interruptedForms,
	isOpen,
	undeliveredOutcomes,
} from "./journal/replay.ts";
import type { AskRuntime } from "./runtime.ts";
import type { AskParams } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";

export interface AskRecoveryDeps {
	/** Runs `task` after the current lifecycle dispatch has finished. */
	defer?: (task: () => void) => void;
	runFlow?: typeof runAskFlow;
}

export interface AskRecovery {
	/** Stop for good: the session this runtime belongs to is going away. */
	dispose(): void;
	/** Check the active branch; returns at once, never waits for a form. */
	schedule(ctx: ExtensionContext): void;
	/** Resolves when no recovery work is in flight. For tests. */
	settled(): Promise<void>;
}

export function registerAskRecovery(
	pi: ExtensionAPI,
	runtime: AskRuntime,
	deps: AskRecoveryDeps = {}
): AskRecovery {
	const recovery = createAskRecovery(pi, runtime, deps);
	// Handlers only schedule: an open form must not hold up Pi's lifecycle.
	pi.on("session_start", (_event, ctx) => recovery.schedule(ctx));
	pi.on("session_tree", (_event, ctx) => recovery.schedule(ctx));
	pi.on("session_shutdown", () => recovery.dispose());
	return recovery;
}

export function createAskRecovery(
	pi: Pick<ExtensionAPI, "sendMessage">,
	{ journal, live }: AskRuntime,
	deps: AskRecoveryDeps = {}
): AskRecovery {
	const defer = deps.defer ?? ((task) => setTimeout(task, 0));
	const runFlow = deps.runFlow ?? runAskFlow;
	// Guards for one process, on top of the journal: a form is offered once,
	// and an outcome is sent once, even if a journal write was lost.
	const offered = new Set<string>();
	const sent = new Set<string>();
	// The recovered form on screen. `detached` once its branch is no longer
	// the active one: from then on nothing about it is written.
	let open: { detached: boolean; requestId: string } | undefined;
	let ctx: ExtensionContext | undefined;
	let disposed = false;
	let work: Promise<void> | undefined;
	let again = false;

	function deliverPending(current: ExtensionContext) {
		for (const { outcome } of undeliveredOutcomes(readAskJournal(current))) {
			if (sent.has(outcome.outcomeId)) {
				continue;
			}
			sent.add(outcome.outcomeId);
			deliverAskOutcome(pi, current, journal, outcome);
		}
	}

	async function recoverNext(current: ExtensionContext): Promise<boolean> {
		const record = interruptedForms(readAskJournal(current)).find(
			({ requestId }) => !(offered.has(requestId) || live.has(requestId))
		);
		if (!record) {
			return false;
		}
		const { requestId } = record;
		offered.add(requestId);
		live.add(requestId);
		const form = { requestId, detached: false };
		const recordDraft = journal.draftRecorder(requestId, record.draft);
		let result: Awaited<ReturnType<typeof runAskFlow>>;
		open = form;
		try {
			current.ui.notify(askStrings().recoveredNotice, "info");
			result = await runFlow(current, formToParams(record.form), {
				draft: record.draft,
				onStateChange(state) {
					if (!(disposed || form.detached)) {
						recordDraft(state);
					}
				},
			});
		} finally {
			open = undefined;
			live.delete(requestId);
		}
		if (disposed) {
			return false;
		}
		// The branch may have changed while the form was open. An answer is
		// only written to a branch that still has the form and no outcome.
		const latest = getRecord(readAskJournal(ctx ?? current), requestId);
		if (
			form.detached ||
			!(latest && isOpen(latest)) ||
			result.status === "unavailable"
		) {
			return true;
		}
		const outcome = journal.recordOutcome(requestId, result, "message");
		sent.add(outcome.outcomeId);
		deliverAskOutcome(pi, ctx ?? current, journal, outcome);
		return true;
	}

	async function run() {
		do {
			again = false;
			const current = ctx;
			if (disposed || !current) {
				return;
			}
			try {
				deliverPending(current);
				while (await recoverNext(current)) {
					// One form at a time, in request order.
				}
			} catch {
				// A stale context or a UI that failed to open: give up quietly.
				// Unanswered forms stay in the journal for the next start.
			}
		} while (again);
	}

	return {
		schedule(next) {
			if (disposed || next.mode !== "tui") {
				return;
			}
			ctx = next;
			if (open && !isOnBranch(next, open.requestId)) {
				open.detached = true;
			}
			if (work) {
				again = true;
				return;
			}
			work = new Promise<void>((resolve) => defer(resolve))
				.then(run)
				.finally(() => {
					work = undefined;
				});
		},
		dispose() {
			disposed = true;
			ctx = undefined;
		},
		async settled() {
			while (work) {
				await work;
			}
		},
	};
}

function isOnBranch(ctx: ExtensionContext, requestId: string): boolean {
	try {
		return !!getRecord(readAskJournal(ctx), requestId);
	} catch {
		return false;
	}
}

function formToParams(form: AskFormSnapshot): AskParams {
	return {
		title: form.title,
		questions: form.questions,
		...(form.timeoutSeconds === undefined
			? {}
			: { timeoutSeconds: form.timeoutSeconds }),
	};
}
