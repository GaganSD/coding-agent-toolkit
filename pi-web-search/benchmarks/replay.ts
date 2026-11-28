import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { timeoutError } from "../src/providers/http.ts";
import type { EvidenceProvider } from "../src/providers/types.ts";

export const directory = fileURLToPath(new URL(".", import.meta.url));
export const routes = {
	exa: "https://mcp.exa.ai/mcp",
	"exa-rest": "https://api.exa.ai/search",
	parallel: "https://search.parallel.ai/mcp",
	grep: "https://mcp.grep.app/",
	sourcegraph: "https://sourcegraph.com/.api/search/stream",
	github: "https://api.github.com/search/code",
	brave: "https://api.search.brave.com/res/v1/web/search",
	"brave-context": "https://api.search.brave.com/res/v1/llm/context",
	context7: "https://context7.com/api/v2/context",
	searxng: "http://127.0.0.1:7987/search",
	jina: "https://r.jina.ai/",
} satisfies Partial<Record<EvidenceProvider | "exa-rest" | "brave-context", string>>;

export type Transport = keyof typeof routes;
export interface Evidence { title: string; url: string; text: string }
export interface Fault { id: string; status?: number; retryAfter?: string; retryable: boolean; mcpOnly?: boolean }
type Request = { jsonrpc?: string; method?: string; id?: number; params?: { name?: string; arguments?: Record<string, unknown> }; query?: string };
export interface Fixture {
	transport: Transport;
	evidence: Evidence[];
	query?: string;
	target?: string;
	fault?: Fault;
	once?: boolean;
	onRequest?: (url: URL, init: RequestInit | undefined) => void;
}

function loadJson<T>(path: string): T {
	return JSON.parse(readFileSync(join(directory, "fixtures", path), "utf8")) as T;
}

export const excerpts = loadJson<Record<string, string>>("evidence.json");
export const faults = loadJson<Fault[]>("faults.json");

export function assertSanitizedFixtures(): void {
	for (const folder of ["fixtures", "tasks"]) {
		for (const entry of readdirSync(join(directory, folder), { withFileTypes: true, recursive: true })) {
			if (entry.isDirectory()) continue;
			const filename = join(entry.parentPath, entry.name);
			assert.ok(entry.isFile(), `Unexpected benchmark input: ${filename}`);
			const contents = readFileSync(filename, "utf8");
			const secrets = /(?:(?:authorization|x-subscription-token|x-api-key|api_key|cookie|set-cookie|mcp-session-id|account[_-]?id)["']?\s*[:=]\s*["']?(?:Bearer\s+)?|\bBearer\s+)([^\s"',}]+)/giu;
			for (const [, value] of contents.matchAll(secrets)) {
				assert.match(value, /^(?:\[redacted\]|<placeholder>|PLACEHOLDER)$/iu, `Non-placeholder credential in ${filename}`);
			}
		}
	}
}

export function evidenceFor(id: string, step: number, category: string, transport: Transport, target?: string): Evidence[] {
	const body = excerpts[category];
	assert.ok(body, `Unknown evidence category: ${category}`);
	const counts = category === "ref" || target ? 1 : category === "fact" || category === "docs" ? 3 : 2;
	return Array.from({ length: counts }, (_, index) => {
		const path = `${id}-${step + 1}-${index + 1}.ts`;
		const url = transport === "grep" || transport === "sourcegraph" || transport === "github"
			? `https://github.com/public-example/replay/blob/main/${path}`
			: `https://example.org/${id}/${step + 1}/${index + 1}`;
		const text = category === "ref"
			? Array.from({ length: 32 }, (_, n) => `Section ${n + 1}. ${body}`).join("\n\n")
			: body;
		return { title: `Fixture ${id}, source ${index + 1}`, url: target ?? url, text };
	});
}

const mcpTools = { exa: "web_search_exa", parallel: "web_search", grep: "searchGitHub" } as const;
function isMcp(transport: Transport): transport is keyof typeof mcpTools {
	return Object.hasOwn(mcpTools, transport);
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(body, { status, headers });
}

function literalCodeQuery(query: string | undefined): string | undefined {
	return query?.split(/\s+/u).filter((word) => !/^(repo|language):/iu.test(word)).join(" ");
}

function match(fixture: Fixture, url: URL, method: string, rpc: Request): boolean {
	const { transport, target, query } = fixture;
	const endpoint = new URL(routes[transport]);
	if (transport === "jina") return method === "GET" && target !== undefined && url.href === endpoint.href + target;
	if (url.origin !== endpoint.origin) return false;
	if (transport === "context7" && url.pathname === "/api/v2/libs/search") {
		return method === "GET" && url.searchParams.get("query") === query;
	}
	if (url.pathname !== endpoint.pathname) return false;
	if (transport === "context7") return method === "GET" && url.searchParams.get("query") === query;
	if (transport === "searxng") {
		const q = url.searchParams.get("q");
		return method === "GET" && url.searchParams.get("format") === "json" && (q === query || q?.startsWith(query + " ") === true);
	}

	if (isMcp(transport)) {
		if (method === "DELETE") return true;
		if (method !== "POST" || rpc.jsonrpc !== "2.0") return false;
		if (rpc.method === "initialize" || rpc.method === "notifications/initialized") return true;
		if (rpc.method !== "tools/call" || rpc.params?.name !== mcpTools[transport]) return false;
		const args = rpc.params.arguments;
		if (transport === "parallel") return args?.objective === query;
		if (transport === "grep") return args?.query === literalCodeQuery(query);
		return args?.query === query;
	}

	if (transport === "exa-rest") return method === "POST" && rpc.query === query;
	if (transport === "sourcegraph") {
		const literal = literalCodeQuery(query);
		return method === "GET" && literal !== undefined && url.searchParams.get("q")?.startsWith(literal + " ") === true;
	}
	return method === "GET" && url.searchParams.get("q") === query;
}

function fixtureResponse(fixture: Fixture, rpc: Request, method: string, session: number, url: URL): Response {
	const { transport, evidence } = fixture;
	if (isMcp(transport)) {
		if (method === "DELETE" || rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
		if (rpc.method === "initialize") {
			return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }, 200,
				{ "Mcp-Session-Id": `replay-${session}` });
		}
		const result = transport === "parallel"
			? { content: [], structuredContent: { results: evidence.map(({ title, url, text }) => ({ title, url, excerpts: [text] })) } }
			: { content: [{ type: "text", text: transport === "exa"
				? evidence.map(({ title, url, text }) => `Title: ${title}\nURL: ${url}\nHighlights:\n${text}`).join("\n\n")
				: evidence.map(({ url, text }) => `Repository: public-example/replay\nPath: ${url.split("/").at(-1)}\nURL: ${url}\n--- Snippet 1 (Line 1) ---\n${text}`).join("\n") }] };
		return json({ jsonrpc: "2.0", id: rpc.id, result });
	}
	if (transport === "jina") {
		const { title, text } = evidence[0];
		return json({ data: { title, url: fixture.target, content: text, httpStatus: 200 } });
	}
	if (transport === "exa-rest") return json({ results: evidence.map(({ title, url, text }) => ({ title, url, highlights: [text] })) });
	if (transport === "brave") return json({ web: { results: evidence.map(({ title, url, text }) => ({ title, url, description: text })) } });
	if (transport === "brave-context") return json({
		grounding: { generic: evidence.map(({ title, url, text }) => ({ title, url, snippets: [text] })), map: [] },
		sources: Object.fromEntries(evidence.map(({ title, url }) => [url, { title, hostname: new URL(url).hostname, age: [] }])),
	});
	if (transport === "searxng") return json({ results: evidence.map(({ title, url, text }) => ({ title, url, content: text })) });
	if (transport === "context7") {
		if (url.pathname === "/api/v2/libs/search") return json({ results: [{ id: "/public-example/library" }] });
		return json({ libraryId: url.searchParams.get("libraryId"), codeSnippets: [],
			infoSnippets: evidence.map(({ title, url, text }) => ({ breadcrumb: title, pageId: url, content: text })) });
	}
	if (transport === "github") return json({ items: evidence.map(({ url, text }) => ({
		html_url: url, path: url.split("/").at(-1), repository: { full_name: "public-example/replay", private: false },
		text_matches: [{ fragment: text }],
	})) });
	const matches = evidence.map(({ url, text }) => ({
		repository: "github.com/public-example/replay", commit: "main", path: url.split("/").at(-1),
		lineMatches: [{ line: text }],
	}));
	return new Response(`event: matches\ndata: ${JSON.stringify(matches)}\n\nevent: progress\ndata: {"done":true}\n\n`);
}

function faultResponse(fault: Fault, signal?: AbortSignal | null): Response {
	if (fault.status !== undefined) return new Response("Synthetic upstream failure.", {
		status: fault.status, headers: fault.retryAfter ? { "Retry-After": fault.retryAfter } : undefined,
	});
	if (fault.id === "timeout") throw timeoutError(50);
	if (fault.id === "mcp-disconnect") throw new TypeError("Synthetic transport disconnect.");
	if (fault.id === "malformed-json") return new Response('{"unclosed":', { headers: { "Content-Type": "application/json" } });
	return new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"incomplete":'));
			if (fault.id === "truncated-body") controller.error(new Error("Synthetic truncated body."));
			else if (signal?.aborted) controller.close();
		},
	}), { headers: { "Content-Type": "application/json" } });
}

export class Replay {
	attempts: { host: string; path: string; method: string; rpc?: string }[] = [];
	private misses: string[] = [];
	private fixtures: Fixture[] = [];
	private usedFaults = new Set<Fixture>();
	private session = 0;
	replayMs = 0;

	use(fixtures: Fixture[]): void {
		this.assertClean();
		this.fixtures = fixtures;
		this.usedFaults.clear();
		this.attempts = [];
		this.replayMs = 0;
	}

	async fetch(input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
		const start = performance.now();
		const url = new URL(input instanceof Request ? input.url : input);
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
		let rpc: Request = {};
		try {
			if (typeof body === "string" && body.length) rpc = JSON.parse(body);
		} catch {
			this.miss(method, url);
		}
		this.attempts.push({ host: url.host, path: url.pathname, method, ...(rpc.method ? { rpc: rpc.method } : {}) });
		const fixture = this.fixtures.find((candidate) => match(candidate, url, method, rpc));
		if (!fixture) this.miss(method, url);
		try {
			const isCall = !isMcp(fixture.transport) || rpc.method === "tools/call";
			if (isCall) {
				fixture.onRequest?.(url, init);
				const libraryLookup = fixture.transport === "context7" && url.pathname.endsWith("/libs/search");
				if (!libraryLookup && fixture.fault && !(fixture.once && this.usedFaults.has(fixture))) {
					this.usedFaults.add(fixture);
					return faultResponse(fixture.fault, init?.signal);
				}
			}
			if (rpc.method === "initialize") this.session++;
			return fixtureResponse(fixture, rpc, method, this.session, url);
		} finally {
			this.replayMs += performance.now() - start;
		}
	}

	private miss(method: string, url: URL): never {
		const message = `Unreplayed request: ${method} ${url.host}${url.pathname}`;
		this.misses.push(message);
		throw new Error(message);
	}

	installGuard(): void {
		globalThis.fetch = this.fetch.bind(this);
		const block = (transport: string) => {
			const message = `Unreplayed ${transport} attempt: offline benchmark permits fixture responses only`;
			this.misses.push(message);
			throw new Error(message);
		};
		// Catches node:http, node:https, TLS and alternate fetch clients that bypass global fetch.
		net.Socket.prototype.connect = () => block("socket connection");
		dgram.Socket.prototype.send = () => block("datagram");
		syncBuiltinESMExports();
	}

	assertClean(): void {
		assert.deepEqual(this.misses, [], this.misses.join("\n"));
	}
}
