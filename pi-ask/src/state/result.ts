import { askStrings } from "../i18n.ts";
import { formatResultLines } from "../result-format.ts";
import type {
	AskResult,
	AskResultAnswer,
	AskResultStatus,
	AskState,
	AskStateAnswer,
} from "../types.ts";
import {
	getExtraOptionNotes,
	isAnswerEmpty,
	isResultAnswerCommitted,
	isResultAnswerEmpty,
	serializeAnswer,
} from "./answers.ts";

export type ReviewAnswer = AskResult["answers"][string] & {
	extraOptionNotes?: Array<{
		label: string;
		note: string;
	}>;
};

export function toAskResult(
	state: AskState,
	requested?: AskResultStatus
): AskResult {
	const answers = Object.fromEntries(
		Object.entries(state.answers)
			.map(
				([questionId, answer]) => [questionId, serializeAnswer(answer)] as const
			)
			.filter(([, answer]) => !isResultAnswerEmpty(answer))
	);
	const skipped = state.questions
		.map((question) => question.id)
		.filter((id) => state.skipped?.includes(id));
	// Skipped is a decision, not a gap: the two lists never overlap.
	const unanswered = state.questions
		.filter(
			(question) =>
				!(
					skipped.includes(question.id) ||
					isResultAnswerCommitted(answers[question.id] ?? emptyResultAnswer())
				)
		)
		.map((question) => question.id);
	const status = requested ?? resultStatusFromState(state);

	return {
		title: state.title,
		status,
		questions: state.questions.map((question) => ({
			id: question.id,
			label: question.label,
			prompt: question.prompt,
			type: question.requestedType ?? question.type,
			...(question.presentedType &&
			question.presentedType !== question.requestedType
				? { presentedType: question.presentedType }
				: {}),
		})),
		answers,
		unanswered,
		...(skipped.length > 0 ? { skipped } : {}),
		...(status === "cancelled" && state.cancelComment
			? { comment: state.cancelComment }
			: {}),
	};
}

export function summarizeResult(result: AskResult): string {
	if (result.status === "cancelled") {
		return result.comment
			? askStrings().cancelledWithComment(result.comment)
			: askStrings().cancelledSummary;
	}
	if (result.status === "unavailable") {
		return "Needs user input";
	}
	if (result.status === "invalid") {
		return "Invalid tool payload";
	}
	// Receipts carry their own rules so the guidance costs tokens only when
	// it applies, instead of living in the recurring prompt guidelines.
	if (result.status === "queued") {
		return askStrings().queuedSummary(result.requestId ?? "", result.pending);
	}
	if (result.status === "deferred") {
		return askStrings().deferredSummary(result.requestId ?? "");
	}

	const lines = formatResultLines(result, { mode: "summary" });
	if (result.skipped?.length) {
		lines.push(askStrings().skippedSummary(skippedLabels(result)));
	}
	if (result.status === "expired") {
		lines.push(askStrings().expiredSummary(expiredLabels(result)));
		return lines.join("\n");
	}
	return lines.join("\n") || askStrings().submittedSummary;
}

function skippedLabels(result: AskResult): string[] {
	const skipped = new Set(result.skipped ?? []);
	return result.questions
		.filter((question) => skipped.has(question.id))
		.map((question) => question.label);
}

function expiredLabels(result: AskResult): string[] {
	const expired = new Set(result.expired ?? []);
	return result.questions
		.filter((question) => expired.has(question.id))
		.map((question) => question.label);
}

export function hasAnswerContent(state: AskState, questionId: string): boolean {
	const answer = state.answers[questionId];
	return !!answer && !isAnswerEmpty(answer);
}

function resultStatusFromState(state: AskState): AskResultStatus {
	return state.cancelled ? "cancelled" : "submitted";
}

function emptyResultAnswer(): AskResultAnswer {
	return { values: [], labels: [] };
}

export function toReviewAnswer(
	question: AskState["questions"][number],
	answer: AskStateAnswer | undefined
): ReviewAnswer | undefined {
	if (!answer) {
		return;
	}

	const serialized = serializeAnswer(answer);
	const hasCommittedAnswer = isResultAnswerCommitted(serialized);

	const extraOptionNotes = getExtraOptionNotes({
		answer,
		questionOptions: question.options,
		selectedValues: serialized.values,
	});
	if (
		!(hasCommittedAnswer || serialized.note) &&
		extraOptionNotes.length === 0
	) {
		return;
	}

	return {
		...serialized,
		extraOptionNotes:
			extraOptionNotes.length > 0 ? extraOptionNotes : undefined,
	};
}

export function shouldRenderAnswersIndividually(answer: ReviewAnswer): boolean {
	if (!answer.labels.length) {
		return false;
	}

	return (
		answer.labels.length > 1 ||
		Boolean(answer.optionNotes && Object.keys(answer.optionNotes).length > 0)
	);
}
