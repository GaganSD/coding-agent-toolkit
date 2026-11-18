import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { boot, SUBMIT_TWO, start, unrecordedToolSession, withBackgroundForm } from "./support/background.ts";
import { KEY, quietConfig, tick } from "./support/fake-pi.ts";

beforeEach(quietConfig);

test("a journal read that throws on attach neither throws nor stops later delivery", async (t) => {
	const { host } = await withBackgroundForm();
	const failing = t.mock.method(host.session, "getBranch", () => {
		throw new Error("stale context");
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
		throw new Error("stale context");
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
