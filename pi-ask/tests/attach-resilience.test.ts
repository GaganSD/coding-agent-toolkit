import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { boot, ONE, SUBMIT_ONE, SUBMIT_TWO, start, unrecordedToolSession, withBackgroundForm } from "./support/background.ts";
import { KEY, quietConfig, tick } from "./support/fake-pi.ts";

beforeEach(quietConfig);

test("a journal read that throws on attach neither throws nor stops later delivery", async (t) => {
	const { host } = await withBackgroundForm();
	const failing = t.mock.method(host.session, "getBranch", () => {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	});
	assert.doesNotThrow(() => host.emit("session_tree"));
	await tick();
	failing.mock.restore();

	host.emit("session_tree");
	await tick();
	assert.match(host.panelText(), /Which database/);
	if (!host.focusIs("panel")) {
		host.type(KEY.focus);
	}
	host.type(...SUBMIT_TWO);
	await tick();
	assert.equal(host.sent.length, 1);
	host.emit("session_shutdown");
});

test("an orphaned tool answer is adopted by a later pump after a failed attach, once", async (t) => {
	const session = await unrecordedToolSession();
	const host = boot(session);
	const failing = t.mock.method(host.session, "getBranch", () => {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	});
	assert.doesNotThrow(() => host.emit("session_start", { reason: "resume" }));
	await tick();
	failing.mock.restore();
	assert.equal(host.sent.length, 0, "nothing is delivered while the branch is unreadable");

	host.emit("agent_settled", { aborted: false });
	await tick();
	assert.equal(host.sent.length, 1);
	host.recordWake();
	host.emit("agent_settled", { aborted: false });
	await start(host, "reload");
	assert.equal(host.sent.length, 1, "delivered exactly once");
	host.emit("session_shutdown");
});

test("an unrelated error that mentions staleness is surfaced, not swallowed", async (t) => {
	const { host } = await withBackgroundForm();
	t.mock.method(host.session, "getBranch", () => {
		throw new Error("stale cache entry");
	});
	assert.throws(() => host.emit("session_tree"), /stale cache entry/);
	host.emit("session_shutdown");
});

test("an unrecognised attach failure is surfaced, after the attach finished its other work", async (t) => {
	const { host } = await withBackgroundForm();
	const failing = t.mock.method(host.session, "getBranch", () => {
		throw new Error("boom");
	});
	assert.throws(() => host.emit("session_tree"), /boom/);
	failing.mock.restore();
	host.emit("session_tree");
	await tick();
	assert.match(host.panelText(), /Which database/);
	host.emit("session_shutdown");
});

test("a blocking answer whose tool result has not landed is never adopted and sent as well", async (t) => {
	const host = boot(undefined, { holdToolResults: true });
	const pending = host.ask(ONE("choice"));
	await tick();
	host.forms[0]?.press(...SUBMIT_ONE);
	const response = await pending;
	assert.equal(response.details.status, "submitted");
	assert.equal(host.answers().length, 0, "the result is still on its way");
	assert.equal(host.session.getBranch().some((entry) => entry.type === "message" && entry.message.role === "toolResult"), false);

	// A failing read, then a recovering one, then a pump from another event.
	const failing = t.mock.method(host.session, "getBranch", () => {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	});
	assert.doesNotThrow(() => host.emit("session_tree"));
	failing.mock.restore();
	host.emit("session_tree");
	host.emit("session_compact");
	await tick();
	assert.deepEqual(host.sent, [], "the live answer is not sent as a message");

	// Pi awaits message_end handlers before it persists the result: a pump or
	// attach in that gap must still not send the answer.
	host.endHeldToolResults();
	host.emit("session_tree");
	host.emit("session_compact");
	await tick();
	assert.deepEqual(host.sent, [], "nothing is sent between message_end and the append");

	host.landToolResults();
	host.emit("session_tree");
	host.emit("session_compact");
	host.settle();
	await tick();
	assert.deepEqual(host.sent, [], "nothing extra once the result landed");
	host.emit("session_shutdown");
});
