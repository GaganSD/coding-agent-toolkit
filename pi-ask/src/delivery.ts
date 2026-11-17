/**
 * Sends a journalled outcome to the agent as a follow-up message. Used when
 * the tool call that asked is no longer waiting (recovered, deferred or
 * background forms). Exactly-once is the journal's job: callers pass only
 * records from `undeliveredOutcomes`, and the marker is written here.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { askStrings } from "./i18n.ts";
import {
	ASK_ANSWER_MESSAGE_TYPE,
	type AskAnswerMessageDetails,
	type AskOutcomeEntry,
} from "./journal/entries.ts";
import type { AskJournal } from "./journal/journal.ts";
import { summarizeResult } from "./state/result.ts";
import type { AskResult } from "./types.ts";

type SendOptions = Parameters<ExtensionAPI["sendMessage"]>[1];

/** Model-facing text of the follow-up message. */
export function formatDeliveredOutcome(result: AskResult): string {
	const requestId = result.requestId ?? "";
	if (result.status === "cancelled") {
		return askStrings().cancelDelivered(requestId, result.title);
	}
	return [
		askStrings().answerDelivered(requestId, result.title),
		summarizeResult(result),
	].join("\n");
}

/**
 * An answer wakes an idle agent and joins a working one at the next turn
 * boundary. A cancellation is added as context but never starts a turn.
 */
export function deliveryOptions(
	result: AskResult,
	idle: boolean
): SendOptions {
	if (result.status === "cancelled") {
		return { triggerTurn: false };
	}
	return idle ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "steer" };
}

export function deliverAskOutcome(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: Pick<ExtensionContext, "isIdle">,
	journal: AskJournal,
	outcome: AskOutcomeEntry
): void {
	const details: AskAnswerMessageDetails = {
		requestId: outcome.requestId,
		outcomeId: outcome.outcomeId,
		result: outcome.result,
	};
	// Send first: if it throws, no marker is written and it is retried on
	// the next replay. The persisted message also proves delivery by itself.
	pi.sendMessage(
		{
			customType: ASK_ANSWER_MESSAGE_TYPE,
			content: formatDeliveredOutcome(outcome.result),
			display: true,
			details,
		},
		deliveryOptions(outcome.result, ctx.isIdle())
	);
	journal.recordDelivered(outcome.requestId, outcome.outcomeId);
}
