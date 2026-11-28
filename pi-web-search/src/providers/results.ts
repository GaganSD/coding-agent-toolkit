import { sourceFamily } from "./types.ts";
import type {
	EvidenceProvider,
	SearchResultDetail,
	Source,
	StreamResult,
} from "./types.ts";

/** `Source.title` is required, so an untitled page falls back to its URL. */
export function sourcesFromResults(results: SearchResultDetail[]): Source[] {
	const sources: Source[] = [];
	for (const result of results) {
		if (result.url) {
			sources.push({ title: result.title || result.url, url: result.url });
		}
	}
	return sources;
}

/** Preserve query strings and fragments that identify distinct evidence. */
export function evidenceKey(hit: SearchResultDetail): string | undefined {
	return hit.url ? JSON.stringify([hit.url, hit.citedText, hit.type]) : undefined;
}

/** Exact evidence deduplication, not URL-only dedup: distinct passages stay distinct. */
export function uniqueEvidence(result: StreamResult): StreamResult {
	const seen = new Map<string, SearchResultDetail>();
	const searchResults: SearchResultDetail[] = [];
	for (const hit of result.searchResults ?? []) {
		const key = evidenceKey(hit);
		if (!key || !seen.has(key)) {
			searchResults.push({ ...hit });
			if (key) seen.set(key, searchResults[searchResults.length - 1]);
		} else {
			const existing = seen.get(key)!;
			const providers = new Set([...(existing.source ?? "").split(", "), ...(hit.source ?? "").split(", ")].filter(Boolean));
			existing.source = [...providers].join(", ");
		}
	}
	return { ...result, searchResults };
}

/** One global preview count; URL evidence is prioritized rather than silently lost. */
export function previewEvidence(result: StreamResult, maxResults: number, urls: string[] = [], continuation = false): StreamResult {
	const all = result.searchResults ?? [];
	const requested = new Set(urls.map(extractionUrlKey));
	const priority = all.filter((hit) => hit.url && requested.has(extractionUrlKey(hit.url)) && ["extract", "content"].includes(hit.type ?? ""));
	const prioritized = new Set(priority);
	const rest = all.filter((hit) => !prioritized.has(hit));
	const ordered = [...priority, ...rest];
	const searchResults = selectPreview(ordered, maxResults);
	const chosen = new Set(searchResults.flatMap((hit) => hit.url ? [hit.url] : []));
	const omitted = all.length - searchResults.length;
	return {
		...result, searchResults,
		sources: all.length ? (result.sources ?? []).filter((source) => chosen.has(source.url)) : result.sources,
		warnings: [...(result.warnings ?? []), ...(omitted ? [`${omitted} additional result(s) omitted from the preview; ${continuation ? "use search({ref}) for stored evidence" : "retrieve cited URLs again for more evidence"}.`] : [])],
	};
}

/** HTTP document identity: preserve the path/query; ignore fragments. */
export function extractionUrlKey(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:") { url.hash = ""; return url.href; }
	} catch { /* Invalid values retain exact-match behavior. */ }
	return value;
}

export function extractedDocuments(result: StreamResult, urls: string[]): number {
	const requested = new Set(urls.map(extractionUrlKey));
	const read = new Set<string>();
	for (const hit of result.searchResults ?? []) {
		if (!hit.citedText?.trim() || (hit.type !== "content" && hit.type !== "extract")) continue;
		const url = hit.url;
		if (url && requested.has(extractionUrlKey(url))) read.add(extractionUrlKey(url));
	}
	return read.size;
}

/** Reserve one slot per represented family without changing stored-order refs. */
function selectPreview(ordered: SearchResultDetail[], maxResults: number): SearchResultDetail[] {
	const picked = ordered.slice(0, Math.max(0, maxResults));
	if (picked.length < 2) return picked;
	for (const family of ["web", "code"] as const) {
		if (picked.some((hit) => sourceFamily(hit.source) === family)) continue;
		const candidate = ordered.find((hit) => sourceFamily(hit.source) === family);
		if (!candidate) continue;
		// The other family keeps its first slot; replace the last redundant hit.
		for (let index = picked.length - 1; index >= 0; index--) {
			const current = sourceFamily(picked[index].source);
			if (current && picked.filter((hit) => sourceFamily(hit.source) === current).length === 1) continue;
			picked[index] = candidate;
			break;
		}
	}
	return picked.sort((left, right) => ordered.indexOf(left) - ordered.indexOf(right));
}

export interface ProviderContribution {
	kind: EvidenceProvider;
	result: StreamResult;
}

/**
 * Concatenates successful provider results. Hits that share a URL stay
 * distinct — a search hit and a /contents hit are not the same document.
 * Citations (the `sources` index) are deduplicated by URL so the same page is
 * not listed once per provider, and text-only contributions are preserved
 * rather than silently dropped.
 */
export function mergeStreamResults(
	parts: ProviderContribution[],
	extraWarnings: string[] = [],
): StreamResult {
	if (parts.length === 0) {
		throw new Error("mergeStreamResults requires at least one contribution");
	}

	const searchResults: SearchResultDetail[] = [];
	const sources: Source[] = [];
	const seenSourceUrls = new Set<string>();
	const texts: string[] = [];
	const seenText = new Set<string>();
	const warnings: string[] = [...extraWarnings];
	const usage: { name: string; count: number }[] = [];
	const requestIds: string[] = [];
	const kinds = new Set<EvidenceProvider>();

	for (const { kind, result } of parts) {
		kinds.add(kind);
		for (const provider of result.providers ?? []) kinds.add(provider);
		searchResults.push(...(result.searchResults ?? []));
		const contributed = result.sources?.length
			? result.sources
			: sourcesFromResults(result.searchResults ?? []);
		for (const source of contributed) {
			if (seenSourceUrls.has(source.url)) {
				continue;
			}
			seenSourceUrls.add(source.url);
			sources.push(source);
		}
		if (result.text.length > 0 && !seenText.has(result.text)) {
			seenText.add(result.text);
			texts.push(result.text);
		}
		warnings.push(...(result.warnings ?? []));
		usage.push(...(result.usage ?? []));
		if (result.requestId) {
			requestIds.push(`${kind}:${result.requestId}`);
		}
	}

	return {
		text: texts.join("\n\n"),
		providerKind: parts[0].kind,
		providers: [...kinds],
		...(parts.every(({ result }) => result.cached) ? { cached: true } : {}),
		searchResults,
		sources,
		...(requestIds.length > 0 ? { requestId: requestIds.join(",") } : {}),
		...(usage.length > 0 ? { usage } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
	};
}
