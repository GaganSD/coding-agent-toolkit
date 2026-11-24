import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { askStrings } from "../src/i18n.ts";
import type { AskResult, AskState } from "../src/types.ts";
import type { readClipboardPaste } from "../src/ui/clipboard-paste.ts";
import {
	createAskFlowController,
	DRAFT_TYPING_DEBOUNCE_MS,
} from "../src/ui/controller.ts";
import { bindClipboardPaste, fakePi, KEY } from "./support/fake-pi.ts";

const PASTE = "\x16";
const PATH = "/tmp/pi-clipboard-screenshot.png";

after(bindClipboardPaste());

function openForm(readPaste: typeof readClipboardPaste, note = false) {
	const host = fakePi();
	const drafts: AskState[] = [];
	const results: AskResult[] = [];
	const form = createAskFlowController(
		[host.tui as never, host.theme as never, undefined, (result) => results.push(result)],
		{
			config: DEFAULT_ASK_CONFIG,
			ctx: host.ctx,
			cwd: process.cwd(),
			onStateChange: (state) => drafts.push(state),
			questions: note
				? [{ id: "q1", prompt: "Which one?", options: [{ value: "a", label: "A" }] }]
				: [{ id: "q1", prompt: "What did you see?", type: "text" }],
			readPaste,
			rebuilt: true,
		}
	);
	if (note) {
		form.handleInput("N");
		drafts.length = 0;
	}
	return { form, drafts, results };
}

test("pasting an image path is debounced like typing and submits as customText", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pasted = Promise.resolve({ kind: "image", text: PATH } as const);
	const { form, drafts, results } = openForm(() => pasted);
	t.after(() => form.dispose());
	for (const key of ["a", "b", "\x1b[D"]) {
		form.handleInput(key);
	}
	t.mock.timers.tick(DRAFT_TYPING_DEBOUNCE_MS);
	assert.equal(drafts.at(-1)?.answers.q1?.customText, "ab");

	form.handleInput(PASTE);
	await pasted;
	const expected = `a${PATH}b`;
	assert.equal(form.getState().answers.q1?.customText, expected);
	assert.equal(drafts.length, 1, "paste is not reported immediately");
	t.mock.timers.tick(DRAFT_TYPING_DEBOUNCE_MS);
	assert.equal(drafts.at(-1)?.answers.q1?.customText, expected);
	form.handleInput(KEY.enter);
	form.handleInput(KEY.enter);
	assert.equal(results[0]?.answers.q1?.customText, expected);
});

test("pasting an image path into a question note saves it as note text", async (t) => {
	const pasted = Promise.resolve({ kind: "image", text: PATH } as const);
	const { form, results } = openForm(() => pasted, true);
	t.after(() => form.dispose());
	form.handleInput(PASTE);
	await pasted;
	assert.equal(form.getState().answers.q1?.note, PATH);
	form.handleInput(KEY.enter); // Save the note.
	form.handleInput(KEY.enter); // Choose A.
	form.handleInput(KEY.enter); // Submit the form.
	assert.equal(results[0]?.answers.q1?.note, PATH);
});

test("an in-flight paste is dropped after closing and reopening the same editor", async (t) => {
	const pasted = Promise.resolve({ kind: "path", text: PATH } as const);
	const { form, drafts } = openForm(() => pasted, true);
	t.after(() => form.dispose());
	form.handleInput(PASTE);
	form.handleInput(KEY.escape);
	form.handleInput("N");
	await pasted;
	assert.equal(form.getState().answers.q1?.note, undefined);
	assert.equal(drafts.at(-1)?.answers.q1?.note, undefined);
});

test("an in-flight paste is dropped after disposing the form", async () => {
	const pasted = Promise.resolve({ kind: "path", text: PATH } as const);
	const { form } = openForm(() => pasted);
	form.handleInput(PASTE);
	form.dispose();
	await pasted;
	assert.equal(form.getState().answers.q1?.customText, undefined);
});

test("text pastes use editor sanitizing and drafts expand large-paste markers", async (t) => {
	const text = "abc".repeat(400);
	const pasted = Promise.resolve({ kind: "text", text: `\x00${text}` } as const);
	const { form } = openForm(() => pasted);
	t.after(() => form.dispose());
	form.handleInput(PASTE);
	await pasted;
	assert.match(form.render(80).join("\n"), /\[paste #1 1200 chars\]/);
	assert.equal(form.getState().answers.q1?.customText, text);
});

test("clipboard errors appear in the editor's status notice", async (t) => {
	const failure = Promise.reject(new Error("disk full"));
	const { form } = openForm(() => failure);
	t.after(() => form.dispose());
	form.handleInput(PASTE);
	await assert.rejects(failure);
	assert.ok(form.render(80).join("\n").includes(askStrings().clipboardPasteFailed("disk full")));
});
