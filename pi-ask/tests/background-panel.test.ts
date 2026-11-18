import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { KEY, quietConfig, tick } from "./support/fake-pi.ts";
import {
	boot,
	start,
	kinds,
	ids,
	ONE,
	SUBMIT_ONE,
	SUBMIT_TWO,
	withBackgroundForm,
} from "./support/background.ts";

beforeEach(quietConfig);

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

// --- Ownership -------------------------------------------------------------

test("a blocking form leaves pending background typing and its editor intact", async () => {
	const { host } = await withBackgroundForm({
		questions: [{ id: "notes", prompt: "Write notes", type: "text" }],
	});
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		host.type(..."keep-me");
		assert.deepEqual(kinds(host), ["form"], "typing has not been flushed");
		const blocking = host.ask(ONE("urgent"));
		// Let the modal open without advancing the draft debounce.
		await new Promise<void>((resolve) => setImmediate(resolve));
		host.forms.at(-1)?.press(...SUBMIT_ONE);
		await blocking;

		assert.match(host.panelText(), /keep-me/);
		host.type(..."-too", KEY.enter, KEY.enter);
		assert.equal(
			host.sent[0]?.message.details.result.answers.notes.customText,
			"keep-me-too"
		);
	} finally {
		host.emit("session_shutdown");
		mock.timers.reset();
	}
});

test("hide and reopen retain the active option-note editor", async () => {
	const { host } = await withBackgroundForm(ONE("choice"));
	host.type("n", ..."first", KEY.later, KEY.focus);
	assert.match(host.panelText(), /first/);
	// Reopening must keep the note editor, not return to option navigation.
	host.type(..." second", KEY.enter, ...SUBMIT_ONE);
	assert.equal(
		host.sent[0]?.message.details.result.answers.choice.optionNotes.yes,
		"first second"
	);
	host.emit("session_shutdown");
});

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
