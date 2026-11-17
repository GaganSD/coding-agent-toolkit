import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "../src/ask-tool.ts";
import { ASK_ANSWER_MESSAGE_TYPE } from "../src/journal/entries.ts";
import { registerAskRecovery } from "../src/recovery.ts";
import { createAskRuntime } from "../src/runtime.ts";
import { fakePi, KEY, quietConfig, tick } from "./support/fake-pi.ts";

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
		{
			id: "cache",
			label: "Cache",
			prompt: "Which cache?",
			options: [
				{ value: "redis", label: "Redis" },
				{ value: "none", label: "None" },
			],
		},
	],
};

/** One Pi process: the extension wired as `src/index.ts` wires it. */
function boot(session?: SessionManager, options?: { mode?: string }) {
	const host = fakePi(session, options);
	const runtime = createAskRuntime(host.pi);
	registerAskTool(host.pi, { runtime });
	const recovery = registerAskRecovery(host.pi, runtime);
	const ask = () =>
		host.tools[0].execute("call-1", PARAMS, undefined, () => {}, host.ctx);
	return { ...host, recovery, ask };
}

/** A session whose foreground form was open, DB answered, when Pi died. */
async function interruptedSession() {
	const first = boot();
	first.ask().catch(() => {});
	await tick();
	first.forms[0]?.press(KEY.enter);
	assert.deepEqual(
		first.journal().map((entry) => entry.kind),
		["form", "draft"]
	);
	return first.session;
}

async function start(host: ReturnType<typeof boot>, reason = "resume") {
	host.emit("session_start", { reason });
	await tick();
}

function kinds(host: ReturnType<typeof boot>) {
	return host.journal().map((entry) => entry.kind);
}

beforeEach(quietConfig);

test("a tool call journals the form before waiting and the outcome before returning", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	assert.deepEqual(kinds(host), ["form"]);
	assert.equal(host.journal()[0].mode, "foreground");
	assert.equal(host.journal()[0].toolCallId, "call-1");

	host.forms[0]?.press(KEY.enter, KEY.enter, KEY.enter);
	const response = await pending;
	const outcome = host.journal().at(-1);
	assert.equal(outcome.kind, "outcome");
	assert.equal(outcome.channel, "tool");
	assert.equal(response.details.status, "submitted");
	assert.equal(response.details.requestId, host.journal()[0].requestId);
	assert.deepEqual(outcome.result, response.details);

	// Nothing is left to recover and nothing is sent twice.
	await start(host, "reload");
	assert.equal(host.forms.length, 1);
	assert.deepEqual(host.sent, []);
});

test("non-interactive and dialog hosts journal a settled outcome", async () => {
	const host = boot(undefined, { mode: "json" });
	const response = await host.tools[0].execute(
		"call-1",
		PARAMS,
		undefined,
		() => {},
		{ mode: "json", hasUI: false }
	);
	assert.equal(response.details.status, "unavailable");
	assert.deepEqual(kinds(host), ["form", "outcome"]);
	assert.equal(response.details.requestId, host.journal()[0].requestId);
});

test("an interrupted form reopens with its draft and its answer reaches the agent once", async () => {
	const session = await interruptedSession();
	const host = boot(session);
	const returned = host.emit("session_start", { reason: "resume" });
	assert.deepEqual(
		returned,
		[undefined],
		"the handler returns at once instead of waiting for the form"
	);
	await tick();
	assert.equal(host.forms.length, 1);
	assert.equal(host.notices.length, 1);
	assert.equal(host.sent.length, 0, "nothing is delivered while open");

	// DB came back from the draft; only Cache and the review tab remain.
	host.forms[0]?.press(KEY.enter, KEY.enter);
	await tick();

	assert.equal(host.sent.length, 1);
	const [{ message, options }] = host.sent;
	assert.equal(message.customType, ASK_ANSWER_MESSAGE_TYPE);
	assert.deepEqual(options, { triggerTurn: true });
	assert.match(message.content, /ask-[0-9a-f]{8} \(Storage\)/);
	assert.match(message.content, /DB: Postgres\nCache: Redis/);
	assert.equal(message.details.result.status, "submitted");
	assert.deepEqual(kinds(host), [
		"form",
		"draft",
		"draft",
		"outcome",
		"delivered",
	]);
	assert.equal(host.journal().at(-2).channel, "message");
});

test("no duplicate delivery after a second session_start", async () => {
	const session = await interruptedSession();
	const host = boot(session);
	await start(host);
	host.forms[0]?.press(KEY.enter, KEY.enter);
	await tick();
	assert.equal(host.sent.length, 1);

	await start(host, "reload");
	host.emit("session_tree");
	await tick();
	assert.equal(host.forms.length, 1);
	assert.equal(host.sent.length, 1);

	// A later process on the same session sees the marker too.
	const later = boot(session);
	await start(later);
	assert.equal(later.forms.length, 0);
	assert.deepEqual(later.sent, []);
});

test("the delivery marker alone prevents a second delivery", async () => {
	const session = await interruptedSession();
	// A working agent queues the message, so it is not in the session yet.
	const host = fakePi(session, { persistSentMessages: false });
	const runtime = createAskRuntime(host.pi);
	registerAskRecovery(host.pi, runtime);
	host.setIdle(false);
	host.emit("session_start", { reason: "resume" });
	await tick();
	host.forms[0]?.press(KEY.enter, KEY.enter);
	await tick();
	assert.deepEqual(host.sent[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});

	const later = boot(session);
	await start(later);
	assert.equal(later.forms.length, 0);
	assert.deepEqual(later.sent, []);
});

test("an outcome journalled but never sent is delivered on the next start, once", async () => {
	const session = await interruptedSession();
	const dying = fakePi(session);
	const requestId = dying.journal()[0].requestId;
	createAskRuntime(dying.pi).journal.recordOutcome(
		requestId,
		{
			status: "submitted",
			title: "Storage",
			questions: [],
			answers: {},
			unanswered: [],
		},
		"message"
	);

	const host = boot(session);
	await start(host);
	await start(host, "reload");
	assert.equal(host.forms.length, 0, "an answered form is not reopened");
	assert.equal(host.sent.length, 1);
	assert.equal(host.sent[0]?.message.details.requestId, requestId);
});

test("a cancelled recovery is recorded, never wakes the agent and does not reopen", async () => {
	const session = await interruptedSession();
	const host = boot(session);
	await start(host);
	// The restored draft makes the form dirty: cancel asks to confirm.
	host.forms[0]?.press(KEY.escape, KEY.escape);
	await tick();

	assert.equal(host.sent.length, 1);
	assert.deepEqual(host.sent[0]?.options, { triggerTurn: false });
	assert.match(host.sent[0]?.message.content ?? "", /cancelled/);
	assert.match(host.sent[0]?.message.content ?? "", /not approval/);
	assert.equal(host.journal().at(-2).result.status, "cancelled");

	await start(host, "reload");
	const later = boot(session);
	await start(later);
	assert.equal(host.forms.length, 1);
	assert.equal(later.forms.length, 0);
	assert.equal(later.sent.length, 0);
});

test("a stale form from another branch is ignored", async () => {
	const session = SessionManager.inMemory();
	const rootId = session.appendMessage({
		role: "user",
		content: "start",
		timestamp: Date.now(),
	});
	// Branch A: a form interrupted mid-answer.
	const first = boot(session);
	first.ask().catch(() => {});
	await tick();
	first.forms[0]?.press(KEY.enter);
	assert.equal(first.journal().length, 2);

	// Branch B forks from before the form was asked.
	session.branch(rootId);
	session.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
	const host = boot(session);
	await start(host);
	host.emit("session_tree");
	await tick();
	assert.equal(host.forms.length, 0);
	assert.deepEqual(host.sent, []);
	assert.deepEqual(host.journal(), []);
});

test("an answer is dropped when the branch changes while the form is open", async () => {
	const session = SessionManager.inMemory();
	const rootId = session.appendMessage({
		role: "user",
		content: "start",
		timestamp: Date.now(),
	});
	const first = boot(session);
	first.ask().catch(() => {});
	await tick();

	const host = boot(session);
	await start(host);
	assert.equal(host.forms.length, 1);

	session.branch(rootId);
	host.emit("session_tree");
	host.forms[0]?.press(KEY.enter, KEY.enter, KEY.enter);
	await tick();

	assert.deepEqual(host.sent, []);
	assert.deepEqual(
		host.journal(),
		[],
		"nothing from the other branch's form is written into this one"
	);
});

test("a form the conversation moved past is not reopened", async () => {
	const session = await interruptedSession();
	session.appendMessage({ role: "user", content: "never mind", timestamp: Date.now() });
	const host = boot(session);
	await start(host);
	assert.equal(host.forms.length, 0);
	assert.deepEqual(host.sent, []);
});

test("a form that is open in this process is not treated as interrupted", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	host.emit("session_tree");
	await start(host, "reload");
	assert.equal(host.forms.length, 1);

	host.forms[0]?.press(KEY.enter, KEY.enter, KEY.enter);
	assert.equal((await pending).details.status, "submitted");
	assert.deepEqual(host.sent, []);
});

test("recovery is TUI-only and stops at session shutdown", async () => {
	const session = await interruptedSession();
	const rpc = boot(session, { mode: "rpc" });
	await start(rpc);
	assert.equal(rpc.forms.length, 0);
	assert.deepEqual(rpc.sent, []);

	const host = boot(session);
	await start(host);
	assert.equal(host.forms.length, 1);
	host.emit("session_shutdown", { reason: "quit" });
	host.forms[0]?.press(KEY.enter, KEY.enter);
	await tick();
	assert.deepEqual(host.sent, [], "a torn-down runtime writes nothing");
	assert.deepEqual(kinds(host), ["form", "draft"]);

	await start(host);
	assert.equal(host.forms.length, 1);
});
