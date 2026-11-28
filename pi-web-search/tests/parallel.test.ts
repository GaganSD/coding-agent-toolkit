import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { disableStoredCredentials, enableStoredCredentials, removeApiKey, storeApiKey } from "../src/env.ts";
import { applyConfig } from "../src/providers/config.ts";
import { runSearch, type SearchRequest } from "../src/providers/index.ts";
import { formatSearchError } from "../src/utils.ts";
import { parallelSearch } from "../src/providers/parallel.ts";
import { providerError } from "../src/providers/types.ts";
import { parallelHttp } from "./fixtures/parallel-http.ts";

const query = "history of MCP search";
const result = { search_id: "search-123", results: [
	{ url: "https://example.test/one", title: "One", excerpts: ["one excerpt"] },
	{ url: "https://example.test/two", title: "Two", publish_date: "2026-01-02", excerpts: ["two excerpt"] },
], usage: [{ name: "search", count: 1 }] };
const structured = { structuredContent: result };
const error = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
const request = (extra: Partial<SearchRequest> = {}): SearchRequest => ({
	query, settings: applyConfig("/tmp/web-search.json", { web: { provider: "parallel", fallback: [] } }),
	sessionId: "conversation-one", ...extra,
});

test("direct anonymous search keeps payload, analytics, and MCP lifecycle", async (t) => {
	const previous = process.env.PARALLEL_API_KEY;
	delete process.env.PARALLEL_API_KEY;
	t.after(() => { if (previous === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = previous; });
	const fixture = parallelHttp(() => ({ ...structured, content: [{ type: "text", text: '{"results":[]}' }] }));
	const output = await parallelSearch(request({ modelId: "gpt-5.6-sol" }), { fetchImpl: fixture.fetch });
	const [call] = fixture.calls;
	assert.equal(call.name, "web_search");
	assert.deepEqual(call.arguments, { objective: query, search_queries: [query], session_id: call.arguments.session_id, model_name: "gpt-5.6-sol" });
	assert.match(call.arguments.session_id as string, /^[a-f0-9]{64}$/);
	assert.deepEqual(fixture.methods, ["initialize", "notifications/initialized", "tools/call", "DELETE"]);
	assert.ok(fixture.headers.every((auth) => auth === null));
	assert.equal(output.providerKind, "parallel");
	assert.equal(output.requestId, "search-123");
	assert.equal(output.searchResults?.[0].citedText, "one excerpt");
	assert.deepEqual(output.sources?.[0], { url: "https://example.test/one", title: "One" });
	assert.deepEqual(output.usage, [{ name: "search", count: 1 }]);
	for (const [sessionId, modelId] of [["conversation-one", "unknown"], ["conversation-two", "x".repeat(101)]]) {
		await parallelSearch(request({ sessionId, modelId }), { fetchImpl: fixture.fetch });
		const metadata = fixture.calls.at(-1)!.arguments;
		assert.equal(metadata.session_id === call.arguments.session_id, sessionId === "conversation-one");
		assert.equal(metadata.model_name, undefined);
	}
});

test("direct Parallel picks up saved key, rotation, env override, and removal on the next call", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "parallel-key-"));
	const path = join(dir, "auth.json");
	const previous = process.env.PARALLEL_API_KEY;
	delete process.env.PARALLEL_API_KEY;
	enableStoredCredentials(path);
	t.after(async () => {
		if (previous === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = previous;
		disableStoredCredentials();
		await rm(dir, { recursive: true, force: true });
	});
	const observe = async (expected: string | null) => {
		const fixture = parallelHttp();
		await parallelSearch(request(), { fetchImpl: fixture.fetch });
		assert.deepEqual(fixture.headers, Array(4).fill(expected));
	};
	await observe(null);
	await storeApiKey("parallel", "stored", path);
	await observe("Bearer stored");
	await storeApiKey("parallel", "rotated", path);
	await observe("Bearer rotated");
	process.env.PARALLEL_API_KEY = "  override  ";
	await observe("Bearer override");
	delete process.env.PARALLEL_API_KEY;
	await removeApiKey("parallel", path);
	await observe(null);
});

test("web_fetch keeps full citation URLs and the old metadata; URL-only avoids web_search", async () => {
	const fetched = { results: [{ url: "https://example.test/page", title: "Page", excerpts: ["page excerpt"], full_content: "do not use" }], errors: [{ url: "https://example.test/gone" }] };
	const fixture = parallelHttp(({ name }) => ({ content: [{ type: "text", text: JSON.stringify(name === "web_fetch" ? fetched : result) }] }));
	const urls = ["https://example.test/page", "https://example.test/gone", ...Array.from({ length: 20 }, (_, i) => `https://example.test/${i}`)];
	const output = await parallelSearch(request({ query: "x".repeat(300), urls, modelId: "m" }), { fetchImpl: fixture.fetch });
	const [search, fetch] = fixture.calls;
	assert.equal(search.name, "web_search");
	assert.equal(fetch.name, "web_fetch");
	assert.deepEqual(fetch.arguments, { urls: urls.slice(0, 20), objective: "x".repeat(200), search_queries: search.arguments.search_queries,
		full_content: false, session_id: search.arguments.session_id, model_name: "m" });
	assert.equal(output.searchResults?.[2].type, "extract");
	assert.equal(output.searchResults?.[2].citedText, "page excerpt");
	assert.ok(output.warnings?.includes("https://example.test/gone"));
	await parallelSearch(request({ query: "", urls: urls.slice(0, 1), fetchOnly: true }), { fetchImpl: fixture.fetch });
	assert.deepEqual(fixture.calls.map(({ name }) => name), ["web_search", "web_fetch", "web_fetch"]);
	assert.deepEqual(fixture.calls[2].arguments.search_queries, []);
	assert.equal(fixture.calls[2].arguments.objective, "Extract the requested pages.");
});

test("direct Parallel classifies tool failures and rejects invented evidence", async () => {
	for (const [message, code, status, retryable] of [
		["HTTP 429 too many requests", "rate_limited", 429, true], ["403 Forbidden", "http_error", 403, false],
		["Tool not found", "tool_error", undefined, false], ["connection dropped", "tool_error", undefined, true],
	] as const) {
		const fixture = parallelHttp(() => error(message));
		await assert.rejects(parallelSearch(request(), { fetchImpl: fixture.fetch }), { code, ...(status === undefined ? {} : { status }), retryable });
	}
	for (const payload of [{ content: [{ type: "text", text: "Not evidence: https://fake.test" }] }, { structuredContent: { results: [{ url: "file:///tmp/fake" }] } }]) {
		await assert.rejects(parallelSearch(request(), { fetchImpl: parallelHttp(() => payload).fetch }), { code: "parse_error" });
	}
});

test("failed web_fetch retains search evidence but timeout and caller abort are fatal", async () => {
	const urls = ["https://example.test/page"];
	const partial = parallelHttp(({ name }) => name === "web_fetch" ? error("connection dropped") : structured);
	const output = await parallelSearch(request({ urls }), { fetchImpl: partial.fetch });
	assert.equal(output.searchResults?.length, 2);
	assert.match(output.warnings?.join(" ") ?? "", /parallel fetch failed/);
	for (const reason of [providerError("timeout", "deadline passed"), undefined]) {
		const controller = new AbortController();
		const stuck = parallelHttp(({ name }) => name === "web_fetch" ? new Promise(() => {}) : structured);
		const pending = parallelSearch(request({ urls, signal: controller.signal }), { fetchImpl: stuck.fetch });
		while (stuck.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
		controller.abort(reason);
		await assert.rejects(pending, { code: reason?.code ?? "aborted" });
		assert.equal(stuck.methods.at(-1), "DELETE");
	}
});

test("Parallel failures match main's model envelope, with credentials redacted before clipping", async (t) => {
	const key = "PARALLEL_SENTINEL_SECRET_NOT_FOR_OUTPUT";
	const previous = process.env.PARALLEL_API_KEY;
	process.env.PARALLEL_API_KEY = key;
	t.after(() => { if (previous === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = previous; });
	const native = "mcp__pi_web_search_parallel__web_search";
	const pipeline = (message: string) => providerError("tool_error", `${native} failed in Pi's tool pipeline: ${message}. Check /mcp for pi_web_search_parallel and run /reload.`, { retryable: false });
	const prefix = "x".repeat(440) + " ";
	let parseMessage = "";
	assert.throws(() => JSON.parse('{"bad": [redacted]}'), (error: SyntaxError) => { parseMessage = error.message; return true; });
	const cases = [
		[() => new Response(`${prefix}${key}`, { status: 503 }), pipeline(`MCP HTTP request failed with status 503: ${prefix}[redacted]`.slice(0, 500))],
		[() => new Response(`{"bad": ${key}}`, { headers: { "content-type": "application/json" } }), pipeline(parseMessage)],
		[() => ({ rpcError: { code: -32603, message: `unavailable ${key}` } }), pipeline("unavailable [redacted]")],
		[() => error(`invalid api key ${key}`), providerError("http_error", `${native}: invalid api key [redacted]`, { status: 401 })],
		[() => ({ content: [{ type: "text", text: "not evidence" }] }), providerError("parse_error", "Parallel web_search returned no structured results; check /mcp for pi_web_search_parallel.")],
	] as const;
	for (const [respond, expected] of cases) {
		const fixture = parallelHttp(respond);
		const execute = () => parallelSearch(request(), { fetchImpl: fixture.fetch });
		await assert.rejects(execute, (actual: unknown) => {
			assert.ok(actual instanceof Error);
			const shown = formatSearchError("search", actual), baseline = formatSearchError("search", expected);
			assert.deepEqual(shown.content, baseline.content);
			assert.deepEqual(shown.structuredContent, baseline.structuredContent);
			assert.equal((actual as typeof expected).retryable, expected.retryable);
			assert.doesNotMatch(JSON.stringify(shown), /PARALLEL_SENTINEL/);
			return true;
		});
	}
	const fixture = parallelHttp(() => error(`429 rate limit for key ${key}`));
	const req = request();
	req.settings.web.fallback = ["exa"];
	const fallback = await runSearch(req, {
		family: "web", availability: { parallel: true, exa: true },
		transports: { parallel: (r) => parallelSearch(r, { fetchImpl: fixture.fetch }), exa: async () => ({ providerKind: "exa", text: "fallback evidence" }) },
	});
	assert.equal(fallback.text, "fallback evidence");
	assert.match(fallback.warnings?.join("\n") ?? "", /rate limit for key \[redacted\]/);
	assert.doesNotMatch(JSON.stringify(fallback), /PARALLEL_SENTINEL/);
});

test("Parallel correlates JSON batches exactly as single replies", async () => {
	const single = parallelHttp(() => structured);
	const batch = parallelHttp(() => structured, { batch: true });
	assert.deepEqual(await parallelSearch(request(), { fetchImpl: batch.fetch }), await parallelSearch(request(), { fetchImpl: single.fetch }));
});

test("a headerless session expiry replays only the rejected call once with a new session ID", async () => {
	let expiries = 0;
	const fixture = parallelHttp((call) => {
		if (call.name === "web_fetch" && expiries++ === 0) return new Response("expired", { status: 404 });
		return structured;
	});
	const output = await parallelSearch(request({ urls: ["https://example.test/one"] }), { fetchImpl: fixture.fetch });
	assert.ok(output.searchResults?.length);
	assert.deepEqual(fixture.calls.map((call) => call.name), ["web_search", "web_fetch", "web_fetch"]);
	assert.deepEqual(fixture.sessionHeaders, [null, "local-mcp-session", "local-mcp-session", "local-mcp-session",
		null, "local-mcp-session-2", "local-mcp-session-2", "local-mcp-session-2"]);
	const twice = parallelHttp(() => new Response("expired again", { status: 404 }));
	await assert.rejects(parallelSearch(request(), { fetchImpl: twice.fetch }), { code: "tool_error", retryable: false,
		message: "mcp__pi_web_search_parallel__web_search failed in Pi's tool pipeline: MCP session expired. Check /mcp for pi_web_search_parallel and run /reload." });
	assert.equal(twice.calls.length, 2);
});

test("a 404 carrying a response session header cannot expire a stateless request", async () => {
	const fixture = parallelHttp(() => new Response("ordinary 404", { status: 404, headers: { "mcp-session-id": "not-established" } }), { stateless: true });
	await assert.rejects(parallelSearch(request(), { fetchImpl: fixture.fetch }),
		(error: unknown) => error instanceof Error && /MCP HTTP request failed with status 404: ordinary 404/u.test(error.message));
	assert.equal(fixture.calls.length, 1);
});

test("Parallel's fresh session shares the original operation deadline", async () => {
	const fixture = parallelHttp(async () => { await sleep(210); return new Response(null, { status: 404 }); });
	let initializations = 0;
	const req = request();
	req.settings.timeoutMs = 400;
	await assert.rejects(parallelSearch(req, { fetchImpl: async (url, init) => {
		if (init?.body && JSON.parse(init.body).method === "initialize" && ++initializations === 2) await sleep(270);
		return fixture.fetch(url, init);
	} }), /timed out/i);
	assert.equal(initializations, 2);
	assert.equal(fixture.calls.length, 1);
});
