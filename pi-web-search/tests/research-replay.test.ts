import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import dns from "node:dns";
import { lookup, resolve4, Resolver } from "node:dns/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedInput, checkPath, claimOutput } from "../benchmarks/harness/provenance.ts";
import { Replay, retrieve } from "../benchmarks/harness/replay.ts";

function rpc(id: number, query: string, options: Record<string, unknown> = {}): RequestInit {
	return { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
		params: { name: "web_search_exa", arguments: { query, ...options } },
	}) };
}

test("research replay shares sanitized Exa responses and fails closed on misses", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-research-replay-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "responses.json");
	const original = t.mock.method(globalThis, "fetch", async () => Response.json({
		jsonrpc: "2.0", id: 123, result: { content: [{ type: "text",
			text: "Title: Example\nURL: https://example.org/doc?api_key=placeholder\nHighlights:\nRecorded text",
		}], requestId: "provider-request" },
	}));
	const writer = new Replay(path, true, "draft");
	const restoreLive = writer.install("model");
	try {
		const captured = await retrieve(() => fetch("https://mcp.exa.ai/mcp", rpc(7, "test query", { objective: "test objective", numResults: 8 })));
		assert.equal((await captured.json()).id, 7);
		writer.save();
		assert.equal(original.mock.callCount(), 1);
	} finally { restoreLive(); }
	assert.doesNotMatch(readFileSync(path, "utf8"), /test query|placeholder|provider-request/u);
	const reader = new Replay(path, false, "draft");
	const restoreOffline = reader.install();
	try {
		const response = await fetch("https://mcp.exa.ai/mcp?tools=web_search_exa", rpc(99, "test query", { numResults: 5 }));
		const value = await response.json();
		assert.equal(value.id, 99);
		assert.match(value.result.content[0].text, /Recorded text/u);
		await assert.rejects(fetch("https://mcp.exa.ai/mcp", rpc(100, "different test query")), /Replay miss/u);
		assert.throws(() => net.connect(443, "example.invalid"), /Replay miss: direct socket/u);
		await assert.rejects(lookup("example.invalid"), /Replay miss: DNS lookup/u);
		await assert.rejects(resolve4("example.invalid"), /Replay miss: DNS resolve4/u);
		await assert.rejects(new Resolver().resolveTxt("example.invalid"), /Replay miss: DNS resolveTxt/u);
		assert.throws(() => dns.resolve4("example.invalid", () => {}), /Replay miss: DNS resolve4/u);
		assert.equal(original.mock.callCount(), 1);
		assert.deepEqual(reader.misses, ["mcp.exa.ai web_search_exa", "direct socket",
			"DNS lookup", "DNS resolve4", "DNS resolveTxt", "DNS resolve4"]);
	} finally { restoreOffline(); }
});

test("draft output and cassettes cannot be reused as final, including through aliases", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-research-provenance-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const output = claimOutput(join(directory, "output"), "draft");
	const alias = join(directory, "alias");
	symlinkSync(output, alias, "junction");
	assert.equal(claimOutput(alias, "draft"), output);
	assert.throws(() => claimOutput(alias, "final"), /output provenance differs/u);
	const cassette = join(output, "private.json");
	new Replay(cassette, true, "draft").save();
	assert.throws(() => new Replay(join(alias, "private.json"), true, "final"), /cassette provenance/u);
	const symlink = join(directory, "alias.json");
	symlinkSync(cassette, symlink);
	assert.throws(() => new Replay(symlink, true, "final"), /must not be a symlink/u);
	assert.throws(() => checkPath(symlink), /must not be a symlink/u);
	const old = join(directory, "legacy");
	mkdirSync(old);
	writeFileSync(join(old, "responses.json"), "{}");
	assert.throws(() => claimOutput(old, "final"), /output has no provenance/u);
	assert.throws(() => new Replay(join(old, "responses.json"), false, "final"), /cassette provenance/u);
	const draftInputs = join(directory, "inputs-draft");
	mkdirSync(draftInputs);
	const inputAlias = join(directory, "inputs");
	symlinkSync(draftInputs, inputAlias, "junction");
	assert.throws(() => approvedInput(inputAlias, "final"), /Use --draft/u);
});

test("Parallel recordings omit session attribution and replay in a new model session", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-parallel-replay-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "responses.json");
	const call = (id: number, session: string, model: string) => ({
		method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
			name: "web_search", arguments: { objective: "unit test", session_id: session, model_name: model },
		} }),
	});
	const original = t.mock.method(globalThis, "fetch", async (_input: Request, init: RequestInit) => {
		assert.deepEqual(JSON.parse(String(init.body)).params.arguments, { objective: "unit test" });
		return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { results: [{ title: "Unit test" }] } } });
	});
	const writer = new Replay(path, true, "draft");
	const restoreLive = writer.install("model");
	try {
		await retrieve(() => fetch("https://search.parallel.ai/mcp", call(1, "session-1", "model-1")));
		writer.save();
	} finally { restoreLive(); }

	const reader = new Replay(path, false, "draft");
	const restoreOffline = reader.install();
	try {
		const response = await fetch("https://search.parallel.ai/mcp", call(2, "session-2", "model-2"));
		assert.equal((await response.json()).id, 2);
		assert.deepEqual(reader.misses, []);
		assert.equal(original.mock.callCount(), 1);
	} finally { restoreOffline(); }
});

test("Sourcegraph captures request and body failures and replays their exact GET keys", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-sourcegraph-replay-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "responses.json");
	const url = (query: string) => new URL("https://sourcegraph.com/.api/search/stream?q=" + encodeURIComponent(query));
	const original = t.mock.method(globalThis, "fetch", async (input: Request) => {
		if (new URL(input.url).searchParams.get("q") === "test request") throw new TypeError("Raw transport diagnostic");
		return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Raw body diagnostic")); } }));
	});
	const writer = new Replay(path, true, "draft");
	const restoreLive = writer.install("model");
	try {
		await assert.rejects(retrieve(() => fetch(url("test request"))), /transport network \(request\)/u);
		const response = await retrieve(() => fetch(url("test body")));
		await assert.rejects(response.text(), /transport network \(body\)/u);
		writer.save();
	} finally { restoreLive(); }
	assert.doesNotMatch(readFileSync(path, "utf8"), /test request|test body|Raw .* diagnostic/u);

	const reader = new Replay(path, false, "draft");
	const restoreOffline = reader.install();
	try {
		await assert.rejects(fetch(url("test request")), /transport network \(request\)/u);
		const response = await fetch(url("test body"));
		await assert.rejects(response.text(), /transport network \(body\)/u);
		assert.equal(reader.misses.length, 0);
		assert.equal(original.mock.callCount(), 2);
		await assert.rejects(fetch(url("other key")), /Replay miss: sourcegraph.com GET/u);
	} finally { restoreOffline(); }
});

test("relative Exa and Parallel dates replay across clocks without modifying outgoing filters", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-recency-replay-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "responses.json");
	let clock = Date.parse("2030-05-13T18:14:06.304Z");
	t.mock.method(Date, "now", () => clock);
	const offset = (days: number) => new Date(clock - days * 86_400_000).toISOString();
	const absolute = "1990-03-20T12:30:00.000Z";
	const exaUrl = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
	const parallelUrl = "https://search.parallel.ai/mcp";
	const makeCall = (name: string, date: string): RequestInit => ({
		method: "POST",
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
			name, arguments: { query: "unit test", ...(name === "web_search_advanced_exa" ? { startPublishedDate: date } : {}) },
		} }),
		...(name === "web_search" ? { headers: { "x-parallel-search-config":
			JSON.stringify({ advanced_settings: { source_policy: { after_date: date, include_domains: ["example.org"] } } }),
		} } : {}),
	});
	const dates: string[] = [];
	const original = t.mock.method(globalThis, "fetch", async (input: Request) => {
		const date = input.headers.get("x-parallel-search-config");
		dates.push(date ? JSON.parse(date).advanced_settings.source_policy.after_date : (await input.json()).params.arguments.startPublishedDate);
		return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } });
	});
	const writer = new Replay(path, true, "draft");
	const restoreLive = writer.install("model");
	try {
		await retrieve(() => fetch(exaUrl, makeCall("web_search_advanced_exa", offset(7))));
		await retrieve(() => fetch(parallelUrl, makeCall("web_search", offset(31).slice(0, 10))));
		await retrieve(() => fetch(exaUrl, makeCall("web_search_advanced_exa", absolute)));
		assert.deepEqual(dates, [offset(7), offset(31).slice(0, 10), absolute]);
		writer.save();
	} finally { restoreLive(); }

	clock = Date.parse("2030-06-21T03:11:14.111Z");
	const reader = new Replay(path, false, "draft");
	const restoreOffline = reader.install();
	try {
		assert.equal((await fetch(exaUrl, makeCall("web_search_advanced_exa", offset(7)))).status, 200);
		assert.equal((await fetch(parallelUrl, makeCall("web_search", offset(31).slice(0, 10)))).status, 200);
		assert.equal((await fetch(exaUrl, makeCall("web_search_advanced_exa", absolute))).status, 200);
		await assert.rejects(fetch(exaUrl, makeCall("web_search_advanced_exa", offset(1))), /Replay miss/u);
		await assert.rejects(fetch(parallelUrl, makeCall("web_search", offset(28).slice(0, 10))), /Replay miss/u);
		await assert.rejects(fetch(exaUrl, makeCall("web_search_advanced_exa", "1990-03-21T12:30:00.000Z")), /Replay miss/u);
		assert.equal(original.mock.callCount(), 3);
	} finally { restoreOffline(); }
});
