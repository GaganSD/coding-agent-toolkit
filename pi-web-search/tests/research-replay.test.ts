import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Replay, retrieve } from "../benchmarks/harness/replay.ts";

function rpc(id: number, query: string, options: Record<string, unknown> = {}): RequestInit {
	return { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
		params: { name: "web_search_exa", arguments: { query, ...options } },
	}) };
}

test("research replay shares sanitized Exa responses and fails closed on misses", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-research-replay-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "responses.json");
	const original = t.mock.method(globalThis, "fetch", async () => Response.json({
		jsonrpc: "2.0", id: 123, result: { content: [{ type: "text",
			text: "Title: Example\nURL: https://example.org/doc?api_key=placeholder\nHighlights:\nRecorded text",
		}], requestId: "provider-request" },
	}));
	const writer = new Replay(path, true);
	const restoreLive = writer.install("model");
	try {
		const captured = await retrieve(() => fetch("https://mcp.exa.ai/mcp", rpc(7, "test query", { objective: "test objective", numResults: 8 })));
		assert.equal((await captured.json()).id, 7);
		writer.save();
		assert.equal(original.mock.callCount(), 1);
	} finally { restoreLive(); }
	assert.doesNotMatch(readFileSync(path, "utf8"), /test query|placeholder|provider-request/u);
	const reader = new Replay(path, false);
	const restoreOffline = reader.install();
	try {
		const response = await fetch("https://mcp.exa.ai/mcp?tools=web_search_exa", rpc(99, "test query", { numResults: 5 }));
		const value = await response.json();
		assert.equal(value.id, 99);
		assert.match(value.result.content[0].text, /Recorded text/u);
		await assert.rejects(fetch("https://mcp.exa.ai/mcp", rpc(100, "different test query")), /Replay miss/u);
		assert.throws(() => net.connect(443, "example.invalid"), /Replay miss: direct socket/u);
		assert.equal(original.mock.callCount(), 1);
		assert.deepEqual(reader.misses, ["mcp.exa.ai web_search_exa", "direct socket"]);
	} finally { restoreOffline(); }
});
