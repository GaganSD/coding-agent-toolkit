import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { braveSearch } from "../src/providers/brave.ts";
import { exaSearch } from "../src/providers/exa.ts";
import { githubSearch } from "../src/providers/github.ts";
import type { SearchRequest } from "../src/providers/index.ts";
import { search } from "../src/search.ts";
import { disableStoredCredentials, enableStoredCredentials } from "../src/env.ts";
import { providerError } from "../src/providers/types.ts";

const key = "SENTINEL_AUTHENTICATED_CREDENTIAL_MUST_NOT_APPEAR";
const ctx = {} as ExtensionContext;

test("authenticated REST errors and fallback warnings never expose an active key or its clipped prefix", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-search-redaction-"));
	const config = join(dir, "web-search.json"), auth = join(dir, "auth.json");
	const old = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = config;
	enableStoredCredentials(auth);
	t.after(async () => {
		disableStoredCredentials();
		if (old === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = old;
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(auth, JSON.stringify(Object.fromEntries(["exa", "brave", "github"].map((id) => [id, { type: "api_key", key }]))));
	const echoed = `${"x".repeat(280)} ${key}`;
	for (const [id, transport] of [["exa", exaSearch], ["brave", braveSearch], ["github", githubSearch]] as const) {
		const scope = id === "github" ? "code" : "web";
		await writeFile(config, JSON.stringify({ [scope]: { provider: id, fallback: [] } }));
		const failed = await search("id", { query: "test", scope }, undefined, undefined, ctx, {
			availability: { [id]: true }, transports: { [id]: (req: SearchRequest) => transport(req, { fetchImpl: async () => new Response(echoed, { status: 403 }) }) },
		});
		assert.equal(failed.details.error?.status, 403, id);
		for (const channel of [failed.content, failed.structuredContent]) {
			assert.match(JSON.stringify(channel), id === "brave" ? /Check BRAVE_API_KEY/u : /\[redacted\]/u, id);
			assert.doesNotMatch(JSON.stringify(channel), /SENTINEL_AUTH/u, id);
		}
	}
	await writeFile(config, '{"web":{"provider":"exa","fallback":["brave"]}}');
	for (const fetchImpl of [async () => new Response(`upstream echoed ${key}`, { status: 503 }), async () => { throw providerError("network_error", `socket: ${key}`); }]) {
		const answer = await search("id", { query: "test" }, undefined, undefined, ctx, {
			availability: { exa: true, brave: true }, transports: {
				exa: (req) => exaSearch(req, { fetchImpl }),
				brave: async () => ({ providerKind: "brave", text: "fallback evidence" }),
			},
		});
		assert.equal(answer.isError, false);
		assert.match(JSON.stringify(answer.structuredContent), /\[redacted\]/u);
		assert.doesNotMatch(JSON.stringify(answer), /SENTINEL_AUTH/u);
	}
});

test("keyed Exa HTML 200 preserves main's model diagnostic unless the body echoes the key", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-exa-main-parity-"));
	const previous = { PI_WEB_SEARCH_CONFIG: process.env.PI_WEB_SEARCH_CONFIG, EXA_API_KEY: process.env.EXA_API_KEY };
	process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
	process.env.EXA_API_KEY = key;
	t.after(async () => {
		for (const [id, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[id]; else process.env[id] = value;
		}
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(process.env.PI_WEB_SEARCH_CONFIG, '{"web":{"provider":"exa","fallback":[]}}');

	for (const [body, safeBody] of [
		["<html>Bad gateway</html>", "<html>Bad gateway</html>"],
		[`${key}<html>Bad gateway</html>`, "[redacted]<html>Bad gateway</html>"],
	]) {
		const result = await search("id", { query: "test" }, undefined, undefined, ctx, {
			availability: { exa: true },
			transports: { exa: (req) => exaSearch(req, { fetchImpl: async (url, init) => {
				assert.equal(url, "https://api.exa.ai/search");
				assert.equal(new Headers(init?.headers).get("x-api-key"), key);
				return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
			} }) },
		});
		// Main uses the native V8 message. Generate it from the fixture instead
		// of tying the expected bytes to a specific supported Node release.
		let diagnostic = "";
		assert.throws(() => JSON.parse(safeBody), (error: SyntaxError) => { diagnostic = error.message; return true; });
		const message = `search failed (parse_error): Response from https://api.exa.ai/search was not valid JSON: ${diagnostic}`;
		assert.equal(JSON.stringify(result.content), JSON.stringify([{ type: "text", text: message }]));
		assert.equal(JSON.stringify(result.structuredContent), JSON.stringify({
			status: "error", text: message, resultCount: 0, grounded: false, sources: [], searchResults: [],
			warnings: [], error: { code: "parse_error", message, retryable: false },
		}));
		assert.doesNotMatch(JSON.stringify(result), /SENTINEL_AUTH/);
	}
});
