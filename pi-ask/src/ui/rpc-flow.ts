import type {
	ExtensionContext,
	ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { askStrings } from "../i18n.ts";
import {
	emptyAnswer,
	saveCustomText,
	serializeAnswer,
	setSingleSelection,
	toggleSelection,
} from "../state/answers.ts";
import { toAskResult } from "../state/result.ts";
import type {
	AskQuestion,
	AskResult,
	AskState,
	AskStateAnswer,
} from "../types.ts";

/**
 * Dialog-card fallback for hosts without the custom TUI (RPC subagents, ACP
 * clients). Questions run as sequential select/input cards with back
 * navigation and a review card before submit; drafts live in the state so
 * navigation never loses a half-finished answer.
 */

type DialogUI = Pick<ExtensionContext["ui"], "select" | "input">;

type CardRow =
	| { kind: "option"; index: number }
	| { kind: "custom" }
	| { kind: "done" }
	| { kind: "skip" }
	| { kind: "back" };

type CardStep = "next" | "back" | "cancel";

export async function runRpcAskFlow(
	ui: DialogUI,
	state: AskState,
	signal?: AbortSignal
): Promise<AskResult> {
	let position = 0;
	for (;;) {
		if (signal?.aborted) {
			return finish(state, "cancelled");
		}
		if (position < state.questions.length) {
			const step = await askQuestionCard(
				ui,
				state,
				state.questions[position] as AskQuestion,
				position,
				signal
			);
			if (step === "cancel") {
				return finish(state, "cancelled");
			}
			position += step === "back" ? -1 : 1;
			continue;
		}
		const revisit = await reviewCard(ui, state, signal);
		if (signal?.aborted || revisit === undefined) {
			return finish(state, "cancelled");
		}
		if (revisit === "submit") {
			return finish(state, "submitted");
		}
		position = revisit >= 0 ? revisit : state.questions.length;
	}
}

async function askQuestionCard(
	ui: DialogUI,
	state: AskState,
	question: AskQuestion,
	index: number,
	signal?: AbortSignal
): Promise<CardStep> {
	if (question.type === "text") {
		return askTextCard(ui, state, question, index, signal);
	}
	const strings = askStrings();
	const total = state.questions.length;
	const previousLabel = state.questions[index - 1]?.label;
	for (;;) {
		if (signal?.aborted) {
			return "cancel";
		}
		const answer = currentAnswer(state, question);
		const rows = buildRows(question, answer, previousLabel);
		const chosen = await ui.select(
			cardTitle(question, index, total),
			rows.map((row) => row.label),
			dialogOptions(signal)
		);
		if (signal?.aborted || chosen === undefined) {
			return "cancel";
		}
		const row = rows.find((candidate) => candidate.label === chosen);
		if (!row) {
			return "cancel";
		}
		if (row.action.kind === "back") {
			return "back";
		}
		if (row.action.kind === "done" || row.action.kind === "skip") {
			return "next";
		}
		if (row.action.kind === "custom") {
			const typed = await ui.input(
				`${cardTitle(question, index, total)} — ${strings.customAnswerTitle}`,
				answer.customText,
				dialogOptions(signal)
			);
			if (signal?.aborted) {
				return "cancel";
			}
			if (typed === undefined) {
				continue;
			}
			state.answers[question.id] = saveCustomText(
				answer,
				typed,
				question.type === "multi" ? "multi" : "single"
			);
			if (question.type !== "multi" && typed.trim()) {
				return "next";
			}
			continue;
		}
		const option = question.options[row.action.index];
		if (!option) {
			continue;
		}
		if (question.type === "multi") {
			state.answers[question.id] = toggleSelection(
				answer,
				option,
				row.action.index
			);
			continue;
		}
		state.answers[question.id] = setSingleSelection(
			answer,
			option,
			row.action.index
		);
		return "next";
	}
}

async function askTextCard(
	ui: DialogUI,
	state: AskState,
	question: AskQuestion,
	index: number,
	signal?: AbortSignal
): Promise<CardStep> {
	const total = state.questions.length;
	const typed = await ui.input(
		cardTitle(question, index, total),
		currentAnswer(state, question).customText,
		dialogOptions(signal)
	);
	if (signal?.aborted || typed === undefined) {
		return "cancel";
	}
	state.answers[question.id] = saveCustomText(
		currentAnswer(state, question),
		typed,
		"single"
	);
	return "next";
}

async function reviewCard(
	ui: DialogUI,
	state: AskState,
	signal?: AbortSignal
): Promise<number | "submit" | undefined> {
	const strings = askStrings();
	const rows = state.questions.map((question, index) => {
		const serialized = serializeAnswer(currentAnswer(state, question));
		const picked = [...serialized.labels];
		if (serialized.customText) {
			picked.push(serialized.customText);
		}
		const summary = picked.length > 0 ? picked.join(", ") : strings.noAnswer;
		return `${index + 1}. ${question.label} → ${summary}`;
	});
	const list = [strings.submitAnswers, ...rows, strings.cancel];
	const chosen = await ui.select(
		strings.reviewHeading,
		list,
		dialogOptions(signal)
	);
	if (chosen === undefined || chosen === strings.cancel) {
		return undefined;
	}
	if (chosen === strings.submitAnswers) {
		return "submit";
	}
	const index = rows.indexOf(chosen);
	return index >= 0 ? index : undefined;
}

function buildRows(
	question: AskQuestion,
	answer: AskStateAnswer,
	previousLabel?: string
): Array<{ label: string; action: CardRow }> {
	const strings = askStrings();
	const picked = new Set(answer.selected.map((selection) => selection.value));
	const rows: Array<{ label: string; action: CardRow }> = question.options.map(
		(option, index) => {
			const mark =
				question.type === "multi"
					? picked.has(option.value)
						? "☑"
						: "☐"
					: picked.has(option.value)
						? "◉"
						: "○";
			const recommended = option.recommended
				? ` ${strings.recommendedMarker}`
				: "";
			const description = option.description
				? ` — ${option.description}`
				: "";
			return {
				label: `${mark} ${index + 1}. ${option.label}${recommended}${description}`,
				action: { kind: "option", index },
			};
		}
	);
	const custom = answer.customText ? ` — ${answer.customText}` : "";
	rows.push({
		label: `${strings.typeYourOwn}${custom}`,
		action: { kind: "custom" },
	});
	if (question.type === "multi") {
		rows.push({
			label: strings.done(picked.size + (answer.customSelected ? 1 : 0)),
			action: { kind: "done" },
		});
	} else {
		// Single-choice cards need an explicit no-answer path so questions
		// can stay unanswered, matching the TUI's tab navigation.
		rows.push({ label: strings.skip, action: { kind: "skip" } });
	}
	if (previousLabel) {
		rows.push({
			label: strings.backTo(previousLabel),
			action: { kind: "back" },
		});
	}
	return rows;
}

function cardTitle(
	question: AskQuestion,
	index: number,
	total: number
): string {
	const progress = total > 1 ? `(${index + 1}/${total}) ` : "";
	return `${progress}[${question.label}] ${question.prompt}`;
}

function currentAnswer(state: AskState, question: AskQuestion): AskStateAnswer {
	return state.answers[question.id] ?? emptyAnswer();
}

function dialogOptions(signal?: AbortSignal): ExtensionUIDialogOptions {
	return signal ? { signal } : {};
}

function finish(state: AskState, status: "submitted" | "cancelled"): AskResult {
	state.completed = status === "submitted";
	state.cancelled = status === "cancelled";
	return toAskResult(state, status);
}
