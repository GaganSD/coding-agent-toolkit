import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import { KEY, quietConfig, tick } from "./support/fake-pi.ts";
import {
	boot,
	start,
	kinds,
	PARAMS,
	SUBMIT_TWO,
	interruptedSession,
} from "./support/background.ts";

beforeEach(quietConfig);

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

const TEXT_FORM = {
	title: "Notes",
	questions: [{ id: "dir", label: "DIR", prompt: "Which directory?", type: "text" }],
};

test("text typed in an editor survives a restart, written once typing pauses", async () => {
	const host = boot();
	await start(host, "startup");
	await host.askInBackground(TEXT_FORM);
	assert.ok(host.focusIs("panel"), "a new form takes the idle keyboard");

	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		host.type(..."src/ui");
		assert.deepEqual(kinds(host), ["form"], "keystrokes are not written one by one");
		mock.timers.tick(5000);
	} finally {
		mock.timers.reset();
	}
	assert.deepEqual(kinds(host), ["form", "draft"], "one draft for the burst");

	// A key that ends the typing writes at once, with the text folded in.
	host.type("/");
	host.type(KEY.escape);
	assert.deepEqual(kinds(host), ["form", "draft", "draft"]);

	const later = boot(host.session);
	await start(later);
	await later.command("ask-panel");
	assert.match(later.panelText(), /src\/ui\//, "the unfinished answer came back");
});

test("an editor still open when Pi quits is journalled on dispose", async () => {
	const host = boot();
	await start(host, "startup");
	await host.askInBackground(TEXT_FORM);
	host.type(..."draft text");
	assert.deepEqual(kinds(host), ["form"]);
	host.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(kinds(host), ["form", "draft"]);

	const later = boot(host.session);
	await start(later);
	await later.command("ask-panel");
	assert.match(later.panelText(), /draft text/);
});

test("a tree move rebuilds a kept form from the branch, dropping rolled-back answers", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
	const host = boot(session);
	await start(host, "startup");
	await host.askInBackground();
	const formEntry = session.getBranch().at(-1)?.id;
	assert.ok(formEntry);
	host.type(KEY.enter);
	assert.match(host.panelText(), /Which cache\?/, "DB answered, cache is next");
	assert.deepEqual(kinds(host), ["form", "draft"]);

	// Back to the moment the form was asked: the answer is not on this branch.
	session.branch(formEntry);
	host.emit("session_tree");
	await tick();
	assert.deepEqual(kinds(host), ["form"]);
	assert.match(host.panelText(), /Which database\?/, "the rolled-back answer is gone");
	assert.ok(host.focusIs("editor"), "a rebuild never takes the keyboard");

	host.type(KEY.focus, ...SUBMIT_TWO);
	await tick();
	assert.match(host.sent[0]?.message.content ?? "", /db "Which database\?": Postgres/);
	assert.deepEqual(kinds(host), ["form", "draft", "draft", "outcome"]);
});

test("a tree move to the same branch keeps the form, with its unsent text", async () => {
	const host = boot();
	await start(host, "startup");
	await host.askInBackground(TEXT_FORM);
	host.type(..."keep");
	host.emit("session_tree");
	await tick();
	assert.match(host.panelText(), /keep/);
	host.type(KEY.focus, ..."me");
	assert.match(host.panelText(), /keepme/);
});

test("a form rebuilt after a tree move does not notify the user again", async () => {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { channels: ["bell"], enabled: true },
	});
	const bells = () => writes.mock.calls.filter((call) => call.arguments[0] === "\x07").length;
	const writes = mock.method(process.stdout, "write", () => true);
	try {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		const host = boot(session);
		await start(host, "startup");
		await host.askInBackground();
		await tick();
		assert.equal(bells(), 1, "the user is told once, when the form first appears");
		const formEntry = session.getBranch().at(-1)?.id;
		assert.ok(formEntry);
		host.type(KEY.enter);

		session.branch(formEntry);
		host.emit("session_tree");
		await tick();
		assert.match(host.panelText(), /Which database\?/, "the form was rebuilt");
		assert.equal(bells(), 1, "a rebuilt form is not announced again");
	} finally {
		writes.mock.restore();
	}
});

test("a blocking form's last keystrokes are journalled on shutdown", async () => {
	const host = boot();
	await start(host, "startup");
	const pending = host.ask(TEXT_FORM);
	pending.catch(() => {});
	await tick();
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		host.forms[0]?.press(..."src/ui");
		assert.deepEqual(kinds(host), ["form"], "typing waits for the pause");
		// Pi quits before the typing timer fires.
		host.emit("session_shutdown", { reason: "quit" });
		assert.deepEqual(kinds(host), ["form", "draft"]);
		mock.timers.tick(5000);
	} finally {
		mock.timers.reset();
	}
	assert.deepEqual(kinds(host), ["form", "draft"], "nothing is written twice");

	const later = boot(host.session);
	await start(later);
	await later.command("ask-panel");
	assert.match(later.panelText(), /src\/ui/, "the unfinished answer came back");
});

test("a finished blocking form is not flushed again on shutdown", async () => {
	const host = boot();
	await start(host, "startup");
	const pending = host.ask(PARAMS);
	await tick();
	host.forms[0]?.press(...SUBMIT_TWO);
	await pending;
	const before = kinds(host);
	host.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(kinds(host), before);
});
