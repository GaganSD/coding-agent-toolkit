import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_ANSWER_MESSAGE_TYPE } from "../src/journal/entries.ts";
import { KEY, quietConfig, tick } from "./support/fake-pi.ts";
import {
	boot,
	start,
	kinds,
	ONE,
	SUBMIT_ONE,
	SUBMIT_TWO,
	withBackgroundForm,
	unrecordedToolSession,
} from "./support/background.ts";

beforeEach(quietConfig);

// --- Delivery --------------------------------------------------------------

test("an adopted tool answer retries synchronous send failures until delivered once", async (t) => {
	const host = boot(await unrecordedToolSession());
	const pi: ExtensionAPI = host.pi;
	const send = pi.sendMessage;
	let attempts = 0;
	t.mock.method(pi, "sendMessage", (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
		if (++attempts <= 2) {
			throw new Error("send unavailable");
		}
		send(...args);
	});

	await start(host);
	assert.equal(attempts, 1);
	host.settle();
	assert.equal(attempts, 2);
	assert.equal(host.sent.length, 0);
	host.settle();
	assert.equal(attempts, 3);
	assert.equal(host.sent.length, 1);
	host.recordWake();
	host.settle();
	await start(host, "reload");
	assert.equal(attempts, 3);
	assert.equal(host.answers().length, 1);
	host.emit("session_shutdown");
});

test("adoption keeps every orphaned tool answer eligible across delivery plans", async () => {
	const first = boot(undefined, { persistToolResults: false });
	for (const id of ["a", "b"]) {
		const pending = first.ask(ONE(id));
		await tick();
		first.forms.at(-1)?.press(...SUBMIT_ONE);
		await pending;
	}
	first.emit("session_shutdown");

	const host = boot(first.session);
	await start(host);
	assert.equal(host.sent.length, 1, "only the first answer wakes the agent");
	host.recordWake();
	const boundary = host.turnEnd();
	assert.equal(boundary.entries.length, 1, "the held answer joins the running turn");
	assert.equal(host.answers().length, 2);
	assert.equal(boundary.continue, true);
	assert.deepEqual(host.turnEnd(), { entries: [], continue: false });
	host.settle();
	await start(host, "reload");
	assert.equal(host.answers().length, 2);
	assert.equal(host.sent.length, 1);
	host.emit("session_shutdown");
});

test("an idle agent is woken by the answer, which names the form and each question", async () => {
	const { host, requestId } = await withBackgroundForm();
	host.type(...SUBMIT_TWO);
	await tick();

	assert.equal(host.sent.length, 1);
	const [{ message, options }] = host.sent;
	assert.equal(message.customType, ASK_ANSWER_MESSAGE_TYPE);
	assert.deepEqual(options, { triggerTurn: true });
	assert.equal(
		message.content,
		[
			`User answered your earlier ask_user form ${requestId} (Storage):`,
			'- db "Which database?": Postgres [postgres]',
			'- cache "Which cache?": Redis [redis]',
		].join("\n")
	);
	assert.equal(message.details.result.status, "submitted");
	assert.deepEqual(kinds(host), ["form", "draft", "draft", "outcome"]);
	assert.equal(host.journal().at(-1).channel, "message");
});

test("no duplicate when the woken run reaches its turn boundary before the message is recorded", async () => {
	const { host } = await withBackgroundForm();
	host.type(...SUBMIT_TWO);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.equal(host.answers().length, 0, "the run has not recorded it yet");
	assert.equal(host.isIdle(), false);

	host.emit("turn_start");
	assert.deepEqual(host.turnEnd(), { entries: [], continue: false });
	assert.deepEqual(host.beforeSettle(), { entries: [], continue: false });
	host.recordWake();
	assert.deepEqual(host.turnEnd(), { entries: [], continue: false });
	host.settle();
	await tick();

	assert.equal(host.sent.length, 1);
	assert.equal(host.answers().length, 1);
});

test("a wake whose run never starts is retried instead of losing the answer", async () => {
	const { host, requestId } = await withBackgroundForm();
	host.failNextWake();
	host.type(...SUBMIT_TWO);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.equal(host.answers().length, 0, "the failed wake never reached the branch");
	assert.equal(host.isIdle(), true, "the run failed to start");

	// The host reports the run settled: the branch still lacks the answer, so
	// the in-flight send was never delivered and must be offered again.
	host.settle();
	await tick();
	assert.equal(host.sent.length, 2);
	assert.deepEqual(host.sent[1]?.options, { triggerTurn: true });
	assert.equal(host.sent[1]?.message.details.requestId, requestId);

	host.recordWake();
	host.settle();
	await start(host, "reload");
	assert.equal(host.answers().length, 1, "the branch proves exactly one delivery");
	assert.equal(host.sent.length, 2);
});

test("an adopted tool answer whose wake never starts is retried here, once", async () => {
	const session = await unrecordedToolSession();
	const host = boot(session, { persistToolResults: false });
	host.failNextWake();
	await start(host);
	assert.equal(host.sent.length, 1, "the rebuild adopts the answer as a wake");
	assert.equal(host.answers().length, 0, "the failed wake never reached the branch");
	assert.equal(host.isIdle(), true, "the run failed to start");

	// The branch still lacks the adopted answer, so it must be offered again
	// in this process instead of waiting for the next reload or fork.
	host.settle();
	await tick();
	assert.equal(host.sent.length, 2, "the failed adoption is retried");
	assert.deepEqual(host.sent[1]?.options, { triggerTurn: true });

	host.recordWake();
	host.settle();
	await start(host, "reload");
	assert.equal(host.answers().length, 1, "the branch proves exactly one delivery");
	assert.equal(host.sent.length, 2);
});

test("a new run releases an answer whose wake never started, and delivers it once", async () => {
	const { host, requestId } = await withBackgroundForm();
	host.failNextWake();
	host.type(...SUBMIT_TWO);
	await tick();
	assert.equal(host.sent.length, 1);

	// Another run starts. The answer joins it at its first turn boundary.
	host.setIdle(false);
	host.emit("agent_start");
	const boundary = host.turnEnd();
	assert.equal(boundary.entries.length, 1);
	assert.equal(boundary.entries[0].details.requestId, requestId);
	host.settle();
	await start(host, "reload");
	assert.equal(host.answers().length, 1);
	assert.equal(host.sent.length, 1, "no second wake was needed");
});

test("a working agent gets the answer at the next turn boundary, once, with no extra turn started", async () => {
	const { host, requestId } = await withBackgroundForm();
	host.setIdle(false);
	host.type(...SUBMIT_TWO);
	await tick();
	assert.deepEqual(host.sent, [], "nothing is sent while the agent works");

	const first = host.turnEnd();
	assert.equal(first.continue, true, "the answer must be seen even on a final turn");
	assert.equal(first.entries.length, 1);
	assert.equal(first.entries[0].type, "custom_message");
	assert.equal(first.entries[0].customType, ASK_ANSWER_MESSAGE_TYPE);
	assert.equal(first.entries[0].details.requestId, requestId);
	assert.match(first.entries[0].content, /db "Which database\?": Postgres/);

	// Turn boundary, then settle: the same answer is not offered or sent again.
	assert.deepEqual(host.turnEnd(), { entries: [], continue: false });
	assert.deepEqual(host.beforeSettle(), { entries: [], continue: false });
	host.settle();
	await tick();
	assert.deepEqual(host.sent, []);
	assert.equal(host.answers().length, 1);
});

test("an answer given after the last turn joins at the settle boundary", async () => {
	const { host } = await withBackgroundForm();
	host.setIdle(false);
	host.turnEnd();
	host.type(...SUBMIT_TWO);
	const boundary = host.beforeSettle();
	assert.equal(boundary.entries.length, 1);
	assert.equal(boundary.continue, true);
	host.settle();
	await tick();
	assert.deepEqual(host.sent, []);
	assert.equal(host.answers().length, 1);
});

test("boundary entries from other extensions are kept", async () => {
	const { host } = await withBackgroundForm();
	host.setIdle(false);
	host.type(...SUBMIT_TWO);
	const other = { type: "custom", customType: "other", data: 1 };
	const [result] = host.emit("turn_end", { entries: [other], message: {} }) as any[];
	assert.equal(result.entries.length, 2);
	assert.equal(result.entries[0], other);
});

test("an answer left over after the user aborts is added without restarting the agent", async () => {
	const { host } = await withBackgroundForm();
	host.setIdle(false);
	host.type(...SUBMIT_TWO);
	// The aborted turn's boundary adds the answer but asks for nothing more.
	const aborted = boot(host.session);
	await start(aborted);
	assert.equal(aborted.sent.length, 1, "control: a fresh idle process would wake");

	const { host: second } = await withBackgroundForm();
	second.setIdle(false);
	second.type(...SUBMIT_TWO);
	const boundary = second.turnEnd({ stopReason: "aborted" });
	assert.equal(boundary.entries.length, 1);
	assert.equal(boundary.continue, false);

	const { host: third } = await withBackgroundForm();
	third.setIdle(false);
	third.type(...SUBMIT_TWO);
	third.settle(true);
	await tick();
	assert.equal(third.sent.length, 1);
	assert.deepEqual(third.sent[0]?.options, { triggerTurn: false });
	assert.equal(third.answers().length, 1);
});

test("no duplicate delivery after reload, resume or a second session_start", async () => {
	const { host } = await withBackgroundForm();
	host.type(...SUBMIT_TWO);
	await tick();
	host.recordWake();
	host.settle();
	assert.equal(host.sent.length, 1);

	await start(host, "reload");
	host.emit("session_tree");
	host.emit("session_compact");
	await tick();
	assert.equal(host.sent.length, 1);
	assert.equal(host.panelText(), "");

	// A later process on the same session sees the message on the branch.
	const later = boot(host.session);
	await start(later);
	later.turnEnd();
	later.settle();
	await tick();
	assert.deepEqual(later.sent, []);
	assert.equal(later.panelText(), "");
	assert.equal(later.answers().length, 1);
});

test("an outcome journalled but never recorded is delivered on the next start, once", async () => {
	// The process dies after the answer was accepted but before the run wrote it.
	const dying = boot(undefined, {});
	await start(dying, "startup");
	const receipt = await dying.askInBackground();
	dying.type(...SUBMIT_TWO);
	await tick();
	assert.equal(dying.sent.length, 1);
	assert.equal(dying.answers().length, 0);

	const host = boot(dying.session);
	await start(host);
	await start(host, "reload");
	assert.equal(host.panelText(), "", "an answered form is not shown again");
	assert.equal(host.sent.length, 1);
	assert.equal(host.sent[0]?.message.details.requestId, receipt.details.requestId);
	host.recordWake();
	host.settle();
	await start(host, "reload");
	assert.equal(host.sent.length, 1);
});

test("an answer whose tool result never reached the branch is delivered on attach", async () => {
	// The process died after the outcome was journalled but before Pi wrote
	// the tool result: the branch has the answer, the agent never saw it.
	const dying = boot(undefined, { persistToolResults: false });
	const pending = dying.ask();
	await tick();
	dying.forms[0]?.press(...SUBMIT_TWO);
	const response = await pending;
	assert.equal(response.details.status, "submitted");
	assert.equal(dying.answers().length, 0);
	assert.equal(dying.journal().at(-1)?.channel, "tool");

	const host = boot(dying.session);
	await start(host, "resume");
	assert.equal(host.sent.length, 1);
	assert.equal(host.sent[0]?.message.details.requestId, response.details.requestId);
	assert.deepEqual(host.sent[0]?.options, { triggerTurn: true });

	host.recordWake();
	await start(host, "reload");
	assert.equal(host.sent.length, 1, "the answer message proves delivery");
	assert.equal(host.answers().length, 1);
});

test("a tool result on the branch proves the answer was delivered", async () => {
	const dying = boot(undefined, { persistToolResults: false });
	const pending = dying.ask();
	await tick();
	dying.forms[0]?.press(...SUBMIT_TWO);
	await pending;
	dying.session.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "ask_user",
		content: [{ type: "text", text: "answered" }],
		isError: false,
		timestamp: Date.now(),
	});

	const host = boot(dying.session);
	await start(host, "resume");
	assert.deepEqual(host.sent, []);
});

test("a cancellation is recorded as context and never wakes or aborts the agent", async () => {
	const { host, requestId } = await withBackgroundForm();
	// Dismiss, confirmed because the form has a draft.
	host.type(KEY.enter, KEY.ctrlC, KEY.ctrlC);
	await tick();

	assert.equal(host.sent.length, 1);
	assert.deepEqual(host.sent[0]?.options, { triggerTurn: false });
	assert.equal(
		host.sent[0]?.message.content,
		[
			`User cancelled your earlier ask_user form ${requestId} (Storage). Cancellation is not approval; keep risky actions blocked.`,
			'- db "Which database?"',
			'- cache "Which cache?"',
		].join("\n")
	);
	assert.equal(host.isIdle(), true, "no turn was started");
	assert.equal(host.aborts, 0, "unrelated agent work is not aborted");
	assert.equal(host.journal().at(-1).result.status, "cancelled");
	assert.equal(host.panelText(), "");

	host.settle();
	await start(host, "reload");
	const later = boot(host.session);
	await start(later);
	assert.equal(host.sent.length, 1);
	assert.deepEqual(later.sent, []);
	assert.equal(later.panelText(), "");
});

test("a cancellation while the agent works joins the turn boundary without asking for a turn", async () => {
	const { host } = await withBackgroundForm(ONE("a"));
	await host.askInBackground(ONE("b"));
	host.setIdle(false);
	host.type(KEY.ctrlC);
	await tick();
	assert.match(host.panelText(), /Pick b\?/, "only the cancelled form closed");
	assert.deepEqual(host.sent, []);
	assert.equal(host.aborts, 0);

	const boundary = host.turnEnd({ stopReason: "stop" });
	assert.equal(boundary.entries.length, 1);
	assert.equal(boundary.continue, false);
	assert.match(boundary.entries[0].content, /cancelled/);
});

test("delivered answers render as a compact card", async () => {
	const { host } = await withBackgroundForm();
	host.type(...SUBMIT_TWO);
	await tick();
	const render = host.renderers.get(ASK_ANSWER_MESSAGE_TYPE);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const card = render?.(host.sent[0]?.message, { expanded: false }, theme);
	const text = card.render(80).join("\n");
	assert.match(text, /ask_user answered · Storage/);
	assert.match(text, /✓ DB: Postgres/);
	assert.doesNotMatch(text, /requestId|\{/);
	assert.equal(render?.({ details: undefined }, {}, theme), undefined);
});
