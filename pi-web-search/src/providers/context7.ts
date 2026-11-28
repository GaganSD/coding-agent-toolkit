import { context7ApiKey } from "../env.ts";
import { getJson, normalizeHttpError, withTimeout, type FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { publicResultUrl } from "./result-url.ts";
import { sourcesFromResults } from "./results.ts";
import { isProviderError, providerError, type SearchResultDetail, type StreamResult } from "./types.ts";

// V3 searches documentation from the full query. V2 context preserves exact version pins.
// https://context7.com/docs/api-guide
const ORIGIN = "https://context7.com";
export const CONTEXT7_LIBRARIES_URL = ORIGIN + "/api/v2/libs/search";
const LIBRARY_ID = /^\/\w[\w.-]*\/\w[\w.-]*(?:@[\w.+-]+)?$/u;

interface InfoSnippet { libraryId?: unknown; pageId?: unknown; breadcrumb?: unknown; content?: unknown; rank?: unknown }
interface CodeSnippet { libraryId?: unknown; codeId?: unknown; codeTitle?: unknown; codeDescription?: unknown; codeList?: { code?: unknown }[]; rank?: unknown }
interface ContextResponse { libraryId?: unknown; version?: { requested?: unknown; served?: unknown; status?: unknown }; infoSnippets?: InfoSnippet[]; codeSnippets?: CodeSnippet[] }

export async function context7Search(req: SearchRequest, { fetchImpl }: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	const deadline = withTimeout(req.signal, req.settings.timeoutMs);
	const key = context7ApiKey();
	const request = <T>(url: URL) => getJson<T>(url.href, {
		fetchImpl, signal: deadline.signal, timeoutMs: req.settings.timeoutMs, maxResponseBytes: 2 * 1024 * 1024,
		headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
		httpError(response, text) {
			if (response.status === 401 || response.status === 403) {
				return providerError("missing_credentials", "Context7 requires a valid CONTEXT7_API_KEY or stored context7 key for this request.", { status: response.status });
			}
			return normalizeHttpError(response, text);
		},
	});
	try {
		if (req.query.length > 500 || (req.library?.length ?? 0) > 500) {
			throw providerError("unknown", "Context7 accepts up to 500 characters per query or library ID.");
		}
		const library = req.library;
		if (library !== undefined && !LIBRARY_ID.test(library)) return noLibrary();

		const url = new URL(library ? "/api/v2/context" : "/api/v3/search", ORIGIN);
		url.searchParams.set("query", req.query || "Overview and examples");
		url.searchParams.set("type", "json");
		if (library) url.searchParams.set("libraryId", library);
		const body = await request<ContextResponse>(url).catch((error: unknown): ContextResponse | undefined => {
			if (!isProviderError(error) || error.status !== 404) throw error;
			if (!library) {
				if (error.message.includes("no_documentation_found")) return { infoSnippets: [], codeSnippets: [] };
				throw error;
			}
			if (error.message.includes("version_not_found")) {
				throw providerError("unknown", "Context7 could not find the requested version. Check the library version pin.");
			}
			if (error.message.includes("no_snippets_found")) return { infoSnippets: [], codeSnippets: [] };
			return undefined;
		});
		if (body === undefined) return noLibrary();
		if (!Array.isArray(body?.infoSnippets) || !Array.isArray(body?.codeSnippets)) {
			throw providerError("parse_error", "Context7 returned an invalid context response.", { retryable: true });
		}
		const fallback = libraryUrl(body.libraryId) ?? libraryUrl(library);
		const info = body.infoSnippets.flatMap((snippet) => documentation(snippet?.pageId, snippet?.breadcrumb, snippet?.content, snippet?.rank, libraryUrl(snippet?.libraryId) ?? fallback));
		const code = body.codeSnippets.flatMap((snippet) => {
			const example = Array.isArray(snippet?.codeList) ? snippet.codeList.find((item) => typeof item?.code === "string")?.code : undefined;
			return documentation(snippet?.codeId, snippet?.codeTitle, example ?? snippet?.codeDescription, snippet?.rank, libraryUrl(snippet?.libraryId) ?? fallback);
		});
		const searchResults = [...info, ...code].sort((a, b) => a.rank - b.rank).slice(0, req.settings.maxResults).map(({ hit }) => hit);
		const warnings = body.version?.status === "unverified"
			? ["Context7 could not verify the requested version. Returned evidence may be from another release."] : undefined;
		return { text: "", providerKind: "context7", searchResults, sources: sourcesFromResults(searchResults), warnings };
	} finally {
		deadline.dispose();
	}
}

function libraryUrl(id: unknown): string | undefined {
	return typeof id === "string" && LIBRARY_ID.test(id) ? new URL(id, ORIGIN).href : undefined;
}

function noLibrary(): StreamResult {
	return { text: "", providerKind: "context7", searchResults: [], warnings: ["Context7: no library matched. Try library:/owner/name with code scope."] };
}

function documentation(url: unknown, title: unknown, content: unknown, rank: unknown, fallback: string | undefined): { hit: SearchResultDetail; rank: number }[] {
	const citedUrl = publicResultUrl(url) ?? fallback;
	if (!citedUrl || typeof content !== "string" || !content.trim()) return [];
	return [{
		rank: typeof rank === "number" && Number.isFinite(rank) ? rank : Infinity,
		hit: { source: "context7", url: citedUrl, title: typeof title === "string" ? title : undefined,
			citedText: content, type: "content" },
	}];
}
