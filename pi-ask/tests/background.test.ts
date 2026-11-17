import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "../src/ask-tool.ts";
import { registerAskBackground } from "../src/background.ts";
import { ASK_ANSWER_MESSAGE_TYPE } from "../src/journal/entries.ts";
import { createAskRuntime } from "../src/runtime.ts";
import { fakePi, KEY, quietConfig, tick } from "./support/fake-pi.ts";

const question = (id: string, prompt: string, first: string, second: string) => ({
	id,
	label: id.toUpperCase(),
	prompt,
	options: [
		{ value: first.toLowerCase(), label: first },
		{ value: second.toLowerCase(), label: second },
	],
});

const PARAMS = {
	title: "Storage",
	questions: [
		question("db", "Which database?", "Postgres", "SQLite"),
		question("cache", "Which cache?", "Redis", "None"),
	],
};
const ONE = (id: string, title = id) => ({
	title,
	questions: [question(id, `Pick ${id}?`, "Yes", "No")],
});
/** Answer every question with its first option and submit. */
const SUBMIT_TWO = [KEY.enter, KEY.enter, KEY.enter];
const SUBMIT_ONE = [KEY.enter, KEY.enter];

/** One Pi process: the extension wired as `src/index.ts` wires it. */
function boot(
	session?: SessionManager,
	options: { background?: boolean; mode?: string } = {}
) {
	const host = fakePi(session, options);
	const runtime = createAskRuntime(host.pi);
	registerAskBackground(host.pi, runtime);
	registerAskTool(host.pi, {
		runtime,
		features: { background: options.background ?? true, expiry: false },
	});
	let calls = 0;
	const ask = (params: object = PARAMS) =>
		host.tools[0].execute(`call-${++calls}`, params, undefined, () => {}, host.ctx);
	const askInBackground = (params: object = PARAMS) =>
		ask({ ...params, background: true });
	return { ...host, host, ask, askInBackground };
}

type Host = ReturnType<typeof boot>;

async function start(host: Host, reason = "resume") {
	host.emit("session_start", { reason });
	await tick();
}

const kinds = (host: Host) => host.journal().map((entry) => entry.kind);
const ids = (host: Host) =>
	host
		.journal()
		.filter((entry) => entry.kind === "form")
		.map((entry) => entry.requestId);

/** A session whose foreground form was open, DB answered, when Pi died. */
async function interruptedSession() {
	const first = boot();
	first.ask().catch(() => {});
	await tick();
	first.forms[0]?.press(KEY.enter);
	assert.deepEqual(kinds(first), ["form", "draft"]);
	return first.session;
}

/** A started process with one background form in the focused panel. */
async function withBackgroundForm(params: object = PARAMS) {
	const host = boot();
	await start(host, "startup");
	const receipt = await host.askInBackground(params);
	return { host, receipt, requestId: receipt.details.requestId as string };
}

beforeEach(quietConfig);

// --- The tool call ---------------------------------------------------------

test("a blocking call journals the form before waiting and the outcome before returning", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	assert.deepEqual(kinds(host), ["form"]);
	assert.equal(host.journal()[0].mode, "foreground");
	assert.equal(host.journal()[0].toolCallId, "call-1");

	host.forms[0]?.press(...SUBMIT_TWO);
	const response = await pending;
	const outcome = host.journal().at(-1);
	assert.equal(outcome.kind, "outcome");
	assert.equal(outcome.channel, "tool");
	assert.equal(response.details.status, "submitted");
	assert.deepEqual(outcome.result, response.details);

	// Nothing is left to show and nothing is sent.
	await start(host, "reload");
	assert.equal(host.forms.length, 1);
	assert.equal(host.panelText(), "");
	assert.deepEqual(host.sent, []);
});

test("a background call returns a queued receipt at once and writes no outcome", async () => {
	const { host, receipt, requestId } = await withBackgroundForm();
	assert.equal(receipt.details.status, "queued");
	assert.match(requestId, /^ask-[0-9a-f]{8}$/);
	assert.equal(receipt.details.pending, 1);
	assert.deepEqual(receipt.details.answers, {});
	assert.deepEqual(receipt.details.unanswered, ["db", "cache"]);
	const text = receipt.content[0].text;
	assert.match(text, new RegExp(requestId));
	assert.match(text, /not an answer or approval/);
	assert.match(text, /later message/);
	assert.match(text, /Do not ask again/);
	assert.deepEqual(kinds(host), ["form"]);
	assert.equal(host.journal()[0].mode, "background");
	assert.equal(host.forms.length, 0, "no blocking form was opened");
	assert.deepEqual(host.sent, []);

	const second = await host.askInBackground(ONE("x"));
	assert.equal(second.details.pending, 2);
	assert.match(second.content[0].text, /2 forms waiting/);
});

test("with background switched off a stale call carrying the flag blocks", async () => {
	const host = boot(undefined, { background: false });
	await start(host, "startup");
	const pending = host.askInBackground();
	await tick();
	assert.equal(host.forms.length, 1);
	assert.equal(host.journal()[0].mode, "foreground");
	host.forms[0]?.press(...SUBMIT_TWO);
	assert.equal((await pending).details.status, "submitted");
	assert.equal(host.panelText(), "");
});

test("hosts without the TUI block on a background call or report unavailable", async () => {
	const rpc = boot(undefined, { mode: "rpc" });
	await start(rpc, "startup");
	const cards: string[] = [];
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: {
			select: (title: string, options: string[]) => {
				cards.push(title);
				return Promise.resolve(
					options.find((option) => option.includes("Submit")) ?? options[0]
				);
			},
		},
	};
	const response = await rpc.tools[0].execute(
		"call-1",
		{ ...ONE("x"), background: true },
		undefined,
		() => {},
		ctx
	);
	assert.equal(response.details.status, "submitted");
	assert.ok(cards.length >= 2, "the card flow ran to its review card");
	assert.deepEqual(kinds(rpc), ["form", "outcome"]);
	assert.equal(rpc.journal()[0].mode, "foreground");
	assert.equal(rpc.widgets.size, 0);

	const json = boot(undefined, { mode: "json" });
	const unavailable = await json.tools[0].execute(
		"call-1",
		{ ...PARAMS, background: true },
		undefined,
		() => {},
		{ mode: "json", hasUI: false }
	);
	assert.equal(unavailable.details.status, "unavailable");
	assert.deepEqual(kinds(json), ["form", "outcome"]);
});

// --- The panel -------------------------------------------------------------

test("the panel sits above the editor, which keeps its text and its keyboard", async () => {
	const host = boot();
	await start(host, "startup");
	host.type("d", "r", "a", "f", "t");
	await host.askInBackground();

	assert.match(host.panelText(), /Which database\?/);
	assert.equal(host.widgets.get("pi-ask:panel")?.placement, "aboveEditor");
	assert.ok(host.focusIs("editor"), "a message in progress keeps the keyboard");
	host.type("!", KEY.enter);
	assert.equal(host.editor.text, `draft!${KEY.enter}`, "ordinary input still works");
	assert.deepEqual(kinds(host), ["form"], "typing did not touch the form");

	// One key moves the keyboard into the panel and back.
	host.type(KEY.focus);
	assert.ok(host.focusIs("panel"));
	host.type(KEY.enter);
	assert.equal(host.journal().at(-1).kind, "draft");
	assert.equal(host.editor.text, `draft!${KEY.enter}`, "the draft message is intact");
	host.type(KEY.focus);
	assert.ok(host.focusIs("editor"));
	assert.match(host.panelText(), /answer here/);
});

test("a new form takes the keyboard when no message is being written", async () => {
	const { host } = await withBackgroundForm();
	assert.ok(host.focusIs("panel"));
	assert.match(host.panelText(), /hide/);
	assert.match(host.panelText(), /cancel form/);
});

test("hiding cancels nothing, survives a reload, and only the user reopens", async () => {
	const { host, requestId } = await withBackgroundForm();
	host.type(KEY.enter, KEY.escape);
	assert.equal(host.panelText(), "");
	assert.ok(host.focusIs("editor"));
	assert.deepEqual(kinds(host), ["form", "draft", "panel"]);
	assert.match(host.indicator() ?? "", /1 unanswered question in 1 form/);
	assert.match(host.indicator() ?? "", /\/ask-panel/);

	// A new request neither reopens the panel nor takes the keyboard.
	const second = await host.askInBackground(ONE("x"));
	assert.equal(second.details.pending, 2);
	assert.equal(host.panelText(), "");
	assert.ok(host.focusIs("editor"));
	assert.equal(host.notices.length, 1);
	assert.match(host.indicator() ?? "", /2 unanswered questions in 2 forms/);
	host.type("h", "i");
	assert.equal(host.editor.text, "hi");

	// Still hidden for a later process on the same branch.
	const later = boot(host.session);
	await start(later);
	assert.equal(later.panelText(), "");
	assert.ok(later.focusIs("editor"));
	assert.match(later.indicator() ?? "", /2 unanswered questions in 2 forms/);

	await later.command("ask-panel");
	assert.ok(later.focusIs("panel"));
	assert.match(later.panelText(), /Which cache\?/, "the draft came back");
	later.type(KEY.enter, KEY.enter);
	await tick();
	assert.equal(later.sent[0]?.message.details.requestId, requestId);
	assert.match(later.panelText(), /Pick x\?/, "the next form follows");
});

test("the focus key reopens a hidden panel; with nothing waiting it is an ordinary key", async () => {
	const host = boot();
	await start(host, "startup");
	host.type(KEY.focus);
	assert.equal(host.editor.text, KEY.focus, "passed through to the editor");
	await host.command("ask-panel");
	assert.deepEqual(host.notices, ["No questions are waiting"]);

	host.editor.text = "";
	await host.askInBackground();
	host.type(KEY.later);
	assert.equal(host.panelText(), "", "the later key hides the panel too");
	host.type(KEY.focus);
	assert.ok(host.focusIs("panel"));
	assert.deepEqual(kinds(host), ["form", "panel", "panel"]);
	assert.equal(host.journal().at(-1).hidden, false);
});

test("the pending indicator counts unanswered questions and clears", async () => {
	const { host } = await withBackgroundForm();
	assert.match(host.indicator() ?? "", /2 unanswered questions in 1 form/);
	assert.equal(host.widgets.get("pi-ask:pending")?.placement, "belowEditor");
	host.type(KEY.enter);
	assert.match(host.indicator() ?? "", /1 unanswered question in 1 form/);
	host.type(KEY.enter);
	assert.match(host.indicator() ?? "", /1 form ready to submit/);
	host.type(KEY.enter);
	await tick();
	assert.equal(host.indicator(), undefined);
	assert.equal(host.widgets.size, 0);
	assert.ok(host.focusIs("editor"));
});

test("forms are shown one at a time in request order, across defer and reopen", async () => {
	const host = boot();
	await start(host, "startup");
	await host.askInBackground(ONE("a"));
	// B is asked second as a blocking form and deferred; C arrives after.
	const blocking = host.ask(ONE("b"));
	await tick();
	host.forms[0]?.press(KEY.down, KEY.later);
	const deferred = await blocking;
	assert.equal(deferred.details.status, "deferred");
	await host.askInBackground(ONE("c"));
	const [a, b, c] = ids(host);

	assert.match(host.panelText(), /Pick a\?/);
	assert.doesNotMatch(host.panelText(), /Pick [bc]\?/);

	// A later process rebuilds the same order from the branch.
	const later = boot(host.session);
	await start(later);
	await later.command("ask-panel");
	const order: string[] = [];
	for (const expected of ["a", "b", "c"]) {
		assert.match(later.panelText(), new RegExp(`Pick ${expected}\\?`));
		later.type(...SUBMIT_ONE);
		await tick();
		later.recordWake();
		order.push(later.answers().at(-1).details.requestId);
		later.settle();
	}
	assert.deepEqual(order, [a, b, c]);
	assert.equal(later.panelText(), "");
});

// --- Defer -----------------------------------------------------------------

test("answer later returns a deferred receipt and keeps the draft for the panel", async () => {
	const host = boot();
	await start(host, "startup");
	const pending = host.ask();
	await tick();
	assert.match(host.forms[0]?.render() ?? "", /answer later/);
	host.forms[0]?.press(KEY.enter, KEY.later);
	const response = await pending;

	assert.equal(response.details.status, "deferred");
	assert.deepEqual(response.details.answers, {}, "a receipt carries no answers");
	assert.match(response.content[0].text, /not an answer or approval/);
	assert.match(response.content[0].text, /Do not ask again/);
	assert.deepEqual(kinds(host), ["form", "draft", "defer"]);

	// In the panel, unfocused: "later" means the keyboard goes to the input.
	assert.match(host.panelText(), /Which cache\?/);
	assert.ok(host.focusIs("editor"));
	assert.equal(host.sent.length, 0);

	host.type(KEY.focus, KEY.enter, KEY.enter);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.deepEqual(host.sent[0]?.options, { triggerTurn: true });
	assert.equal(host.sent[0]?.message.details.requestId, response.details.requestId);
	assert.deepEqual(
		host.sent[0]?.message.details.result.answers.db.values,
		["postgres"]
	);
});

test("answer later is not offered where there is no queue to move to", async () => {
	const host = fakePi();
	registerAskTool(host.pi);
	const pending = host.tools[0].execute("c", PARAMS, undefined, () => {}, host.ctx);
	await tick();
	assert.doesNotMatch(host.forms[0]?.render() ?? "", /answer later/);
	host.forms[0]?.press(KEY.later, ...SUBMIT_TWO);
	assert.equal((await pending).details.status, "submitted");
});

// --- Ownership -------------------------------------------------------------

test("a blocking call takes the keyboard from an open background form and gives it back", async () => {
	const { host, requestId } = await withBackgroundForm();
	host.type(KEY.enter);
	assert.ok(host.focusIs("panel"));

	const blocking = host.ask(ONE("urgent"));
	await tick();
	assert.equal(host.panelText(), "", "only one form is on screen");
	assert.ok(host.focusIs("form"));
	// Every key reaches the blocking form: no listener or panel swallows it.
	host.type(KEY.focus);
	host.type(...SUBMIT_ONE);
	const response = await blocking;
	assert.equal(response.details.status, "submitted");
	assert.deepEqual(response.details.answers.urgent.values, ["yes"]);

	// The background form is back as it was, with the keyboard.
	assert.match(host.panelText(), /Which cache\?/);
	assert.ok(host.focusIs("panel"));
	host.type(KEY.enter, KEY.enter);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.equal(host.sent[0]?.message.details.requestId, requestId);
});

test("a blocking form open in this process is never queued as interrupted", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	host.emit("session_tree");
	await start(host, "reload");
	assert.equal(host.forms.length, 1);
	assert.equal(host.panelText(), "");
	assert.equal(host.indicator(), undefined);

	host.forms[0]?.press(...SUBMIT_TWO);
	assert.equal((await pending).details.status, "submitted");
	assert.deepEqual(host.sent, []);
});

// --- Delivery --------------------------------------------------------------

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

// --- Recovery and branches -------------------------------------------------

test("an interrupted form comes back in the panel with its draft and is answered once", async () => {
	const session = await interruptedSession();
	const host = boot(session);
	const returned = host.emit("session_start", { reason: "resume" });
	assert.deepEqual(returned, [undefined], "the handler returns at once");
	await tick();

	assert.equal(host.forms.length, 0, "recovery does not block the input");
	assert.match(host.panelText(), /Which cache\?/, "DB came back from the draft");
	assert.ok(host.focusIs("editor"), "a rebuild never takes the keyboard");
	assert.equal(host.notices.length, 1);
	assert.equal(host.sent.length, 0);

	host.type(KEY.focus, KEY.enter, KEY.enter);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.match(host.sent[0]?.message.content ?? "", /db "Which database\?": Postgres/);
	assert.match(host.sent[0]?.message.content ?? "", /cache "Which cache\?": Redis/);
	assert.deepEqual(kinds(host), ["form", "draft", "draft", "outcome"]);
});

test("a form the conversation moved past is not brought back", async () => {
	const session = await interruptedSession();
	session.appendMessage({ role: "user", content: "never mind", timestamp: Date.now() });
	const host = boot(session);
	await start(host);
	assert.equal(host.panelText(), "");
	assert.equal(host.indicator(), undefined);
	assert.deepEqual(host.sent, []);
});

test("a form from another branch is not shown and writes nothing", async () => {
	const session = SessionManager.inMemory();
	const rootId = session.appendMessage({
		role: "user",
		content: "start",
		timestamp: Date.now(),
	});
	const first = boot(session);
	await start(first, "startup");
	await first.askInBackground();
	first.type(KEY.enter);
	assert.equal(first.journal().length, 2);

	// Branch B forks from before the form was asked.
	session.branch(rootId);
	session.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
	const host = boot(session);
	await start(host);
	host.emit("session_tree");
	await tick();
	assert.equal(host.panelText(), "");
	assert.equal(host.indicator(), undefined);
	assert.deepEqual(host.sent, []);
	assert.deepEqual(host.journal(), []);
});

test("a stale form cannot write into the branch the user moved to", async () => {
	const session = SessionManager.inMemory();
	const rootId = session.appendMessage({
		role: "user",
		content: "start",
		timestamp: Date.now(),
	});
	const host = boot(session);
	await start(host, "startup");
	await host.askInBackground();
	// Keep hold of the form as it is on screen, as a late callback would.
	const stale = host.widgets.get("pi-ask:panel")?.component;
	assert.ok(stale);
	const handleInput = stale.handleInput?.bind(stale);

	session.branch(rootId);
	host.emit("session_tree");
	assert.equal(host.panelText(), "", "the panel follows the branch at once");
	for (const key of SUBMIT_TWO) {
		handleInput?.(key);
	}
	host.type(KEY.focus, ...SUBMIT_TWO);
	await tick();

	assert.deepEqual(host.sent, []);
	assert.deepEqual(host.journal(), [], "nothing was written into this branch");
	assert.equal(host.turnEnd().entries.length, 0);

	// Back on the original branch the form is still waiting, unanswered.
	const original = boot(session);
	session.branch(session.getEntries().at(-1)?.id ?? rootId);
	await start(original);
	assert.deepEqual(original.sent, []);
});

test("the queue is TUI-only and a torn-down runtime writes nothing", async () => {
	const session = await interruptedSession();
	const rpc = boot(session, { mode: "rpc" });
	await start(rpc);
	assert.equal(rpc.widgets.size, 0);
	assert.deepEqual(rpc.sent, []);

	const host = boot(session);
	await start(host);
	assert.match(host.panelText(), /Which cache\?/);
	const panel = host.widgets.get("pi-ask:panel")?.component;
	host.emit("session_shutdown", { reason: "quit" });
	assert.equal(host.widgets.size, 0);
	panel?.handleInput?.(KEY.enter);
	panel?.handleInput?.(KEY.enter);
	host.type(KEY.focus);
	await tick();
	assert.deepEqual(host.sent, []);
	assert.deepEqual(kinds(host), ["form", "draft"]);
	assert.equal(host.turnEnd().entries.length, 0);
});
