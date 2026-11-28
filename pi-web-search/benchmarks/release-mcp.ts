import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { Value } from "typebox/value";
import { writeFileSync } from "node:fs";
import { serveStdio } from "../src/mcp.ts";
import { jinaFetch } from "../src/providers/jina.ts";
import { readUrls } from "../src/read/index.ts";
import type { PageTransport } from "../src/read/http.ts";
import type { SearchInput } from "../src/search.ts";
import { searchTool } from "../src/tool.ts";
import { auditCitations, directText, loadTasks, taskFixtures, type Result } from "./corpus.ts";
import { measureAddressSafety, measureLocalReading } from "./release-reader.ts";
import { clearRetrievalCache } from "../src/providers/reuse.ts";
import { type Replay } from "./replay.ts";

async function openSession() {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines = createInterface({ input: output });
	let reader: PageTransport | undefined;
	const done = serveStdio(input, output, "0.5.0", {
		readUrls: (request) => reader
			? readUrls(request, { transport: reader, runGh: async () => undefined, githubToken: () => undefined })
			: jinaFetch(request),
	});
	const iterator = lines[Symbol.asyncIterator]();
	let id = 0;
	async function request<T>(method: string, params?: object): Promise<T> {
		input.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
		const timeout = AbortSignal.timeout(15_000);
		const message = await new Promise<IteratorResult<string>>((resolve, reject) => {
			const abort = () => reject(new Error(`MCP benchmark call timed out: ${method}`));
			timeout.addEventListener("abort", abort, { once: true });
			void iterator.next().then(resolve, reject).finally(() => timeout.removeEventListener("abort", abort));
		});
		assert.equal(message.done, false, "MCP call ended without a response");
		const envelope = JSON.parse(message.value);
		assert.equal(envelope.id, id, "Mismatched MCP response ID");
		assert.ok(!envelope.error, JSON.stringify(envelope.error));
		return envelope.result as T;
	}
	function notify(method: string): void {
		input.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
	}
	await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "benchmark", version: "1" } });
	notify("notifications/initialized");
	return {
		request,
		call: async (params: SearchInput, transport?: PageTransport): Promise<Result> => {
			reader = transport;
			const result = await request<Omit<Result, "details">>("tools/call", { name: "search", arguments: params });
			assert.ok(Value.Check(searchTool.outputSchema, result.structuredContent), "MCP structured content must conform to the Pi output schema");
			return { ...result, details: result.structuredContent as Result["details"] };
		},
		close: async () => {
			input.end();
			await done;
			lines.close();
		},
	};
}

function declarationFootprint(tools: { name: string; description: string; inputSchema: unknown; outputSchema?: unknown; annotations: unknown }[]) {
	assert.deepEqual(tools.map(({ name }) => name), ["search"]);
	const [tool] = tools;
	assert.deepEqual(tool.inputSchema, searchTool.parameters);
	assert.equal(tool.outputSchema, undefined, "MCP declaration should omit the programmatic output schema");
	assert.deepEqual(tool.annotations, searchTool.annotations);
	const pi = { name: searchTool.name, description: searchTool.description, parameters: searchTool.parameters };
	const mcp = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
	const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
	const estimates = {
		piInputTokens: tokens(pi),
		mcpInputTokens: tokens(mcp),
		mcpFullTokens: tokens(tools),
		piWithAnnotationsTokens: tokens([{ ...pi, annotations: searchTool.annotations }]),
	};
	assert.ok(estimates.mcpInputTokens <= estimates.piInputTokens * 1.1, "MCP input declaration exceeded 110% of corresponding Pi declaration");
	assert.ok(estimates.mcpFullTokens <= tokens([pi]) * 1.1, "Full MCP declaration exceeded 110% of the Pi tool declaration");
	return estimates;
}

export async function measureMcp(replay: Replay, configPath: string) {
	writeFileSync(configPath, JSON.stringify({ research: { enabled: true } }));
	const session = await openSession();
	try {
		const listed = await session.request<{ tools: Parameters<typeof declarationFootprint>[0] }>("tools/list");
		const declaration = declarationFootprint(listed.tools);
		let citedHits = 0;
		let refChecks = 0;
		let cursorChecks = 0;
		for (const task of loadTasks()) {
			let fixtures = taskFixtures(task, 0, task.steps[0]);
			let ref: string | undefined;
			let cursor: string | undefined;
			let offset = 0;
			for (const [index, step] of task.steps.entries()) {
				const continuation = "ref" in step;
				if (!continuation) fixtures = taskFixtures(task, index, step);
				replay.use(continuation ? [] : fixtures);
				const args = continuation ? { ref, ...(step.cursor ? { cursor } : {}) } : step;
				if (continuation) assert.ok(ref && (!step.cursor || cursor), `MCP fixture omitted ref/cursor for ${task.id}`);
				const result = await session.call(args);
				replay.assertClean();
				assert.equal(result.isError, false, `${task.id}: ${directText(result)}`);
				citedHits += auditCitations(result, fixtures, task.id).hits;
				const hit = result.details.searchResults?.[0];
				assert.ok(hit?.url);
				if (continuation) {
					const text = fixtures.flatMap((fixture) => fixture.evidence).find(({ url }) => hit.url === url)?.text;
					assert.ok(text && hit.citedText);
					assert.equal(hit.ref, ref);
					assert.equal(hit.citedText, text.slice(offset, offset + hit.citedText.length));
					assert.ok(directText(result).startsWith(hit.citedText));
					offset += hit.citedText.length;
					cursor = result.details.cursor;
					assert.equal(replay.attempts.length, 0, "MCP ref call accessed a provider");
					refChecks++;
					if (step.cursor) cursorChecks++;
				} else {
					ref = hit.ref;
					offset = 0;
				}
			}
		}
		const reader = await measureLocalReading(session.call, replay, "MCP");
		const safety = await measureAddressSafety(session.call, replay, "MCP");
		process.env.EXA_API_KEY = "SENTINEL_OFFLINE_MCP_CREDENTIAL";
		try {
			clearRetrievalCache();
			writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: [] } }));
			replay.use([{
				transport: "exa-rest", query: "redaction round trip", evidence: [],
				onRequest: () => { throw new TypeError("Upstream echoed SENTINEL_OFFLINE_MCP_CREDENTIAL"); },
			}]);
			const redacted = await session.call({ query: "redaction round trip" });
			replay.assertClean();
			assert.equal(redacted.isError, true);
			assert.doesNotMatch(JSON.stringify(redacted), /SENTINEL_OFFLINE_MCP_CREDENTIAL/u);
			assert.match(directText(redacted), /\[redacted\]/u);
		} finally {
			delete process.env.EXA_API_KEY;
		}
		return { declaration, citedHits, refChecks, cursorChecks, reader, safety, leakedKeys: 0 };
	} finally {
		await session.close();
	}
}
