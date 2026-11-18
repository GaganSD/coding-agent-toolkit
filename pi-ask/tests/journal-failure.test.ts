import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskJournalEntry } from "../src/journal/entries.ts";
import { AskJournalWriteError, createAskJournal } from "../src/journal/journal.ts";
import { createInitialState } from "../src/state/create.ts";
import { boot, kinds, ONE, SUBMIT_ONE, SUBMIT_TWO, withBackgroundForm } from "./support/background.ts";
import { KEY, quietConfig, tick } from "./support/fake-pi.ts";

beforeEach(quietConfig);

for (const background of [false, true]) {
	test(`a failed form append rejects a ${background ? "background" : "blocking"} call before acknowledging it`, async (t) => {
		const host = boot();
		const pi: ExtensionAPI = host.pi;
		t.mock.method(pi, "appendEntry", () => { throw new Error("disk full"); });

		await assert.rejects(host.ask({ ...ONE("choice"), background }), AskJournalWriteError);
		assert.deepEqual(kinds(host), []);
		assert.equal(host.forms.length, 0);
		assert.equal(host.panelText(), "");
		assert.deepEqual(host.sent, []);
		host.emit("session_shutdown");
	});
}

test("a failed background outcome stays editable and can be submitted again", async (t) => {
	const { host } = await withBackgroundForm();
	const pi: ExtensionAPI = host.pi;
	const append = pi.appendEntry;
	const failure = t.mock.method(pi, "appendEntry", (type: string, data: unknown) => {
		if ((data as AskJournalEntry).kind === "outcome") {
			throw new Error("disk full");
		}
		append(type, data);
	});

	host.type(...SUBMIT_TWO);
	assert.equal(host.sent.length, 0);
	assert.deepEqual(kinds(host), ["form", "draft", "draft"]);
	assert.match(host.notices.at(-1) ?? "", /Could not save ask_user outcome.*disk full/);
	assert.match(host.panelText(), /Could not save ask_user outcome/);

	failure.mock.restore();
	host.type(KEY.enter);
	assert.equal(host.sent.length, 1);
	assert.deepEqual(host.sent[0].message.details.result.answers.db.values, ["postgres"]);
	assert.deepEqual(host.sent[0].message.details.result.answers.cache.values, ["redis"]);
	assert.equal(kinds(host).filter((kind) => kind === "outcome").length, 1);
	host.emit("session_shutdown");
});

test("a failed foreground outcome rejects the tool result instead of returning an answer", async (t) => {
	const host = boot();
	const pi: ExtensionAPI = host.pi;
	const append = pi.appendEntry;
	t.mock.method(pi, "appendEntry", (type: string, data: unknown) => {
		if ((data as AskJournalEntry).kind === "outcome") {
			throw new Error("disk full");
		}
		append(type, data);
	});
	const rejected = assert.rejects(host.ask(ONE("choice")), AskJournalWriteError);
	await tick();
	host.forms[0]?.press(...SUBMIT_ONE);
	await rejected;
	assert.equal(kinds(host).includes("outcome"), false);
	assert.equal(host.answers().length, 0);
	host.emit("session_shutdown");
});

test("a failed debounced draft reports the error and retains the typed answer for retry", async (t) => {
	const { host } = await withBackgroundForm({
		questions: [{ id: "notes", prompt: "Notes?", type: "text" }],
	});
	const pi: ExtensionAPI = host.pi;
	const append = pi.appendEntry;
	const failure = t.mock.method(pi, "appendEntry", (type: string, data: unknown) => {
		if ((data as AskJournalEntry).kind === "draft") {
			throw new Error("disk full");
		}
		append(type, data);
	});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	host.type(..."keep this");
	t.mock.timers.tick(1000);
	assert.match(host.notices.at(-1) ?? "", /Could not save ask_user draft/);
	assert.match(host.panelText(), /keep this/);
	assert.deepEqual(kinds(host), ["form"]);

	failure.mock.restore();
	host.type(KEY.enter, KEY.enter);
	assert.equal(host.sent[0]?.message.details.result.answers.notes.customText, "keep this");
	assert.deepEqual(kinds(host), ["form", "draft", "outcome"]);
	host.emit("session_shutdown");
});

test("draft deduplication advances only after a successful write", () => {
	let writes = 0;
	const journal = createAskJournal(() => {
		if (++writes === 1) {
			throw new Error("disk full");
		}
	});
	const record = journal.draftRecorder("ask-retry");
	const state = createInitialState({ questions: [{ id: "notes", prompt: "Notes?", type: "text" }] });
	state.answers.notes = { selected: [], customText: "same draft", customSelected: true };
	assert.throws(() => record(state), /disk full/);
	record(state);
	record(state);
	assert.equal(writes, 2, "the failed write is retried, then deduplicated");
});

for (const [name, kind, keys, wording] of [
	["submit", "outcome", SUBMIT_ONE, /answer was not saved/],
	["defer", "defer", [KEY.later], /deferral was not saved/],
	["cancel", "outcome", [KEY.ctrlC], /cancellation was not saved/],
] as const) {
	test(`a failed blocking ${name} save puts the form back in the panel, tells the user and the agent`, async (t) => {
		const host = boot();
		const pi: ExtensionAPI = host.pi;
		const append = pi.appendEntry;
		t.mock.method(pi, "appendEntry", (type: string, data: unknown) => {
			if ((data as AskJournalEntry).kind === kind) {
				throw new Error("disk full");
			}
			append(type, data);
		});
		const rejected = assert.rejects(
			host.ask(ONE("choice")),
			new RegExp(`${wording.source}.*reappear in their panel.*Do not re-ask`)
		);
		await tick();
		host.forms[0]?.press(...keys);
		await rejected;
		assert.match(host.panelText(), /CHOICE/, "the form is back at once");
		assert.match(host.notices.at(-1) ?? "", /Could not save ask_user.*disk full.*back in your panel/);
		host.emit("session_shutdown");
	});
}
