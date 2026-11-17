import type { AskDraftSnapshot } from "../journal/entries.ts";
import type { AskState } from "../types.ts";
import { navigateView, submitView } from "./view.ts";

/** What must survive a restart for an open form to continue where it was. */
export function toDraftSnapshot(state: AskState): AskDraftSnapshot {
	const typeChanged = state.questions.some(
		(question) => question.presentedType !== undefined
	);
	return {
		answers: structuredClone(state.answers),
		activeTabIndex: state.activeTabIndex,
		...(typeChanged ? { questions: structuredClone(state.questions) } : {}),
	};
}

/**
 * Restore a draft onto a freshly created state. Answers for questions the
 * form does not have are dropped; a question list that no longer lines up
 * with the form is ignored.
 */
export function applyDraftSnapshot(
	state: AskState,
	draft: AskDraftSnapshot | undefined
): AskState {
	if (!draft) {
		return state;
	}
	const ids = state.questions.map((question) => question.id);
	const questions =
		draft.questions?.length === ids.length &&
		draft.questions.every((question, index) => question.id === ids[index])
			? structuredClone(draft.questions)
			: state.questions;
	const answers = Object.fromEntries(
		Object.entries(draft.answers).filter(([questionId]) =>
			ids.includes(questionId)
		)
	);
	const tab = draft.activeTabIndex;
	const activeTabIndex =
		typeof tab === "number" && Number.isInteger(tab)
			? Math.max(0, Math.min(tab, ids.length))
			: state.activeTabIndex;
	return {
		...state,
		questions,
		answers: structuredClone(answers),
		activeTabIndex,
		view: activeTabIndex >= ids.length ? submitView() : navigateView(),
	};
}

/** Changes in this key are worth a journal entry; cursor moves are not. */
export function draftContentKey(draft: AskDraftSnapshot): string {
	return JSON.stringify([draft.answers, draft.questions ?? null]);
}
