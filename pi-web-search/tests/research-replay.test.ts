import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import dns from "node:dns";
import { lookup, resolve4, Resolver } from "node:dns/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedInput, checkPath, claimOutput } from "../benchmarks/harness/provenance.ts";
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
	const writer = new Replay(path, true, "draft");
	const restoreLive = writer.install("model");
	try {
		const captured = await retrieve(() => fetch("https://mcp.exa.ai/mcp", rpc(7, "test query", { objective: "test objective", numResults: 8 })));
		assert.equal((await captured.json()).id, 7);
		writer.save();
		assert.equal(original.mock.callCount(), 1);
	} finally { restoreLive(); }
	assert.doesNotMatch(readFileSync(path, "utf8"), /test query|placeholder|provider-request/u);
	const reader = new Replay(path, false, "draft");
	const restoreOffline = reader.install();
	try {
		const response = await fetch("https://mcp.exa.ai/mcp?tools=web_search_exa", rpc(99, "test query", { numResults: 5 }));
		const value = await response.json();
		assert.equal(value.id, 99);
		assert.match(value.result.content[0].text, /Recorded text/u);
		await assert.rejects(fetch("https://mcp.exa.ai/mcp", rpc(100, "different test query")), /Replay miss/u);
		assert.throws(() => net.connect(443, "example.invalid"), /Replay miss: direct socket/u);
		await assert.rejects(lookup("example.invalid"), /Replay miss: DNS lookup/u);
		await assert.rejects(resolve4("example.invalid"), /Replay miss: DNS resolve4/u);
		await assert.rejects(new Resolver().resolveTxt("example.invalid"), /Replay miss: DNS resolveTxt/u);
		assert.throws(() => dns.resolve4("example.invalid", () => {}), /Replay miss: DNS resolve4/u);
		assert.equal(original.mock.callCount(), 1);
		assert.deepEqual(reader.misses, ["mcp.exa.ai web_search_exa", "direct socket",
			"DNS lookup", "DNS resolve4", "DNS resolveTxt", "DNS resolve4"]);
	} finally { restoreOffline(); }
});

test("draft output and cassettes cannot be reused as final, including through aliases", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-research-provenance-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const output = claimOutput(join(directory, "output"), "draft");
	const alias = join(directory, "alias");
	symlinkSync(output, alias, "junction");
	assert.equal(claimOutput(alias, "draft"), output);
	assert.throws(() => claimOutput(alias, "final"), /output provenance differs/u);
	const cassette = join(output, "private.json");
	new Replay(cassette, true, "draft").save();
	assert.throws(() => new Replay(join(alias, "private.json"), true, "final"), /cassette provenance/u);
	const symlink = join(directory, "alias.json");
	symlinkSync(cassette, symlink);
	assert.throws(() => new Replay(symlink, true, "final"), /must not be a symlink/u);
	assert.throws(() => checkPath(symlink), /must not be a symlink/u);
	const old = join(directory, "legacy");
	mkdirSync(old);
	writeFileSync(join(old, "responses.json"), "{}");
	assert.throws(() => claimOutput(old, "final"), /output has no provenance/u);
	assert.throws(() => new Replay(join(old, "responses.json"), false, "final"), /cassette provenance/u);
	const draftInputs = join(directory, "inputs-draft");
	mkdirSync(draftInputs);
	const inputAlias = join(directory, "inputs");
	symlinkSync(draftInputs, inputAlias, "junction");
	assert.throws(() => approvedInput(inputAlias, "final"), /Use --draft/u);
});
