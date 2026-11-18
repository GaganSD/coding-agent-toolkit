import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/state/create.ts";
import {
	applyFallbacks,
	createExpiryTimer,
	effectiveTimeoutSeconds,
	formatRemaining,
	toExpiredResult,
} from "../src/state/expiry.ts";
import type { AskParams } from "../src/types.ts";
import { fakeClock } from "./support/fake-clock.ts";

function record(timer: ReturnType<typeof createExpiryTimer>) {
	const events: string[] = [];
	timer.subscribe({
		change: (view) =>
			events.push(`change:${view.phase}:${view.remainingSeconds}`),
		expire: () => events.push("expire"),
		stop: (reason) => events.push(`stop:${reason}`),
	});
	return events;
}

test("the floor raises short limits and never rejects them", () => {
	assert.equal(effectiveTimeoutSeconds(undefined, 30), undefined);
	assert.equal(effectiveTimeoutSeconds(5, 30), 30);
	assert.equal(effectiveTimeoutSeconds(90, 30), 90);
	assert.equal(effectiveTimeoutSeconds(45.2, 30), 46);
	assert.equal(effectiveTimeoutSeconds(1, 0.5), 1);
});

test("the clock does not start until the form is armed and visible", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(30, fake.clock);
	const events = record(timer);

	timer.show();
	assert.equal(timer.view().phase, "pending", "visible but not yet notified");
	assert.equal(fake.pending, 0, "no timer is scheduled while pending");
	fake.advance(120_000);
	assert.deepEqual(events, []);

	timer.arm();
	assert.equal(timer.view().phase, "running");
	assert.equal(timer.view().remainingSeconds, 30);
});

test("a form that is queued or hidden never counts down", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(30, fake.clock);
	const events = record(timer);
	timer.arm();
	fake.advance(10 * 60_000);
	assert.equal(timer.view().phase, "pending");
	assert.deepEqual(events, []);
	assert.equal(fake.pending, 0);

	timer.hide();
	assert.equal(timer.view().phase, "pending", "hiding an idle clock is a no-op");
	timer.show();
	assert.equal(timer.view().phase, "running");
});

test("it ticks once per second and expires exactly at the limit", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(3, fake.clock);
	const events = record(timer);
	timer.arm();
	timer.show();
	fake.advance(1000);
	fake.advance(1000);
	fake.advance(1000);
	assert.deepEqual(events, [
		"change:running:3",
		"change:running:2",
		"change:running:1",
		"change:expired:0",
		"expire",
	]);
	assert.equal(fake.pending, 0, "nothing is left scheduled");
	fake.advance(60_000);
	assert.equal(events.filter((event) => event === "expire").length, 1);
});

test("a late wake-up still expires and redraws only on a changed second", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(10, fake.clock);
	const events = record(timer);
	timer.arm();
	timer.show();
	fake.advance(250);
	fake.advance(250);
	assert.equal(
		events.filter((event) => event.startsWith("change:running")).length,
		1,
		"sub-second time does not redraw"
	);
	fake.advance(60_000);
	assert.equal(timer.view().phase, "expired");
});

test("any interaction stops the clock for good", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(30, fake.clock);
	const events = record(timer);
	timer.arm();
	timer.show();
	fake.advance(5000);
	timer.interact();
	assert.equal(timer.view().phase, "stopped");
	assert.equal(timer.view().stopReason, "interaction");
	assert.equal(fake.pending, 0);

	// It cannot be restarted by showing, arming or waiting.
	timer.hide();
	timer.show();
	timer.arm();
	fake.advance(10 * 60_000);
	assert.equal(timer.view().phase, "stopped");
	assert.ok(!events.includes("expire"));
	assert.equal(events.filter((event) => event.startsWith("stop:")).length, 1);
});

test("interacting before the clock started also stops it for good", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(30, fake.clock);
	timer.interact();
	timer.arm();
	timer.show();
	assert.equal(timer.view().phase, "stopped");
});

test("hiding a running clock stops it for good", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(30, fake.clock);
	const events = record(timer);
	timer.arm();
	timer.show();
	fake.advance(2000);
	timer.hide();
	assert.equal(timer.view().stopReason, "hidden");
	timer.show();
	fake.advance(60_000);
	assert.equal(timer.view().phase, "stopped");
	assert.ok(!events.includes("expire"));
});

test("dispose cancels the pending wake-up and silences listeners", () => {
	const fake = fakeClock();
	const timer = createExpiryTimer(30, fake.clock);
	const events = record(timer);
	timer.arm();
	timer.show();
	assert.equal(fake.pending, 1);
	timer.dispose();
	assert.equal(fake.pending, 0);
	const seen = events.length;
	fake.advance(60_000);
	timer.show();
	assert.equal(events.length, seen);
});

test("remaining time reads as m:ss", () => {
	assert.equal(formatRemaining(0), "0:00");
	assert.equal(formatRemaining(9), "0:09");
	assert.equal(formatRemaining(75), "1:15");
	assert.equal(formatRemaining(3725), "1:02:05");
});

const PARAMS: AskParams = {
	questions: [
		{
			id: "db",
			prompt: "Which database?",
			options: [
				{ value: "pg", label: "Postgres" },
				{ value: "lite", label: "SQLite" },
			],
			fallback: "lite",
		},
		{
			id: "cache",
			prompt: "Which cache?",
			options: [
				{ value: "redis", label: "Redis" },
				{ value: "none", label: "None" },
			],
		},
		{ id: "notes", prompt: "Anything else?", type: "text" },
	],
};

test("only declared fallbacks apply, and the rest stay unanswered", () => {
	const result = toExpiredResult(createInitialState(PARAMS));
	assert.equal(result.status, "expired");
	assert.deepEqual(result.expired, ["db"]);
	assert.deepEqual(Object.keys(result.answers), ["db"]);
	assert.deepEqual(result.answers.db?.values, ["lite"]);
	assert.deepEqual(result.answers.db?.labels, ["SQLite"]);
	assert.deepEqual(result.unanswered, ["cache", "notes"]);
});

test("a question the user answered or skipped keeps no fallback", () => {
	const state = createInitialState(PARAMS);
	const answered = {
		...state,
		answers: {
			db: { selected: [{ value: "pg", label: "Postgres", index: 1 }] },
		},
	};
	assert.deepEqual(applyFallbacks(answered).applied, []);
	assert.deepEqual(
		applyFallbacks({ ...state, skipped: ["db"] }).applied,
		[]
	);
});

test("an expiry with no declared fallback is still expired, with nothing applied", () => {
	const state = createInitialState({
		questions: [{ id: "q", prompt: "Pick?", options: [{ value: "a", label: "A" }] }],
	});
	const result = toExpiredResult(state);
	assert.equal(result.status, "expired");
	assert.deepEqual(result.expired, []);
	assert.deepEqual(result.answers, {});
});
