import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "../../src/ask-tool.ts";
import { registerAskBackground } from "../../src/background.ts";
import { createAskRuntime } from "../../src/runtime.ts";
import { fakePi, KEY, tick } from "./fake-pi.ts";

const question = (id: string, prompt: string, first: string, second: string) => ({
	id,
	label: id.toUpperCase(),
	prompt,
	options: [
		{ value: first.toLowerCase(), label: first },
		{ value: second.toLowerCase(), label: second },
	],
});

export const PARAMS = {
	title: "Storage",
	questions: [
		question("db", "Which database?", "Postgres", "SQLite"),
		question("cache", "Which cache?", "Redis", "None"),
	],
};
export const ONE = (id: string, title = id) => ({
	title,
	questions: [question(id, `Pick ${id}?`, "Yes", "No")],
});
/** Answer every question with its first option and submit. */
export const SUBMIT_TWO = [KEY.enter, KEY.enter, KEY.enter];
export const SUBMIT_ONE = [KEY.enter, KEY.enter];

/** One Pi process: the extension wired as `src/index.ts` wires it. */
export function boot(
	session?: SessionManager,
	options: {
		background?: boolean;
		mode?: string;
		persistToolResults?: boolean;
	} = {}
) {
	const host = fakePi(session, options);
	const runtime = createAskRuntime(host.pi);
	registerAskBackground(host.pi, runtime);
	registerAskTool(host.pi, {
		runtime,
		features: { background: options.background ?? true, expiry: false },
	});
	let calls = 0;
	const ask = (params: object = PARAMS) =>
		host.tools[0].execute(`call-${++calls}`, params, undefined, () => {}, host.ctx);
	const askInBackground = (params: object = PARAMS) =>
		ask({ ...params, background: true });
	return { ...host, host, ask, askInBackground };
}

type Host = ReturnType<typeof boot>;

export async function start(host: Host, reason = "resume") {
	host.emit("session_start", { reason });
	await tick();
}

export const kinds = (host: Host) => host.journal().map((entry) => entry.kind);
export const ids = (host: Host) =>
	host
		.journal()
		.filter((entry) => entry.kind === "form")
		.map((entry) => entry.requestId);

/** A session whose foreground form was open, DB answered, when Pi died. */
export async function interruptedSession() {
	const first = boot();
	first.ask().catch(() => {});
	await tick();
	first.forms[0]?.press(KEY.enter);
	assert.deepEqual(kinds(first), ["form", "draft"]);
	return first.session;
}

/** A started process with one background form in the focused panel. */
export async function withBackgroundForm(params: object = PARAMS) {
	const host = boot();
	await start(host, "startup");
	const receipt = await host.askInBackground(params);
	return { host, receipt, requestId: receipt.details.requestId as string };
}

/**
 * A session whose blocking form was answered, but where Pi died before it
 * wrote the tool result: the answer exists only in the journal.
 */
export async function unrecordedToolSession() {
	const first = boot(undefined, { persistToolResults: false });
	const pending = first.ask();
	await tick();
	first.forms[0]?.press(...SUBMIT_TWO);
	await pending;
	assert.equal(first.journal().at(-1)?.channel, "tool");
	assert.equal(first.answers().length, 0);
	return first.session;
}
