import { askStrings } from "./i18n.ts";
import { isCustomOnlyAnswer } from "./state/answers.ts";
import type { AskResult } from "./types.ts";

export function formatResultLines(
	result: AskResult,
	options: { mode: "summary" | "render" }
): string[] {
	const lines: string[] = [];

	const presentedTypes = new Set<"single" | "multi">();
	const fallbacks = new Set(result.expired ?? []);
	const skipped = new Set(result.skipped ?? []);

	for (const question of result.questions) {
		if (hasPresentedTypeOverride(question.type, question.presentedType)) {
			if (
				question.presentedType === "single" ||
				question.presentedType === "multi"
			) {
				presentedTypes.add(question.presentedType);
			}
		}

		const answer = result.answers[question.id];
		if (skipped.has(question.id)) {
			lines.push(formatSkippedLine(question.label, options.mode));
			continue;
		}
		if (!answer) {
			lines.push(formatUnansweredLine(question.label, options.mode));
			continue;
		}

		const answerLine = formatAnswerLine(question.label, answer, options.mode);
		lines.push(
			answerLine
				? markFallback(answerLine, fallbacks.has(question.id))
				: formatUnansweredLine(question.label, options.mode)
		);

		const questionNoteLine = formatQuestionNoteLine(
			question.label,
			answer.note,
			options.mode
		);
		if (questionNoteLine) {
			lines.push(questionNoteLine);
		}

		lines.push(...formatOptionNoteLines(question.label, answer, options.mode));
	}

	if (presentedTypes.size > 0) {
		const types = (["single", "multi"] as const).filter((type) =>
			presentedTypes.has(type)
		);
		lines.push(formatPresentationNoteLine(options.mode, types));
	}

	return lines;
}

/** An auto-applied answer says so on its own line, wherever it is read. */
function markFallback(line: string, isFallback: boolean): string {
	return isFallback ? `${line} ${askStrings().fallbackMark}` : line;
}

function formatSkippedLine(
	questionLabel: string,
	mode: "summary" | "render"
): string {
	const mark = askStrings().skippedMark;
	return mode === "summary"
		? `${questionLabel}: ${mark}`
		: `⊘ ${questionLabel}: ${mark}`;
}

function formatUnansweredLine(
	questionLabel: string,
	mode: "summary" | "render"
): string {
	const mark = askStrings().unansweredMark;
	return mode === "summary"
		? `${questionLabel}: ${mark}`
		: `? ${questionLabel}: ${mark}`;
}

function formatAnswerLine(
	questionLabel: string,
	answer: AskResult["answers"][string],
	mode: "summary" | "render"
): string | undefined {
	const optionText = answer.labels.join(", ");
	const customText = answer.customText?.trim();
	const answerText = [optionText, customText].filter(Boolean).join(", ");
	if (!answerText) {
		return;
	}
	if (mode === "summary") {
		return `${questionLabel}: ${answerText}`;
	}
	if (isCustomOnlyAnswer(answer)) {
		return `✓ ${questionLabel}: (wrote) ${answerText}`;
	}
	return `✓ ${questionLabel}: ${answerText}`;
}

function hasPresentedTypeOverride(
	type: string,
	presentedType: string | undefined
): boolean {
	return !!presentedType && presentedType !== type;
}

function formatPresentationNoteLine(
	mode: "summary" | "render",
	presentedTypes: ReadonlyArray<"single" | "multi">
): string {
	const text = askStrings().presentationNote(presentedTypes);
	return mode === "summary" ? text : `  ${text}`;
}

function formatQuestionNoteLine(
	questionLabel: string,
	note: string | undefined,
	mode: "summary" | "render"
): string | undefined {
	if (!note) {
		return;
	}
	return mode === "summary"
		? `${questionLabel} note: ${note}`
		: `  note: ${note}`;
}

function formatOptionNoteLines(
	questionLabel: string,
	answer: AskResult["answers"][string],
	mode: "summary" | "render"
): string[] {
	const lines: string[] = [];
	for (let index = 0; index < answer.values.length; index++) {
		const value = answer.values[index];
		const label = answer.labels[index] ?? value;
		const note = answer.optionNotes?.[value];
		if (!note) {
			continue;
		}
		lines.push(
			mode === "summary"
				? `${questionLabel} / ${label} note: ${note}`
				: `  ${label} note: ${note}`
		);
	}
	return lines;
}
