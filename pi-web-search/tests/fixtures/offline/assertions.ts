import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { WebSearchDetails } from "../../../src/format.ts";
import type { SearchInput } from "../../../src/search.ts";
import { routes, type Fixture } from "./replay.ts";

export type Result = AgentToolResult<WebSearchDetails>;
export type Search = (input: SearchInput, signal?: AbortSignal) => Promise<Result>;

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
