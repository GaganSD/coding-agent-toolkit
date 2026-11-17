import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { registerAnswerCommands } from "../src/answer-commands.ts";
import { collectExtractionBusinessIssues } from "../src/answer-extraction.ts";
import { registerAskSettingsCommand } from "../src/ask-settings-command.ts";
import { registerAskTool } from "../src/ask-tool.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigPath } from "../src/config/store.ts";
import { AskParamsSchema } from "../src/schema.ts";
import { serializeAnswer } from "../src/state/answers.ts";
import { createInitialState } from "../src/state/create.ts";
import { collectValidationIssues } from "../src/state/normalize.ts";
import { cycleCurrentQuestionType } from "../src/state/question-type.ts";
import { summarizeResult, toAskResult } from "../src/state/result.ts";
import {
	confirmCurrentSelection,
	toggleCurrentMultiOption,
} from "../src/state/transitions.ts";
import type { AskParams, AskResult } from "../src/types.ts";

function registerMockTool() {
	const tools: Record<string, unknown>[] = [];
	registerAskTool({
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
	} as never);
	return tools[0] as {
		name: string;
		parameters: unknown;
		promptGuidelines: string[];
		execute: (...args: any[]) => Promise<any>;
	};
}

test("registers ask_user", () => {
	const tool = registerMockTool();
	assert.equal(tool.name, "ask_user");
	assert.equal(Value.Check(AskParamsSchema, { questions: [] }), true);
});

test("schema accepts text questions and rejects preview and required", () => {
	assert.equal(
		Value.Check(AskParamsSchema, {
			questions: [{ id: "dir", prompt: "Which directory?", type: "text" }],
		}),
		true
	);
	assert.equal(
		collectValidationIssues({
			questions: [{ id: "dir", prompt: "Which directory?", type: "text" }],
		}).length,
		0
	);
	assert.ok(
		collectValidationIssues({
			questions: [
				{
					id: "dir",
					prompt: "Which directory?",
					type: "text",
					options: [{ value: "fake", label: "Fake" }],
				},
			],
		}).some((issue) => issue.message.includes("text questions have no options"))
	);
	assert.ok(
		collectValidationIssues({
			questions: [
				{
					id: "choice",
					prompt: "Pick one",
					type: "preview",
					options: [{ value: "a", label: "A" }],
				} as unknown as AskParams["questions"][number],
			],
		}).some((issue) => issue.message.includes("invalid type"))
	);
	assert.ok(
		collectValidationIssues({
			questions: [{ id: "choice", prompt: "Pick one", type: "single" }],
		}).some((issue) => issue.message.includes("at least one option"))
	);
});

test("typed text is not merged into option values", () => {
	const answer = serializeAnswer({
		selected: [{ index: 1, label: "Vue", value: "vue" }],
		customSelected: true,
		customText: "SolidStart",
	});
	assert.deepEqual(answer.values, ["vue"]);
	assert.deepEqual(answer.labels, ["Vue"]);
	assert.equal(answer.customText, "SolidStart");
	assert.equal("indices" in answer, false);
});

test("result uses honest status and unanswered ids", () => {
	const state = createInitialState({
		title: "Scope",
		questions: [
			{
				id: "goal",
				prompt: "Goal?",
				options: [
					{ value: "speed", label: "Speed" },
					{ value: "clarity", label: "Clarity" },
				],
			},
			{ id: "notes", prompt: "Anything else?", type: "text" },
		],
	});
	const selected = confirmCurrentSelection(state);
	const result = toAskResult(selected);
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal.values, ["speed"]);
	assert.deepEqual(result.unanswered, ["notes"]);
	assert.equal(result.answers.notes, undefined);
});

test("non-TUI tool execution returns unavailable", async () => {
	const tool = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "goal",
					label: "Goal",
					prompt: "What should I optimize for?",
					options: [{ value: "speed", label: "Speed" }],
				},
			],
		},
		undefined,
		() => {},
		{ mode: "rpc", hasUI: false }
	);
	assert.equal(response.details.status, "unavailable");
	assert.match(response.content[0].text, /Needs user input: ask_user requires interactive TUI mode/);
	assert.deepEqual(response.details.unanswered, ["goal"]);
});

test("invalid payloads return status invalid", async () => {
	const tool = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{ questions: [] },
		undefined,
		() => {},
		{ mode: "tui" }
	);
	assert.equal(response.details.status, "invalid");
	assert.match(response.content[0].text, /Invalid ask_user payload/);
});

test("live type change is single to multi with confirm when dropping selections", () => {
	let state = createInitialState({
		questions: [
			{
				id: "stack",
				prompt: "Stack?",
				type: "multi",
				options: [
					{ value: "vue", label: "Vue" },
					{ value: "react", label: "React" },
				],
			},
		],
	});
	state = toggleCurrentMultiOption(state);
	state = {
		...state,
		activeOptionIndex: 1,
	};
	state = toggleCurrentMultiOption(state);
	const pending = cycleCurrentQuestionType(state);
	assert.equal(pending.needsConfirmation, true);
	const confirmed = cycleCurrentQuestionType(state, { confirmed: true });
	assert.equal(confirmed.state.questions[0]?.type, "single");
	assert.equal(confirmed.state.answers.stack, undefined);
});

test("/answer extraction keeps every offered option", () => {
	const params: AskParams = {
		questions: [
			{
				id: "stack",
				prompt: "Which stack?",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
					{ value: "c", label: "C" },
					{ value: "d", label: "D" },
					{ value: "e", label: "E" },
				],
			},
		],
	};
	assert.deepEqual(collectExtractionBusinessIssues(params), []);
	assert.equal(params.questions[0]?.options?.length, 5);
});

test("commands and config path are first-party", () => {
	const commands = new Set<string>();
	registerAnswerCommands({
		registerCommand(name: string) {
			commands.add(name);
		},
	} as never);
	registerAskSettingsCommand({
		registerCommand(name: string) {
			commands.add(name);
		},
	} as never);
	assert.deepEqual(
		[...commands].sort(),
		["answer", "ask-settings"]
	);
	assert.match(getAskConfigPath(), /pi-ask\.json$/);
	assert.deepEqual(DEFAULT_ASK_CONFIG.answer.extractionModels, []);
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.autoSubmitWhenAnsweredWithoutNotes, false);
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.confirmDismissWhenDirty, true);
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.doublePressReviewShortcuts, true);
	assert.deepEqual(DEFAULT_ASK_CONFIG.keymaps.main.changeQuestionType, ["t"]);
});

const CHOICE = {
	id: "db",
	label: "DB",
	prompt: "Which database?",
	options: [
		{ value: "pg", label: "Postgres" },
		{ value: "sqlite", label: "SQLite" },
	],
};

test("fallback must name an option value and is refused on text questions", () => {
	assert.deepEqual(
		collectValidationIssues({ questions: [{ ...CHOICE, fallback: "sqlite" }] }),
		[]
	);
	assert.deepEqual(
		collectValidationIssues({
			questions: [{ ...CHOICE, fallback: "mysql" }],
		}).map((issue) => issue.path),
		["questions[0].fallback"]
	);
	assert.deepEqual(
		collectValidationIssues({
			questions: [
				{ id: "why", prompt: "Why?", type: "text", fallback: "because" },
			],
		}).map((issue) => issue.path),
		["questions[0].fallback"]
	);
	assert.equal(
		createInitialState({ questions: [{ ...CHOICE, fallback: " sqlite " }] })
			.questions[0]?.fallback,
		"sqlite"
	);
});

test("timeoutSeconds must be positive and finite; background must be boolean", () => {
	for (const timeoutSeconds of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.deepEqual(
			collectValidationIssues({ questions: [CHOICE], timeoutSeconds }).map(
				(issue) => issue.path
			),
			["timeoutSeconds"]
		);
	}
	assert.deepEqual(
		collectValidationIssues({
			questions: [CHOICE],
			timeoutSeconds: 45,
			background: true,
		}),
		[]
	);
	assert.deepEqual(
		collectValidationIssues({
			questions: [CHOICE],
			background: "yes",
		} as unknown as AskParams).map((issue) => issue.path),
		["background"]
	);
});

function receipt(overrides: Partial<AskResult>): AskResult {
	return {
		...toAskResult(createInitialState({ questions: [CHOICE] })),
		requestId: "ask-1",
		...overrides,
	};
}

test("queued and deferred results are receipts that carry their own rules", () => {
	for (const status of ["queued", "deferred"] as const) {
		const text = summarizeResult(receipt({ status }));
		assert.ok(text.includes("ask-1"));
		assert.ok(text.includes("not an answer or approval"));
		assert.ok(text.includes("Do not ask again"));
		assert.ok(!text.includes("(no answer)"));
	}
});

test("expired results name applied fallbacks and deny approval", () => {
	const text = summarizeResult(
		receipt({
			status: "expired",
			answers: { db: { values: ["sqlite"], labels: ["SQLite"] } },
			unanswered: [],
			expired: ["db"],
		})
	);
	assert.ok(text.includes("DB: SQLite"));
	assert.ok(text.includes("Fallback applied for: DB."));
	assert.ok(text.includes("not user approval"));
	assert.ok(text.includes("keep irreversible actions blocked"));

	const none = summarizeResult(receipt({ status: "expired", expired: [] }));
	assert.ok(none.includes("DB: (no answer)"));
	assert.ok(none.includes("No fallback was applied."));
});
