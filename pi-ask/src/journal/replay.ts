/**
 * Pure replay of the journal: branch entries in, form records out. Callers
 * pass the ACTIVE branch (`ctx.sessionManager.getBranch()`), never the whole
 * file, so a form asked on a sibling branch does not exist here.
 */
import {
	ASK_ANSWER_MESSAGE_TYPE,
	ASK_JOURNAL_ENTRY_TYPE,
	type AskDraftSnapshot,
	type AskFormMode,
	type AskFormSnapshot,
	type AskOutcomeEntry,
	isRecord,
	parseJournalEntry,
} from "./entries.ts";

/** The parts of a Pi `SessionEntry` the replay reads. */
export interface BranchEntryLike {
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: unknown;
	type: string;
}

export interface AskJournalRecord {
	/** A foreground form the user sent to the queue with "answer later". */
	deferred: boolean;
	/** The user stopped this form's countdown; it never runs again. */
	clockStopped: boolean;
	/** Outcome ids that already reached the agent as a follow-up message. */
	delivered: ReadonlySet<string>;
	draft?: AskDraftSnapshot;
	form: AskFormSnapshot;
	mode: AskFormMode;
	/** The user closed an expired form without correcting it. */
	offerDismissed: boolean;
	/** Latest outcome; undefined while the form is still open. */
	outcome?: AskOutcomeEntry;
	requestId: string;
	/**
	 * A user or assistant message landed on the branch while the form was
	 * still open. For a blocking foreground form that means the conversation
	 * went on without it.
	 */
	supersededByMessage: boolean;
	/**
	 * Pi recorded the tool result for this foreground call. False means the
	 * process may have died between journalling the answer and the result.
	 */
	toolResultOnBranch: boolean;
	toolCallId?: string;
}

export interface AskJournalState {
	/** The user put the background panel away on this branch. */
	panelHidden: boolean;
	/** In request order. */
	records: AskJournalRecord[];
}

interface MutableRecord extends AskJournalRecord {
	delivered: Set<string>;
}

export function replayJournal(
	entries: readonly BranchEntryLike[]
): AskJournalState {
	const records = new Map<string, MutableRecord>();
	const deliveredOutcomeIds = new Map<string, string>();
	let panelHidden = false;
	const toolResults = new Set<string>();
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			isRecord(entry.message) &&
			entry.message.role === "toolResult" &&
			typeof entry.message.toolCallId === "string"
		) {
			toolResults.add(entry.message.toolCallId);
		}
	}

	for (const entry of entries) {
		if (entry.type === "custom_message") {
			noteAnswerMessage(entry, deliveredOutcomeIds);
			continue;
		}
		if (entry.type === "message") {
			if (isConversationMessage(entry.message)) {
				for (const record of records.values()) {
					if (!record.outcome) {
						record.supersededByMessage = true;
					}
				}
			}
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== ASK_JOURNAL_ENTRY_TYPE) {
			continue;
		}
		const journalEntry = parseJournalEntry(entry.data);
		if (!journalEntry) {
			continue;
		}
		if (journalEntry.kind === "panel") {
			panelHidden = journalEntry.hidden;
			continue;
		}
		if (journalEntry.kind === "form") {
			if (!records.has(journalEntry.requestId)) {
				records.set(journalEntry.requestId, {
					requestId: journalEntry.requestId,
					mode: journalEntry.mode === "background" ? "background" : "foreground",
					form: journalEntry.form,
					toolCallId: journalEntry.toolCallId,
					toolResultOnBranch:
						!!journalEntry.toolCallId &&
						toolResults.has(journalEntry.toolCallId),
					deferred: false,
					clockStopped: false,
					offerDismissed: false,
					delivered: new Set(),
					supersededByMessage: false,
				});
			}
			continue;
		}
		// Anything about a form this branch never asked is ignored.
		const record = records.get(journalEntry.requestId);
		if (!record) {
			continue;
		}
		switch (journalEntry.kind) {
			case "draft":
				record.draft = journalEntry.draft;
				break;
			case "defer":
				record.deferred = true;
				break;
			case "outcome":
				record.outcome = journalEntry;
				// A new outcome is a new life: an earlier dismissal does not carry.
				record.offerDismissed = false;
				break;
			case "expiry":
				record.clockStopped = true;
				break;
			case "dismiss":
				record.offerDismissed = true;
				break;
			default:
				break;
		}
	}

	for (const [outcomeId, requestId] of deliveredOutcomeIds) {
		records.get(requestId)?.delivered.add(outcomeId);
	}
	return { panelHidden, records: [...records.values()] };
}

export function getRecord(
	state: AskJournalState,
	requestId: string
): AskJournalRecord | undefined {
	return state.records.find((record) => record.requestId === requestId);
}

/** Still waiting for its first outcome. */
export function isOpen(record: AskJournalRecord): boolean {
	return !record.outcome;
}

/**
 * Foreground forms whose tool call ended without an outcome (Pi quit or
 * crashed mid-form) and that the conversation has not moved past.
 */
export function interruptedForms(state: AskJournalState): AskJournalRecord[] {
	return state.records.filter(
		(record) =>
			isOpen(record) &&
			record.mode === "foreground" &&
			!record.deferred &&
			!record.supersededByMessage
	);
}

/** Background and deferred forms awaiting an answer, first asked first. */
export function queuedForms(state: AskJournalState): AskJournalRecord[] {
	return state.records.filter(
		(record) =>
			isOpen(record) && (record.mode === "background" || record.deferred)
	);
}

/**
 * Everything the background panel shows, first asked first: queued forms
 * plus interrupted foreground forms. `live` are the blocking forms on screen
 * in this process, which are open but not interrupted.
 */
export function pendingForms(
	state: AskJournalState,
	live: ReadonlySet<string> = new Set(),
	reopened: ReadonlySet<string> = new Set()
): AskJournalRecord[] {
	const waiting = new Set(
		[...queuedForms(state), ...interruptedForms(state)]
			.filter((record) => record.deferred || !live.has(record.requestId))
			.map((record) => record.requestId)
	);
	// An expired form joins the queue only once the user asked for it.
	for (const record of reopenableForms(state)) {
		if (reopened.has(record.requestId)) {
			waiting.add(record.requestId);
		}
	}
	return state.records.filter((record) => waiting.has(record.requestId));
}

/**
 * Expired forms: resolved by fallback, still open to a late correction. They
 * are offered until the user corrects or dismisses them, or `offer` runs out
 * (`maxAgeMs` after the expiry, as stamped on the outcome).
 */
export function reopenableForms(
	state: AskJournalState,
	offer?: { maxAgeMs: number; now: number }
): AskJournalRecord[] {
	return state.records.filter(
		(record) =>
			record.outcome?.result.status === "expired" &&
			!record.offerDismissed &&
			(!offer || offer.now - record.outcome.at <= offer.maxAgeMs)
	);
}

/** Records whose latest outcome still has to be sent as a follow-up. */
export function undeliveredOutcomes(
	state: AskJournalState,
	options: { unrecordedTool?: boolean } = {}
): Array<AskJournalRecord & { outcome: AskOutcomeEntry }> {
	return state.records.filter(
		(record): record is AskJournalRecord & { outcome: AskOutcomeEntry } =>
			!!record.outcome &&
			!record.delivered.has(record.outcome.outcomeId) &&
			(record.outcome.channel === "message" ||
				// A foreground call's answer is its tool result. If the branch has
				// no result for the call, the process died before Pi wrote it, so
				// the answer is only in the journal and must be sent instead. This
				// is only safe on a rebuild: a live call may still be writing it.
				(options.unrecordedTool === true &&
					record.outcome.channel === "tool" &&
					!!record.toolCallId &&
					!record.toolResultOnBranch))
	);
}

/** A persisted answer message proves delivery even if its marker is missing. */
function noteAnswerMessage(
	entry: BranchEntryLike,
	deliveredOutcomeIds: Map<string, string>
) {
	if (entry.customType !== ASK_ANSWER_MESSAGE_TYPE || !isRecord(entry.details)) {
		return;
	}
	const { outcomeId, requestId } = entry.details;
	if (typeof outcomeId === "string" && typeof requestId === "string") {
		deliveredOutcomeIds.set(outcomeId, requestId);
	}
}

function isConversationMessage(message: unknown): boolean {
	return (
		isRecord(message) &&
		(message.role === "user" || message.role === "assistant")
	);
}
