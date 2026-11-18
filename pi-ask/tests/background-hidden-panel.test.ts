import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AskJournalEntry } from "../src/journal/entries.ts";
import { KEY, quietConfig, type SentMessage, tick } from "./support/fake-pi.ts";
import { boot, kinds, ONE, start, SUBMIT_ONE, withBackgroundForm } from "./support/background.ts";

beforeEach(quietConfig);

const NOTES = { title: "Notes", questions: [{ id: "dir", label: "DIR", prompt: "Which directory?", type: "text" }] };

test("a turn boundary with a cancellation and an answer continues the turn", async () => {
	const { host } = await withBackgroundForm(ONE("a"));
	await host.askInBackground(ONE("b"));
	host.setIdle(false);
	host.type(KEY.ctrlC);
	host.type(...SUBMIT_ONE);
	await tick();

	const boundary = host.turnEnd();
	assert.equal(boundary.entries.length, 2);
	assert.equal(boundary.continue, true, "the answer must be seen by the agent");
	host.emit("session_shutdown");
});

test("a tree move while the panel is hidden shows the branch's draft and answers once", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
	const host = boot(session);
	await start(host, "startup");
	await host.askInBackground();
	const formEntry = session.getBranch().at(-1)?.id;
	assert.ok(formEntry);

	// Branch A: the database is answered.
	host.type(KEY.enter, KEY.escape);
	const branchA = session.getBranch().at(-1)?.id;
	assert.ok(branchA);
	// Branch B: the same form, a different draft, panel hidden.
	session.branch(formEntry);
	host.emit("session_tree");
	await tick();
	host.type(KEY.focus, KEY.down, KEY.enter, KEY.escape);
	assert.equal(host.panelText(), "");

	const drafts = () => kinds(host).filter((kind) => kind === "draft").length;
	session.branch(branchA);
	host.emit("session_tree");
	await tick();
	const before = drafts();
	assert.equal(host.panelText(), "", "the panel stays hidden");

	await host.command("ask-panel");
	assert.match(host.panelText(), /Which cache\?/, "branch A's draft is shown");
	assert.equal(drafts(), before, "no stale draft was written");

	host.type(KEY.enter, KEY.enter);
	await tick();
	assert.equal(host.sent.length, 1);
	assert.deepEqual(host.sent[0].message.details.result.answers.db.values, ["postgres"]);
	assert.equal(kinds(host).filter((kind) => kind === "outcome").length, 1);
	host.emit("session_shutdown");
});

test("a hidden panel whose draft cannot be saved keeps the form and reports it", async (t) => {
	const { host } = await withBackgroundForm(NOTES);
	const pi: ExtensionAPI = host.pi;
	const append = pi.appendEntry;
	const failure = t.mock.method(pi, "appendEntry", (type: string, data: unknown) => {
		if ((data as AskJournalEntry).kind === "draft") {
			throw new Error("disk full");
		}
		append(type, data);
	});
	host.type(..."keep this");
	host.type(KEY.escape, KEY.escape);
	await tick();
	assert.match(host.notices.join("\n"), /Could not save ask_user draft/);
	assert.deepEqual(host.sent, []);
	assert.equal(kinds(host).includes("outcome"), false);

	failure.mock.restore();
	await host.command("ask-panel");
	assert.match(host.panelText(), /keep this/, "the typed answer was kept");
	host.type(KEY.enter, KEY.enter, KEY.enter);
	await tick();
	const sent = host.sent as SentMessage[];
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.message.details.result.answers.dir.customText, "keep this");
	host.emit("session_shutdown");
});
