import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evidenceStore } from "./evidence.ts";
import { clearRetrievalCache } from "./providers/reuse.ts";
import { search, type SearchInput, type UnifiedSearchOptions } from "./search.ts";
import { searchTool } from "./tool.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_MESSAGE_CHARS = 128 * 1024;
const MAX_IN_FLIGHT = 16;
type RequestId = string | number;

const mcpSearchTool = {
	name: searchTool.name,
	description: searchTool.description,
	inputSchema: searchTool.parameters,
	annotations: searchTool.annotations,
};

export async function serveStdio(input: Readable, output: Writable, version: string, options: UnifiedSearchOptions = {}): Promise<void> {
	const sessionId = randomUUID();
	const ctx = { sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
	const inFlight = new Map<RequestId, AbortController>();
	const jobs = new Set<Promise<void>>();
	let protocol: string | undefined;
	let ready = false;
	let closing = false;
	const send = (message: object) => { if (!closing) output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); };
	const result = (id: RequestId, value: object) => send({ id, result: value });
	const fail = (id: RequestId | null, code: number, message: string) => send({ id, error: { code, message } });

	async function handle(line: string | null) {
		if (line === null) { fail(null, -32700, "Message is too large"); return; }
		let value: unknown;
		try { value = JSON.parse(line); } catch { fail(null, -32700, "Parse error"); return; }
		const rpc = record(value);
		const params = record(rpc?.params);
		const id = rpc?.id;
		if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string" ||
			(id !== undefined && typeof id !== "string" && typeof id !== "number")) {
			fail(null, -32600, "Invalid request"); return;
		}

		if (id === undefined) {
			if (rpc.method === "notifications/initialized" && protocol) ready = true;
			if (rpc.method === "notifications/cancelled") {
				const requestId = params?.requestId;
				if (typeof requestId === "string" || typeof requestId === "number") inFlight.get(requestId)?.abort();
			}
			return;
		}

		switch (rpc.method) {
			case "initialize": {
				if (protocol || typeof params?.protocolVersion !== "string") { fail(id, -32602, "Invalid initialize parameters"); return; }
				protocol = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
				result(id, { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: "@gagansd/pi-web-search", version } });
				return;
			}
			case "ping": result(id, {}); return;
			case "tools/list": {
				if (!ready) { fail(id, -32002, "Server is not initialized"); return; }
				result(id, { tools: [mcpSearchTool] });
				return;
			}
			case "tools/call": {
				if (!ready) { fail(id, -32002, "Server is not initialized"); return; }
				const args = record(params?.arguments);
				if (params?.name !== searchTool.name || (params.arguments !== undefined && !args)) {
					fail(id, -32602, "Expected search and an arguments object"); return;
				}
				if (inFlight.has(id) || inFlight.size >= MAX_IN_FLIGHT) {
					fail(id, -32000, "Duplicate request ID or too many requests in flight"); return;
				}
				const controller = new AbortController();
				inFlight.set(id, controller);
				try {
					const found = await search(String(id), (args ?? {}) as SearchInput, controller.signal, undefined, ctx, { ...options, standalone: true });
					if (!controller.signal.aborted) result(id, {
						content: found.content,
						...(protocol !== "2024-11-05" && protocol !== "2025-03-26" ? { structuredContent: found.structuredContent } : {}),
						isError: found.isError === true,
					});
				} catch {
					if (!controller.signal.aborted) fail(id, -32603, "Search failed internally");
				} finally {
					inFlight.delete(id);
				}
				return;
			}
			default: fail(id, -32601, "Method not found");
		}
	}

	try {
		for await (const line of messageLines(input)) {
			const job = handle(line);
			jobs.add(job);
			void job.then(() => jobs.delete(job), () => jobs.delete(job));
			if (output.writableNeedDrain) await new Promise<void>((resolve) => output.once("drain", resolve));
		}
	} finally {
		closing = true;
		for (const controller of inFlight.values()) controller.abort();
		await Promise.allSettled(jobs);
		evidenceStore.clear(sessionId);
		clearRetrievalCache(sessionId);
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** JSON-RPC stdio uses one UTF-8 message per newline. Discard oversized lines as they arrive. */
async function* messageLines(input: Readable): AsyncGenerator<string | null> {
	const decoder = new StringDecoder("utf8");
	let line = "";
	let oversized = false;
	for await (const chunk of input) {
		const segments = (typeof chunk === "string" ? chunk : decoder.write(chunk)).split("\n");
		for (const segment of segments.slice(0, -1)) {
			yield oversized || line.length + segment.length > MAX_MESSAGE_CHARS ? null : line + segment;
			line = "";
			oversized = false;
		}
		const tail = segments.at(-1)!;
		oversized ||= line.length + tail.length > MAX_MESSAGE_CHARS;
		line = oversized ? "" : line + tail;
	}
	const tail = decoder.end();
	if (oversized) yield null;
	else if (line || tail) yield line + tail;
}
