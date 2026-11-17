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
	createdAt: number;
	/** A foreground form the user sent to the queue with "answer later". */
	deferred: boolean;
	/** Outcome ids that already reached the agent as a follow-up message. */
	delivered: ReadonlySet<string>;
	draft?: AskDraftSnapshot;
	form: AskFormSnapshot;
	mode: AskFormMode;
	/** Latest outcome; undefined while the form is still open. */
	outcome?: AskOutcomeEntry;
	requestId: string;
	/**
	 * A user or assistant message landed on the branch while the form was
	 * still open. For a blocking foreground form that means the conversation
	 * went on without it.
	 */
	supersededByMessage: boolean;
	toolCallId?: string;
}

export interface AskJournalState {
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
		if (journalEntry.kind === "form") {
			if (!records.has(journalEntry.requestId)) {
				records.set(journalEntry.requestId, {
					requestId: journalEntry.requestId,
					createdAt: journalEntry.at,
					mode: journalEntry.mode === "background" ? "background" : "foreground",
					form: journalEntry.form,
					toolCallId: journalEntry.toolCallId,
					deferred: false,
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
				break;
			case "delivered":
				deliveredOutcomeIds.set(journalEntry.outcomeId, journalEntry.requestId);
				break;
			default:
				break;
		}
	}

	for (const [outcomeId, requestId] of deliveredOutcomeIds) {
		records.get(requestId)?.delivered.add(outcomeId);
	}
	return { records: [...records.values()] };
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

/** Expired forms: resolved by fallback, still open to a late correction. */
export function reopenableForms(state: AskJournalState): AskJournalRecord[] {
	return state.records.filter(
		(record) => record.outcome?.result.status === "expired"
	);
}

/** Records whose latest outcome still has to be sent as a follow-up. */
export function undeliveredOutcomes(
	state: AskJournalState
): Array<AskJournalRecord & { outcome: AskOutcomeEntry }> {
	return state.records.filter(
		(record): record is AskJournalRecord & { outcome: AskOutcomeEntry } =>
			!!record.outcome &&
			record.outcome.channel === "message" &&
			!record.delivered.has(record.outcome.outcomeId)
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
