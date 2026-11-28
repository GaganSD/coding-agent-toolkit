import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "../scripts/validation.ts";
import { exaSearch, EXA_MCP_URL } from "../src/providers/exa.ts";
import { applyConfig } from "../src/providers/config.ts";
import { loadTasks } from "./corpus.ts";
import { directory } from "./replay.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log("npm run research:record -- --live --task=cal-01\nRecord one versioned, public web query against keyless Exa into ignored research/results.");
} else {
	assert.ok(args.includes("--live"), "Recording sends a public task query to keyless Exa. Pass --live explicitly.");
	const id = args.find((arg) => arg.startsWith("--task="))?.slice("--task=".length);
	const task = loadTasks().find((candidate) => candidate.id === id);
	assert.ok(task, "Select one versioned task using --task=<task-id>");
	const step = task.steps.find((step) => "query" in step && step.scope === "web");
	assert.ok(step && "query" in step, "Recording requires a task with a public web query step");
	if (!args.includes("--child")) {
		withTemporaryDirectory("pi-web-search-record-", (root) => {
			process.stdout.write(runCommand(process.execPath, [process.argv[1], "--child", ...args], root, isolatedEnvironment(root)));
		});
	} else {
		assert.ok(process.env.PI_WEB_SEARCH_CONFIG && !process.env.EXA_API_KEY, "Recording requires an isolated, credentialless child");
		const result = await exaSearch({
			query: step.query,
			settings: applyConfig(process.env.PI_WEB_SEARCH_CONFIG, { timeoutMs: 15_000 }),
		}, {
			fetchImpl: async (input, init) => {
				assert.equal(String(input), EXA_MCP_URL);
				assert.equal(new Headers(init?.headers).has("authorization"), false);
				return fetch(input, { ...init, redirect: "error" });
			},
		});
		// Keep a small, reviewable normalized recording. Do not copy provider
		// headers, payload metadata, request IDs, account IDs or session IDs.
		const evidence = result.searchResults?.flatMap((hit) => {
			if (!hit.url || !hit.citedText) return [];
			const url = new URL(hit.url);
			if (url.protocol !== "https:" || url.username || url.password) return [];
			url.search = "";
			url.hash = "";
			if (/(?:authorization|bearer\s|cookie|api[_ -]?key|subscription-token|account[_ -]?id)[\s":=]*\S/iu.test(hit.citedText + "\n" + hit.title)) return [];
			return [{ url: url.href, title: hit.title ?? url.href, text: hit.citedText }];
		}) ?? [];
		assert.ok(evidence.length, "Keyless Exa returned no evidence suitable for review");
		const output = resolve(directory, "../research", "results", `recorded-${task.id}.json`);
		mkdirSync(resolve(output, ".."), { recursive: true });
		writeFileSync(output, JSON.stringify({ transport: "exa", query: step.query, evidence }, null, 2) + "\n");
		console.log(`Saved ${evidence.length} normalized excerpts to ${output}`);
	}
}
