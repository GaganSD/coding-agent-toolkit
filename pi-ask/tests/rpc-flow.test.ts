import assert from "node:assert/strict";
import test from "node:test";
import { registerAskTool } from "../src/ask-tool.ts";
import { askStrings } from "../src/i18n.ts";
import { createInitialState } from "../src/state/create.ts";
import { runRpcAskFlow } from "../src/ui/rpc-flow.ts";
import type { AskParams } from "../src/types.ts";

type Reply =
	| { select: string }
	| { input: string | undefined }
	| { dismiss: true };

interface DialogCall {
	kind: "select" | "input";
	title: string;
	rows?: string[];
}

/** Scripted dialog host: each reply services one select/input card in order. */
function scriptHost(replies: Reply[]) {
	const calls: DialogCall[] = [];
	let cursor = 0;
	const next = (kind: DialogCall["kind"]) => {
		const reply = replies[cursor++] as Reply | undefined;
		assert.ok(reply, `Unexpected ${kind} card at step ${cursor}`);
		if ("dismiss" in reply) {
			return undefined;
		}
		assert.ok(
			kind in reply,
			`Step ${cursor}: expected ${kind} reply, got ${JSON.stringify(reply)}`
		);
		return reply;
	};
	const ui = {
		async select(title: string, rows: string[]) {
			calls.push({ kind: "select", title, rows });
			const reply = next("select");
			if (reply === undefined) {
				return undefined;
			}
			const wanted = (reply as { select: string }).select;
			const match = rows.find((row) => row.includes(wanted));
			assert.ok(match, `No row matching "${wanted}" in ${rows.join(" | ")}`);
			return match;
		},
		async input(title: string) {
			calls.push({ kind: "input", title });
			const reply = next("input");
			return reply === undefined ? undefined : (reply as { input: string }).input;
		},
	};
	return { ui, calls };
}

const SINGLE_PARAMS: AskParams = {
	questions: [
		{
			id: "goal",
			label: "Goal",
			prompt: "What should I optimize for?",
			options: [
				{ value: "speed", label: "Speed" },
				{ value: "quality", label: "Quality", recommended: true },
			],
		},
	],
};

const TWO_STEP_PARAMS: AskParams = {
	questions: [
		...SINGLE_PARAMS.questions,
		{
			id: "features",
			label: "Features",
			prompt: "Which features do you need?",
			type: "multi",
			options: [
				{ value: "auth", label: "Auth" },
				{ value: "billing", label: "Billing" },
			],
		},
	],
};

test("locale honors PI_ASK_LOCALE-style tags", () => {
	const saved = process.env.PI_ASK_LOCALE;
	try {
		for (const [tag, expected] of [
			[undefined, "en"],
			["", "en"],
			["fr", "en"],
			["zh", "zh"],
			["zh-CN", "zh"],
		] as const) {
			if (tag === undefined) delete process.env.PI_ASK_LOCALE;
			else process.env.PI_ASK_LOCALE = tag;
			assert.equal(
				askStrings().reviewHeading,
				expected === "zh" ? "检查你的回答" : "Review your answers"
			);
		}
	} finally {
		if (saved === undefined) delete process.env.PI_ASK_LOCALE;
		else process.env.PI_ASK_LOCALE = saved;
	}
});

test("single-select card reviews before submit", async () => {
	const { ui, calls } = scriptHost([
		{ select: "Speed" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(SINGLE_PARAMS));
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal?.values, ["speed"]);
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.title, "[Goal] What should I optimize for?");
	assert.ok(calls[0]?.rows?.some((row) => row.includes("(Recommended)")));
	assert.equal(calls[1]?.title, "Review your answers");
	assert.ok(calls[1]?.rows?.some((row) => row.includes("1. Goal → Speed")));
});

test("multi-select card toggles options and finishes on Done", async () => {
	const { ui, calls } = scriptHost([
		{ select: "Speed" },
		{ select: "Auth" },
		{ select: "Billing" },
		{ select: "Auth" },
		{ select: "Done" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(TWO_STEP_PARAMS));
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.features?.values, ["billing"]);
	const toggledCard = calls[4];
	assert.ok(toggledCard?.rows?.some((row) => row.includes("☑ 2. Billing")));
});

test("custom answers go through the input card and show as draft", async () => {
	const { ui, calls } = scriptHost([
		{ select: "Type your own" },
		{ input: "My own way" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(SINGLE_PARAMS));
	assert.equal(result.status, "submitted");
	assert.equal(result.answers.goal?.customText, "My own way");
	assert.deepEqual(result.answers.goal?.values, []);
	assert.equal(calls[1]?.kind, "input");
});

test("back navigation keeps the draft selection", async () => {
	const { ui, calls } = scriptHost([
		{ select: "Speed" },
		{ select: "Back to Goal" },
		{ select: "Speed" },
		{ select: "Done" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(TWO_STEP_PARAMS));
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal?.values, ["speed"]);
	const revisited = calls[2];
	assert.ok(revisited?.rows?.some((row) => row.includes("◉ 1. Speed")));
});

test("review card jumps back to a question and still submits", async () => {
	const { ui } = scriptHost([
		{ select: "Speed" },
		{ select: "Done" },
		{ select: "1. Goal → Speed" },
		{ select: "Quality" },
		{ select: "Done" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(TWO_STEP_PARAMS));
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal?.values, ["quality"]);
});

test("single-choice skip leaves the question unanswered", async () => {
	const { ui, calls } = scriptHost([
		{ select: "Skip for now" },
		{ select: "Auth" },
		{ select: "Done" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(TWO_STEP_PARAMS));
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.unanswered, ["goal"]);
	assert.equal(result.answers.goal, undefined);
	assert.deepEqual(result.answers.features?.values, ["auth"]);
	assert.ok(calls[3]?.rows?.some((row) => row.includes("1. Goal → —")));
});

test("skip preserves an earlier draft selection", async () => {
	const { ui } = scriptHost([
		{ select: "Speed" },
		{ select: "Back to Goal" },
		{ select: "Skip for now" },
		{ select: "Done" },
		{ select: "Submit answers" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(TWO_STEP_PARAMS));
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal?.values, ["speed"]);
	assert.deepEqual(result.unanswered, ["features"]);
});

test("dismissing a card cancels the flow", async () => {
	const { ui } = scriptHost([{ dismiss: true }]);
	const result = await runRpcAskFlow(ui, createInitialState(SINGLE_PARAMS));
	assert.equal(result.status, "cancelled");
});

test("review cancel aborts a fully answered flow", async () => {
	const { ui } = scriptHost([
		{ select: "Speed" },
		{ select: "Done" },
		{ select: "Cancel" },
	]);
	const result = await runRpcAskFlow(ui, createInitialState(TWO_STEP_PARAMS));
	assert.equal(result.status, "cancelled");
});

test("text questions ask through the input card", async () => {
	const { ui, calls } = scriptHost([
		{ input: "Anything goes" },
		{ select: "Submit answers" },
	]);
	const params: AskParams = {
		questions: [{ id: "notes", label: "Notes", prompt: "Any notes?", type: "text" }],
	};
	const result = await runRpcAskFlow(ui, createInitialState(params));
	assert.equal(result.status, "submitted");
	assert.equal(result.answers.notes?.customText, "Anything goes");
	assert.equal(calls[0]?.kind, "input");
});

test("an aborted signal cancels before the next card", async () => {
	const controller = new AbortController();
	const { ui } = scriptHost([
		{ select: "Speed" },
		{ select: "Submit answers" },
	]);
	const state = createInitialState(TWO_STEP_PARAMS);
	const promise = runRpcAskFlow(ui, state, controller.signal);
	controller.abort();
	// The in-flight card resolves from the script; the next loop sees the signal.
	const result = await promise;
	assert.equal(result.status, "cancelled");
});

test("abort racing with review submission cancels the flow", async () => {
	const controller = new AbortController();
	const host = scriptHost([{ select: "Speed" }, { select: "Submit answers" }]);
	const ui = {
		...host.ui,
		async select(title: string, rows: string[]) {
			const reply = await host.ui.select(title, rows);
			if (title === "Review your answers") controller.abort();
			return reply;
		},
	};
	const result = await runRpcAskFlow(ui, createInitialState(SINGLE_PARAMS), controller.signal);
	assert.equal(result.status, "cancelled");
});

test("unexpected question and review responses cancel safely", async () => {
	for (const atReview of [false, true]) {
		let calls = 0;
		const ui = {
			async select(_title: string, rows: string[]) {
				calls++;
				return atReview && calls === 1 ? rows[0] : "unknown row";
			},
			async input() { throw new Error("Unexpected input"); },
		};
		const result = await runRpcAskFlow(ui, createInitialState(SINGLE_PARAMS));
		assert.equal(result.status, "cancelled");
		assert.equal(calls, atReview ? 2 : 1);
	}
});

test("abort racing with text input does not commit the answer", async () => {
	const controller = new AbortController();
	const ui = {
		async select() { throw new Error("Unexpected select"); },
		async input() { controller.abort(); return "Not committed"; },
	};
	const params: AskParams = {
		questions: [{ id: "notes", prompt: "Any notes?", type: "text" }],
	};
	const result = await runRpcAskFlow(ui, createInitialState(params), controller.signal);
	assert.equal(result.status, "cancelled");
	assert.equal(result.answers.notes, undefined);
});

test("zh locale renders localized rows and summaries", async () => {
	process.env.PI_ASK_LOCALE = "zh";
	try {
		const strings = askStrings();
		assert.equal(strings.reviewHeading, "检查你的回答");
		const { ui, calls } = scriptHost([{ dismiss: true }]);
		const result = await runRpcAskFlow(ui, createInitialState(SINGLE_PARAMS));
		assert.equal(result.status, "cancelled");
		assert.ok(calls[0]?.rows?.some((row) => row.includes("✎ 自己输入")));
		assert.ok(calls[0]?.rows?.some((row) => row.includes("（推荐）")));
	} finally {
		delete process.env.PI_ASK_LOCALE;
	}
});

function registerMockTool() {
	const tools: Array<Record<string, unknown>> = [];
	registerAskTool({
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
	} as never);
	return tools[0] as {
		execute: (...args: any[]) => Promise<{
			content: Array<{ text: string }>;
			details: { status: string; answers: Record<string, { values: string[] }> };
		}>;
	};
}

test("ask tool runs the card fallback in rpc mode with dialog UI", async () => {
	const tool = registerMockTool();
	const { ui } = scriptHost([
		{ select: "Speed" },
		{ select: "Submit answers" },
	]);
	const response = await tool.execute(
		"call-1",
		SINGLE_PARAMS,
		undefined,
		() => {},
		{ mode: "rpc", hasUI: true, ui } as never
	);
	assert.equal(response.details.status, "submitted");
	assert.deepEqual(response.details.answers.goal?.values, ["speed"]);
});

test("ask tool keeps the pending summary when the host has no UI", async () => {
	const tool = registerMockTool();
	const response = await tool.execute(
		"call-1",
		SINGLE_PARAMS,
		undefined,
		() => {},
		{ mode: "rpc", hasUI: false } as never
	);
	assert.equal(response.details.status, "unavailable");
});
