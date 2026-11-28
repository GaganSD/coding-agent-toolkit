import assert from "node:assert/strict";
import { PARALLEL_MCP_URL } from "../../src/providers/parallel.ts";

export type ToolCall = { name: string; arguments: Record<string, unknown> };
export function parallelHttp(handle: (call: ToolCall) => unknown | Promise<unknown> = () => ({ structuredContent: { results: [
	{ url: "https://example.test/result", title: "Evidence", excerpts: ["Search citation"] },
] } }), { batch = false, stateless = false } = {}) {
	const calls: ToolCall[] = [];
	const headers: (string | null)[] = [];
	const methods: string[] = [];
	const sessionHeaders: (string | null)[] = [];
	let sessions = 0;
	const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		assert.equal(String(url), PARALLEL_MCP_URL);
		const requestHeaders = new Headers(init?.headers);
		headers.push(requestHeaders.get("authorization"));
		sessionHeaders.push(requestHeaders.get("mcp-session-id"));
		const session = () => stateless ? null : sessions === 1 ? "local-mcp-session" : `local-mcp-session-${sessions}`;
		if (init?.method === "DELETE") {
			methods.push("DELETE");
			assert.equal(requestHeaders.get("mcp-session-id"), session());
			return new Response(null, { status: 204 });
		}
		const { id, method, params } = JSON.parse(String(init?.body));
		methods.push(method);
		const reply = (result: unknown, extra?: Record<string, string>) => {
			const message = { jsonrpc: "2.0", id, result };
			return Response.json(batch ? [{ ...message, id: -1 }, message] : message, { headers: extra });
		};
		if (method === "initialize") {
			assert.equal(requestHeaders.get("mcp-session-id"), null);
			sessions++;
			const id = session();
			return reply({ protocolVersion: "2025-03-26" }, id ? { "mcp-session-id": id } : undefined);
		}
		assert.equal(requestHeaders.get("mcp-session-id"), session());
		assert.equal(requestHeaders.get("mcp-protocol-version"), "2025-03-26");
		if (method === "notifications/initialized") return new Response(null, { status: 202 });
		assert.equal(method, "tools/call");
		calls.push(params as ToolCall);
		const payload = await handle(params);
		if (payload instanceof Response) return payload;
		if (payload && typeof payload === "object" && "rpcError" in payload) {
			return Response.json({ jsonrpc: "2.0", id, error: payload.rpcError });
		}
		return reply(payload);
	};
	return { fetch, calls, methods, headers, sessionHeaders };
}
