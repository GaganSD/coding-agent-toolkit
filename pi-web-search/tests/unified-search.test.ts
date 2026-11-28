import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatResult, type WebSearchDetails } from "../src/format.ts";
import { CONFIG_PATH_ENV_VAR } from "../src/providers/config.ts";
import { providerError, type StreamResult } from "../src/providers/types.ts";
import { SearchSchema, search } from "../src/search.ts";

const ctx = {} as ExtensionContext;

function textOf(result: AgentToolResult<WebSearchDetails>): string {
	const item = result.content[0];
	assert.equal(item.type, "text");
	return item.text;
}

async function withSettings(settings: unknown, run: () => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "unified-search-"));
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	try {
		const path = join(dir, "web-search.json");
		await writeFile(path, typeof settings === "string" ? settings : JSON.stringify(settings));
		process.env[CONFIG_PATH_ENV_VAR] = path;
		await run();
	} finally {
		if (previous === undefined) delete process.env[CONFIG_PATH_ENV_VAR];
		else process.env[CONFIG_PATH_ENV_VAR] = previous;
		await rm(dir, { recursive: true, force: true });
	}
}

function document(providerKind: StreamResult["providerKind"], url = "https://example.test/evidence"): StreamResult {
	return {
		text: "",
		providerKind,
		searchResults: [{ title: `${providerKind} evidence`, url, citedText: `${providerKind} cited text` }],
		sources: [{ title: `${providerKind} evidence`, url }],
	};
}

test("unified search exposes one flat schema with documented defaults", () => {
	assert.deepEqual(Object.keys(SearchSchema.properties).sort(), [
		"cursor", "domains", "effort", "find", "query", "recency", "ref", "scope", "urls",
	]);
	const schema = JSON.stringify(SearchSchema);
	assert.match(schema, /"web"/);
	assert.match(schema, /"code"/);
	assert.match(schema, /"both"/);
	assert.match(schema, /"fast"/);
	assert.match(schema, /"thorough"/);
	for (const legacy of ["web_search", "code_search", "multi_search", "resultId", "index"]) {
		assert.equal(schema.includes(`"${legacy}"`), false, `${legacy} must not be in the unified schema`);
	}
});

test("unified search rejects absent, multiple, unknown, and inappropriate selectors", async () => {
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{}, /Use exactly one of query, urls, or ref/],
		[{ query: "one", urls: ["https://example.test"] }, /Use exactly one of query, urls, or ref/],
		[{ query: "one", ref: "0:1" }, /Use exactly one of query, urls, or ref/],
		[{ urls: ["https://example.test"], ref: "0:1" }, /Use exactly one of query, urls, or ref/],
		[{ query: "   " }, /query must not be blank/],
		[{ urls: [] }, /urls must contain at least one URL/],
		[{ query: "one", find: "needle" }, /find and cursor require ref/],
		[{ urls: ["https://example.test"], cursor: "next" }, /find and cursor require ref/],
		[{ query: "one", limit: 5 }, /Unknown parameter: limit/],
		[{ urls: ["https://example.test"], scope: "code" }, /urls accept only web scope/],
		[{ urls: ["https://example.test"], effort: "thorough" }, /urls do not accept effort/],
		[{ ref: "0:1", scope: "web" }, /ref does not accept scope/],
		[{ ref: "0:1", effort: "fast" }, /ref does not accept effort/],
		[{ query: "one", scope: "both", effort: "fast" }, /scope both requires effort thorough/],
	];
	for (const [input, message] of cases) {
		const result = await search("call", input, undefined, undefined, ctx);
		assert.equal(result.isError, true, JSON.stringify(input));
		assert.equal(result.details.error?.code, "unknown");
		assert.match(result.details.error?.message ?? "", /^search failed \(unknown\): /);
		assert.match(result.details.error?.message ?? "", message);
	}
});

test("fast web query uses the configured provider then its fallback", async () => {
	await withSettings({ web: { provider: "exa", fallback: ["parallel"] } }, async () => {
		const calls: string[] = [];
		const result = await search("call", { query: "fast web" }, undefined, undefined, ctx, {
			availability: { exa: true, parallel: true },
			transports: {
				exa: async () => { calls.push("exa"); throw providerError("timeout", "exa timed out"); },
				parallel: async () => { calls.push("parallel"); return document("parallel"); },
			},
		});
		assert.deepEqual(calls, ["exa", "parallel"]);
		assert.equal(result.isError, false);
		assert.equal(result.details.scope, "web");
		assert.equal(result.details.provider, "parallel");
		assert.equal(result.details.classifierStatus, "disabled");
	});
});

test("fast code query stays in the code family and never waits for MCP", async () => {
	await withSettings({}, async () => {
		let webCalls = 0;
		const result = await search("call", { query: "AbortSignal.timeout", scope: "code" }, undefined, undefined, ctx, {
			availability: { grep: true, exa: true },
			transports: {
				exa: async () => { webCalls++; return document("exa"); },
				grep: async () => document("grep", "https://github.test/file"),
			},
		});
		assert.equal(result.isError, false);
		assert.equal(result.details.scope, "code");
		assert.equal(result.details.provider, "grep");
		assert.equal(webCalls, 0);
	});
});

test("scope both defaults to thorough and fans out once research is enabled", async () => {
	await withSettings({ research: { enabled: true } }, async () => {
		const calls: string[] = [];
		const result = await search("call", { query: "AbortSignal.timeout", scope: "both" }, undefined, undefined, ctx, {
			availability: { exa: true, grep: true },
			transports: {
				exa: async () => { calls.push("exa"); return document("exa"); },
				grep: async () => { calls.push("grep"); return document("grep", "https://github.test/file"); },
			},
		});
		assert.deepEqual(calls.sort(), ["exa", "grep"]);
		assert.equal(result.isError, false);
		assert.equal(result.details.scope, "both");
		assert.equal(result.details.classifierStatus, "disabled");
	});
});

test("thorough query is gated by research.enabled before any transport runs", async () => {
	await withSettings({ research: { enabled: false } }, async () => {
		const calls: string[] = [];
		const result = await search("call", { query: "gated", effort: "thorough" }, undefined, undefined, ctx, {
			availability: { exa: true },
			transports: { exa: async () => { calls.push("exa"); return document("exa"); } },
		});
		assert.equal(result.isError, true);
		assert.equal(result.details.error?.code, "invalid_config");
		assert.match(result.details.error?.message ?? "", /^search failed \(invalid_config\): /);
		assert.match(result.details.error?.message ?? "", /thorough search is disabled/);
		assert.match(result.details.error?.message ?? "", /research/);
		assert.deepEqual(calls, []);
	});
});

test("URL-only calls use the extractor and do not start a search transport", async () => {
	await withSettings({}, async () => {
		let searchCalls = 0;
		let extracted: string[] = [];
		const result = await search("call", { urls: ["https://example.test/page"] }, undefined, undefined, ctx, {
			availability: { exa: true },
			transports: { exa: async () => { searchCalls++; return document("exa"); } },
			fetchUrls: async (req) => { extracted = req.urls ?? []; return document("jina", "https://example.test/page"); },
		});
		assert.equal(result.isError, false);
		assert.deepEqual(extracted, ["https://example.test/page"]);
		assert.equal(searchCalls, 0);
		assert.equal(result.details.provider, "jina");
		assert.equal(result.details.resultCount, 1);
	});
});

test("ref reads stay local, pass find/cursor through, and ignore broken settings", async () => {
	await withSettings("{ broken", async () => {
		const priorFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("ref must never access the network"); };
		const seen: Array<{ ref: string; find?: string; cursor?: string }> = [];
		try {
			const local = formatResult("More evidence: search({ ref: \"opaque:2\" })", { resultCount: 1, grounded: true, provider: "exa" });
			const result = await search("call", { ref: "opaque:2", find: "needle", cursor: "next" }, undefined, undefined, ctx, {
				readRef: async (params) => {
					seen.push({ ref: params.ref, find: params.find, cursor: params.cursor });
					return local;
				},
			});
			assert.equal(result.isError, false);
			assert.deepEqual(seen, [{ ref: "opaque:2", find: "needle", cursor: "next" }]);
			assert.deepEqual(result.content, local.content, "direct content is returned exactly as the evidence reader produced it");
			assert.deepEqual(result.structuredContent, local.structuredContent);
			assert.equal(typeof result.details.durationMs, "number");
		} finally {
			globalThis.fetch = priorFetch;
		}
	});
});

test("web filters reject incompatible arguments with the field named", async () => {
	for (const [filter, value] of [["recency", "week"], ["domains", ["python.org"]]] as const) {
		for (const args of [{ urls: ["https://example.test"] }, { ref: "evidence:1" }, { query: "needle", scope: "code" as const }]) {
			const result = await search("call", { ...args, [filter]: value }, undefined, undefined, ctx);
			assert.equal(result.details.error?.message, `search failed (unknown): ${filter} requires query and web scope.`);
		}
	}
});

test("domain filters apply locally to both lists and subdomains before evidence is stored", async () => {
	const allowed = "https://docs.python.org/3";
	const rejected = [
		"https://www.pinterest.com/wrong",
		"https://private.python.org/hidden",
		"https://python.org.example.test/masquerade",
	];
	const owner = { sessionManager: { getSessionId: () => "filter-fixture" } } as ExtensionContext;
	const documentFixture: StreamResult = {
		text: "An unattributed provider summary.",
		providerKind: "exa",
		searchResults: [allowed, ...rejected].map((url) => ({ url, citedText: "cited passage" })),
		sources: [allowed, ...rejected].map((url) => ({ url, title: url })),
	};
	await withSettings({}, async () => {
		const result = await search("call", {
			query: "needle",
			domains: ["PYTHON.ORG.", "pinterest.com", "-pinterest.com", "-private.python.org"],
			recency: "week",
		}, undefined, undefined, owner, {
			transports: { exa: async (req) => {
				assert.deepEqual(req.filters, {
					recency: "week", domains: ["python.org", "pinterest.com", "-pinterest.com", "-private.python.org"],
				});
				return documentFixture;
			} },
		});
		assert.equal(result.details.storedCount, 1);
		assert.deepEqual(result.details.searchResults?.map(({ url }) => url), [allowed]);
		assert.deepEqual(result.details.sources?.map(({ url }) => url), [allowed]);
		assert.doesNotMatch(textOf(result), /unattributed|pinterest|masquerade/);
	});
});

test("fast web search continues after a successful empty response and names every empty provider", async () => {
	await withSettings({ web: { provider: "exa", fallback: ["parallel"] } }, async () => {
		const attempts: string[] = [];
		const run = (parallelHasResults: boolean) => search("call", { query: "needle" }, undefined, undefined, ctx, {
			transports: {
				exa: async () => { attempts.push("exa"); return { text: "", providerKind: "exa", searchResults: [] }; },
				parallel: async () => {
					attempts.push("parallel");
					return parallelHasResults ? document("parallel") : { text: "", providerKind: "parallel", searchResults: [] };
				},
			},
		});
		const fallback = await run(true);
		assert.deepEqual(attempts, ["exa", "parallel"]);
		assert.equal(fallback.details.provider, "parallel");
		assert.deepEqual(fallback.details.warnings, ["exa returned no results."]);
		const empty = await run(false);
		assert.equal(empty.isError, false);
		assert.deepEqual(empty.details.warnings, ["exa returned no results.", "parallel returned no results."]);
	});
});

test("BM25 previews select the matching passage and keep a winning provider highlight", async () => {
	const unrelated = "A group of archivists compiled the records. ".repeat(8).trim();
	const answer = "AbortSignal timeout cancels a network request once the delay expires.";
	const highlight = "AbortSignal timeout cancels network requests.";
	const owner = { sessionManager: { getSessionId: () => "preview-fixture" } } as ExtensionContext;
	await withSettings({}, async () => {
		for (const upstreamHighlight of [undefined, highlight]) {
			const text = [unrelated, unrelated, upstreamHighlight ?? answer].join("\n\n");
			const result = await search("call", { query: "AbortSignal timeout" }, undefined, undefined, owner, {
				transports: { exa: async () => ({
					...document("exa"),
					searchResults: [{ url: "https://example.test/evidence", title: "Docs", citedText: text, highlight: upstreamHighlight }],
				}) },
			});
			const shown = (result.structuredContent as WebSearchDetails).searchResults?.[0];
			assert.ok(shown?.ref);
			assert.equal(shown.citedText, upstreamHighlight ?? answer);
			const read = await search("read", { ref: shown.ref }, undefined, undefined, owner);
			assert.equal(read.isError, false);
			assert.match(textOf(read), /A group of archivists/);
			assert.match(textOf(read), /AbortSignal timeout/);
		}
	});
});

test("a single string keeps its regular result format", async () => {
	await withSettings({}, async () => {
		const result = await search("call", { query: "exa" }, undefined, undefined, ctx, {
			transports: { exa: async () => document("exa") },
		});
		assert.equal(textOf(result), "## Results\n\n1. [exa evidence](https://example.test/evidence)\n> exa cited text");
		assert.deepEqual(result.structuredContent, {
			status: "success",
			searchResults: [{ title: "exa evidence", url: "https://example.test/evidence", citedText: "exa cited text" }],
			resultCount: 1, provider: "exa",
		});
	});
});

test("batches run three queries concurrently and preserve their order, refs, and partial results", async () => {
	const owner = { sessionManager: { getSessionId: () => "batch-fixture" } } as ExtensionContext;
	await withSettings({}, async () => {
		const active = new Set<string>();
		let peak = 0;
		const query = ["first", "fails", "last"];
		const response = await search("call", { query, recency: "month", domains: ["example.test"] }, undefined, undefined, owner, {
			transports: { exa: async (req) => {
				assert.deepEqual(req.filters, { recency: "month", domains: ["example.test"] });
				active.add(req.query);
				peak = Math.max(peak, active.size);
				await new Promise((resolve) => setTimeout(resolve, 5 * (3 - query.indexOf(req.query))));
				active.delete(req.query);
				if (req.query === "fails") throw providerError("parse_error", "invalid fixture");
				const first = document("exa");
				return req.query === "first" ? first : {
					...first, searchResults: [...first.searchResults!, ...document("exa", "https://example.test/last").searchResults!],
				};
			} },
		});
		assert.equal(peak, 3);
		assert.equal(response.isError, false);
		assert.equal(response.details.storedCount, 2);
		assert.deepEqual(response.details.searchResults?.map(({ ref }) => ref), [
			`${response.details.resultId}:1`, `${response.details.resultId}:2`,
		]);
		assert.match(textOf(response), /Query 1 — first[\s\S]*Query 2 — fails[\s\S]*Query 3 — last[\s\S]*1 duplicate result\(s\) appeared earlier/);
		assert.deepEqual(response.details.warnings, ["Query 2 failed: invalid fixture"]);
		assert.equal((response.structuredContent as WebSearchDetails).searchResults?.[1].queryGroup, 2);
	});
	const rejected = await search("call", { query: ["a", "b", "c", "d"] }, undefined, undefined, ctx);
	assert.equal(rejected.details.error?.message, "search failed (unknown): query accepts 1 to 3 strings.");
});

test("a batch shares the 8000-character budget with evidence from each query", async () => {
	await withSettings({}, async () => {
		const response = await search("call", { query: ["first", "middle", "last"] }, undefined, undefined, ctx, {
			transports: { exa: async ({ query }) => ({
				providerKind: "exa", text: "",
				searchResults: Array.from({ length: query === "middle" ? 1 : 8 }, (_, index) => ({
					url: `https://example.test/${query}/${index}/${"p".repeat(630)}`,
					title: `${query} evidence ${index}`,
					citedText: query + " detail".repeat(80),
				})),
			}) },
		});
		assert.ok(textOf(response).length <= 8000);
		assert.ok(JSON.stringify(response.structuredContent).length <= 8000);
		const counts = [0, 0, 0];
		for (const hit of (response.structuredContent as WebSearchDetails).searchResults ?? []) counts[hit.queryGroup!]++;
		assert.ok(counts[0] > counts[2], JSON.stringify(counts));
		assert.equal(counts[1], 1);
		assert.ok(counts[2] >= 1);
	});
});

test("thorough both uses at most six transports per batch and routes a pinned library only to Context7", async () => {
	await withSettings({ research: { enabled: true }, classifier: { enabled: false } }, async () => {
		const requests: [string, string, string | undefined, unknown][] = [];
		const transport = (kind: "exa" | "parallel" | "grep" | "sourcegraph" | "context7") => async (req: import("../src/providers/index.ts").SearchRequest) => {
			requests.push([kind, req.query, req.library, req.filters]);
			return document(kind, `https://example.test/${kind}/${encodeURIComponent(req.query)}`);
		};
		const response = await search("call", {
			query: ["library:/vercel/next.js@v15 route handlers", "abort", "timeout"], scope: "both", recency: "day",
		}, undefined, undefined, ctx, {
			transports: { exa: transport("exa"), parallel: transport("parallel"), grep: transport("grep"), sourcegraph: transport("sourcegraph"), context7: transport("context7") },
		});
		assert.equal(response.isError, false);
		assert.equal(requests.length, 6);
		assert.deepEqual(requests.filter(([, query]) => query === "route handlers"), [
			["exa", "route handlers", undefined, { recency: "day", domains: undefined }],
			["context7", "route handlers", "/vercel/next.js@v15", undefined],
		]);
		assert.ok(requests.every(([, query]) => !query.includes("library:")));
		assert.ok(requests.filter(([kind]) => kind === "grep").every((request) => request[3] === undefined));
	});
});

test("a low preview limit keeps evidence for every successful batch group", async () => {
	await withSettings({ maxResults: 1 }, async () => {
		const result = await search("fair-share", { query: ["one", "two", "three"] }, undefined, undefined, ctx, {
			availability: { exa: true },
			transports: { exa: async ({ query }) => document("exa", `https://example.test/${query}`) },
		});
		assert.deepEqual((result.structuredContent as WebSearchDetails).searchResults?.map(({ url }) => url),
			["https://example.test/one", "https://example.test/two", "https://example.test/three"]);
	});
});
