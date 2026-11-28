import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { clearRetrievalCache } from "../src/providers/reuse.ts";
import { assertHosts, auditCitations, directText, type Search } from "./corpus.ts";
import { evidenceFor, routes, type Fixture, type Replay, type Transport } from "./replay.ts";

const docs = (transport: Transport, query: string, step = 0): Fixture => ({
	transport, query, evidence: evidenceFor("release-contract", step, "docs", transport),
});
const hasWarning = (result: Awaited<ReturnType<Search>>, message: RegExp) =>
	assert.match(JSON.stringify(result.details.warnings), message);
const callCount = (replay: Replay) => replay.attempts.filter((event) => event.rpc === "tools/call").length;

export async function measureReleaseProviders(search: Search, replay: Replay, configPath: string) {
	const query = "configure the documented fixture mode";
	let mappedFilters = 0;
	let providerCitations = 0;
	const exa = docs("exa-rest", query);
	const deniedUrl = "https://discard.example.org/docs";
	const retainedUrl = "https://docs.example.org/manual";
	exa.evidence = [
		{ ...exa.evidence[0], url: retainedUrl },
		{ ...exa.evidence[1], url: deniedUrl },
		{ ...exa.evidence[2], url: "https://outside.invalid/manual" },
	];
	process.env.EXA_API_KEY = "SENTINEL_OFFLINE_EXA_FIXTURE";
	try {
		writeFileSync(configPath, "{}");
		exa.onRequest = (_url, init) => {
			const request = JSON.parse(String(init?.body));
			assert.ok(Number.isFinite(Date.parse(request.startPublishedDate)), "Missing Exa native recency");
			assert.deepEqual(request.includeDomains, ["example.org"]);
			assert.deepEqual(request.excludeDomains, ["discard.example.org"]);
			mappedFilters++;
		};
		replay.use([exa]);
		const filtered = await search({ query, domains: ["example.org", "-discard.example.org"], recency: "week" });
		replay.assertClean();
		assert.equal(filtered.isError, false);
		assert.deepEqual(filtered.details.searchResults?.map(({ url }) => url), [retainedUrl]);
		providerCitations += auditCitations(filtered, [exa], "Exa domains and recency").hits;
	} finally {
		delete process.env.EXA_API_KEY;
	}
	clearRetrievalCache();
	const keyless = docs("exa-advanced", query);
	keyless.evidence = exa.evidence;
	keyless.onRequest = (_url, init) => {
		const { params: { arguments: args, name } } = JSON.parse(String(init?.body));
		assert.equal(name, "web_search_advanced_exa");
		assert.ok(Number.isFinite(Date.parse(args.startPublishedDate)), "Missing keyless Exa native recency");
		assert.deepEqual(args.includeDomains, ["example.org"]);
		assert.deepEqual(args.excludeDomains, ["discard.example.org"]);
		assert.equal(args.enableHighlights, true);
		mappedFilters++;
	};
	replay.use([keyless]);
	const advanced = await search({ query, domains: ["example.org", "-discard.example.org"], recency: "day" });
	replay.assertClean();
	assert.equal(advanced.isError, false);
	assert.equal(callCount(replay), 1);
	assert.deepEqual(advanced.details.searchResults?.map(({ url }) => url), [retainedUrl]);
	providerCitations += auditCitations(advanced, [keyless], "Keyless Exa domains and recency").hits;

	const objective = "how do I cancel a fetch request after 5 seconds in node";
	const parallel = docs("parallel", objective);
	parallel.onRequest = (_url, init) => {
		const { params } = JSON.parse(String(init?.body));
		assert.equal(params.arguments.objective, objective);
		assert.ok(params.arguments.search_queries[0].length < objective.length);
	};
	writeFileSync(configPath, JSON.stringify({ web: { provider: "parallel", fallback: [] } }));
	replay.use([parallel]);
	const requested = await search({ query: objective, recency: "day" });
	replay.assertClean();
	assert.equal(requested.isError, false, directText(requested));
	hasWarning(requested, /Parallel anonymous MCP cannot apply recency/u);

	const brave = docs("brave-context", query);
	brave.onRequest = (url) => {
		assert.equal(url.searchParams.get("freshness"), "pm");
		assert.ok(Number(url.searchParams.get("maximum_number_of_tokens")) > 0);
		mappedFilters++;
	};
	process.env.BRAVE_API_KEY = "SENTINEL_OFFLINE_BRAVE_FIXTURE";
	try {
		writeFileSync(configPath, JSON.stringify({ web: { provider: "brave", fallback: [] } }));
		replay.use([brave]);
		const context = await search({ query, recency: "month" });
		replay.assertClean();
		assert.equal(context.isError, false);
		providerCitations += auditCitations(context, [brave], "Brave context").hits;
	} finally {
		delete process.env.BRAVE_API_KEY;
	}

	const searxng = docs("searxng", query);
	searxng.onRequest = (url) => {
		assert.equal(url.searchParams.get("time_range"), "day");
		assert.equal(url.searchParams.get("q"), query + " site:example.org");
		mappedFilters++;
	};
	writeFileSync(configPath, JSON.stringify({ web: { provider: "searxng", fallback: [] }, searxng: { url: new URL(routes.searxng).origin } }));
	replay.use([searxng]);
	const privateInstance = await search({ query, recency: "day", domains: ["example.org"] });
	replay.assertClean();
	assert.equal(privateInstance.isError, false);
	assertHosts(replay.attempts, [searxng], "SearXNG origin isolation");
	assert.equal(replay.attempts.length, 1, "SearXNG-only chain made an extra request");
	providerCitations += auditCitations(privateInstance, [searxng], "SearXNG").hits;
	const denied: Fixture = { ...searxng, query: query + " disabled", onRequest: undefined, fault: { id: "403", status: 403, retryable: false } };
	replay.use([denied]);
	const invalid = await search({ query: denied.query });
	replay.assertClean();
	assert.equal(invalid.details.error?.code, "invalid_config");
	assert.match(directText(invalid), /Enable "json" under search.formats/u);

	writeFileSync(configPath, JSON.stringify({ code: { provider: "context7", fallback: [] } }));
	const first = docs("context7", "library configure option");
	const second = docs("context7", "library read option", 1);
	for (const fixture of [first, second]) {
		replay.use([fixture]);
		const context = await search({ scope: "code", query: fixture.query });
		replay.assertClean();
		assert.equal(context.isError, false);
		assert.deepEqual(replay.attempts.map(({ path }) => path), ["/api/v3/search"], "Context7 must search the full query in one request");
		providerCitations += auditCitations(context, [fixture], "Context7 document search").hits;
	}
	writeFileSync(configPath, "{}");
	const pinned = docs("context7", "configure feature", 2);
	pinned.library = "/public-example/library@v3";
	replay.use([pinned]);
	const versioned = await search({ scope: "code", query: "library:/public-example/library@v3 configure feature" });
	replay.assertClean();
	assert.equal(versioned.isError, false);
	assert.deepEqual(replay.attempts.map(({ path }) => path), ["/api/v2/context"]);
	providerCitations += auditCitations(versioned, [pinned], "Context7 version pin").hits;
	return { mappedFilters, recencyWarnings: 1, providerCitations, searxngOnlyRequests: 1, context7SearchRequests: [1, 1], context7PinnedRequests: 1 };
}

export async function measureReleaseEfficiency(search: Search, replay: Replay, configPath: string) {
	writeFileSync(configPath, "{}");
	const emptyQuery = "synthetic empty primary";
	const empty: Fixture = { transport: "exa", query: emptyQuery, evidence: [] };
	const healthy = docs("parallel", emptyQuery);
	replay.use([empty, healthy]);
	const recovered = await search({ query: emptyQuery });
	replay.assertClean();
	assert.equal(recovered.isError, false);
	assert.equal(callCount(replay), 2);
	auditCitations(recovered, [healthy], "empty fallback");
	hasWarning(recovered, /exa returned no results/u);

	const query = "synthetic anchorpoint";
	const passages = ["Archived background. ".repeat(18), "Historical notes. ".repeat(19),
		"The relevant passage describes anchorpoint and its synthetic example."];
	const ranked = docs("exa", query);
	ranked.evidence = [{ ...ranked.evidence[0], text: passages.join("\n\n") }];
	replay.use([ranked]);
	const preview = await search({ query });
	replay.assertClean();
	assert.equal(preview.isError, false);
	assert.match(directText(preview), /relevant passage describes anchorpoint/u);
	assert.doesNotMatch(directText(preview), /Archived background/u);
	auditCitations(preview, [ranked], "query-aware preview");

	const batch = [docs("exa", "fixture alpha", 1), docs("exa", "fixture beta", 2), docs("exa", "fixture gamma", 3)];
	replay.use(batch);
	const batched = await search({ query: batch.map((entry) => entry.query!) });
	replay.assertClean();
	assert.equal(batched.isError, false, directText(batched));
	assert.equal(callCount(replay), 3);
	const hitUrls = new Set(batched.details.searchResults?.map(({ url }) => url));
	assert.ok(batch.every(({ evidence }) => evidence.some(({ url }) => hitUrls.has(url))), "Batch lost a query group");
	const citedBatchHits = auditCitations(batched, batch, "batch").hits;

	const mixed: Fixture[] = [
		docs("exa", "fixture partial alpha", 1),
		{ ...docs("exa", "fixture partial beta", 2), fault: { id: "502", status: 502, retryable: true } },
		docs("exa", "fixture partial gamma", 3),
	];
	writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: [] } }));
	replay.use(mixed);
	const partial = await search({ query: mixed.map((entry) => entry.query!) });
	replay.assertClean();
	assert.equal(partial.isError, false, directText(partial));
	assert.equal(callCount(replay), 3);
	assert.deepEqual(partial.details.queryGroups?.map(({ query, failed }) => [query, failed ?? false]),
		mixed.map(({ query, fault }) => [query, fault !== undefined]));
	hasWarning(partial, /Query 2 failed/u);
	auditCitations(partial, [mixed[0], mixed[2]], "partially failed batch");
	return { emptyFallbackRequests: 2, queryAwarePreviews: 1, batchedToolCalls: 1, batchProviderCalls: 3, citedBatchHits, partialBatchGroupsRetained: 2 };
}
