/**
 * Session journal entry shapes. Every `ask_user` form, draft and outcome is
 * appended to the session as a custom entry (never model context), so the
 * state of any form, and of the panel that shows them, can be rebuilt by
 * replaying the active branch.
 *
 * Entries are append-only and versioned; `replayJournal` ignores anything it
 * does not recognise, so new kinds can be added without breaking old sessions.
 */
import type { AskQuestion, AskResult, AskStateAnswer } from "../types.ts";

/** `customType` of every journal entry (`pi.appendEntry`). */
export const ASK_JOURNAL_ENTRY_TYPE = "pi-ask:journal";
/** `customType` of the follow-up message that carries a late answer. */
export const ASK_ANSWER_MESSAGE_TYPE = "pi-ask:answer";
export const ASK_JOURNAL_VERSION = 1;

/**
 * `foreground`: the tool call blocks on the form and returns its answer.
 * `background`: the call returned a `queued` receipt; the form waits in the queue.
 */
export type AskFormMode = "foreground" | "background";

/**
 * How an outcome reaches the agent. `tool`: it was the tool call's own result.
 * `message`: the tool call is gone (or returned a receipt), so the outcome
 * must be sent as a follow-up message and tracked with a `delivered` entry.
 */
export type AskOutcomeChannel = "tool" | "message";

/** The normalized form, enough to reopen it without the original call. */
export interface AskFormSnapshot {
	questions: AskQuestion[];
	timeoutSeconds?: number;
	title?: string;
}

/** In-progress answers of an open form. */
export interface AskDraftSnapshot {
	activeTabIndex?: number;
	answers: Record<string, AskStateAnswer>;
	/** Present only when the user changed a question's presented type. */
	questions?: AskQuestion[];
}

interface AskJournalEntryBase {
	/** Epoch milliseconds. */
	at: number;
	requestId: string;
	v: typeof ASK_JOURNAL_VERSION;
}

/** A valid call was accepted. Written before any waiting starts. */
export interface AskFormEntry extends AskJournalEntryBase {
	form: AskFormSnapshot;
	kind: "form";
	mode: AskFormMode;
	toolCallId?: string;
}

/** Latest draft wins. */
export interface AskDraftEntry extends AskJournalEntryBase {
	draft: AskDraftSnapshot;
	kind: "draft";
}

/**
 * The user chose "answer later" on a foreground form: its tool call returned
 * `deferred` and the form joined the queue in its original request order.
 */
export interface AskDeferEntry extends AskJournalEntryBase {
	kind: "defer";
}

/**
 * A form was resolved: `submitted`, `cancelled`, `expired` or `unavailable`.
 * A later outcome for the same request supersedes it (late override of an
 * expired form). Receipts (`queued`, `deferred`) are never outcomes.
 */
export interface AskOutcomeEntry extends AskJournalEntryBase {
	channel: AskOutcomeChannel;
	kind: "outcome";
	outcomeId: string;
	result: AskResult;
	/** The expired outcome this one corrects (late override). */
	supersedes?: string;
}

/**
 * Exactly-once marker for a `message` outcome. Independent of queue state:
 * it names the outcome, so a correction to an expired form is a new delivery.
 */
export interface AskDeliveredEntry extends AskJournalEntryBase {
	kind: "delivered";
	outcomeId: string;
}

/**
 * The user put the background panel away (`hidden: true`) or brought it
 * back. Latest wins; `requestId` is the form that was showing, if any.
 */
export interface AskPanelEntry extends AskJournalEntryBase {
	hidden: boolean;
	kind: "panel";
}

/** Why a form's countdown will never fire; see `state/expiry.ts`. */
export type AskExpiryStopReason = "interaction" | "hidden";

/**
 * The form's countdown was stopped by the user. It is never restarted: a
 * reload, resume or fork must not give a form back a clock the user stopped.
 */
export interface AskExpiryEntry extends AskJournalEntryBase {
	kind: "expiry";
	reason: AskExpiryStopReason;
}

/**
 * The user closed an expired form without correcting it. It is no longer
 * offered for a late override; the agent's earlier result stands.
 */
export interface AskDismissEntry extends AskJournalEntryBase {
	kind: "dismiss";
}

export type AskJournalEntry =
	| AskFormEntry
	| AskDraftEntry
	| AskDeferEntry
	| AskOutcomeEntry
	| AskDeliveredEntry
	| AskPanelEntry
	| AskExpiryEntry
	| AskDismissEntry;

/** `details` of the follow-up message; also proves delivery on replay. */
export interface AskAnswerMessageDetails {
	/** The message corrects an earlier expired result. */
	correction?: boolean;
	outcomeId: string;
	requestId: string;
	result: AskResult;
}

const ENTRY_KINDS = new Set([
	"form",
	"draft",
	"defer",
	"outcome",
	"delivered",
	"panel",
	"expiry",
	"dismiss",
]);

/** Journal data from a session entry, or undefined if it is not usable. */
export function parseJournalEntry(data: unknown): AskJournalEntry | undefined {
	if (!isRecord(data)) {
		return;
	}
	if (
		data.v !== ASK_JOURNAL_VERSION ||
		typeof data.requestId !== "string" ||
		typeof data.kind !== "string" ||
		!ENTRY_KINDS.has(data.kind)
	) {
		return;
	}
	switch (data.kind) {
		case "form":
			return isRecord(data.form) && Array.isArray(data.form.questions)
				? (data as unknown as AskFormEntry)
				: undefined;
		case "draft":
			return isRecord(data.draft) && isRecord(data.draft.answers)
				? (data as unknown as AskDraftEntry)
				: undefined;
		case "outcome":
			return typeof data.outcomeId === "string" && isRecord(data.result)
				? (data as unknown as AskOutcomeEntry)
				: undefined;
		case "delivered":
			return typeof data.outcomeId === "string"
				? (data as unknown as AskDeliveredEntry)
				: undefined;
		case "panel":
			return typeof data.hidden === "boolean"
				? (data as unknown as AskPanelEntry)
				: undefined;
		case "expiry":
			return data.reason === "interaction" || data.reason === "hidden"
				? (data as unknown as AskExpiryEntry)
				: undefined;
		case "dismiss":
			return data as unknown as AskDismissEntry;
		default:
			return data as unknown as AskDeferEntry;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
