import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { WebSearchDetails } from "../src/format.ts";
import type { SearchInput, SearchScope } from "../src/search.ts";
import { directory, evidenceFor, excerpts, routes, type Fixture, type Transport } from "./replay.ts";

export type Result = AgentToolResult<WebSearchDetails>;
export type Step = { query: string; scope: SearchScope } | { urls: string[] } | { ref: true; cursor?: true };
export interface Task {
	id: string;
	split: "calibration" | "holdout";
	category: string;
	prompt: string;
	fixture: string;
	steps: Step[];
	expected: { maxCalls: number; ref: boolean };
}
export type Search = (input: SearchInput, signal?: AbortSignal) => Promise<Result>;

export function loadTasks(): Task[] {
	const ids = new Set<string>();
	return (["calibration", "holdout"] as const).flatMap((split) => {
		const rows = readFileSync(join(directory, "tasks", `${split}.jsonl`), "utf8").trim().split("\n");
		assert.ok(rows.length >= 20, `${split} must contain at least 20 tasks`);
		return rows.map((line) => {
			const task: Task = JSON.parse(line);
			assert.ok(!ids.has(task.id) && /^[a-z]+-\d+$/u.test(task.id) && task.fixture === task.id, "A task must have a unique ID and fixture ID");
			assert.ok(task.split === split && task.prompt.trim() && Object.hasOwn(excerpts, task.category), `Invalid task metadata: ${task.id}`);
			assert.ok(task.steps.length >= 1 && task.steps.length <= task.expected.maxCalls, `Invalid call budget: ${task.id}`);
			assert.equal(task.steps.some((step) => "ref" in step), task.expected.ref, `Invalid ref expectation: ${task.id}`);
			ids.add(task.id);
			return task;
		});
	});
}

export function taskFixtures(task: Task, index: number, step: Step, thorough = false): Fixture[] {
	if ("ref" in step) return [];
	if ("urls" in step) return step.urls.map((value) => {
		const url = new URL(value);
		url.hash = "";
		return { transport: "jina", target: url.href, evidence: evidenceFor(task.fixture, index, task.category, "jina", value) };
	});
	const transports: Transport[] = step.scope === "both" ? ["exa", "parallel", "grep", "sourcegraph"]
		: step.scope === "code" ? thorough ? ["grep", "sourcegraph"] : ["grep"]
		: thorough ? ["exa", "parallel"] : ["exa"];
	return transports.map((transport) => ({ transport, query: step.query, evidence: evidenceFor(task.fixture, index, task.category, transport) }));
}

export function directText(result: Result): string {
	return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

interface OutputEvidence { searchResults?: { url?: string; citedText?: string; ref?: string }[]; sources?: { url: string }[] }

export function auditCitations(result: Result, fixtures: Fixture[], id: string) {
	const structured = result.structuredContent as OutputEvidence;
	const hits = structured.searchResults ?? [];
	const cited = fixtures.flatMap((fixture) => fixture.evidence);
	let snippetChars = 0;
	let duplicates = 0;
	const seen = new Set<string>();
	assert.ok(hits.length > 0, `No visible evidence for ${id}`);
	for (const [index, hit] of hits.entries()) {
		assert.match(hit.url ?? "", /^https?:\/\//u, `No HTTP(S) URL for ${id} hit ${index + 1}`);
		const evidence = cited.filter(({ url }) => url === hit.url);
		assert.ok(evidence.length, `Unexpected citation in ${id} hit ${index + 1}`);
		const snippet = normalize((hit.citedText ?? "").replace(/\s*…\s*$/u, ""));
		assert.ok(snippet && evidence.some(({ text }) => normalize(text).includes(snippet)), `Citation snippet is absent from the fixture: ${id} hit ${index + 1}`);
		const key = JSON.stringify([hit.url, snippet]);
		if (seen.has(key)) duplicates++;
		seen.add(key);
		snippetChars += snippet.length;
	}
	for (const source of structured.sources ?? []) {
		assert.ok(cited.some(({ url }) => url === source.url), `Unexpected source URL in ${id}`);
	}
	return { hits: hits.length, duplicates, snippetChars };
}

export function assertHosts(attempts: { host: string }[], fixtures: Fixture[], id: string): void {
	const hosts = new Set(fixtures.map(({ transport }) => new URL(routes[transport]).host));
	assert.ok(attempts.every(({ host }) => hosts.has(host)), `Disallowed destination in ${id}`);
}
