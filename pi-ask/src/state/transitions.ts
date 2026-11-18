import { SUBMIT_CHOICES } from "../constants/text.ts";
import type { AskState } from "../types.ts";
import {
	emptyAnswer,
	isAnswerAnswered,
	isAnswerEmpty,
	saveCustomText,
	saveOptionNote,
	saveQuestionNote,
	setCustomSelected,
	setSingleSelection,
	toggleSelection,
} from "./answers.ts";
import {
	getAnswer,
	getCurrentOption,
	getCurrentQuestion,
	getQuestionById,
	getRenderableOptions,
	isSubmitTab,
} from "./selectors.ts";
import {
	commentView,
	inputView,
	navigateView,
	optionNoteView,
	questionNoteView,
	submitView,
} from "./view.ts";

const SUBMIT_ACTION_COUNT = SUBMIT_CHOICES.length;

export function enterInputMode(state: AskState, questionId: string): AskState {
	return setView(state, inputView(questionId));
}

export function enterQuestionNoteMode(
	state: AskState,
	questionId: string
): AskState {
	return setView(state, questionNoteView(questionId));
}

export function enterOptionNoteMode(
	state: AskState,
	questionId: string,
	optionValue: string
): AskState {
	return setView(state, optionNoteView(questionId, optionValue));
}

/** Longest cancel comment kept; it is a short reason, not a message. */
export const MAX_CANCEL_COMMENT_LENGTH = 500;

/** Review tab only: start typing a reason for cancelling. */
export function enterCancelComment(state: AskState): AskState {
	return isSubmitTab(state) ? setView(state, commentView()) : state;
}

/**
 * Cancel with the typed reason. An empty comment cancels nothing: it goes
 * back to the review tab, so an accidental Enter is not a cancellation.
 */
export function cancelWithComment(state: AskState, text: string): AskState {
	const comment = text.trim().slice(0, MAX_CANCEL_COMMENT_LENGTH);
	if (!comment) {
		return { ...state, view: submitView() };
	}
	return {
		...state,
		cancelComment: comment,
		cancelled: true,
		completed: true,
		view: submitView(),
	};
}

/**
 * Decline just the current question: its answer and notes are dropped and
 * the form moves on. The form itself stays open, and skipping every
 * question still ends at the review tab for an explicit submit.
 */
export function skipCurrentQuestion(state: AskState): AskState {
	const question = getCurrentQuestion(state);
	if (!question || isSubmitTab(state)) {
		return state;
	}
	const answers = { ...state.answers };
	delete answers[question.id];
	const skipped = new Set(state.skipped ?? []);
	skipped.add(question.id);
	return advanceToNextTab({
		...state,
		answers,
		skipped: orderedSkipped(state, skipped),
	});
}

function orderedSkipped(state: AskState, skipped: ReadonlySet<string>) {
	return state.questions
		.map((question) => question.id)
		.filter((id) => skipped.has(id));
}

export function toggleCurrentMultiOption(state: AskState): AskState {
	return activateCurrentOption(state, "toggle");
}

export function confirmCurrentSelection(state: AskState): AskState {
	if (isSubmitTab(state)) {
		return completeSubmitAction(state);
	}
	return activateCurrentOption(state, "confirm");
}

export function applyNumberShortcut(state: AskState, digit: number): AskState {
	if (digit <= 0) {
		return state;
	}

	if (isSubmitTab(state)) {
		if (digit > SUBMIT_ACTION_COUNT) {
			return state;
		}
		return confirmCurrentSelection({
			...state,
			activeSubmitActionIndex: digit - 1,
		});
	}

	const question = getCurrentQuestion(state);
	const index = digit - 1;
	const option = question ? getRenderableOptions(question)[index] : undefined;
	if (!(question && option)) {
		return state;
	}

	return activateCurrentOption({ ...state, activeOptionIndex: index }, "digit");
}

export function saveCustomAnswer(state: AskState, rawValue: string): AskState {
	return saveInputValue(state, rawValue, false);
}

export function submitCustomAnswer(
	state: AskState,
	rawValue: string
): AskState {
	return saveInputValue(state, rawValue, true);
}

export function saveNote(state: AskState, rawValue: string): AskState {
	return saveNoteValue(state, rawValue);
}

function completeSubmitAction(state: AskState): AskState {
	if (state.activeSubmitActionIndex === 1) {
		return { ...state, cancelled: true, completed: true };
	}
	return { ...state, completed: true };
}

function activateCurrentOption(
	state: AskState,
	trigger: "toggle" | "confirm" | "digit"
): AskState {
	const question = getCurrentQuestion(state);
	const option = getCurrentOption(state);
	if (!(question && option)) {
		return state;
	}
	if (option.isCustomOption) {
		return activateCustomOption(state, question.id, question.type, trigger);
	}
	if (question.type === "multi") {
		if (trigger === "confirm") {
			return advanceToNextTab(state);
		}
		return updateAnswer(state, question.id, (answer) =>
			toggleSelection(answer, option, state.activeOptionIndex)
		);
	}

	const nextState = updateAnswer(state, question.id, (answer) => {
		if (trigger === "toggle") {
			const isSelected = answer.selected.some(
				(selection) => selection.value === option.value
			);
			if (isSelected) {
				return {
					...answer,
					selected: [],
				};
			}
		}
		return setSingleSelection(answer, option, state.activeOptionIndex);
	});
	return trigger === "toggle" ? nextState : advanceToNextTab(nextState);
}

function activateCustomOption(
	state: AskState,
	questionId: string,
	questionType: AskState["questions"][number]["type"],
	trigger: "toggle" | "confirm" | "digit"
): AskState {
	if (questionType === "multi" && trigger !== "confirm") {
		const answer = getAnswer(state, questionId);
		if (answer?.customText?.trim()) {
			return updateAnswer(state, questionId, (currentAnswer) =>
				setCustomSelected(currentAnswer, !answer.customSelected)
			);
		}
	}
	return setView(state, inputView(questionId));
}

function saveInputValue(
	state: AskState,
	rawValue: string,
	submit: boolean
): AskState {
	if (state.view.kind !== "input") {
		return state;
	}

	const question = getQuestionById(state, state.view.questionId);
	if (!question) {
		return exitEditingView(state);
	}

	const nextState = updateAnswer(
		exitEditingView(state),
		question.id,
		(answer) =>
			saveCustomText(
				answer,
				rawValue,
				question.type === "multi" ? "multi" : "single"
			)
	);
	if (
		question.type === "multi" ||
		!(submit && isAnswerAnswered(nextState.answers[question.id]))
	) {
		return nextState;
	}
	return advanceToNextTab(nextState);
}

function saveNoteValue(state: AskState, rawValue: string): AskState {
	if (state.view.kind !== "note") {
		return exitEditingView(state);
	}

	const { questionId, optionValue } = state.view;
	const nextState = updateAnswer(
		exitEditingView(state),
		questionId,
		(answer) =>
			optionValue
				? saveOptionNote(answer, optionValue, rawValue)
				: saveQuestionNote(answer, rawValue)
	);
	return nextState;
}

function setView(state: AskState, view: AskState["view"]): AskState {
	return {
		...state,
		view,
	};
}

function exitEditingView(state: AskState): AskState {
	return {
		...state,
		view: isSubmitTab(state) ? submitView() : navigateView(),
	};
}

function advanceToNextTab(state: AskState): AskState {
	const nextTab = Math.min(state.activeTabIndex + 1, state.questions.length);
	return {
		...state,
		activeTabIndex: nextTab,
		activeOptionIndex: 0,
		activeSubmitActionIndex: 0,
		view: nextTab === state.questions.length ? submitView() : navigateView(),
	};
}

function updateAnswer(
	state: AskState,
	questionId: string,
	mutate: (
		answer: ReturnType<typeof emptyAnswer>
	) => ReturnType<typeof emptyAnswer>
): AskState {
	const existing = getAnswer(state, questionId) ?? emptyAnswer();
	const nextAnswer = mutate(existing);
	const answers = { ...state.answers };
	if (isAnswerEmpty(nextAnswer)) {
		delete answers[questionId];
	} else {
		answers[questionId] = nextAnswer;
	}
	// Answering a skipped question takes the skip back.
	const skipped = state.skipped?.filter((id) => id !== questionId);
	return {
		...state,
		answers,
		...(state.skipped ? { skipped } : {}),
	};
}
