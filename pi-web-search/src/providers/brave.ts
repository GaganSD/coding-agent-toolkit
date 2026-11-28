import { braveApiKey } from "../env.ts";
import { getJson, normalizeHttpError, type FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { publicResultUrl } from "./result-url.ts";
import { jinaFetch } from "./jina.ts";
import { mergeStreamResults, sourcesFromResults } from "./results.ts";
import { isProviderError, providerError, type SearchResultDetail, type StreamResult } from "./types.ts";

export const BRAVE_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

/** Search the configured Brave endpoint using the same credential. */
export async function braveSearch(req: SearchRequest, options: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	if (req.fetchOnly) return jinaFetch(req, options);
	const key = braveApiKey();
	if (!key) throw providerError("missing_credentials", "Brave requires BRAVE_API_KEY or a stored brave key.");
	const context = req.settings.brave?.mode !== "web";
	const maxChars = context ? 600 : 400;
	const maxWords = context ? 75 : 50;
	if (!req.query.trim() || req.query.length > maxChars || req.query.trim().split(/\s+/u).length > maxWords) {
		throw providerError("unknown", `Brave queries must contain 1–${maxChars} characters and at most ${maxWords} words.`);
	}
	const url = new URL(context ? BRAVE_CONTEXT_URL : BRAVE_SEARCH_URL);
	url.searchParams.set("q", req.query);
	url.searchParams.set("count", String(req.settings.maxResults));
	if (req.filters?.recency) url.searchParams.set("freshness", FRESHNESS[req.filters.recency]);
	if (context) {
		// https://api-dashboard.search.brave.com/api-reference/ai/llm_context/get
		url.searchParams.set("maximum_number_of_urls", String(req.settings.maxResults));
		url.searchParams.set("maximum_number_of_tokens", "8192");
	} else {
		url.searchParams.set("text_decorations", "false");
	}
	const [search, fetched] = await Promise.allSettled([
		getJson<unknown>(url.href, { headers: { Accept: "application/json", "X-Subscription-Token": key },
			signal: req.signal, timeoutMs: req.settings.timeoutMs, maxResponseBytes: 1024 * 1024, fetchImpl: options.fetchImpl, httpError: braveHttpError }),
		req.urls?.length ? jinaFetch(req, options) : Promise.resolve(undefined),
	]);
	if (search.status === "rejected") {
		if (search.reason instanceof Error) search.reason.message = search.reason.message.replaceAll(key, "[redacted]");
		throw search.reason;
	}
	const body = record(search.value);
	const web = record(body?.web);
	const items = context ? record(body?.grounding)?.generic
		: web?.results ?? (body?.type === "search" && body.web === undefined ? [] : undefined);
	if (!Array.isArray(items)) throw providerError("parse_error", "Brave returned an invalid result envelope.", { retryable: true });
	const searchResults = items.flatMap((value): SearchResultDetail[] => {
		const hit = record(value);
		const url = publicResultUrl(hit?.url);
		if (!hit || !url) return [];
		const snippets = Array.isArray(hit.snippets) ? hit.snippets.filter((text): text is string => typeof text === "string") : [];
		return [{ url, source: "brave", title: typeof hit.title === "string" ? plainText(hit.title) : undefined,
			citedText: context ? snippets.join("\n\n") : typeof hit.description === "string" ? plainText(hit.description) : "",
			pageAge: typeof hit.page_age === "string" ? hit.page_age : null }];
	}).slice(0, req.settings.maxResults);
	if (items.length && !searchResults.length) throw providerError("parse_error", "Brave returned no valid public result URLs.", { retryable: true });
	const result: StreamResult = { text: "", providerKind: "brave", searchResults, sources: sourcesFromResults(searchResults) };
	if (fetched.status === "rejected") {
		if (req.signal?.aborted || (isProviderError(fetched.reason) && fetched.reason.code === "aborted")) throw fetched.reason;
		return { ...result, warnings: [`Jina URL extraction failed (${isProviderError(fetched.reason) ? fetched.reason.code : "unknown"}).`] };
	}
	return fetched.value ? mergeStreamResults([{ kind: "brave", result }, { kind: "jina", result: fetched.value }]) : result;
}

const braveHttpError: typeof normalizeHttpError = (response, text) => {
	const status = response.status;
	const base = normalizeHttpError(response, text);
	if (status === 402 || /"code"\s*:\s*"QUOTA_LIMITED"/u.test(text)) {
		return providerError(status === 429 ? "rate_limited" : "http_error", "Brave search quota exceeded. Check the Brave API dashboard.", {
			status, retryable: true, retryAfterMs: base.retryAfterMs,
		});
	}
	if (status === 401 || status === 403) {
		return providerError("missing_credentials", "Brave rejected the key. Check BRAVE_API_KEY or the stored brave key and its endpoint access.", { status });
	}
	return base;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function plainText(text: string): string {
	const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
	return text.replace(/<\/?(?:b|strong|em|mark)\b[^>]*>/gi, "").replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, value: string) => {
		if (!value.startsWith("#")) return named[value.toLowerCase()] ?? entity;
		const code = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : Number(value.slice(1));
		return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
	});
}
