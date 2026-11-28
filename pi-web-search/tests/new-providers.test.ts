import assert from "node:assert/strict";
import test from "node:test";
import { BRAVE_CONTEXT_URL, braveSearch } from "../src/providers/brave.ts";
import { applyConfig, parseWebSearchConfig } from "../src/providers/config.ts";
import { context7Search } from "../src/providers/context7.ts";
import type { FetchLike } from "../src/providers/http.ts";
import { listRunnableProviders, runParallelSearch, type SearchRequest } from "../src/providers/index.ts";
import { clearRetrievalCache, reuseTransport } from "../src/providers/reuse.ts";
import { searxngSearch } from "../src/providers/searxng.ts";
import { isProviderError } from "../src/providers/types.ts";

const search = (query: string, extra: Partial<SearchRequest> = {}): SearchRequest =>
	({ query, settings: applyConfig("fixture", {}), ...extra });

test("Brave LLM Context stores bounded cited evidence and maps freshness", async (t) => {
	process.env.BRAVE_API_KEY = "brave-fixture-key";
	t.after(() => { delete process.env.BRAVE_API_KEY; });
	const req = search("fixture", { filters: { recency: "week" } });
	const evidence = await braveSearch(req, { fetchImpl: async (raw, init) => {
		const url = new URL(raw);
		assert.equal(url.origin + url.pathname, BRAVE_CONTEXT_URL);
		assert.equal(url.searchParams.get("freshness"), "pw");
		assert.equal(url.searchParams.get("maximum_number_of_urls"), "8");
		assert.equal(url.searchParams.get("maximum_number_of_tokens"), "8192");
		assert.equal(init.headers?.["X-Subscription-Token"], "brave-fixture-key");
		return Response.json({ grounding: { generic: [
			{ title: "Documentation", url: "https://docs.example.com/guide", snippets: ["First passage.", "Second passage."] },
			{ title: "Notes", url: "https://example.com/notes", snippets: ["Notes."] },
		], map: [] }, sources: {
			"https://docs.example.com/guide": { title: "Documentation", hostname: "docs.example.com", age: [] },
			"https://example.com/notes": { title: "Notes", hostname: "example.com", age: [] },
		} });
	} });
	assert.deepEqual(evidence.searchResults?.map((hit) => hit.citedText), ["First passage.\n\nSecond passage.", "Notes."]);
	assert.deepEqual(evidence.sources?.map(({ url }) => url), ["https://docs.example.com/guide", "https://example.com/notes"]);
	assert.equal((await braveSearch(req, { fetchImpl: async () => Response.json({ grounding: { generic: [] } }) })).searchResults?.length, 0);
	await assert.rejects(braveSearch(req, { fetchImpl: async () => new Response("a".repeat(1_048_577)) }), (error) => isProviderError(error) && error.code === "parse_error");
	for (const [status, code] of [[403, "missing_credentials"], [402, "http_error"], [429, "rate_limited"]] as const) {
		await assert.rejects(braveSearch(req, { fetchImpl: async () => Response.json({ error: { detail: "brave-fixture-key" } }, { status, headers: { "Retry-After": "4" } }) }),
			(error) => isProviderError(error) && error.code === code && !error.message.includes("brave-fixture-key") && (status !== 429 || error.retryAfterMs === 4000));
	}
});

test("SearXNG uses the configured origin and fixed route, with clear JSON setup and recency warnings", async () => {
	const settings = applyConfig("fixture", { web: { provider: "searxng", fallback: [] }, searxng: { url: "http://127.0.0.1:8080" } });
	const req = search("docs", { settings, filters: { recency: "month", domains: ["python.org", "-pinterest.com"] } });
	const result = await searxngSearch(req, { fetchImpl: async (raw, init) => {
		const url = new URL(raw);
		assert.equal(url.origin + url.pathname, "http://127.0.0.1:8080/search");
		assert.equal(init.redirect, "error");
		assert.equal(url.searchParams.get("q"), "docs -site:pinterest.com site:python.org");
		assert.equal(url.searchParams.get("time_range"), "month");
		assert.equal(url.searchParams.get("format"), "json");
		return Response.json({ results: [{ url: "https://docs.python.org/3/", title: "Python", content: "Official docs." }, { title: "No URL" }] });
	} });
	assert.equal(result.searchResults?.length, 1);
	const empty = await searxngSearch({ ...req, filters: { recency: "week" } }, { fetchImpl: async (raw) => {
		assert.equal(new URL(raw).searchParams.has("time_range"), false);
		return Response.json({ results: [] });
	} });
	assert.match(empty.warnings?.join() ?? "", /cannot apply recency "week"/);
	for (const response of [new Response(null, { status: 403 }), new Response("<html/>", { headers: { "Content-Type": "text/html" } })]) {
		await assert.rejects(searxngSearch(req, { fetchImpl: async () => response }), /search\.formats/);
	}
	for (const url of ["file:///foo", "https://user@example.com", "https://example.com/search", "https://example.com?"]) {
		assert.equal(parseWebSearchConfig({ searxng: { url } }, "fixture").status, "invalid");
	}
	assert.equal(parseWebSearchConfig({ web: { provider: "searxng" } }, "fixture").status, "invalid");
	const defaultRoutes = listRunnableProviders(applyConfig("fixture", {}));
	assert.equal(defaultRoutes.includes("searxng"), false);
	assert.equal(defaultRoutes.includes("context7"), false);
	let requests = 0;
	const thorough = await runParallelSearch(req, { family: "web", transports: {
		searxng: (request) => searxngSearch(request, { fetchImpl: async () => {
			requests++;
			return Response.json({ results: [{ url: "https://docs.python.org", content: "Fixture" }] });
		} }),
		exa: async () => { assert.fail("A SearXNG-only chain must never invoke Exa"); },
		parallel: async () => { assert.fail("A SearXNG-only chain must never invoke Parallel"); },
	} });
	assert.equal(requests, 1);
	assert.equal(thorough.searchResults?.[0].url, "https://docs.python.org");
	assert.deepEqual(thorough.warnings ?? [], []);
});

test("Context7 pins versions, caches resolves, and always cites documentation", async (t) => {
	const old = process.env.CONTEXT7_API_KEY;
	delete process.env.CONTEXT7_API_KEY;
	t.after(() => {
		if (old === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = old;
		clearRetrievalCache();
	});
	const requests: URL[] = [];
	const fetchImpl: FetchLike = async (raw, init) => {
		const url = new URL(raw);
		requests.push(url);
		assert.equal(url.origin, "https://context7.com");
		assert.equal(init.headers?.Authorization, process.env.CONTEXT7_API_KEY ? "Bearer fixture-context7-key" : undefined);
		if (url.pathname.endsWith("/libs/search")) {
			assert.equal(url.searchParams.get("libraryName"), "React");
			return Response.json({ results: [{ id: "/facebook/react" }] });
		}
		assert.equal(url.pathname, "/api/v2/context");
		return Response.json({
			libraryId: url.searchParams.get("libraryId"),
			infoSnippets: [{ content: "Documentation", rank: 1 }],
			codeSnippets: [{ codeId: "https://react.dev/docs", codeList: [{ code: "const example = 1;" }], rank: 2 }],
		});
	};
	const first = await context7Search(search("React hooks", { reuseScope: "context7-fixture" }), { fetchImpl });
	assert.deepEqual(first.searchResults?.map((hit) => hit.url), ["https://context7.com/facebook/react", "https://react.dev/docs"]);
	await context7Search(search("React state", { reuseScope: "context7-fixture" }), { fetchImpl });
	assert.deepEqual(requests.map((url) => url.pathname), ["/api/v2/libs/search", "/api/v2/context", "/api/v2/context"]);
	process.env.CONTEXT7_API_KEY = "fixture-context7-key";
	await context7Search(search("routing", { library: "/vercel/next.js@v15" }), { fetchImpl });
	assert.equal(requests.at(-1)?.searchParams.get("libraryId"), "/vercel/next.js@v15");
	const missing = await context7Search(search("Unknown"), { fetchImpl: async () => Response.json({ error: "no_libraries_found" }, { status: 404 }) });
	assert.match(missing.warnings?.join() ?? "", /no library matched/);
	const substituted = await context7Search(search("v15 docs", { library: "/vercel/next.js@v15" }), {
		fetchImpl: async () => Response.json({ version: { requested: "v15", served: "v16", status: "unverified" }, infoSnippets: [], codeSnippets: [] }),
	});
	assert.match(substituted.warnings?.join() ?? "", /could not verify the requested version/);
	const throttled = search("routing", { library: "/vercel/next.js", reuseScope: "context7-throttled" });
	let calls = 0;
	const transport = (req: SearchRequest) => context7Search(req, { fetchImpl: async () => {
		calls++;
		return new Response(null, { status: 429, headers: { "Retry-After": "5" } });
	} });
	await assert.rejects(reuseTransport("context7", throttled, transport), /429/);
	await assert.rejects(reuseTransport("context7", throttled, transport), /cooling down/);
	assert.equal(calls, 1);
});
