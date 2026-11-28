import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessOffTopic } from "../src/classifier/offtopic.ts";
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

const pinnedClassifier = { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" };
const relevanceSettings = { web: { fallbackOnOffTopic: true }, classifier: pinnedClassifier };
const relevanceUsage = {
	input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
	cost: { input: 0.0001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0011 },
};
type RelevanceState = { query: string; candidates: Array<{ index: number; title: string; url: string; excerpt: string }> };

function relevanceContext(
	score: (state: RelevanceState, signal: AbortSignal) => number | Promise<number>,
	forcedChoice?: "off_topic" | "addresses",
): ExtensionContext {
	const model = { provider: pinnedClassifier.provider, id: pinnedClassifier.model };
	return {
		sessionManager: { getSessionId: () => "off-topic-test" },
		modelRegistry: {
			findOfType: (type: string, provider: string, id: string) => {
				assert.deepEqual([type, provider, id], ["classifier", model.provider, model.id]);
				return model;
			},
			getAvailableOfType: async () => [model],
			classify: async (_model: unknown, { state, questions }: { state: RelevanceState; questions: Record<string, { type: string }> }, { signal }: { signal: AbortSignal }) => {
				assert.deepEqual(Object.keys(questions), ["relevance"]);
				assert.equal(questions.relevance.type, "choice");
				const offTopic = await score(state, signal);
				const choice = forcedChoice ?? (offTopic >= 0.5 ? "off_topic" : "addresses");
				return { stopReason: "stop", usage: relevanceUsage, answers: {
					relevance: { type: "choice", choice, confidence: 0.99, probabilities: { off_topic: offTopic, addresses: 1 - offTopic } },
				} };
			},
		},
	} as unknown as ExtensionContext;
}

const relevanceTransports = {
	availability: { exa: true, parallel: true },
	transports: {
		exa: async () => document("exa", "https://exa.example/evidence"),
		parallel: async () => document("parallel", "https://parallel.example/evidence"),
	},
};

test("off-topic fallback classifies the provider response, then stores only the selected evidence", () => withSettings(relevanceSettings, async () => {
	const calls: RelevanceState[] = [];
	const owner = relevanceContext((state) => { calls.push(state); return calls.length === 1 ? 0.85 : 0.84; });
	const result = await search("call", { query: "fast query" }, undefined, undefined, owner, relevanceTransports);
	assert.equal(result.isError, false);
	assert.deepEqual(calls.map(({ candidates }) => candidates.map(({ url }) => url)), [
		["https://exa.example/evidence"], ["https://parallel.example/evidence"],
	]);
	assert.deepEqual(calls[0], { query: "fast query", candidates: [{
		index: 0, title: "exa evidence", url: "https://exa.example/evidence", excerpt: "exa cited text",
	}] });
	assert.equal(result.details.provider, "parallel");
	assert.deepEqual(result.details.attempted, ["exa", "parallel"]);
	assert.deepEqual(result.details.contributors, ["parallel"]);
	assert.match(result.details.warnings?.join(" ") ?? "", /judged exa's results off-topic/);
	assert.equal(result.usage?.totalTokens, 22);
	assert.equal(result.details.storedCount, 1);
	const ref = result.details.searchResults?.[0].ref;
	assert.ok(ref);
	const continued = await search("call", { ref }, undefined, undefined, owner);
	assert.match(textOf(continued), /parallel cited text/);
	assert.doesNotMatch(textOf(continued), /exa cited text/);
	assert.equal(calls.length, 2);
}));

test("off-topic fallback keeps below-threshold evidence and limits the judge to ten citations", () => withSettings(relevanceSettings, async () => {
	const owner = relevanceContext(({ candidates }) => {
		assert.equal(candidates.length, 10);
		assert.equal(candidates[0].excerpt.length, 400);
		assert.deepEqual(candidates.map(({ index }) => index), Array.from({ length: 10 }, (_, i) => i));
		return 0.849;
	});
	const result = await search("call", { query: "test search" }, undefined, undefined, owner, {
		...relevanceTransports,
		transports: {
			...relevanceTransports.transports,
			exa: async () => ({ providerKind: "exa", text: "", searchResults: Array.from({ length: 11 }, (_, i) => ({
				url: `https://example.test/hit/${i}`, title: "result", citedText: "a".repeat(800),
			})) }),
		},
	});
	assert.equal(result.isError, false);
	assert.deepEqual(result.details.attempted, ["exa"]);
	assert.equal(result.usage?.totalTokens, 11);
}));

test("off-topic fallback keeps the first response after an off-topic, empty, or failed backup", () => withSettings(relevanceSettings, async () => {
	const owner = relevanceContext(() => 0.95);
	for (const parallel of [
		relevanceTransports.transports.parallel,
		async () => ({ providerKind: "parallel" as const, text: "", searchResults: [] }),
		async () => { throw providerError("http_error", "fixture denied", { retryable: false }); },
	]) {
		const result = await search("call", { query: "fast query" }, undefined, undefined, owner, {
			...relevanceTransports, transports: { ...relevanceTransports.transports, parallel },
		});
		assert.equal(result.isError, false);
		assert.equal(result.details.provider, "exa");
		assert.deepEqual(result.details.contributors, ["exa"]);
		assert.match(result.details.warnings?.join(" ") ?? "", /Returning the first response from exa/);
	}
}));

test("off-topic fallback fails open on malformed or failed classifier responses without leaking errors", () => withSettings(relevanceSettings, async () => {
	for (const owner of [
		relevanceContext(() => Number.NaN),
		relevanceContext(() => { throw new Error("credential-fixture-value"); }),
		relevanceContext(() => 0.95, "addresses"),
	]) {
		const result = await search("call", { query: "fast query" }, undefined, undefined, owner, relevanceTransports);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details.attempted, ["exa"]);
		assert.match(textOf(result), /off-topic checking was unavailable/);
		assert.doesNotMatch(textOf(result), /credential-fixture-value/);
	}
}));

test("the fast-web classifier leaves code, URL reads and thorough retrieval alone", () => withSettings({
	...relevanceSettings, research: { enabled: true },
}, async () => {
	let calls = 0;
	const owner = relevanceContext(() => { calls++; return 0.95; });
	const tests: Parameters<typeof search>[1][] = [
		{ query: "fast query", scope: "code" },
		{ query: "thorough query", effort: "thorough" },
		{ urls: ["https://exa.example/evidence"] },
	];
	for (const params of tests) {
		const result = await search("call", params, undefined, undefined, owner, {
			...relevanceTransports,
			availability: { ...relevanceTransports.availability, grep: true },
			transports: { ...relevanceTransports.transports, grep: async () => document("grep") },
			readUrls: relevanceTransports.transports.exa,
		});
		assert.equal(result.isError, false);
	}
	assert.equal(calls, 0);
}));

test("off-topic fallback honors the state cap and the standalone path makes no classifier call", () => withSettings({
	...relevanceSettings, classifier: { ...pinnedClassifier, maxStateChars: 12 },
}, async () => {
	for (const standalone of [true, false]) {
		let calls = 0;
		const owner = relevanceContext(() => { calls++; return 0.99; });
		const result = await search("call", { query: "fast query" }, undefined, undefined, owner, { ...relevanceTransports, standalone });
		assert.equal(result.isError, false);
		assert.deepEqual(result.details.attempted, ["exa"]);
		assert.match(textOf(result), standalone ? /Classifier unavailable without Pi/ : /12-character classifier limit/);
		assert.equal(calls, 0);
	}
}));

test("off-topic classifier timeout preserves retrieved evidence and prevents fallback", async () => {
	const owner = relevanceContext(() => new Promise<number>(() => {}));
	const assessment = await assessOffTopic("query", document("exa"), 1000, {
		...pinnedClassifier, modelRegistry: owner.modelRegistry, timeoutMs: 20,
	});
	assert.equal(assessment.offTopic, undefined);
	assert.match(assessment.warning ?? "", /classifier timed out/);
});

test("off-topic search deadline keeps evidence during judging or fallback retrieval", () => withSettings({
	...relevanceSettings, timeoutMs: 1000,
}, async () => {
	for (const inClassifier of [true, false]) {
		const owner = relevanceContext(() => inClassifier ? new Promise<number>(() => {}) : 0.95);
		const result = await search("call", { query: "fast query" }, undefined, undefined, owner, {
			...relevanceTransports,
			transports: { ...relevanceTransports.transports, parallel: () => new Promise(() => {}) },
		});
		assert.equal(result.isError, false);
		assert.equal(result.details.provider, "exa");
		assert.deepEqual(result.details.attempted, inClassifier ? ["exa"] : ["exa", "parallel"]);
		assert.match(textOf(result), /search deadline reached/i);
	}
}));

test("cancelling the off-topic check propagates abort without trying a backup", () => withSettings(relevanceSettings, async () => {
	const caller = new AbortController();
	const owner = relevanceContext((_state, signal) => {
		caller.abort();
		assert.equal(signal.aborted, true);
		return new Promise(() => {});
	});
	const result = await search("call", { query: "fast query" }, caller.signal, undefined, owner, relevanceTransports);
	assert.equal(result.isError, true);
	assert.equal(result.details.error?.code, "aborted");
	assert.deepEqual(result.details.attempted, ["exa"]);
}));

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
