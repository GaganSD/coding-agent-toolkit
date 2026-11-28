import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import dgram from "node:dgram";
import net from "node:net";

const retrievalScope = new AsyncLocalStorage<boolean>();
export const retrieve = <T>(run: () => T): T => retrievalScope.run(true, run);

type Rpc = { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type Recording = { status: number; contentType: string; body: string; rpc?: boolean };
const providers = new Set(["mcp.exa.ai", "mcp.grep.app", "search.parallel.ai", "sourcegraph.com", "r.jina.ai", "context7.com"]);
const privateToken = /(?:-----BEGIN [^-]+ PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~-]{16,})/giu;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function scrub(text: string, removeQueryStrings = true): string {
	const safe = text.replace(privateToken, "[redacted]")
		.replace(/(\b(?:authorization|x-subscription-token|x-api-key|api_key|mcp-session-id|account[_-]?id)[ "'\t]*[:=][ "'\t]*)(?:Bearer[ \t]+)?[A-Za-z0-9._~-]{8,}/giu, "$1[redacted]")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted email]");
	return removeQueryStrings ? safe.replace(/(https?:\/\/[^\s"'<>\\?#]+)\?[^\s"'<>\\#]+/gu, "$1")
		: safe.replace(/([?&](?:access_token|key|api_key|signature|token)=)[^\s&"'<>]+/giu, "$1[redacted]");
}
export const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
	: value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, child]) => [key, canonical(child)])) : value;

export class Replay {
	readonly misses: string[] = [];
	readonly errors: string[] = [];
	private records: Record<string, Recording>;
	private original = globalThis.fetch;
	private inFlight = new Map<string, Promise<Recording>>();

	private readonly path: string;
	private readonly live: boolean;

	constructor(path: string, live: boolean) {
		this.path = path;
		this.live = live;
		try { this.records = JSON.parse(readFileSync(path, "utf8")); }
		catch (error) {
			if (!live || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.records = {};
		}
	}

	save() {
		if (!this.live) return;
		const temporary = this.path + "." + process.pid + ".tmp";
		writeFileSync(temporary, JSON.stringify(this.records, null, 2) + "\n", { mode: 0o600 });
		renameSync(temporary, this.path);
	}

	// The guard spans imports in offline mode and retrieval calls during live model runs.
	install(fallback: "deny" | "model" = "deny") {
		const fetch = globalThis.fetch;
		const connect = net.Socket.prototype.connect;
		const send = dgram.Socket.prototype.send;
		const guarded = () => retrievalScope.getStore() ?? fallback === "deny";
		globalThis.fetch = (input, init) => guarded() ? this.fetch(input, init) : fetch(input, init);
		const miss = (reason: string) => this.miss(reason);
		net.Socket.prototype.connect = function (...args: unknown[]) {
			return guarded() ? miss("direct socket") : Reflect.apply(connect, this, args);
		};
		dgram.Socket.prototype.send = function (...args: unknown[]) {
			return guarded() ? miss("datagram") : Reflect.apply(send, this, args);
		};
		return () => {
			globalThis.fetch = fetch;
			net.Socket.prototype.connect = connect;
			dgram.Socket.prototype.send = send;
		};
	}

	private miss(reason: string): never {
		this.misses.push(reason);
		throw new Error("Replay miss: " + reason);
	}

	async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!providers.has(url.hostname) || url.protocol !== "https:" || url.username || url.password) {
			return this.miss("non-provider request");
		}
		if (["authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie", "proxy-authorization", "x-subscription-token"]
			.some((name) => request.headers.has(name))) return this.miss("credentialed retrieval");
		const raw = await request.clone().text();
		let rpc: Rpc | undefined;
		if (raw.startsWith("{")) {
			const body = JSON.parse(raw) as Rpc;
			if (body.method && (body as { jsonrpc?: string }).jsonrpc === "2.0") rpc = body;
		}
		if (rpc?.method === "initialize") {
			const version = (rpc.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-03-26";
			return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "recording", version: "1" } } });
		}
		if (rpc?.method?.startsWith("notifications/") || request.method === "DELETE") return new Response(null, { status: 202 });
		// Both extensions receive the same basic Exa evidence, despite different
		// client metadata, RPC IDs, endpoint option strings and result-count defaults.
		const exa = url.hostname === "mcp.exa.ai" && rpc?.params?.name === "web_search_exa";
		const resultCount = Number(rpc?.params?.arguments?.numResults);
		const overfetch = Number.isInteger(resultCount) && resultCount > 8 ? [resultCount] : [];
		const identity = exa ? [url.hostname, rpc?.params?.name, rpc?.params?.arguments?.query, ...overfetch]
			: [request.method, request.url, rpc ? [rpc.method, rpc.params] : raw, request.headers.get("x-parallel-search-config")];
		const key = digest(JSON.stringify(canonical(identity)));
		let record = this.records[key];
		if (!record) {
			if (!this.live) return this.miss(url.hostname + " " + (rpc?.params?.name ?? rpc?.method ?? request.method));
			let pending = this.inFlight.get(key);
			if (!pending) {
				pending = this.record(request, rpc, exa).finally(() => this.inFlight.delete(key));
				this.inFlight.set(key, pending);
			}
			record = this.records[key] = await pending;
		}
		if (record.status >= 400) this.errors.push(url.hostname + " HTTP " + record.status);
		if (record.rpc && /"error":\s*\{|"isError":true/u.test(record.body)) this.errors.push(url.hostname + " RPC tool error");
		const body = record.rpc ? JSON.stringify({ ...JSON.parse(record.body), id: rpc?.id }) : record.body;
		return new Response(record.status === 204 || record.status === 304 ? null : body, {
			status: record.status, headers: { "content-type": record.contentType },
		});
	}

	private network(input: string | Request, init: RequestInit) {
		return retrievalScope.run(false, () => this.original(input, init));
	}

	private async record(request: Request, rpc: Rpc | undefined, exa: boolean): Promise<Recording> {
		const headers = new Headers(request.headers);
		headers.delete("mcp-session-id");
		const response = exa ? await this.network("https://mcp.exa.ai/mcp?tools=web_search_exa", {
			method: "POST", headers, redirect: "error", signal: request.signal,
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa",
				arguments: { query: rpc?.params?.arguments?.query, numResults: Math.max(8, Number(rpc?.params?.arguments?.numResults) || 0) } } }),
		}) : await this.network(request, { headers, redirect: "error" });
		const body = await response.text();
		const contentType = response.headers.get("content-type") ?? "text/plain";
		if (rpc && response.ok) {
			const data = contentType.includes("text/event-stream") ? body.split("\n").filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim()).filter(Boolean) : [body];
			for (const frame of data) {
				let reply: { result?: unknown; error?: unknown };
				try { reply = JSON.parse(frame); } catch { continue; }
				if (reply.result !== undefined || reply.error !== undefined) {
					const safe = JSON.parse(JSON.stringify({ result: reply.result, error: reply.error }), (key, value: unknown) =>
						/^(?:auth|sessionId|requestId|accountId|apiKey|token|cookie)$/iu.test(key) ? undefined
							: typeof value === "string" ? scrub(value) : value);
					return { status: response.status, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", ...safe }), rpc: true };
				}
			}
			this.errors.push("Unparseable provider RPC");
		}
		return { status: response.status, contentType, body: scrub(body) };
	}
}
