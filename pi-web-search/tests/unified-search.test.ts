import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatResult } from "../src/format.ts";
import { CONFIG_PATH_ENV_VAR } from "../src/providers/config.ts";
import { PARALLEL_MCP_SERVER } from "../src/providers/parallel.ts";
import { providerError, type StreamResult } from "../src/providers/types.ts";
import { SearchSchema, search, searchReachesTools } from "../src/search.ts";

const ctx = {} as ExtensionContext;

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
		"cursor", "effort", "find", "query", "ref", "scope", "urls",
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
		assert.equal(result.details.jevStatus, "disabled");
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
		assert.deepEqual(searchReachesTools({ query: "AbortSignal.timeout", scope: "code" }), []);
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
		assert.equal(result.details.jevStatus, "disabled");
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
			assert.equal(result, local, "direct content is returned exactly as the evidence reader produced it");
		} finally {
			globalThis.fetch = priorFetch;
		}
	});
});

test("reachesTools is local for refs and code-only calls, MCP-aware for web retrieval", () => {
	const mcp = `mcp__${PARALLEL_MCP_SERVER}`;
	assert.deepEqual(searchReachesTools({ ref: "opaque:1" }), []);
	assert.deepEqual(searchReachesTools({ query: "id", scope: "code" }), []);
	assert.deepEqual(searchReachesTools({ query: "id" }), [mcp]);
	assert.deepEqual(searchReachesTools({ query: "id", scope: "both" }), [mcp]);
	assert.deepEqual(searchReachesTools({ urls: ["https://example.test"] }), [mcp]);
});
