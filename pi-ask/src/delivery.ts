/**
 * Sends journalled outcomes to the agent as a follow-up message. Used when
 * the tool call that asked is no longer waiting: background, deferred and
 * recovered forms.
 *
 * Exactly-once rests on the session branch. An outcome is delivered when its
 * `pi-ask:answer` message is on the branch; until then it is pending. The
 * only in-memory state is the set of outcomes sent and not yet seen there,
 * which keeps a message that is still on its way from being sent again.
 * How a pending outcome is sent is decided in `state/outbox.ts`.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
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
	boundaryContinues,
	planDelivery,
} from "./state/outbox.ts";
import type { AskResult, AskResultAnswer } from "./types.ts";

type DeliveryContext = Pick<ExtensionContext, "isIdle" | "sessionManager">;

/** The part of a `turn_end` / `agent_before_settle` event that is read. */
export interface AskBoundaryEvent {
	entries?: readonly unknown[];
	message?: unknown;
}

/** What Pi appends at the boundary; shaped as its `custom_message` draft. */
export interface AskBoundaryResult {
	continue?: boolean;
	entries: unknown[];
}

export interface AskDelivery {
	/**
	 * A turn boundary of a working agent. Returns the pending outcomes as
	 * entries for Pi to append there, or undefined when there are none.
	 */
	boundary(
		ctx: DeliveryContext,
		event: AskBoundaryEvent
	): AskBoundaryResult | undefined;
	/** An outcome was just journalled with channel `message`. */
	post(): void;
	/** Deliver what can be delivered now. `settled`: the run is over. */
	pump(
		ctx: DeliveryContext,
		situation?: Partial<Pick<AskDeliverySituation, "aborted" | "trigger">>
	): void;
}

/** Model-facing text of the follow-up message. */
export function formatDeliveredOutcome(result: AskResult): string {
	const requestId = result.requestId ?? "";
	const cancelled = result.status === "cancelled";
	const heading = cancelled
		? askStrings().cancelDelivered(requestId, result.title)
		: askStrings().answerDelivered(requestId, result.title);
	// Each question is named by id and prompt: the call that asked may be
	// far back in the context, or compacted away.
	const lines = result.questions.map((question) => {
		const asked = `- ${question.id} "${oneLine(question.prompt)}"`;
		return cancelled
			? asked
			: `${asked}: ${formatAnswer(result.answers[question.id])}`;
	});
	return [heading, ...lines].join("\n");
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
	const details: AskAnswerMessageDetails = {
		requestId: outcome.requestId,
		outcomeId: outcome.outcomeId,
		result: outcome.result,
	};
	return {
		customType: ASK_ANSWER_MESSAGE_TYPE,
		content: formatDeliveredOutcome(outcome.result),
		display: true,
		details,
	};
}

export function createAskDelivery(
	pi: Pick<ExtensionAPI, "sendMessage">
): AskDelivery {
	// Sent in this process, not yet on the branch. Never cleared on a timer or
	// a lifecycle event: a second send is the one thing that must not happen.
	const inFlight = new Set<string>();
	// False while the branch is known to have nothing pending, so that turn
	// boundaries of an ordinary run cost nothing.
	let watching = true;

	function plan(ctx: DeliveryContext, situation: AskDeliverySituation) {
		if (!watching) {
			return;
		}
		const pending = undeliveredOutcomes(readAskJournal(ctx));
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
		pump(ctx, situation = {}) {
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
				...(event.entries ?? []),
				...proposed.map((outcome) => ({
					type: "custom_message",
					...answerMessage(outcome),
				})),
			];
			const wantsTurn = boundaryContinues(
				proposed.map((outcome) => ({
					cancelled: outcome.result.status === "cancelled",
				})),
				stopReason(event.message)
			);
			return wantsTurn ? { entries, continue: true } : { entries };
		},
	};
}

function stopReason(message: unknown): string | undefined {
	const reason = (message as { stopReason?: unknown } | undefined)?.stopReason;
	return typeof reason === "string" ? reason : undefined;
}

type MessageTheme = ExtensionContext["ui"]["theme"];

/** Transcript card for a delivered answer, in place of the raw message. */
export function renderAskAnswerMessage(
	message: { details?: unknown },
	_options: unknown,
	theme: MessageTheme
) {
	const details = message.details as
		| Partial<AskAnswerMessageDetails>
		| undefined;
	const result = details?.result;
	if (!(result && Array.isArray(result.questions))) {
		return;
	}
	const strings = askStrings();
	const label =
		result.status === "cancelled"
			? strings.cancelledCardLabel
			: strings.answeredCardLabel;
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
}
