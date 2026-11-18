/**
 * Sends journalled outcomes to the agent as a follow-up message. Used when
 * the tool call that asked is no longer waiting: background, deferred and
 * recovered forms.
 *
 * Exactly-once rests on the session branch. An outcome is delivered when its
 * `pi-ask:answer` message is on the branch; until then it is pending. The
 * process-local state identifies orphaned tool outcomes adopted on attach
 * and sends still in flight, so messages on their way are not sent twice.
 * How a pending outcome is sent is decided in `state/outbox.ts`.
 */
import type {
	BoundaryResult,
	BoundaryState,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { askStrings } from "./i18n.ts";
import {
	ASK_ANSWER_MESSAGE_TYPE,
	type AskAnswerMessageDetails,
	type AskOutcomeEntry,
} from "./journal/entries.ts";
import { readAskJournal } from "./journal/journal.ts";
import { undeliveredOutcomes } from "./journal/replay.ts";
import { renderResultText } from "./result.ts";
import {
	type AskDeliverySituation,
	type AskDeliveryStep,
	planDelivery,
} from "./state/outbox.ts";
import type { AskResult, AskResultAnswer } from "./types.ts";

type DeliveryContext = Pick<ExtensionContext, "isIdle" | "sessionManager">;

/** The part of a `turn_end` / `agent_before_settle` event that is read. */
export type AskBoundaryEvent = Pick<BoundaryState, "entries" | "outcome">;

export interface AskDelivery {
	/**
	 * A turn boundary of a working agent. Returns the pending outcomes as
	 * entries for Pi to append there, or undefined when there are none.
	 */
	boundary(
		ctx: DeliveryContext,
		event: AskBoundaryEvent
	): BoundaryResult | undefined;
	/** An outcome was just journalled with channel `message`. */
	post(): void;
	/**
	 * The branch was (re)built. A foreground answer whose tool result never
	 * landed is adopted as a follow-up message, once.
	 */
	attach(ctx: DeliveryContext): void;
	/**
	 * A run started. A send the branch still lacks never made it into a run,
	 * so the answer is no longer held back; the next pump retries it.
	 */
	started(): void;
	/** Deliver what can be delivered now. `settled`: the run is over. */
	pump(
		ctx: DeliveryContext,
		situation?: Partial<Pick<AskDeliverySituation, "aborted" | "trigger">>
	): void;
}

/** Model-facing text of the follow-up message. */
export function formatDeliveredOutcome(
	result: AskResult,
	options: { correction?: boolean } = {}
): string {
	const requestId = result.requestId ?? "";
	const strings = askStrings();
	const cancelled = result.status === "cancelled";
	const expired = result.status === "expired";
	let heading = strings.answerDelivered(requestId, result.title);
	if (options.correction) {
		heading = cancelled
			? strings.correctionCancelDelivered(requestId, result.title)
			: strings.correctionDelivered(requestId, result.title);
	} else if (cancelled) {
		heading = strings.cancelDelivered(requestId, result.title);
	} else if (expired) {
		heading = strings.expiredDelivered(requestId, result.title);
	}
	const fallbacks = new Set(result.expired ?? []);
	const skipped = new Set(result.skipped ?? []);
	// Each question is named by id and prompt: the call that asked may be
	// far back in the context, or compacted away.
	const lines = result.questions.map((question) => {
		const asked = `- ${question.id} "${oneLine(question.prompt)}"`;
		if (cancelled) {
			return asked;
		}
		if (skipped.has(question.id)) {
			return `${asked}: ${strings.skippedMark}`;
		}
		const answer = formatAnswer(result.answers[question.id]);
		return `${asked}: ${answer}${fallbacks.has(question.id) ? ` ${strings.fallbackMark}` : ""}`;
	});
	const trailer: string[] = expired
		? [
				strings.expiredSummary(
					result.questions
						.filter((question) => fallbacks.has(question.id))
						.map((question) => question.label)
				),
			]
		: [];
	if (skipped.size > 0 && !cancelled) {
		trailer.push(
			strings.skippedSummary(
				result.questions
					.filter((question) => skipped.has(question.id))
					.map((question) => question.label)
			)
		);
	}
	const reason =
		cancelled && result.comment ? [strings.cancelReason(result.comment)] : [];
	return [heading, ...reason, ...lines, ...trailer].join("\n");
}

function formatAnswer(answer: AskResultAnswer | undefined): string {
	if (!answer) {
		return "(no answer)";
	}
	const parts = answer.values.map((value, index) => {
		const label = answer.labels[index] ?? value;
		const note = answer.optionNotes?.[value];
		return `${label} [${value}]${note ? ` (note: ${oneLine(note)})` : ""}`;
	});
	const custom = answer.customText?.trim();
	if (custom) {
		parts.push(`wrote "${oneLine(custom)}"`);
	}
	if (answer.note) {
		parts.push(`note: ${oneLine(answer.note)}`);
	}
	return parts.join("; ") || "(no answer)";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function answerMessage(outcome: AskOutcomeEntry) {
	const correction = !!outcome.supersedes;
	const details: AskAnswerMessageDetails = {
		...(correction ? { correction } : {}),
		requestId: outcome.requestId,
		outcomeId: outcome.outcomeId,
		result: outcome.result,
	};
	return {
		customType: ASK_ANSWER_MESSAGE_TYPE,
		content: formatDeliveredOutcome(outcome.result, { correction }),
		display: true,
		details,
	};
}

export function createAskDelivery(
	pi: Pick<ExtensionAPI, "sendMessage">
): AskDelivery {
	// Sent in this process, potentially still being written by a run. Cleared
	// only when idle or a new run starts; the branch then proves delivery.
	const inFlight = new Set<string>();
	// False while the branch is known to have nothing pending, so that turn
	// boundaries of an ordinary run cost nothing.
	let watching = true;
	// Only tool outcomes already orphaned at attach can become messages.
	// Eligibility lasts until branch evidence proves delivery, not one plan.
	let adopted = new Set<string>();

	function plan(ctx: DeliveryContext, situation: AskDeliverySituation) {
		if (!watching) {
			return;
		}
		const pending = undeliveredOutcomes(readAskJournal(ctx), {
			unrecordedTool: true,
		}).filter(
			({ outcome }) => outcome.channel === "message" || adopted.has(outcome.outcomeId)
		);
		if (pending.length === 0) {
			watching = false;
			return;
		}
		const outcomes = new Map(
			pending.map(({ outcome }) => [outcome.outcomeId, outcome])
		);
		const steps = planDelivery(
			pending.map(({ outcome }) => ({
				outcomeId: outcome.outcomeId,
				cancelled: outcome.result.status === "cancelled",
				inFlight: inFlight.has(outcome.outcomeId),
			})),
			situation
		);
		return { outcomes, steps };
	}

	function send(outcome: AskOutcomeEntry, step: AskDeliveryStep) {
		inFlight.add(outcome.outcomeId);
		try {
			pi.sendMessage(answerMessage(outcome), {
				triggerTurn: step.action === "wake",
			});
		} catch {
			// Not sent: leave it pending for the next attempt.
			inFlight.delete(outcome.outcomeId);
		}
	}

	return {
		post() {
			watching = true;
		},
		attach(ctx) {
			adopted = new Set(
				undeliveredOutcomes(readAskJournal(ctx), { unrecordedTool: true })
					.filter(({ outcome }) => outcome.channel === "tool")
					.map(({ outcome }) => outcome.outcomeId)
			);
			watching = true;
		},
		started() {
			// No prior run can still be writing a send. Do not send here: this
			// run's starting message is recorded before its first boundary.
			inFlight.clear();
		},
		pump(ctx, situation = {}) {
			if (ctx.isIdle()) {
				// Nothing can still be writing a send: retry anything the branch
				// lacks, including a wake whose run never started.
				inFlight.clear();
			}
			const planned = plan(ctx, {
				trigger: situation.trigger ?? "now",
				aborted: situation.aborted,
				idle: ctx.isIdle(),
			});
			for (const step of planned?.steps ?? []) {
				const outcome = planned?.outcomes.get(step.outcomeId);
				if (outcome && (step.action === "wake" || step.action === "append")) {
					send(outcome, step);
				}
			}
		},
		boundary(ctx, event) {
			const planned = plan(ctx, { trigger: "boundary", idle: false });
			const proposed = (planned?.steps ?? [])
				.filter((step) => step.action === "propose")
				.map((step) => planned?.outcomes.get(step.outcomeId))
				.filter((outcome): outcome is AskOutcomeEntry => !!outcome);
			if (proposed.length === 0) {
				return;
			}
			// Not marked in flight: Pi appends these as soon as the handlers
			// return, so the branch itself answers the next check.
			const entries = [
				...event.entries,
				...proposed.map((outcome): CustomMessageEntryDraft => ({
					type: "custom_message",
					...answerMessage(outcome),
				})),
			];
			const wantsTurn =
				event.outcome === "completed" &&
				proposed.some((outcome) => outcome.result.status !== "cancelled");
			return wantsTurn ? { entries, continue: true } : { entries };
		},
	};
}

/** Transcript card for a delivered answer, in place of the raw message. */
export const renderAskAnswerMessage: MessageRenderer<AskAnswerMessageDetails> = (
	message,
	_options,
	theme
) => {
	const details = message.details;
	const result = details?.result;
	if (!(result && Array.isArray(result.questions))) {
		return;
	}
	const strings = askStrings();
	let label = strings.answeredCardLabel;
	if (details?.correction) {
		label = strings.correctedCardLabel;
	} else if (result.status === "cancelled") {
		label = strings.cancelledCardLabel;
	} else if (result.status === "expired") {
		label = strings.expiredCardLabel;
	}
	const subject = result.title ?? result.requestId ?? details?.requestId ?? "";
	const heading =
		theme.fg("toolTitle", theme.bold("ask_user ")) +
		theme.fg("muted", [label, subject].filter(Boolean).join(" · "));
	const body = renderResultText(result);
	return new Text(
		[
			heading,
			result.status === "submitted" ? body : theme.fg("warning", body),
		].join("\n"),
		1,
		0
	);
};
