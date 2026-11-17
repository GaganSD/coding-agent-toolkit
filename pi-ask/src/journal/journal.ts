/**
 * Journal writer and branch reader. The writer is the only place entries are
 * created; `replay.ts` is the only place they are interpreted.
 */
import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { draftContentKey, toDraftSnapshot } from "../state/draft.ts";
import type { AskResult, AskState } from "../types.ts";
import {
	ASK_JOURNAL_ENTRY_TYPE,
	ASK_JOURNAL_VERSION,
	type AskDraftSnapshot,
	type AskExpiryStopReason,
	type AskFormMode,
	type AskFormSnapshot,
	type AskJournalEntry,
	type AskOutcomeChannel,
	type AskOutcomeEntry,
} from "./entries.ts";
import { type AskJournalState, replayJournal } from "./replay.ts";

export interface AskJournal {
	/**
	 * Returns a callback for the open form's state changes. It appends a draft
	 * entry only when the answers change, never for cursor movement.
	 */
	draftRecorder(
		requestId: string,
		initial?: AskDraftSnapshot
	): (state: AskState) => void;
	/**
	 * Marks a `message` outcome as having reached the agent. Delivery does
	 * not write it: the answer message on the branch is the proof. Replay
	 * still honours it for a host that confirms delivery some other way.
	 */
	recordDelivered(requestId: string, outcomeId: string): void;
	/** A foreground form moved to the queue ("answer later"). */
	recordDefer(requestId: string): void;
	/** The user closed an expired form without correcting it. */
	recordDismiss(requestId: string): void;
	/** The user stopped a form's countdown. It never restarts. */
	recordExpiryStop(requestId: string, reason: AskExpiryStopReason): void;
	/** The user hid or reopened the panel; `requestId` is the form shown. */
	recordPanel(hidden: boolean, requestId?: string): void;
	/** Saves an accepted form and returns its new request id. */
	recordForm(input: {
		form: AskFormSnapshot;
		mode: AskFormMode;
		toolCallId?: string;
	}): string;
	/**
	 * Saves a form's outcome. The returned entry's result carries the request
	 * id; return or deliver that result, not the one passed in.
	 */
	recordOutcome(
		requestId: string,
		result: AskResult,
		channel: AskOutcomeChannel,
		supersedes?: string
	): AskOutcomeEntry;
}

export interface AskJournalDeps {
	newId?: () => string;
	now?: () => number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

export function createAskJournal(
	append: (entry: AskJournalEntry) => void,
	deps: AskJournalDeps = {}
): AskJournal {
	const now = deps.now ?? Date.now;
	const newId = deps.newId ?? shortId;
	const write = (entry: DistributiveOmit<AskJournalEntry, "at" | "v">) => {
		const full = { ...entry, v: ASK_JOURNAL_VERSION, at: now() };
		append(full as AskJournalEntry);
		return full;
	};

	return {
		recordForm({ form, mode, toolCallId }) {
			const requestId = `ask-${newId()}`;
			write({
				kind: "form",
				requestId,
				mode,
				form,
				...(toolCallId ? { toolCallId } : {}),
			});
			return requestId;
		},
		draftRecorder(requestId, initial) {
			let lastKey = draftContentKey(initial ?? { answers: {} });
			return (state) => {
				if (state.completed) {
					return;
				}
				const draft = toDraftSnapshot(state);
				const key = draftContentKey(draft);
				if (key === lastKey) {
					return;
				}
				lastKey = key;
				write({ kind: "draft", requestId, draft });
			};
		},
		recordDefer(requestId) {
			write({ kind: "defer", requestId });
		},
		recordPanel(hidden, requestId = "") {
			write({ kind: "panel", requestId, hidden });
		},
		recordOutcome(requestId, result, channel, supersedes) {
			return write({
				kind: "outcome",
				requestId,
				outcomeId: newId(),
				channel,
				result: { ...result, requestId },
				...(supersedes ? { supersedes } : {}),
			}) as AskOutcomeEntry;
		},
		recordDismiss(requestId) {
			write({ kind: "dismiss", requestId });
		},
		recordExpiryStop(requestId, reason) {
			write({ kind: "expiry", requestId, reason });
		},
		recordDelivered(requestId, outcomeId) {
			write({ kind: "delivered", requestId, outcomeId });
		},
	};
}

/**
 * Journal backed by the session file. Writing is best-effort: a host without
 * `appendEntry`, or a failed write, must not stop the user being asked.
 */
export function createSessionAskJournal(
	pi: Pick<ExtensionAPI, "appendEntry">,
	deps?: AskJournalDeps
): AskJournal {
	return createAskJournal((entry) => {
		try {
			pi.appendEntry?.(ASK_JOURNAL_ENTRY_TYPE, entry);
		} catch {
			// Losing recovery data is better than losing the question.
		}
	}, deps);
}

/** Journal state of the active branch only. */
export function readAskJournal(
	ctx: Pick<ExtensionContext, "sessionManager">
): AskJournalState {
	return replayJournal(ctx.sessionManager.getBranch());
}

export function toFormSnapshot(
	state: Pick<AskState, "questions" | "title">,
	timeoutSeconds?: number
): AskFormSnapshot {
	return {
		...(state.title ? { title: state.title } : {}),
		questions: structuredClone(state.questions),
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
	};
}

function shortId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 8);
}
