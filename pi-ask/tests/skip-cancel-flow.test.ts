import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { registerAskTool } from "../src/ask-tool.ts";
import { registerAskBackground } from "../src/background.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import { createAskRuntime } from "../src/runtime.ts";
import { fakePi, KEY, quietConfig, tick } from "./support/fake-pi.ts";

const choice = (id: string) => ({
	id,
	label: id.toUpperCase(),
	prompt: `Pick ${id}?`,
	options: [
		{ value: "yes", label: "Yes" },
		{ value: "no", label: "No" },
	],
});
const PARAMS = { title: "Plan", questions: [choice("a"), choice("b")] };
const TAB = "\t";

function boot() {
	const host = fakePi();
	const runtime = createAskRuntime(host.pi);
	registerAskBackground(host.pi, runtime);
	registerAskTool(host.pi, {
		runtime,
		features: { background: true, expiry: true },
	});
	let calls = 0;
	const ask = (params: object = PARAMS) =>
		host.tools[0].execute(`call-${++calls}`, params, undefined, () => {}, host.ctx);
	return { ...host, host, ask };
}

const typeText = (press: (...keys: string[]) => void, text: string) =>
	press(...text.split(""));

beforeEach(quietConfig);

test("s skips the current question and the result lists it apart from unanswered", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	const form = host.forms[0];
	form?.press("s");
	assert.match(form?.render() ?? "", /⊘ A/, "the tab is marked");
	assert.match(form?.render() ?? "", /Pick b\?/, "moved on to the next question");
	form?.press(TAB); // leave b unanswered
	const review = form?.render() ?? "";
	assert.match(review, /→ skipped/);
	assert.match(review, /→ unanswered/);
	form?.press(KEY.enter);

	const response = await pending;
	assert.equal(response.details.status, "submitted");
	assert.deepEqual(response.details.skipped, ["a"]);
	assert.deepEqual(response.details.unanswered, ["b"]);
	const text = response.content[0].text;
	assert.match(text, /A: \(skipped by the user\)/);
	assert.match(text, /B: \(no answer\)/);
	assert.match(text, /not approval and not an answer/);
});

test("skipping every question still needs an explicit submit, even with auto-submit on", async () => {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		behaviour: {
			...DEFAULT_ASK_CONFIG.behaviour,
			autoSubmitWhenAnsweredWithoutNotes: true,
		},
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
	const host = boot();
	let settled = false;
	const pending = host.ask().then((response: any) => {
		settled = true;
		return response;
	});
	await tick();
	host.forms[0]?.press("s", "s");
	await tick();
	assert.equal(settled, false, "waiting on the review tab");
	assert.match(host.forms[0]?.render() ?? "", /Review answers/);
	host.forms[0]?.press(KEY.enter);
	const response = await pending;
	assert.deepEqual(response.details.skipped, ["a", "b"]);
	assert.deepEqual(response.details.answers, {});
});

test("the skip key is typed text inside a text editor, not a skip", async () => {
	const host = boot();
	const pending = host.ask({
		questions: [{ id: "why", label: "Why", prompt: "Why?", type: "text" }],
	});
	await tick();
	typeText(host.forms[0]?.press ?? (() => {}), "sc");
	host.forms[0]?.press(KEY.enter, KEY.enter);
	const response = await pending;
	assert.equal(response.details.skipped, undefined);
	assert.equal(response.details.answers.why.customText, "sc");
});

test("c on the review tab opens a comment; sending it cancels with the reason", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	const form = host.forms[0];
	form?.press(TAB, TAB);
	assert.match(form?.render() ?? "", /C cancel with comment/);
	form?.press("c");
	const typing = form?.render() ?? "";
	assert.match(typing, /Why are you cancelling/);
	assert.match(typing, /Enter cancel with comment/);
	typeText(form?.press ?? (() => {}), "wrong repo");
	form?.press(KEY.enter);

	const response = await pending;
	assert.equal(response.details.status, "cancelled");
	assert.equal(response.details.comment, "wrong repo");
	const text = response.content[0].text;
	assert.match(text, /Reason: "wrong repo"/);
	assert.match(text, /Cancellation is not approval; keep risky actions blocked/);
	assert.equal(host.journal().at(-1).result.comment, "wrong repo");
});

test("an empty comment, or Esc, goes back to the review without cancelling", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	const form = host.forms[0];
	form?.press(TAB, TAB, "c", KEY.enter);
	assert.match(form?.render() ?? "", /Review answers/);
	assert.doesNotMatch(form?.render() ?? "", /Why are you cancelling/);
	form?.press("c");
	typeText(form?.press ?? (() => {}), "oops");
	form?.press(KEY.escape);
	assert.doesNotMatch(form?.render() ?? "", /Why are you cancelling/);
	form?.press(KEY.enter); // Submit
	assert.equal((await pending).details.status, "submitted");
});

test("cancelling the normal way carries no comment and reads as before", async () => {
	const host = boot();
	const pending = host.ask();
	await tick();
	host.forms[0]?.press(TAB, TAB, KEY.down, KEY.enter);
	const response = await pending;
	assert.equal(response.details.status, "cancelled");
	assert.equal("comment" in response.details, false);
	assert.equal(response.content[0].text, "User cancelled the ask flow");
});

test("a background form delivers its comment without waking the agent", async () => {
	const host = boot();
	host.emit("session_start", { reason: "startup" });
	await tick();
	const receipt = await host.ask({ ...PARAMS, background: true });
	assert.equal(receipt.details.status, "queued");
	assert.ok(host.focusIs("panel"));
	host.type(TAB, TAB, "c");
	typeText((...keys) => host.type(...keys), "later please");
	host.type(KEY.enter);
	await tick();

	assert.equal(host.sent.length, 1);
	assert.equal(host.sent[0]?.options?.triggerTurn, false, "a cancellation never wakes");
	const content = host.sent[0]?.message.content ?? "";
	assert.match(content, /cancelled/);
	assert.match(content, /The user's reason: "later please"\./);
	assert.match(content, /Cancellation is not approval/);
	assert.equal(host.sent[0]?.message.details.result.comment, "later please");
});

test("a background form delivers skipped questions by id", async () => {
	const host = boot();
	host.emit("session_start", { reason: "startup" });
	await tick();
	await host.ask({ ...PARAMS, background: true });
	host.type("s", KEY.enter);
	// Question b: pick Yes; then review: submit.
	host.type(KEY.enter);
	await tick();
	const content = host.sent[0]?.message.content ?? "";
	assert.match(content, /- a "Pick a\?": \(skipped by the user\)/);
	assert.match(content, /- b "Pick b\?": Yes \[yes\]/);
	assert.match(content, /not approval and not an answer/);
	assert.deepEqual(host.sent[0]?.message.details.result.skipped, ["a"]);
});
