import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatWebSearchResult, type WebSearchDetails } from "../src/format.ts";
import { formatSearchError } from "../src/utils.ts";
import { githubSearch } from "../src/providers/github.ts";
import { jinaFetch } from "../src/providers/jina.ts";
import { parallelSearch } from "../src/providers/parallel.ts";
import { applyConfig } from "../src/providers/config.ts";
import { providerError, type StreamResult } from "../src/providers/types.ts";
import { search, type SearchInput } from "../src/search.ts";
import { renderCall, renderResult, type TranscriptState } from "../src/ui/transcript.ts";
import { plainTheme } from "./fixtures/panel.ts";

const ctx = {} as ExtensionContext;
const output = (details: WebSearchDetails, args: SearchInput = {}, expanded = false, state: TranscriptState = {}) => {
	return renderResult({ details, content: [{ type: "text", text: "## Results\n\nRead: search({ref: 'secret'})" }] }, { expanded, isPartial: false }, plainTheme, { args, state, isError: false });
};
const show = (details: WebSearchDetails, args?: SearchInput, expanded?: boolean) => output(details, args, expanded).render(170).join("\n");
const call = (args: SearchInput, state: TranscriptState = {}) => renderCall(args, plainTheme, { state }).render(120).join("\n");

test("call line only labels non-default modes and never shows opaque refs", () => {
	assert.equal(call({ query: "AbortSignal.timeout" }), 'search "AbortSignal.timeout"');
	assert.equal(call({ query: "useSyncExternalStore repo:vercel/next.js", scope: "code" }), 'search "useSyncExternalStore" code · vercel/next.js');
	assert.equal(call({ query: "AbortSignal.timeout", effort: "thorough" }), 'search "AbortSignal.timeout" multi-source');
	assert.equal(call({ urls: ["https://x.test", "https://y.test"] }), "search 2 URLs");
	assert.equal(call({ ref: "private" }), "search saved results");
	const args = { ref: "private:2", find: "timeout" }, state = {};
	const header = renderCall(args, plainTheme, { state });
	const passage: WebSearchDetails = { ref: args.ref, storedCount: 8, passage: { index: 2, offset: 0, totalChars: 9000, matches: 1 }, more: true, searchResults: [{ url: "https://nodejs.org/api", citedText: "timeout" }] };
	const body = output(passage, args, false, state);
	assert.equal(header.render(80)[0], "search result 2 of 8");
	assert.equal(body.render(80)[0], 'nodejs.org · characters 1–7 of 9000 · matched "timeout"');
});

test("summary orders count, top domains, unusual states and duration", () => {
	const details: WebSearchDetails = {
		provider: "exa", providers: ["exa", "parallel"], durationMs: 1111,
		searchResults: ["developer.mozilla.org", "nodejs.org", "github.com", "web.dev", "nodejs.org"].map((domain) => ({ url: `https://${domain}/x` })),
		classifier: { suppressed: 2, suppressedUrls: ["https://unsafe.test"], sufficient: true, lowConfidence: false }, classifierStatus: "ran",
	};
	assert.equal(show(details), "5 results from 2 sources · developer.mozilla.org, nodejs.org, github.com +1 · ranked · 2 hidden as unsafe · 1.1s");
	assert.equal(show({ ...details, cached: true, providers: undefined, classifier: undefined, classifierStatus: "disabled" }), "5 results · developer.mozilla.org, nodejs.org, github.com +1 · cached");
	assert.equal(show({ urlsRequested: 3, urlsRead: 2, searchResults: [{ url: "https://nodejs.org" }, { url: "https://web.dev" }] }), "Read 2 of 3 pages · nodejs.org, web.dev · 1 couldn't be read");
	assert.equal(show({ scope: "code", attempted: ["grep", "sourcegraph", "github"] }), "No matches · grep.app, Sourcegraph, GitHub · not proof the code doesn't exist");
	assert.equal(show({ scope: "code", durationMs: 801, searchResults: [
		{ title: "vercel/next.js/packages/fetch.ts", url: "https://github.com/vercel/next.js/blob/main/packages/fetch.ts#L42" },
		{ title: "vercel/next.js/packages/fetch.ts", url: "https://github.com/vercel/next.js/blob/main/packages/fetch.ts#L48" },
		{ title: "vercel/next.js/README.md", url: "https://github.com/vercel/next.js/blob/main/README.md#L1" },
	] }), "3 matches in 2 files · vercel/next.js · 0.8s");
});

test("expanded rows are built from cited details, with code gutter and a single provenance footer", () => {
	const details: WebSearchDetails = { contributors: ["exa", "grep"], durationMs: 1100, excerptsShortened: 3, searchResults: [
		{ title: "AbortSignal: timeout() static method", url: "https://developer.mozilla.org/a", citedText: "Returns an AbortSignal", ref: "secret:1" },
		{ title: "vercel/next.js/packages/fetch.ts", url: "https://github.com/vercel/next.js/blob/main/packages/fetch.ts#L42", source: "grep", citedText: "const signal = AbortSignal.timeout(ms)\nawait fetch(url, { signal })", ref: "secret:2" },
	] };
	assert.equal(show(details, {}, true), [
		"1  AbortSignal: timeout() static method", "   developer.mozilla.org", "   Returns an AbortSignal", "",
		"2  vercel/next.js packages/fetch.ts:42", "   │ const signal = AbortSignal.timeout(ms)", "   │ await fetch(url, { signal })", "",
		"via Exa + grep.app · 1.1s · 3 excerpts shortened",
	].join("\n"));
	for (const width of [1, 5, 20]) assert.ok(output(details, {}, true).render(width).every((line) => visibleWidth(line) <= width));
	assert.doesNotMatch(show({ searchResults: [{ title: "x\x1b[31m\ny", citedText: "reading" }] }, {}, true), /\x1b|secret|Read: search|## Results/);
});

test("partial and terminal errors never print model diagnostics", () => {
	const partial = renderResult({ content: [{ type: "text", text: "◌ grep.app…" }], details: {} }, { isPartial: true, expanded: false }, plainTheme, { args: {}, state: {}, isError: false });
	assert.equal(partial.render(100)[0], "◌ grep.app…");
	assert.equal(show({ attempted: ["exa", "parallel"], allRateLimited: true, error: { code: "rate_limited", message: "do not show" } }), "✕ Couldn't search. Exa and Parallel are both rate limited. Try again in a minute.");
	assert.equal(show({ thoroughOff: true, error: { code: "invalid_config", message: "internal" } }), "✕ Multi-source is off. /web-search to turn it on.");
	assert.equal(show({ error: { code: "invalid_config", message: "internal" }, configIssue: 'unknown setting "maxResult" (line 4)' }), '✕ Search settings are broken: unknown setting "maxResult" (line 4). /web-search to fix.');
});

test("search emits fallback stages and adds UI metadata without changing either evidence channel", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-transcript-"));
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	const config = join(dir, "web-search.json");
	process.env.PI_WEB_SEARCH_CONFIG = config;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = previous;
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(config, "{}");
	const updates: string[] = [];
	const evidence = { providerKind: "parallel" as const, text: "", searchResults: [{ title: "Evidence", url: "https://example.test", citedText: "preview" }] };
	const res = await search("test", { query: "test" }, undefined, ({ content }) => {
		updates.push(content[0].type === "text" ? content[0].text : "");
	}, ctx, { transports: {
		exa: async () => { throw providerError("rate_limited", "quota exhausted"); },
		parallel: async () => evidence,
	} });
	assert.deepEqual(updates, ["◌ Exa…", "◌ Exa is rate limited · trying Parallel…"]);
	assert.deepEqual(res.details.attempted, ["exa", "parallel"]);
	assert.equal(typeof res.details.durationMs, "number");
	assert.equal(res.details.cached, false);
	const expected = formatWebSearchResult({ ...evidence, warnings: ["exa failed (rate_limited): quota exhausted"] });
	assert.deepEqual(res.content, expected.content);
	assert.deepEqual(res.structuredContent, expected.structuredContent);
	assert.match(show(res.details, {}, true), /via Parallel · partial retrieval · Exa unavailable/);

	const unavailable = await search("test", { query: "test" }, undefined, undefined, ctx, { availability: { exa: false, parallel: false, brave: false } });
	const main = formatSearchError("search", providerError("missing_credentials", "exa: No web provider is available. Enable Parallel's native MCP server in Pi (/mcp), or configure Exa."));
	assert.deepEqual(unavailable.content, main.content);
	assert.deepEqual(unavailable.structuredContent, main.structuredContent);
	assert.match(show(unavailable.details), /No web provider is ready.*check providers and Accounts/);

	await writeFile(config, '{"research":{"enabled":true}}');
	const thoroughUpdates: string[] = [];
	const wide = await search("test", { query: "test", effort: "thorough" }, undefined, ({ content }) => {
		if (content[0].type === "text") thoroughUpdates.push(content[0].text);
	}, ctx, { availability: { exa: true, parallel: true }, transports: {
		exa: async () => ({ ...evidence, providerKind: "exa", searchResults: [{ url: "https://exa.test", citedText: "another excerpt" }] }),
		parallel: async () => evidence,
	} });
	assert.deepEqual(thoroughUpdates, ["◌ Exa + Parallel…"]);
	assert.deepEqual(wide.details.contributors, ["exa", "parallel"]);
	assert.match(show(wide.details, {}, true), /via Exa \+ Parallel/);

	const partial = await search("test", { query: "test", effort: "thorough" }, undefined, undefined, ctx,
		{ availability: { exa: true, parallel: true }, transports: {
			exa: async () => ({ text: "", providerKind: "exa", searchResults: [{ type: "unparsed", source: "exa", citedText: "Raw Exa reply" }] }),
			parallel: async () => evidence,
		} });
	assert.deepEqual(partial.details.contributors, ["parallel"]);
	assert.match(show(partial.details), /1 result.*Unparsed provider reply/);
	assert.doesNotMatch(show(partial.details), /from 2 sources/);
	assert.match(show(partial.details, {}, true), /via Parallel/);
	assert.match(show(partial.details, {}, true), /Unparsed provider reply/);
	assert.doesNotMatch(JSON.stringify(partial.structuredContent), /unparsedReply|contributors/);
});

test("call render tolerates malformed arguments both before and after host validation", () => {
	for (const raw of [undefined, null, 42, "text", { ref: 42, query: [], scope: "invalid", urls: {} }, { urls: [123], query: false }]) {
		assert.equal(renderCall(raw, plainTheme, { state: {} }).render(100)[0], "search");
	}
	const raw = { scope: "code", query: 42 as unknown };
	const component = renderCall(raw, plainTheme, { state: {} });
	assert.equal(component.render(100)[0], "search code");
	raw.query = "content repo:owner/project";
	assert.equal(component.render(100)[0], 'search "content" code · owner/project');
});

test("extraction reads count distinct verified requested documents before preview clipping", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-extraction-transcript-"));
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = previous;
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify({ maxResults: 1 }));
	const args = { urls: ["https://one.test/#a", "https://ONE.test:443/#b", "https://two.test/a", "https://three.test/a"] };
	const extract = { type: "extract", citedText: "verified text" };
	const fetchPages = async (): Promise<StreamResult> => ({
		providerKind: "jina", text: "", searchResults: [
			{ ...extract, url: "https://one.test/" }, { ...extract, url: "https://one.test/#other" },
			{ ...extract, url: "https://two.test/a" },
			{ url: "https://three.test/a", type: "unparsed", citedText: "raw evidence" },
			{ ...extract, url: "https://unverified.test/" },
		],
	});
	const retrieve = () => search("test", args, undefined, undefined, ctx, { fetchUrls: fetchPages });
	const res = await retrieve();
	assert.equal(res.details.urlsRequested, 3);
	assert.equal(res.details.urlsRead, 2);
	assert.equal(res.details.searchResults?.length, 1);
	assert.match(show(res.details, args), /^Read 2 of 3 pages/);
	assert.doesNotMatch(JSON.stringify(res.structuredContent), /urlsRead/);
	await writeFile(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify({ maxResults: 8 }));
	const unclipped = await retrieve();
	assert.equal(unclipped.details.urlsRead, 2);
	assert.ok(unclipped.details.searchResults?.some((hit) => hit.type === "unparsed" && hit.citedText === "raw evidence"));
});

test("suppressed results and skipped ranking are shown from formatted results", () => {
	const suppressed = formatWebSearchResult({
		text: "", providerKind: "github", scope: "code", searchResults: [], classifierStatus: "ran",
		classifier: { sufficient: false, lowConfidence: false, suppressed: 1, suppressedUrls: [] },
	});
	assert.match(show(suppressed.details), /^No visible results.*1 hidden as unsafe/);
	const skipped = formatWebSearchResult({ text: "", providerKind: "exa", classifierStatus: "skipped", searchResults: [{ url: "https://example.test" }] });
	assert.match(show(skipped.details), /ranking skipped/);
});

test("expanded errors wrap the full remedy and expanded evidence keeps warnings", () => {
	const error = output({ configIssue: 'unknown setting "repeatedly misspelled classifier property" (line 8)',
		error: { code: "invalid_config", message: "not rendered" } }, {}, true);
	const lines = error.render(78);
	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 78));
	assert.match(lines.join(" "), /\/web-search to fix\./);
	assert.doesNotMatch(lines.join(" "), /not rendered/);

	const details = formatWebSearchResult({ providerKind: "exa", text: "", classifierStatus: "skipped",
		searchResults: [{ url: "https://example.test", citedText: "citation" }] }).details;
	Object.assign(details, { urlsRequested: 2, urlsRead: 1, classifier: { suppressed: 1 } });
	const expanded = output(details, {}, true).render(46).join(" ");
	for (const signal of ["ranking skipped", "1 couldn't be read", "1 hidden as unsafe"]) assert.ok(expanded.includes(signal), expanded);
});

test("Pi-side blocked and schema-rejected calls do not suggest changing providers", () => {
	for (const raw of ["Blocked by policy: fixture-only", "Invalid arguments: fixture-only"]) {
		for (const expanded of [false, true]) {
			const result = renderResult({ content: [{ type: "text", text: raw }], details: undefined!, isError: true },
				{ expanded, isPartial: false }, plainTheme, { args: {}, state: {}, isError: true });
			const text = result.render(78).join(" ");
			assert.match(text, /Search didn’t run/);
			assert.match(text, /tool arguments or Pi’s permissions/);
			assert.doesNotMatch(text, /fixture-only|provider|\/web-search/);
		}
	}
});

test("wrapped expanded errors never exceed the width, even with wide glyphs", () => {
	const result = output({ configIssue: "未知の設定", error: { code: "invalid_config", message: "internal" } }, {}, true);
	for (const width of [1, 2, 3, 10]) {
		assert.ok(result.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("GitHub coverage notices survive in both views without exposing private hits", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-github-coverage-"));
	const previous = { PI_WEB_SEARCH_CONFIG: process.env.PI_WEB_SEARCH_CONFIG, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
	process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
	process.env.GITHUB_TOKEN = "fixture-token";
	t.after(async () => {
		for (const [id, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[id]; else process.env[id] = value;
		}
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(process.env.PI_WEB_SEARCH_CONFIG, '{"code":{"provider":"github","fallback":[]}}');
	const hidden = { path: "not-public-fixture", repository: { private: true, full_name: "private/fixture" } };
	const publicHit = { path: "visible.ts", repository: { private: false, full_name: "open/project" } };
	const args = { query: "hello", scope: "code" } as const;
	for (const incomplete of [false, true]) {
		const result = await search("test", args, undefined, undefined, ctx, {
			availability: { github: true },
			transports: { github: (req) => githubSearch(req, { fetchImpl: async () => Response.json({
				incomplete_results: incomplete, items: incomplete ? [hidden, publicHit] : [hidden],
			}) }) },
		});
		for (const expanded of [false, true]) {
			const rendered = show(result.details, args, expanded);
			assert.match(rendered, incomplete ? /Search incomplete/ : /No public matches shown/);
			assert.doesNotMatch(rendered, /No matches|not-public-fixture|private\/fixture/);
		}
		assert.doesNotMatch(JSON.stringify(result.structuredContent), /withheldMatches|incompleteSearch|not-public-fixture|private\/fixture/);
	}
});

test("unparsed provider prose is labeled and excluded from the human hit count", () => {
	const raw = { type: "unparsed", source: "exa", citedText: "Verbatim provider prose without a citation" };
	const args = { query: "test" } as const;
	const details = { provider: "exa", searchResults: [raw], resultCount: 1 } as const;
	const single = { ...details, searchResults: [...details.searchResults] };
	assert.match(show(single, args), /Unparsed provider reply/);
	assert.doesNotMatch(show(single, args), /1 result|No results/);
	const expanded = show(single, args, true);
	assert.match(expanded, /Unparsed provider reply/);
	assert.match(expanded, /Verbatim provider prose without a citation/);
	assert.doesNotMatch(expanded, /Result 1/);
	assert.match(show({ ...single, resultCount: 2, searchResults: [raw, { url: "https://example.test" }] }, args), /1 result.*Unparsed provider reply/);
});

test("Parallel initialization rejection keeps the legacy error and directs humans to Accounts", async () => {
	let error: unknown;
	try {
		await parallelSearch({ query: "test", settings: applyConfig("fixture", {}) },
			{ fetchImpl: async () => new Response("Unauthorized", { status: 401 }) });
	} catch (cause) { error = cause; }
	assert.ok(error);
	const actual = formatSearchError("search", error);
	const legacy = formatSearchError("search", providerError("tool_error",
		"mcp__pi_web_search_parallel__web_search failed in Pi's tool pipeline: Tool mcp__pi_web_search_parallel__web_search not found. Check /mcp for pi_web_search_parallel and run /reload.",
		{ retryable: false }));
	assert.equal(actual.details.parallelHttpStatus, 401);
	assert.equal(actual.details.error?.code, "tool_error");
	assert.deepEqual(actual.content, legacy.content);
	assert.deepEqual(actual.structuredContent, legacy.structuredContent);
	for (const expanded of [false, true]) assert.match(show(actual.details, {}, expanded), /Parallel rejected access.*Accounts/);
});

test("Sourcegraph repo paths use the blob boundary before the title heuristic", () => {
	const details = { scope: "code" as const, searchResults: [{
		source: "sourcegraph", title: "gitlab.com/group/project/src/file name.ts",
		url: "https://sourcegraph.com/gitlab.com/group/project@abcdef/-/blob/src/file%20name.ts#L42", citedText: "code",
	}] };
	assert.match(show(details), /· gitlab\.com\/group\/project$/);
	assert.match(show(details, {}, true), /gitlab\.com\/group\/project src\/file name\.ts:42/);
});

test("Jina target denial suggests a public URL, not Accounts", async () => {
	const url = "https://example.test/private";
	const args = { urls: [url] };
	const result = await search("test", args, undefined, undefined, ctx, {
		fetchUrls: (req) => jinaFetch(req, { fetchImpl: async () => Response.json({
			data: { url, content: "Forbidden", httpStatus: 403 },
		}) }),
	});
	assert.deepEqual(result.details.attempted, ["jina"]);
	assert.equal(result.details.error?.status, 403);
	assert.match(JSON.stringify(result.structuredContent), /Jina target returned HTTP 403/);
	for (const expanded of [false, true]) {
		assert.equal(show(result.details, args, expanded), "✕ Couldn’t read this URL. Check that the page is publicly accessible.");
	}
	assert.match(show({ attempted: ["exa"], error: { code: "http_error", status: 403, message: "" } }), /check the key/);
});

test("Parallel initialization 429 classifies the UI failure without changing fallback or model errors", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-parallel-throttle-"));
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = previous;
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(process.env.PI_WEB_SEARCH_CONFIG, '{"web":{"provider":"exa","fallback":["parallel","brave"]}}');
	let braveCalls = 0;
	const args = { query: "test" };
	const result = await search("test", args, undefined, undefined, ctx, {
		availability: { exa: true, parallel: true, brave: true },
		transports: {
			exa: async () => { throw providerError("rate_limited", "quota exhausted"); },
			parallel: (req) => parallelSearch(req, { fetchImpl: async () => new Response("Too many requests", { status: 429 }) }),
			brave: async () => { braveCalls++; return { text: "", providerKind: "brave" }; },
		},
	});
	assert.equal(braveCalls, 0);
	assert.equal(result.details.parallelHttpStatus, 429);
	assert.equal(result.details.allRateLimited, true);
	assert.equal(result.details.error?.code, "tool_error");
	assert.equal(result.details.error?.retryable, false);
	assert.doesNotMatch(JSON.stringify(result.structuredContent), /parallelHttpStatus|allRateLimited|rate_limited/);
	for (const expanded of [false, true]) {
		assert.equal(show(result.details, args, expanded), "✕ Couldn't search. Exa and Parallel are both rate limited. Try again in a minute.");
	}
});

test("expanded zero-result searches show the duration only once", () => {
	assert.equal(show({ resultCount: 0, durationMs: 1000 }, {}, true), "No results · 1.0s");
});

