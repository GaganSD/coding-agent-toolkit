import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = process.env.PI_WEB_SEARCH_CONFIG;
assert.ok(config);
writeFileSync(config, JSON.stringify({ web: { provider: "searxng", fallback: [] }, searxng: { url: "https://search.example" } }));
const preload = `
globalThis.fetch = async (url, init) => {
	const parsed = new URL(url);
	if (parsed.origin !== "https://search.example" || parsed.pathname !== "/search" || init.redirect !== "error") {
		throw new Error("Unexpected MCP egress: " + parsed.hostname + parsed.pathname);
	}
	return Response.json({ results: [{ title: "Fixture", url: "https://source.example/item", content: "Fixture evidence for continuation. ".repeat(300) }] });
};
`;
const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, process.argv[2]], {
	stdio: ["pipe", "pipe", "inherit"],
});
const closed = once(child, "close");
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
let id = 0;
const send = (method: string, params: object, requestId?: number) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: requestId }) + "\n");
const call = async (method: string, params = {}) => {
	send(method, params, ++id);
	const reply = await lines.next();
	assert.equal(reply.done, false, `Server exited before replying to ${method}`);
	const message = JSON.parse(reply.value);
	assert.equal(message.id, id);
	assert.equal(message.error, undefined, JSON.stringify(message.error));
	return message.result;
};
try {
	const initialized = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pack-check", version: "1" } });
	assert.equal(initialized.protocolVersion, "2025-11-25");
	assert.match(initialized.instructions, /Supply one of `query`, `urls`, or `ref`/u);
	assert.match(initialized.instructions, /library:/u);
	send("notifications/initialized", {});
	const listed = await call("tools/list");
	assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name), ["search"]);
	assert.ok(listed.tools[0].inputSchema.properties.query);
	const invalid = await call("tools/call", { name: "search", arguments: { query: "invalid", effort: "bogus" } });
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /effort must be fast or thorough/);
	const queried = await call("tools/call", { name: "search", arguments: { query: "fixture" } });
	assert.equal(queried.isError, false, JSON.stringify(queried.structuredContent));
	const ref = queried.structuredContent.searchResults[0].ref;
	assert.ok(ref);
	const continued = await call("tools/call", { name: "search", arguments: { ref } });
	assert.equal(continued.isError, false, JSON.stringify(continued.structuredContent));
	assert.match(continued.content[0].text, /Fixture evidence for continuation/);
	assert.equal(continued.structuredContent.ref, ref);
	child.stdin.end();
	const [status] = await closed;
	assert.equal(status, 0);
	console.log("Packed MCP starts without Pi, lists one tool, and continues a ref across calls.");
} finally {
	clearTimeout(timer);
	if (child.exitCode === null) child.kill();
}
