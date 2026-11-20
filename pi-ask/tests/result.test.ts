import assert from "node:assert/strict";
import test from "node:test";
import { renderResultText } from "../src/result.ts";
import { formatResultLines } from "../src/result-format.ts";
import { serializeAnswer } from "../src/state/answers.ts";
import { createInitialState } from "../src/state/create.ts";
import { cycleCurrentQuestionType } from "../src/state/question-type.ts";
import { toAskResult } from "../src/state/result.ts";
import {
	confirmCurrentSelection,
	enterQuestionNoteMode,
	saveCustomAnswer,
	saveNote,
	toggleCurrentMultiOption,
} from "../src/state/transitions.ts";

test("submitted results include unanswered questions and omit merged custom text", () => {
	let state = createInitialState({
		questions: [
			{
				id: "stack",
				label: "Stack",
				prompt: "Stack?",
				type: "multi",
				options: [
					{ value: "vue", label: "Vue" },
					{ value: "react", label: "React" },
				],
			},
			{ id: "dir", label: "Dir", prompt: "Which directory?", type: "text" },
		],
	});
	state = toggleCurrentMultiOption(state);
	state = saveCustomAnswer(
		{ ...state, view: { kind: "input", questionId: "stack" } },
		"SolidStart"
	);
	const result = toAskResult(state);
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.stack.values, ["vue"]);
	assert.equal(result.answers.stack.customText, "SolidStart");
	assert.deepEqual(result.unanswered, ["dir"]);
	assert.match(formatResultLines(result, { mode: "summary" }).join("\n"), /SolidStart/);
});

test("submitted results include notes with settled answers", () => {
	let state = createInitialState({
		questions: [
			{
				id: "goal",
				label: "Goal",
				prompt: "Goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
			{
				id: "tone",
				label: "Tone",
				prompt: "Tone?",
				options: [{ value: "quiet", label: "Quiet" }],
			},
		],
	});
	state = confirmCurrentSelection(state);
	state = enterQuestionNoteMode(state, "tone");
	state = saveNote(state, "Why quiet?");
	const result = toAskResult(state);
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal.values, ["speed"]);
	assert.equal(result.answers.tone?.note, "Why quiet?");
	assert.deepEqual(result.unanswered, ["tone"]);
});

test("cancelled and invalid render distinctly", () => {
	const cancelled = toAskResult(createInitialState({
		questions: [
			{
				id: "goal",
				label: "Goal",
				prompt: "Goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
		],
	}), "cancelled");
	assert.equal(renderResultText(cancelled), "Cancelled");
	assert.equal(
		renderResultText({
			status: "invalid",
			answers: {},
			questions: [],
			unanswered: [],
			error: { kind: "invalid_input", issues: [] },
		}),
		"Invalid tool payload"
	);
});

test("serializeAnswer never copies custom text into values", () => {
	assert.deepEqual(
		serializeAnswer({
			selected: [],
			customSelected: true,
			customText: "typed",
		}),
		{
			values: [],
			labels: [],
			customText: "typed",
			note: undefined,
			optionNotes: undefined,
		}
	);
});

const PRESENTED_PARAMS = {
	questions: [
		{
			id: "a",
			label: "A",
			prompt: "Pick a?",
			type: "multi" as const,
			options: [{ value: "x", label: "X" }],
		},
		{
			id: "b",
			label: "B",
			prompt: "Pick b?",
			options: [{ value: "x", label: "X" }],
		},
	],
};

function presentedNote(state: ReturnType<typeof createInitialState>): string {
	return formatResultLines(toAskResult(state), { mode: "summary" }).join("\n");
}

test("the presentation note names the type each question was actually shown as", () => {
	const base = createInitialState(PRESENTED_PARAMS);
	const single = presentedNote(
		cycleCurrentQuestionType({ ...base, activeTabIndex: 0 }).state
	);
	assert.match(single, /presented as single-select by user preference/);
	assert.doesNotMatch(single, /multi-select/);

	const multi = presentedNote(
		cycleCurrentQuestionType({ ...base, activeTabIndex: 1 }).state
	);
	assert.match(multi, /presented as multi-select by user preference/);

	let mixed = cycleCurrentQuestionType({ ...base, activeTabIndex: 0 }).state;
	mixed = cycleCurrentQuestionType({ ...mixed, activeTabIndex: 1 }).state;
	assert.match(
		presentedNote(mixed),
		/presented as single-select and multi-select by user preference/
	);
});

test("zh results localize the unanswered marker and presentation note", () => {
	const saved = process.env.PI_ASK_LOCALE;
	process.env.PI_ASK_LOCALE = "zh";
	try {
		const base = createInitialState(PRESENTED_PARAMS);
		const state = cycleCurrentQuestionType({ ...base, activeTabIndex: 1 }).state;
		const text = presentedNote(state);
		assert.match(text, /B: （无回答）/);
		assert.match(text, /以多选形式呈现/);
	} finally {
		if (saved === undefined) delete process.env.PI_ASK_LOCALE;
		else process.env.PI_ASK_LOCALE = saved;
	}
});
