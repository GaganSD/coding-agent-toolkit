import assert from "node:assert/strict";
import test from "node:test";
import { formatDeliveredOutcome } from "../src/delivery.ts";
import {
	type AskDeliveryItem,
	boundaryContinues,
	planDelivery,
} from "../src/state/outbox.ts";
import type { AskResult } from "../src/types.ts";

const item = (
	outcomeId: string,
	overrides: Partial<AskDeliveryItem> = {}
): AskDeliveryItem => ({
	outcomeId,
	cancelled: false,
	inFlight: false,
	...overrides,
});

const actions = (...args: Parameters<typeof planDelivery>) =>
	planDelivery(...args).map((step) => step.action);

test("an idle agent is woken by an answer; a working one is left alone until a boundary", () => {
	assert.deepEqual(actions([item("a")], { trigger: "now", idle: true }), ["wake"]);
	assert.deepEqual(actions([item("a")], { trigger: "now", idle: false }), ["hold"]);
	assert.deepEqual(actions([item("a")], { trigger: "boundary", idle: false }), [
		"propose",
	]);
});

test("a cancellation never wakes: appended when idle, proposed at a boundary", () => {
	const cancelled = [item("a", { cancelled: true })];
	assert.deepEqual(actions(cancelled, { trigger: "now", idle: true }), ["append"]);
	assert.deepEqual(actions(cancelled, { trigger: "settled", idle: false }), ["append"]);
	assert.deepEqual(actions(cancelled, { trigger: "now", idle: false }), ["hold"]);
	assert.deepEqual(actions(cancelled, { trigger: "boundary", idle: false }), [
		"propose",
	]);
	assert.equal(boundaryContinues(cancelled), false);
});

test("an outcome already on its way is never sent again, whatever happens next", () => {
	const flying = [item("a", { inFlight: true })];
	for (const trigger of ["now", "boundary", "settled"] as const) {
		for (const idle of [true, false]) {
			assert.deepEqual(actions(flying, { trigger, idle }), ["hold"]);
			assert.deepEqual(actions(flying, { trigger, idle, aborted: true }), ["hold"]);
		}
	}
});

test("a settled run is idle whatever the host reports; after an abort nothing wakes", () => {
	assert.deepEqual(actions([item("a")], { trigger: "settled", idle: false }), ["wake"]);
	assert.deepEqual(
		actions([item("a"), item("b")], { trigger: "settled", idle: true, aborted: true }),
		["append", "append"]
	);
});

test("one wake per batch, in request order; the rest join at its first boundary", () => {
	const steps = planDelivery(
		[item("c", { cancelled: true }), item("a"), item("b"), item("d", { cancelled: true })],
		{ trigger: "now", idle: true }
	);
	assert.deepEqual(steps, [
		{ outcomeId: "c", action: "append" },
		{ outcomeId: "a", action: "wake" },
		{ outcomeId: "b", action: "hold" },
		{ outcomeId: "d", action: "hold" },
	]);
});

test("an answer at a boundary asks for one more request, unless the turn was aborted or failed", () => {
	assert.equal(boundaryContinues([item("a")]), true);
	assert.equal(boundaryContinues([item("a")], "stop"), true);
	assert.equal(boundaryContinues([item("a")], "toolUse"), true);
	assert.equal(boundaryContinues([item("a")], "aborted"), false);
	assert.equal(boundaryContinues([item("a")], "error"), false);
	assert.equal(
		boundaryContinues([item("c", { cancelled: true }), item("a")]),
		true
	);
	assert.equal(boundaryContinues([]), false);
});

const RESULT: AskResult = {
	title: "Storage",
	status: "submitted",
	requestId: "ask-1",
	questions: [
		{ id: "db", label: "DB", prompt: "Which\n  database?", type: "single" },
		{ id: "extras", label: "Extras", prompt: "Extras?", type: "multi" },
		{ id: "why", label: "Why", prompt: "Why?", type: "text" },
		{ id: "skip", label: "Skip", prompt: "Anything else?", type: "text" },
	],
	answers: {
		db: { values: ["pg"], labels: ["Postgres"], note: "for now" },
		extras: {
			values: ["a", "b"],
			labels: ["Alpha", "Beta"],
			optionNotes: { b: "only\nin prod" },
			customText: "and gamma",
		},
		why: { values: [], labels: [], customText: "it is boring" },
	},
	unanswered: ["skip"],
};

test("a delivered answer names the request and every question by id and prompt", () => {
	assert.equal(
		formatDeliveredOutcome(RESULT),
		[
			"User answered your earlier ask_user form ask-1 (Storage):",
			'- db "Which database?": Postgres [pg]; note: for now',
			'- extras "Extras?": Alpha [a]; Beta [b] (note: only in prod); wrote "and gamma"',
			'- why "Why?": wrote "it is boring"',
			'- skip "Anything else?": (no answer)',
		].join("\n")
	);
});

test("a delivered cancellation lists what was asked and none of the draft", () => {
	const text = formatDeliveredOutcome({ ...RESULT, status: "cancelled", title: undefined });
	assert.equal(
		text,
		[
			"User cancelled your earlier ask_user form ask-1. Cancellation is not approval; keep risky actions blocked.",
			'- db "Which database?"',
			'- extras "Extras?"',
			'- why "Why?"',
			'- skip "Anything else?"',
		].join("\n")
	);
	assert.doesNotMatch(text, /Postgres|boring/);
});
