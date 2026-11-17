import assert from "node:assert/strict";
import test from "node:test";
import {
	type AskPanelEvent,
	type AskPanelState,
	EMPTY_PANEL,
	panelTakesFocusKey,
	panelView,
	reducePanel,
} from "../src/state/panel.ts";

function run(events: AskPanelEvent[], from: AskPanelState = EMPTY_PANEL) {
	return events.reduce(reducePanel, from);
}

const arrive = (queue: string[], focus = true): AskPanelEvent => ({
	type: "arrived",
	queue,
	focus,
});

test("an empty queue shows nothing and owns no key", () => {
	assert.deepEqual(panelView(EMPTY_PANEL), { visible: false, focused: false });
	assert.equal(panelTakesFocusKey(EMPTY_PANEL), false);
	assert.equal(reducePanel(EMPTY_PANEL, { type: "toggleFocus" }), EMPTY_PANEL);
	assert.equal(reducePanel(EMPTY_PANEL, { type: "reopen" }), EMPTY_PANEL);
});

test("only the head of the queue is shown, in request order", () => {
	const state = run([arrive(["a"]), arrive(["a", "b"]), arrive(["a", "b", "c"])]);
	assert.deepEqual(panelView(state), { visible: true, formId: "a", focused: true });
	const next = reducePanel(state, { type: "removed", queue: ["b", "c"] });
	assert.equal(panelView(next).formId, "b");
});

test("a new request takes focus only when it opens the panel and is allowed to", () => {
	assert.equal(panelView(run([arrive(["a"], true)])).focused, true);
	assert.equal(panelView(run([arrive(["a"], false)])).focused, false);
	// The panel already shows a form: its focus is the user's, either way.
	const typing = run([arrive(["a"], false), arrive(["a", "b"], true)]);
	assert.equal(panelView(typing).focused, false);
	const answering = run([arrive(["a"], true), arrive(["a", "b"], false)]);
	assert.equal(panelView(answering).focused, true);
});

test("a hidden panel does not reopen or take focus when a request arrives", () => {
	const state = run([arrive(["a"]), { type: "hide" }, arrive(["a", "b"], true)]);
	assert.deepEqual(panelView(state), { visible: false, focused: false });
	assert.equal(state.hidden, true);
	assert.deepEqual(state.queue, ["a", "b"]);
	// Only the user brings it back, by command or by the focus key.
	assert.deepEqual(panelView(reducePanel(state, { type: "reopen" })), {
		visible: true,
		formId: "a",
		focused: true,
	});
	assert.deepEqual(panelView(reducePanel(state, { type: "toggleFocus" })), {
		visible: true,
		formId: "a",
		focused: true,
	});
});

test("the focus key switches between the panel and the input", () => {
	const focused = run([arrive(["a"])]);
	const blurred = reducePanel(focused, { type: "toggleFocus" });
	assert.equal(panelView(blurred).focused, false);
	assert.equal(panelView(blurred).visible, true);
	assert.equal(panelView(reducePanel(blurred, { type: "toggleFocus" })).focused, true);
});

test("a rebuild restores the queue and visibility but never takes the keyboard", () => {
	const focused = run([arrive(["a"])]);
	const rebuilt = reducePanel(focused, { type: "sync", queue: ["a", "b"], hidden: false });
	assert.deepEqual(panelView(rebuilt), { visible: true, formId: "a", focused: false });
	const hidden = reducePanel(focused, { type: "sync", queue: ["a"], hidden: true });
	assert.equal(panelView(hidden).visible, false);
});

test("a blocking form owns the keyboard: the panel leaves and returns as it was", () => {
	const focused = run([arrive(["a"])]);
	const blocked = reducePanel(focused, { type: "foregroundOpened" });
	assert.deepEqual(panelView(blocked), { visible: false, focused: false });
	assert.equal(panelTakesFocusKey(blocked), false, "the focus key is not ours");
	assert.equal(reducePanel(blocked, { type: "toggleFocus" }), blocked);
	// Requests that arrive meanwhile queue up behind the blocking form.
	const queued = reducePanel(blocked, arrive(["a", "b"]));
	assert.equal(panelView(queued).visible, false);

	const nested = run([{ type: "foregroundOpened" }, { type: "foregroundClosed" }], queued);
	assert.equal(panelView(nested).visible, false, "one blocking form is still open");
	const back = reducePanel(nested, { type: "foregroundClosed" });
	assert.deepEqual(panelView(back), { visible: true, formId: "a", focused: true });
	assert.equal(reducePanel(back, { type: "foregroundClosed" }).foreground, 0);
});

test("focus the host took away stays away; an emptied queue holds none", () => {
	const blurred = run([arrive(["a"]), { type: "blurred" }]);
	assert.equal(panelView(blurred).focused, false);
	// A dialog over the panel closed and the host handed the keyboard back.
	assert.equal(panelView(reducePanel(blurred, { type: "refocused" })).focused, true);
	const hidden = run([{ type: "hide" }, { type: "refocused" }], blurred);
	assert.equal(hidden.focused, false, "an off-screen panel holds no focus");
	const emptied = run([arrive(["a"]), { type: "removed", queue: [] }]);
	assert.equal(emptied.focused, false);
	assert.deepEqual(panelView(emptied), { visible: false, focused: false });
});
