import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "../src/ask-tool.ts";
import { EXPIRED_OFFER_MS, registerAskBackground } from "../src/background.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import { createAskRuntime } from "../src/runtime.ts";
import { fakeClock } from "./support/fake-clock.ts";
import { fakePi, KEY, quietConfig, tick } from "./support/fake-pi.ts";

const DB = {
	id: "db",
	label: "DB",
	prompt: "Which database?",
	options: [
		{ value: "pg", label: "Postgres" },
		{ value: "sqlite", label: "SQLite" },
	],
};
const CACHE = {
	id: "cache",
	label: "Cache",
	prompt: "Which cache?",
	options: [
		{ value: "redis", label: "Redis" },
		{ value: "none", label: "None" },
	],
};
const TIMED = {
	title: "Storage",
	timeoutSeconds: 60,
	questions: [{ ...DB, fallback: "sqlite" }, CACHE],
};
const PLAIN = { title: "Plain", questions: [DB] };
const SECOND = 1000;

function boot(
	options: {
		clock?: ReturnType<typeof fakeClock>;
		expiry?: boolean;
		session?: SessionManager;
	} = {}
) {
	const time = options.clock ?? fakeClock();
	const host = fakePi(options.session);
	const runtime = createAskRuntime(host.pi, time.clock);
	registerAskBackground(host.pi, runtime);
	registerAskTool(host.pi, {
		runtime,
		features: { background: true, expiry: options.expiry ?? true },
	});
	let calls = 0;
	const ask = (params: object) =>
		host.tools[0].execute(`call-${++calls}`, params, undefined, () => {}, host.ctx);
	const askInBackground = (params: object) => ask({ ...params, background: true });
	return { ...host, host, time, ask, askInBackground };
}

type Host = ReturnType<typeof boot>;

async function start(host: Host, reason = "startup") {
	host.emit("session_start", { reason });
	await tick();
}

const kinds = (host: Host) => host.journal().map((entry) => entry.kind);
const outcomes = (host: Host) =>
	host.journal().filter((entry) => entry.kind === "outcome");

/** A started process with a timed background form on screen. */
async function withTimedPanel(params: object = TIMED) {
	const host = boot();
	await start(host);
	const receipt = await host.askInBackground(params);
	await tick();
	return { host, requestId: receipt.details.requestId as string };
}

beforeEach(quietConfig);

// --- Blocking forms --------------------------------------------------------

test("a blocking form counts down on screen and expires to its declared fallback", async () => {
	const host = boot();
	const pending = host.ask(TIMED);
	await tick();
	const text = host.forms[0]?.render() ?? "";
	assert.match(text, /No reply in 1:00/);
	assert.match(text, /Press any key to stop/);
	assert.match(text, /SQLite \(fallback\)/);
	assert.doesNotMatch(text, /Postgres \(fallback\)/);

	host.time.advance(59 * SECOND);
	assert.match(host.forms[0]?.render() ?? "", /No reply in 0:01/);
	host.time.advance(SECOND);
	const response = await pending;

	assert.equal(response.details.status, "expired");
	assert.deepEqual(response.details.expired, ["db"]);
	assert.deepEqual(response.details.answers.db.values, ["sqlite"]);
	assert.deepEqual(response.details.unanswered, ["cache"]);
	const result = response.content[0].text;
	assert.match(result, /DB: SQLite \[fallback/);
	assert.match(result, /Cache: \(no answer\)/);
	assert.match(result, /did not respond/);
	assert.match(result, /own assumption, not user approval/);
	assert.match(result, /irreversible and risky actions blocked/);
	assert.equal(outcomes(host).at(-1)?.channel, "tool");
	assert.equal(host.time.pending, 0, "no timer is left behind");
	assert.equal(host.sent.length, 0, "a blocking form needs no follow-up");
});

test("timeoutSeconds below the floor is raised to it, not rejected", async () => {
	const host = boot();
	const pending = host.ask({ ...TIMED, timeoutSeconds: 5 });
	await tick();
	assert.equal(host.journal()[0].form.timeoutSeconds, 30);
	host.time.advance(29 * SECOND);
	assert.equal(host.forms.length, 1);
	let settled = false;
	pending.then(() => {
		settled = true;
	});
	await tick();
	assert.equal(settled, false);
	host.time.advance(SECOND);
	assert.equal((await pending).details.status, "expired");
});

test("the configured floor applies, and a longer request is kept", async () => {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
		expiry: { enabled: true, minSeconds: 120 },
	});
	const host = boot();
	host.ask({ ...TIMED, timeoutSeconds: 45 }).catch(() => {});
	host.ask({ ...TIMED, timeoutSeconds: 300 }).catch(() => {});
	await tick();
	assert.deepEqual(
		host.journal().map((entry) => entry.form.timeoutSeconds),
		[120, 300]
	);
});

test("one key stops the countdown for good and the form then waits", async () => {
	const host = boot();
	const pending = host.ask(TIMED);
	await tick();
	host.time.advance(10 * SECOND);
	host.forms[0]?.press(KEY.down);
	assert.match(host.forms[0]?.render() ?? "", /Countdown stopped/);
	assert.doesNotMatch(host.forms[0]?.render() ?? "", /\(fallback\)/);
	assert.ok(kinds(host).includes("expiry"));
	assert.equal(host.journal().find((entry) => entry.kind === "expiry").reason, "interaction");
	assert.equal(host.time.pending, 0);

	host.time.advance(24 * 60 * 60 * SECOND);
	let settled = false;
	pending.then(() => {
		settled = true;
	});
	await tick();
	assert.equal(settled, false, "an hour of silence later it still waits");

	host.forms[0]?.press(KEY.enter, KEY.enter, KEY.enter);
	assert.equal((await pending).details.status, "submitted");
});

test("the clock waits for the notification before it starts", async () => {
	const host = boot();
	host.ask(TIMED).catch(() => {});
	// The form is on screen but the notification has not fired yet.
	assert.equal(host.time.pending, 0);
	await tick();
	assert.equal(host.time.pending, 1);
});

test("a question with no declared fallback expires with nothing applied", async () => {
	const host = boot();
	const pending = host.ask({ ...PLAIN, timeoutSeconds: 30 });
	await tick();
	assert.match(host.forms[0]?.render() ?? "", /Times out in 0:30 with no answer applied/);
	host.time.advance(30 * SECOND);
	const response = await pending;
	assert.equal(response.details.status, "expired");
	assert.deepEqual(response.details.expired, []);
	assert.deepEqual(response.details.answers, {});
	assert.match(response.content[0].text, /No fallback was applied/);
});

test("an invalid fallback is rejected as invalid", async () => {
	const host = boot();
	const response = await host.ask({
		timeoutSeconds: 60,
		questions: [{ ...DB, fallback: "mysql" }],
	});
	assert.equal(response.details.status, "invalid");
	assert.equal(host.forms.length, 0);
});

// --- Expiry switched off ---------------------------------------------------

test("with expiry disabled the fields leave the schema and a stale call waits", async () => {
	const host = boot({ expiry: false });
	const props = host.tools[0].parameters.properties;
	assert.ok(!("timeoutSeconds" in props));
	assert.ok(!("fallback" in props.questions.items.properties));

	const pending = host.ask(TIMED);
	await tick();
	assert.doesNotMatch(host.forms[0]?.render() ?? "", /countdown|fallback/i);
	assert.equal(host.journal()[0].form.timeoutSeconds, undefined);
	assert.equal(host.time.pending, 0);
	host.time.advance(24 * 60 * 60 * SECOND);
	host.forms[0]?.press(KEY.enter, KEY.enter, KEY.enter);
	assert.equal((await pending).details.status, "submitted");
});

test("switching expiry off in the live config stops new countdowns at once", async () => {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
		expiry: { enabled: false, minSeconds: 30 },
	});
	const host = boot();
	host.ask(TIMED).catch(() => {});
	await tick();
	assert.equal(host.time.pending, 0);
	assert.doesNotMatch(host.forms[0]?.render() ?? "", /countdown/i);
});

// --- Background forms ------------------------------------------------------

test("a background form that nobody answers expires, wakes the idle agent and says so", async () => {
	const { host, requestId } = await withTimedPanel();
	assert.match(host.panelText(), /No reply in 1:00/);
	assert.match(host.panelText(), /SQLite \(fallback\)/);

	host.time.advance(60 * SECOND);
	const [message] = host.sent;
	assert.equal(message?.options?.triggerTurn, true, "an expiry wakes an idle agent");
	assert.match(message?.message.content ?? "", new RegExp(requestId));
	assert.match(message?.message.content ?? "", /timed out/);
	assert.match(message?.message.content ?? "", /db "Which database\?": SQLite \[sqlite\] \[fallback/);
	assert.match(message?.message.content ?? "", /not user approval/);
	assert.equal(message?.message.details.result.status, "expired");
	assert.deepEqual(message?.message.details.result.expired, ["db"]);
	assert.equal(outcomes(host).at(-1)?.channel, "message");
	assert.equal(host.panelText(), "", "the expired form left the panel");
	assert.equal(host.time.pending, 0);

	// It is not delivered a second time.
	host.recordWake();
	host.settle();
	await start(host, "reload");
	assert.equal(host.sent.length, 1);
});

test("an expiry reaches a working agent at its next turn boundary", async () => {
	const { host } = await withTimedPanel();
	host.setIdle(false);
	host.time.advance(60 * SECOND);
	assert.equal(host.sent.length, 0, "nothing interrupts a running turn");
	host.turnEnd();
	assert.equal(host.answers().length, 1);
	assert.match(host.answers()[0].content, /timed out/);
});

test("a key in the panel stops its countdown", async () => {
	const { host } = await withTimedPanel();
	assert.ok(host.focusIs("panel"));
	host.time.advance(10 * SECOND);
	host.type(KEY.down);
	assert.match(host.panelText(), /Countdown stopped/);
	host.time.advance(60 * 60 * SECOND);
	assert.equal(host.sent.length, 0);
	assert.equal(outcomes(host).length, 0);
	assert.equal(host.journal().find((entry) => entry.kind === "expiry").reason, "interaction");
});

test("typing in the editor beside an unfocused panel does not stop it", async () => {
	const host = boot();
	await start(host);
	host.editor.text = "half a message";
	await host.askInBackground(TIMED);
	await tick();
	assert.ok(host.focusIs("editor"));
	host.type("x");
	host.time.advance(60 * SECOND);
	assert.equal(host.sent.length, 1, "the form expired");
});

test("focusing the panel on purpose counts as being there", async () => {
	const host = boot();
	await start(host);
	host.editor.text = "half a message";
	await host.askInBackground(TIMED);
	await tick();
	host.time.advance(10 * SECOND);
	host.type(KEY.focus);
	assert.match(host.panelText(), /Countdown stopped/);
	host.time.advance(60 * 60 * SECOND);
	assert.equal(host.sent.length, 0);
});

test("a form queued behind another does not count down until it is shown", async () => {
	const host = boot();
	await start(host);
	await host.askInBackground(PLAIN);
	await host.askInBackground({ ...TIMED, title: "Timed", timeoutSeconds: 30 });
	await tick();
	assert.match(host.panelText(), /Plain/);
	assert.equal(host.time.pending, 0, "the queued form has no clock yet");
	host.time.advance(10 * 60 * SECOND);
	assert.equal(host.sent.length, 0);

	// Answering the first brings the second up with its full limit.
	host.type(KEY.enter, KEY.enter);
	await tick();
	host.recordWake();
	host.settle();
	assert.match(host.panelText(), /Timed/);
	assert.match(host.panelText(), /No reply in 0:30/);
	host.time.advance(30 * SECOND);
	assert.equal(host.sent.length, 2);
	assert.match(host.sent[1]?.message.content ?? "", /timed out/);
});

test("a hidden panel does not count down, and hiding a running clock ends it", async () => {
	const host = boot();
	await start(host);
	host.editor.text = "typing";
	host.setIdle(false);
	await host.askInBackground(TIMED);
	await tick();
	assert.equal(host.time.pending, 1);
	host.type(KEY.focus, KEY.later);
	assert.equal(host.panelText(), "", "hidden");
	assert.equal(host.time.pending, 0);
	host.time.advance(10 * 60 * SECOND);
	assert.equal(host.sent.length, 0);
	assert.equal(outcomes(host).length, 0);

	// Bringing it back later gives it no new clock.
	host.command("ask-panel");
	assert.match(host.panelText(), /Countdown stopped/);
	host.time.advance(60 * 60 * SECOND);
	assert.equal(outcomes(host).length, 0);
});

test("a blocking form that takes over the keyboard stops the panel's countdown", async () => {
	const host = boot();
	await start(host);
	host.editor.text = "typing";
	await host.askInBackground(TIMED);
	await tick();
	assert.equal(host.time.pending, 1);
	const blocking = host.ask(PLAIN);
	await tick();
	assert.equal(host.time.pending, 0, "the hidden panel form stopped");
	host.forms[0]?.press(KEY.enter, KEY.enter);
	await blocking;
	host.time.advance(60 * 60 * SECOND);
	assert.equal(outcomes(host).filter((entry) => entry.channel === "message").length, 0);
	assert.equal(host.journal().filter((entry) => entry.kind === "expiry")[0].reason, "hidden");
});

test("a form recovered after a restart never counts down", async () => {
	const first = await withTimedPanel();
	first.host.emit("session_shutdown");
	const second = boot({ clock: first.host.time, session: first.host.session });
	await start(second, "resume");
	assert.match(second.panelText(), /Storage/);
	assert.doesNotMatch(second.panelText(), /countdown|No reply/i);
	assert.equal(second.time.pending, 0);
	second.time.advance(24 * 60 * 60 * SECOND);
	assert.equal(second.sent.length, 0);
	assert.equal(outcomes(second).length, 0);
});

test("timers are released on shutdown", async () => {
	const { host } = await withTimedPanel();
	assert.equal(host.time.pending, 1);
	host.emit("session_shutdown");
	assert.equal(host.time.pending, 0);
});

// --- Late override ---------------------------------------------------------

async function expiredBackgroundForm() {
	const { host, requestId } = await withTimedPanel();
	host.time.advance(60 * SECOND);
	host.recordWake();
	host.settle();
	return { host, requestId };
}

test("an expired form is offered, reopens on request and a correction is sent once", async () => {
	const { host, requestId } = await expiredBackgroundForm();
	assert.match(host.indicator() ?? "", /1 timed-out form can still be answered/);
	assert.match(host.indicator() ?? "", /\/ask-panel/);
	assert.equal(host.panelText(), "");

	host.command("ask-panel");
	assert.match(host.panelText(), /timed out. Your answer is sent to the agent as a correction/);
	assert.doesNotMatch(host.panelText(), /countdown|No reply/i);
	// Answer DB with Postgres, skip past Cache to the review tab and submit.
	host.type(KEY.enter, "\t");
	assert.equal(host.sent.length, 1, "nothing is sent until the form is submitted");
	host.type(KEY.enter);
	await tick();

	assert.equal(host.sent.length, 2);
	const correction = host.sent[1];
	assert.equal(correction?.options?.triggerTurn, true);
	assert.match(correction?.message.content ?? "", /^CORRECTION: /);
	assert.match(correction?.message.content ?? "", new RegExp(requestId));
	assert.match(correction?.message.content ?? "", /replaces the timed-out result, fallbacks included/);
	assert.match(correction?.message.content ?? "", /db "Which database\?": Postgres \[pg\]/);
	assert.match(correction?.message.content ?? "", /cache "Which cache\?": \(no answer\)/);
	assert.doesNotMatch(correction?.message.content ?? "", /\[fallback/);
	assert.equal(correction?.message.details.correction, true);
	assert.equal(host.panelText(), "");
	assert.equal(host.indicator(), undefined, "the offer is over once corrected");

	host.recordWake();
	host.settle();
	await start(host, "reload");
	host.command("ask-panel");
	assert.equal(host.sent.length, 2, "exactly once, across a reload too");
	assert.ok(host.notices.at(-1)?.includes("No questions are waiting"));
});

test("closing a reopened expired form without an answer ends the offer silently", async () => {
	const { host } = await expiredBackgroundForm();
	host.command("ask-panel");
	host.type(KEY.ctrlC);
	await tick();
	assert.equal(host.sent.length, 1, "no message for a bare dismissal");
	assert.equal(host.indicator(), undefined);
	assert.equal(host.panelText(), "");
	await start(host, "reload");
	assert.equal(host.indicator(), undefined, "still gone after a reload");
	assert.ok(kindsOf(host).includes("dismiss"));
});

const kindsOf = (host: Host) => host.journal().map((entry) => entry.kind);

test("the offer lapses after an hour", async () => {
	const { host } = await expiredBackgroundForm();
	host.time.advance(EXPIRED_OFFER_MS + SECOND);
	host.command("ask-panel");
	assert.ok(host.notices.at(-1)?.includes("No questions are waiting"));
	assert.equal(host.panelText(), "");
});

test("a blocking form that expired can be corrected late too", async () => {
	const host = boot();
	const pending = host.ask(TIMED);
	await tick();
	host.time.advance(60 * SECOND);
	await pending;
	assert.match(host.indicator() ?? "", /timed-out form/);

	host.command("ask-panel");
	host.type(KEY.enter, KEY.enter, KEY.enter);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.match(host.sent[0]?.message.content ?? "", /^CORRECTION: /);
	assert.equal(outcomes(host).at(-1)?.supersedes, outcomes(host)[0].outcomeId);
});
