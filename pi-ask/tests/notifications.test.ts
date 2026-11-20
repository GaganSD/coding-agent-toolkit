import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import {
	createQuestionWaitingNotification,
	notifyQuestionWaiting,
} from "../src/notifications.ts";

test("notification payload uses question label before prompt", () => {
	const payload = createQuestionWaitingNotification({
		label: "Scope",
		prompt: "What should we change?",
	});

	assert.deepEqual(payload, {
		event: "question.waiting",
		title: "pi ask",
		message: "Question waiting: Scope",
	});
});

test("notification payload falls back to prompt and compacts whitespace", () => {
	const payload = createQuestionWaitingNotification({
		label: "",
		prompt: "What\nshould\twe change?",
	});

	assert.equal(payload.message, "Question waiting: What should we change?");
});

test("notification title uses the form title, single-lined and truncated", () => {
	const titled = createQuestionWaitingNotification(
		{ label: "Scope", prompt: "Prompt" },
		" Storage\n plan "
	);
	assert.equal(titled.title, "Storage plan");

	const truncated = createQuestionWaitingNotification(
		{ label: "Scope", prompt: "Prompt" },
		"x".repeat(200)
	);
	assert.ok(truncated.title.endsWith("…"));
	assert.ok(truncated.title.length < 200);

	const blank = createQuestionWaitingNotification(
		{ label: "Scope", prompt: "Prompt" },
		"   "
	);
	assert.equal(blank.title, "pi ask");
});

test("notification truncation counts graphemes, not UTF-16 units", () => {
	const payload = createQuestionWaitingNotification({
		label: `${"a".repeat(100)}😀${"b".repeat(20)}`,
		prompt: "Prompt",
	});

	assert.ok(payload.message.endsWith("😀…"), payload.message);
	assert.equal(Array.from(payload.message).at(-2), "😀", "no half surrogate is kept");
});

test("notification message follows PI_ASK_LOCALE", () => {
	const saved = process.env.PI_ASK_LOCALE;
	process.env.PI_ASK_LOCALE = "zh";
	try {
		const payload = createQuestionWaitingNotification({
			label: "Scope",
			prompt: "Prompt",
		});
		assert.equal(payload.message, "等待回答的问题：Scope");
	} finally {
		if (saved === undefined) delete process.env.PI_ASK_LOCALE;
		else process.env.PI_ASK_LOCALE = saved;
	}
});

test("disabled notifications are skipped", async () => {
	const attempts = await notifyQuestionWaiting(
		{
			...DEFAULT_ASK_CONFIG,
			notifications: { channels: ["bell"], enabled: false },
		},
		createQuestionWaitingNotification({ label: "Scope", prompt: "Prompt" })
	);

	assert.deepEqual(attempts, [{ channel: "notifications", status: "skipped" }]);
});

test("command notification receives env and swallows failures", async () => {
	const payload = createQuestionWaitingNotification({
		label: "Scope",
		prompt: "Prompt",
	});
	const attempts = await notifyQuestionWaiting(
		{
			...DEFAULT_ASK_CONFIG,
			notifications: {
				channels: [
					{
						command:
							"node -e 'if (process.env.ASK_NOTIFY_MESSAGE !== \"Question waiting: Scope\") process.exit(7)'",
						type: "command",
					},
					{ command: "node -e 'process.exit(3)'", type: "command" },
				],
				enabled: true,
			},
		},
		payload
	);

	assert.equal(attempts[0]?.status, "attempted");
	assert.equal(attempts[1]?.status, "failed");
});
