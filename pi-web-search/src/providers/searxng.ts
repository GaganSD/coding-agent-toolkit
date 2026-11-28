import { httpOrigin } from "./config.ts";
import { getJson, normalizeHttpError, type FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { publicResultUrl } from "./result-url.ts";
import { applyDomainFilter, recencyWarning } from "./filters.ts";
import { sourcesFromResults } from "./results.ts";
import { isProviderError, providerError, type SearchResultDetail, type StreamResult } from "./types.ts";

const JSON_SETUP = 'Enable "json" under search.formats in your SearXNG settings.yml and restart the instance.';

/** The sole private-origin exception is the operator's origin, on its fixed /search route. */
export async function searxngSearch(req: SearchRequest, { fetchImpl = fetch }: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	const origin = req.settings.searxng?.url && httpOrigin(req.settings.searxng.url);
	if (!origin) throw providerError("invalid_config", 'Set "searxng.url" to an HTTP(S) origin to use SearXNG.');
	const url = new URL("/search", origin);
	const domainOperators = (req.filters?.domains ?? []).filter((domain) => domain.startsWith("-"))
		.map((domain) => `-site:${domain.slice(1)}`);
	// Multiple inclusion domains are an OR filter. Applying those locally avoids relying on backend operator precedence.
	const include = (req.filters?.domains ?? []).filter((domain) => !domain.startsWith("-"));
	if (include.length === 1) domainOperators.push(`site:${include[0]}`);
	url.searchParams.set("q", [req.query, ...domainOperators].join(" "));
	url.searchParams.set("format", "json");
	const recency = req.filters?.recency;
	const warning = recencyWarning("SearXNG", recency);
	if (recency && recency !== "week") url.searchParams.set("time_range", recency);

	const body = await getJson<{ results?: unknown }>(url.href, {
		fetchImpl, headers: { Accept: "application/json" }, timeoutMs: req.settings.timeoutMs,
		signal: req.signal, maxResponseBytes: 2 * 1024 * 1024,
		onResponse(response) {
			if (response.ok && response.headers.get("content-type")?.includes("text/html")) throw providerError("invalid_config", JSON_SETUP);
		},
		httpError(response, text) {
			return response.status === 403 ? providerError("invalid_config", JSON_SETUP, { status: 403 }) : normalizeHttpError(response, text);
		},
	}).catch((error: unknown) => {
		if (isProviderError(error) && error.code === "parse_error" && /<\s*(?:!doctype|html)/iu.test(error.message)) {
			throw providerError("invalid_config", JSON_SETUP);
		}
		if (isProviderError(error) && error.code === "network_error") {
			throw providerError("network_error", "SearXNG could not reach the configured /search endpoint. Check searxng.url and ensure /search serves JSON directly.");
		}
		throw error;
	});
	if (!Array.isArray(body?.results)) throw providerError("parse_error", "SearXNG response is missing its results array.", { retryable: true });
	const searchResults = body.results.flatMap((item): SearchResultDetail[] => {
		const url = publicResultUrl(item?.url);
		if (!url) return [];
		return [{ url, source: "searxng", title: typeof item.title === "string" ? item.title : undefined,
			citedText: typeof item.content === "string" ? item.content : "" }];
	});
	const eligible = applyDomainFilter({ text: "", providerKind: "searxng", searchResults }, req.filters?.domains);
	const selected = eligible.searchResults?.slice(0, req.settings.maxResults) ?? [];
	return { ...eligible, searchResults: selected, sources: sourcesFromResults(selected), ...(warning ? { warnings: [warning] } : {}) };
}
