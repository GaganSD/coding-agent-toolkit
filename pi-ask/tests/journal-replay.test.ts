import assert from "node:assert/strict";
import test from "node:test";
import {
	ASK_ANSWER_MESSAGE_TYPE,
	ASK_JOURNAL_ENTRY_TYPE,
	type AskJournalEntry,
} from "../src/journal/entries.ts";
import { createAskJournal, toFormSnapshot } from "../src/journal/journal.ts";
import {
	type BranchEntryLike,
	getRecord,
	interruptedForms,
	queuedForms,
	reopenableForms,
	replayJournal,
	undeliveredOutcomes,
} from "../src/journal/replay.ts";
import { createInitialState } from "../src/state/create.ts";
import { toAskResult } from "../src/state/result.ts";
import { confirmCurrentSelection } from "../src/state/transitions.ts";
import type { AskResult, AskResultStatus } from "../src/types.ts";

const PARAMS = {
	title: "Storage",
	questions: [
		{
			id: "db",
			label: "DB",
			prompt: "Which database?",
			options: [
				{ value: "pg", label: "Postgres" },
				{ value: "sqlite", label: "SQLite" },
			],
		},
	],
};

/** A branch under construction plus a journal that appends to it. */
function branch() {
	const entries: BranchEntryLike[] = [];
	let id = 0;
	const journal = createAskJournal(
		(entry: AskJournalEntry) =>
			entries.push({
				type: "custom",
				customType: ASK_JOURNAL_ENTRY_TYPE,
				data: structuredClone(entry),
			}),
		{ now: () => 1000 + entries.length, newId: () => String(++id) }
	);
	const form = (mode: "foreground" | "background" = "foreground") =>
		journal.recordForm({
			mode,
			form: toFormSnapshot(createInitialState(PARAMS)),
			toolCallId: "call-1",
		});
	const message = (role: string) =>
		entries.push({ type: "message", message: { role } });
	return { entries, journal, form, message };
}

function result(status: AskResultStatus = "submitted"): AskResult {
	const state = confirmCurrentSelection(createInitialState(PARAMS));
	return toAskResult(state, status);
}

test("a form with no outcome is an interrupted foreground form", () => {
	const b = branch();
	const requestId = b.form();
	const state = replayJournal(b.entries);

	assert.equal(requestId, "ask-1");
	assert.deepEqual(
		interruptedForms(state).map((record) => record.requestId),
		[requestId]
	);
	assert.deepEqual(queuedForms(state), []);
	const record = getRecord(state, requestId);
	assert.equal(record?.form.title, "Storage");
	assert.equal(record?.form.questions[0]?.id, "db");
	assert.equal(record?.toolCallId, "call-1");
});

test("the latest draft wins and survives replay", () => {
	const b = branch();
	const requestId = b.form();
	const record = b.journal.draftRecorder(requestId);
	const initial = createInitialState(PARAMS);
	record(initial);
	record({ ...initial, activeTabIndex: 1 });
	assert.equal(b.entries.length, 1, "cursor moves are not journalled");

	const answered = confirmCurrentSelection(initial);
	record({ ...answered, completed: false });
	record({ ...answered, completed: false });
	assert.equal(b.entries.length, 2, "an unchanged draft is not rewritten");

	const draft = getRecord(replayJournal(b.entries), requestId)?.draft;
	assert.deepEqual(draft?.answers.db?.selected[0]?.value, "pg");
});

test("a tool outcome completes the form and needs no delivery", () => {
	const b = branch();
	const requestId = b.form();
	const outcome = b.journal.recordOutcome(requestId, result(), "tool");
	const state = replayJournal(b.entries);

	assert.equal(outcome.result.requestId, requestId);
	assert.deepEqual(interruptedForms(state), []);
	assert.deepEqual(undeliveredOutcomes(state), []);
	assert.equal(getRecord(state, requestId)?.outcome?.result.status, "submitted");
});

test("a message outcome stays undelivered until its marker is written", () => {
	const b = branch();
	const requestId = b.form();
	const outcome = b.journal.recordOutcome(requestId, result(), "message");
	assert.deepEqual(
		undeliveredOutcomes(replayJournal(b.entries)).map((r) => r.requestId),
		[requestId]
	);

	b.journal.recordDelivered(requestId, outcome.outcomeId);
	assert.deepEqual(undeliveredOutcomes(replayJournal(b.entries)), []);
});

test("a persisted answer message proves delivery without a marker", () => {
	const b = branch();
	const requestId = b.form();
	const outcome = b.journal.recordOutcome(requestId, result(), "message");
	b.entries.push({
		type: "custom_message",
		customType: ASK_ANSWER_MESSAGE_TYPE,
		details: { requestId, outcomeId: outcome.outcomeId },
	});
	assert.deepEqual(undeliveredOutcomes(replayJournal(b.entries)), []);
});

test("delivery is tracked per outcome, so a late correction is delivered again", () => {
	const b = branch();
	const requestId = b.form("background");
	const expired = b.journal.recordOutcome(
		requestId,
		result("expired"),
		"message"
	);
	b.journal.recordDelivered(requestId, expired.outcomeId);
	let state = replayJournal(b.entries);
	assert.deepEqual(undeliveredOutcomes(state), []);
	assert.deepEqual(
		reopenableForms(state).map((record) => record.requestId),
		[requestId]
	);
	assert.deepEqual(queuedForms(state), [], "an expired form left the queue");

	const correction = b.journal.recordOutcome(requestId, result(), "message");
	state = replayJournal(b.entries);
	assert.equal(
		undeliveredOutcomes(state)[0]?.outcome.outcomeId,
		correction.outcomeId
	);
	assert.deepEqual(reopenableForms(state), []);
});

test("the queue is first asked first, and a deferred form keeps its place", () => {
	const b = branch();
	const first = b.form("foreground");
	const second = b.form("background");
	const third = b.form("background");
	b.journal.recordDefer(first);
	b.message("assistant");

	let state = replayJournal(b.entries);
	assert.deepEqual(
		queuedForms(state).map((record) => record.requestId),
		[first, second, third]
	);
	assert.deepEqual(
		interruptedForms(state),
		[],
		"deferred and background forms are never interrupted foreground forms"
	);

	b.journal.recordOutcome(second, result("cancelled"), "message");
	state = replayJournal(b.entries);
	assert.deepEqual(
		queuedForms(state).map((record) => record.requestId),
		[first, third]
	);
});

test("a foreground form the conversation moved past is not interrupted", () => {
	const b = branch();
	b.form();
	b.message("toolResult");
	assert.equal(interruptedForms(replayJournal(b.entries)).length, 1);

	b.message("user");
	assert.deepEqual(interruptedForms(replayJournal(b.entries)), []);
});

test("replay ignores foreign, malformed and orphaned entries", () => {
	const b = branch();
	const requestId = b.form();
	const entries: BranchEntryLike[] = [
		{ type: "custom", customType: "other-extension", data: { kind: "form" } },
		{ type: "custom", customType: ASK_JOURNAL_ENTRY_TYPE },
		{ type: "custom", customType: ASK_JOURNAL_ENTRY_TYPE, data: "nope" },
		{
			type: "custom",
			customType: ASK_JOURNAL_ENTRY_TYPE,
			data: { v: 99, kind: "form", requestId: "ask-future", form: {} },
		},
		{
			type: "custom",
			customType: ASK_JOURNAL_ENTRY_TYPE,
			data: { v: 1, kind: "teleport", requestId },
		},
		// An outcome whose form lives on another branch.
		{
			type: "custom",
			customType: ASK_JOURNAL_ENTRY_TYPE,
			data: {
				v: 1,
				at: 1,
				kind: "outcome",
				requestId: "ask-elsewhere",
				outcomeId: "x",
				channel: "message",
				result: result(),
			},
		},
		{ type: "custom_message", customType: ASK_ANSWER_MESSAGE_TYPE },
		...b.entries,
		// A second form entry with the same id never replaces the first.
		{
			...b.entries[0],
			data: { ...(b.entries[0]?.data as object), mode: "background" },
		} as BranchEntryLike,
	];
	const state = replayJournal(entries);
	assert.deepEqual(
		state.records.map((record) => [record.requestId, record.mode]),
		[[requestId, "foreground"]]
	);
	assert.deepEqual(undeliveredOutcomes(state), []);
});
