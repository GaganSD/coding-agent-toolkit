import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evidenceStore } from "../src/evidence.ts";
import { search } from "../src/search.ts";
import { auditCitations, directText } from "./fixtures/offline/assertions.ts";
import { evidenceFor, Replay, routes, type Fixture } from "./fixtures/offline/replay.ts";
import { reliability, safety } from "./fixtures/offline/suites.ts";

test("offline provider fault matrix, credential redaction, and exact evidence continuation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-web-search-replay-test-"));
	const config = join(root, "web-search.json");
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = config;
	const replay = new Replay();
	const restore = replay.installGuard();
	const sessionId = "offline-replay-test";
	const context = { sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
	const run = (input: Parameters<typeof search>[1], signal?: AbortSignal) => search("replay", input, signal, undefined, context);
	try {
		await t.test("recovers retryable failures and honors cancellation and allowlisted egress", async () => {
			await reliability(replay, run, config);
		});
		await t.test("redacts credentials, rejects bad URLs and suppresses flagged evidence", async () => {
			await safety(replay, run, config, context);
		});
		await t.test("keyless Exa applies native filters and keeps the local domain boundary", async () => {
			writeFileSync(config, "{}");
			const query = "configure the documented fixture mode";
			const [source, excluded, outside] = evidenceFor("exa-filter", 0, "fact", "exa-advanced");
			const fixture: Fixture = { transport: "exa-advanced", query, evidence: [
				{ ...source, url: "https://docs.example.org/manual" },
				{ ...excluded, url: "https://discard.example.org/docs" },
				{ ...outside, url: "https://outside.invalid/manual" },
			], onRequest: (_url, init) => {
				const { params: { arguments: args } } = JSON.parse(String(init?.body));
				assert.ok(Number.isFinite(Date.parse(args.startPublishedDate)));
				assert.deepEqual(args.includeDomains, ["example.org"]);
				assert.deepEqual(args.excludeDomains, ["discard.example.org"]);
			} };
			replay.use([fixture]);
			const result = await run({ query, domains: ["example.org", "-discard.example.org"], recency: "day" });
			replay.assertClean();
			assert.equal(result.isError, false, directText(result));
			assert.equal(replay.attempts.filter(({ rpc }) => rpc === "tools/call").length, 1);
			assert.deepEqual(result.details.searchResults?.map(({ url }) => url), [fixture.evidence[0].url]);
			auditCitations(result, [fixture], query);
		});
		await t.test("Context7 searches unscoped queries and preserves exact library pins", async () => {
			writeFileSync(config, JSON.stringify({ code: { provider: "context7", fallback: [] } }));
			for (const [library, path] of [[undefined, "/api/v3/search"], ["/public-example/library@v3", "/api/v2/context"]] as const) {
				const query = "configure the fixture library";
				const fixture: Fixture = { transport: "context7", query, library, evidence: evidenceFor("context7", 0, "code", "context7") };
				replay.use([fixture]);
				const result = await run({ scope: "code", query: library ? `library:${library} ${query}` : query });
				replay.assertClean();
				assert.equal(result.isError, false, directText(result));
				assert.deepEqual(replay.attempts.map((request) => request.path), [path]);
				auditCitations(result, [fixture], query);
			}
		});
		await t.test("citations and paginated refs resolve to exact source evidence without egress", async () => {
			writeFileSync(config, JSON.stringify({ web: { provider: "exa", fallback: [] } }));
			const query = "exact citation";
			const evidence = evidenceFor("exact-citation", 0, "fact", "exa");
			const fixtures = [{ transport: "exa" as const, evidence, query }];
			replay.use(fixtures);
			const result = await run({ query });
			replay.assertClean();
			assert.equal(result.isError, false);
			auditCitations(result, fixtures, query);
			const hit = result.details.searchResults?.[0];
			const source = evidence.find(({ url }) => url === hit?.url);
			assert.ok(hit?.ref && source);
			replay.use([]);
			let cursor: string | undefined;
			let offset = 0;
			do {
				const page = await run({ ref: hit.ref, ...(cursor ? { cursor } : {}) });
				replay.assertClean();
				const cited = page.details.searchResults?.[0]?.citedText;
				assert.ok(cited && page.details.passage);
				assert.equal(page.details.passage.offset, offset);
				assert.equal(cited, source.text.slice(offset, offset + cited.length));
				assert.ok(directText(page).startsWith(cited));
				assert.equal(page.details.searchResults?.[0]?.ref, hit.ref);
				offset += cited.length;
				cursor = page.details.cursor;
			} while (cursor);
			assert.ok(offset > (hit.citedText?.length ?? 0));
			assert.equal(replay.attempts.length, 0);
		});
		await t.test("a missing fixture fails closed before any network request", async () => {
			replay.use([]);
			await assert.rejects(fetch(routes.exa), /Unreplayed request/u);
			assert.throws(() => replay.assertClean(), /Unreplayed request/u);
		});
	} finally {
		restore();
		evidenceStore.clear(sessionId);
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
