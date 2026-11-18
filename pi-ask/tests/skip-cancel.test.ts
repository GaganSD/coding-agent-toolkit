import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASK_CONFIG, normalizeAskConfig } from "../src/config/defaults.ts";
import {
	DEFAULT_ASK_KEYMAPS,
	normalizeConfiguredKeymaps,
	renderFooterKeymaps,
} from "../src/constants/keymaps.ts";
import { formatDeliveredOutcome } from "../src/delivery.ts";
import { renderResultText } from "../src/result.ts";
import { createInitialState } from "../src/state/create.ts";
import {
	applyDraftSnapshot,
	draftContentKey,
	toDraftSnapshot,
} from "../src/state/draft.ts";
import {
	saveEditorDraft,
	submitEditorDraft,
} from "../src/state/editor.ts";
import { summarizeResult, toAskResult } from "../src/state/result.ts";
import {
	cancelWithComment,
	confirmCurrentSelection,
	enterCancelComment,
	enterQuestionNoteMode,
	MAX_CANCEL_COMMENT_LENGTH,
	saveNote,
	skipCurrentQuestion,
} from "../src/state/transitions.ts";
import { getInputCommand } from "../src/ui/input.ts";
import { buildReviewScreenModel } from "../src/ui/view-models/review.ts";

const choice = (id: string) => ({
	id,
	label: id.toUpperCase(),
	prompt: `Pick ${id}?`,
	options: [
		{ value: "yes", label: "Yes" },
		{ value: "no", label: "No" },
	],
});
const PARAMS = {
	questions: [choice("a"), choice("b"), choice("c")],
};
const fresh = () => createInitialState(PARAMS);

test("skipping drops the answer and notes, moves on, and lists ids in question order", () => {
	let state = confirmCurrentSelection(fresh()); // a: Yes, now on b
	state = saveNote(enterQuestionNoteMode({ ...state, activeTabIndex: 0 }, "a"), "careful");
	assert.ok(state.answers.a?.note);
	state = { ...state, activeTabIndex: 0, view: { kind: "navigate" } };

	state = skipCurrentQuestion(state);
	assert.equal(state.answers.a, undefined, "answer and note are gone");
	assert.deepEqual(state.skipped, ["a"]);
	assert.equal(state.activeTabIndex, 1);
	assert.equal(state.completed, false, "the form stays open");

	// Skip c first, then b: the result still lists them in question order.
	state = skipCurrentQuestion({ ...state, activeTabIndex: 2 });
	state = skipCurrentQuestion({ ...state, activeTabIndex: 1 });
	assert.deepEqual(state.skipped, ["a", "b", "c"]);
});

test("skipping everything still waits on the review tab for an explicit submit", () => {
	let state = fresh();
	for (let index = 0; index < 3; index++) {
		state = skipCurrentQuestion(state);
	}
	assert.equal(state.activeTabIndex, 3, "on the review tab");
	assert.equal(state.completed, false);
	assert.deepEqual(state.skipped, ["a", "b", "c"]);
	// A no-op on the review tab.
	assert.equal(skipCurrentQuestion(state), state);
});

test("answering a skipped question takes the skip back", () => {
	let state = skipCurrentQuestion(fresh());
	assert.deepEqual(state.skipped, ["a"]);
	state = confirmCurrentSelection({ ...state, activeTabIndex: 0, view: { kind: "navigate" } });
	assert.deepEqual(state.skipped, []);
	assert.equal(toAskResult(state).skipped, undefined);
});

test("skipped is its own list: never unanswered, never an answer", () => {
	let state = skipCurrentQuestion(fresh());
	state = confirmCurrentSelection(state); // b: Yes
	const result = toAskResult(state);
	assert.deepEqual(result.skipped, ["a"]);
	assert.deepEqual(result.unanswered, ["c"]);
	assert.deepEqual(Object.keys(result.answers), ["b"]);

	const text = summarizeResult(result);
	assert.match(text, /A: \(skipped by the user\)/);
	assert.match(text, /C: \(no answer\)/);
	assert.match(text, /The user skipped: A\./);
	assert.match(text, /not approval and not an answer/);
	assert.match(renderResultText(result), /⊘ A: \(skipped by the user\)/);

	const delivered = formatDeliveredOutcome({ ...result, requestId: "ask-1" });
	assert.match(delivered, /- a "Pick a\?": \(skipped by the user\)/);
	assert.match(delivered, /- c "Pick c\?": \(no answer\)/);
	assert.match(delivered, /not approval and not an answer/);
});

test("a skip survives the journal draft", () => {
	const state = skipCurrentQuestion(fresh());
	const draft = toDraftSnapshot(state);
	assert.deepEqual(draft.skipped, ["a"]);
	assert.notEqual(draftContentKey(draft), draftContentKey(toDraftSnapshot(fresh())));
	const restored = applyDraftSnapshot(fresh(), draft);
	assert.deepEqual(restored.skipped, ["a"]);
	assert.deepEqual(
		applyDraftSnapshot(fresh(), { ...draft, skipped: ["zzz"] }).skipped,
		undefined
	);
});

test("the review model marks a skipped question apart from an unanswered one", () => {
	const state = skipCurrentQuestion(fresh());
	const [a, b] = buildReviewScreenModel(state, 80).questions;
	assert.equal(a?.skipped, true);
	assert.equal(a?.unanswered, false);
	assert.equal(b?.skipped, undefined);
	assert.equal(b?.unanswered, true);
});

// --- Cancel with a comment -------------------------------------------------

const onReview = () => ({ ...fresh(), activeTabIndex: 3, view: { kind: "submit" as const } });

test("a comment is typed on the review tab and cancels only when sent", () => {
	assert.equal(enterCancelComment(fresh()).view.kind, "navigate", "not outside the review tab");
	const typing = enterCancelComment(onReview());
	assert.equal(typing.view.kind, "comment");

	const cancelled = submitEditorDraft(typing, "  not now, wrong repo  ");
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.completed, true);
	assert.equal(cancelled.cancelComment, "not now, wrong repo");

	const result = toAskResult(cancelled);
	assert.equal(result.status, "cancelled");
	assert.equal(result.comment, "not now, wrong repo");
	const text = summarizeResult(result);
	assert.match(text, /User cancelled the ask flow\. Reason: "not now, wrong repo"\./);
	assert.match(text, /Cancellation is not approval; keep risky actions blocked/);
	assert.match(renderResultText(result), /^Cancelled: not now, wrong repo/);
	assert.match(
		formatDeliveredOutcome({ ...result, requestId: "ask-1" }),
		/The user's reason: "not now, wrong repo"\./
	);
});

test("an empty comment or closing the editor cancels nothing", () => {
	const typing = enterCancelComment(onReview());
	assert.equal(submitEditorDraft(typing, "   ").completed, false);
	assert.equal(submitEditorDraft(typing, "   ").view.kind, "submit");
	const closed = saveEditorDraft(typing, "half a thought");
	assert.equal(closed.view.kind, "submit");
	assert.equal(closed.cancelComment, undefined);
});

test("an uncommented cancel behaves exactly as before", () => {
	const cancelled = confirmCurrentSelection({ ...onReview(), activeSubmitActionIndex: 1 });
	const result = toAskResult(cancelled);
	assert.equal(result.status, "cancelled");
	assert.equal("comment" in result, false);
	assert.equal(summarizeResult(result), "User cancelled the ask flow");
	assert.equal(renderResultText(result), "Cancelled");
});

test("a comment is kept short", () => {
	const state = cancelWithComment(onReview(), "x".repeat(2000));
	assert.equal(state.cancelComment?.length, MAX_CANCEL_COMMENT_LENGTH);
});

test("a comment never rides on a submitted result", () => {
	const state = { ...fresh(), cancelComment: "stale" };
	assert.equal(toAskResult(state).comment, undefined);
});

// --- Keys ------------------------------------------------------------------

test("skip and comment keys have defaults that collide with nothing", () => {
	assert.deepEqual(DEFAULT_ASK_KEYMAPS.main.skip, ["s"]);
	assert.deepEqual(DEFAULT_ASK_KEYMAPS.main.cancelComment, ["c"]);
	const result = normalizeConfiguredKeymaps(DEFAULT_ASK_KEYMAPS);
	assert.ok(result.ok);
});

test("skip fires on a question and comment on the review tab, never in an editor", () => {
	const nav = getInputCommand(fresh(), DEFAULT_ASK_CONFIG, "s");
	assert.deepEqual(nav, { kind: "skipQuestion" });
	assert.deepEqual(getInputCommand(fresh(), DEFAULT_ASK_CONFIG, "c"), { kind: "ignore" });
	assert.deepEqual(getInputCommand(onReview(), DEFAULT_ASK_CONFIG, "s"), { kind: "ignore" });
	assert.deepEqual(getInputCommand(onReview(), DEFAULT_ASK_CONFIG, "c"), {
		kind: "cancelWithComment",
	});

	// A text editor (custom answer, note, comment) receives the letters.
	const editing = {
		...fresh(),
		view: { kind: "input" as const, questionId: "a" },
	};
	for (const view of [
		editing.view,
		{ kind: "note" as const, questionId: "a" },
		{ kind: "comment" as const },
	]) {
		for (const key of ["s", "c"]) {
			assert.deepEqual(
				getInputCommand({ ...editing, view }, DEFAULT_ASK_CONFIG, key, "text"),
				{ kind: "delegateToEditor" }
			);
			assert.deepEqual(
				getInputCommand({ ...editing, view }, DEFAULT_ASK_CONFIG, key, ""),
				{ kind: "delegateToEditor" }
			);
		}
	}
});

test("the keys are configurable, old configs gain them, and a bound key is not stolen", () => {
	const old = structuredClone(DEFAULT_ASK_KEYMAPS) as any;
	delete old.main.skip;
	delete old.main.cancelComment;
	old.main.optionNote = ["s"];
	const config = normalizeAskConfig({ keymaps: old });
	assert.deepEqual(config.keymaps.main.skip, [], "left unbound, not stolen");
	assert.deepEqual(config.keymaps.main.cancelComment, ["c"]);

	const custom = structuredClone(DEFAULT_ASK_KEYMAPS);
	custom.main.skip = ["ctrl+k"];
	assert.deepEqual(
		getInputCommand(fresh(), { ...DEFAULT_ASK_CONFIG, keymaps: normalizeAskConfig({ keymaps: custom }).keymaps }, "\u000b"),
		{ kind: "skipQuestion" }
	);
});

test("footer hints offer skip on questions and the comment on the review tab", () => {
	assert.match(renderFooterKeymaps(DEFAULT_ASK_CONFIG, "default"), /S skip/);
	assert.match(renderFooterKeymaps(DEFAULT_ASK_CONFIG, "multi"), /S skip/);
	assert.match(renderFooterKeymaps(DEFAULT_ASK_CONFIG, "submit"), /C cancel with comment/);
	assert.match(renderFooterKeymaps(DEFAULT_ASK_CONFIG, "comment"), /Enter cancel with comment · Esc back/);
	assert.doesNotMatch(renderFooterKeymaps(DEFAULT_ASK_CONFIG, "input"), /skip/);
});
