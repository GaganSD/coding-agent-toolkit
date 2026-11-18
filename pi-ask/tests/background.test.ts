import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { registerAskTool } from "../src/ask-tool.ts";
import { fakePi, KEY, quietConfig, tick } from "./support/fake-pi.ts";
import {
	boot,
	start,
	kinds,
	PARAMS,
	ONE,
	SUBMIT_TWO,
	withBackgroundForm,
} from "./support/background.ts";

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
