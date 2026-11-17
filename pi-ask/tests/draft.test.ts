import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/state/create.ts";
import {
	applyDraftSnapshot,
	draftContentKey,
	toDraftSnapshot,
} from "../src/state/draft.ts";
import { moveTab } from "../src/state/navigation.ts";
import { cycleCurrentQuestionType } from "../src/state/question-type.ts";
import { toAskResult } from "../src/state/result.ts";
import {
	confirmCurrentSelection,
	saveCustomAnswer,
} from "../src/state/transitions.ts";

const PARAMS = {
	questions: [
		{
			id: "db",
			prompt: "Which database?",
			options: [
				{ value: "pg", label: "Postgres" },
				{ value: "sqlite", label: "SQLite" },
			],
		},
		{ id: "why", prompt: "Why?", type: "text" as const },
	],
};

test("a draft round-trips answers, position and JSON", () => {
	let state = confirmCurrentSelection(createInitialState(PARAMS));
	state = saveCustomAnswer(
		{ ...state, view: { kind: "input", questionId: "why" } },
		"it is boring"
	);
	const draft = JSON.parse(JSON.stringify(toDraftSnapshot(state)));
	const restored = applyDraftSnapshot(createInitialState(PARAMS), draft);

	assert.deepEqual(restored.answers, JSON.parse(JSON.stringify(state.answers)));
	assert.equal(restored.activeTabIndex, state.activeTabIndex);
	assert.equal(restored.completed, false);
	assert.deepEqual(
		toAskResult(restored).answers,
		toAskResult(state).answers
	);
	assert.equal(draft.questions, undefined, "unchanged questions are not stored");
});

test("a draft keeps a changed question type and the submit tab", () => {
	let state = cycleCurrentQuestionType(createInitialState(PARAMS)).state;
	state = moveTab(moveTab(state, 1), 1);
	const restored = applyDraftSnapshot(
		createInitialState(PARAMS),
		toDraftSnapshot(state)
	);
	assert.equal(restored.questions[0]?.type, "multi");
	assert.equal(restored.questions[0]?.presentedType, "multi");
	assert.equal(restored.view.kind, "submit");
});

test("a draft that does not fit the form is applied conservatively", () => {
	const fresh = createInitialState(PARAMS);
	assert.equal(applyDraftSnapshot(fresh, undefined), fresh);
	const restored = applyDraftSnapshot(fresh, {
		answers: { ghost: { selected: [] } },
		activeTabIndex: 99,
		questions: [],
	});
	assert.deepEqual(restored.answers, {});
	assert.equal(restored.activeTabIndex, 2);
	assert.deepEqual(restored.questions, fresh.questions);
});

test("the draft content key ignores cursor position", () => {
	const state = createInitialState(PARAMS);
	assert.equal(
		draftContentKey(toDraftSnapshot(state)),
		draftContentKey(toDraftSnapshot(moveTab(state, 1)))
	);
	assert.notEqual(
		draftContentKey(toDraftSnapshot(state)),
		draftContentKey(toDraftSnapshot(confirmCurrentSelection(state)))
	);
});
