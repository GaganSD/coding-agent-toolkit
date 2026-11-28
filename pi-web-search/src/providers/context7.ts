import { context7ApiKey } from "../env.ts";
import { getJson, normalizeHttpError, withTimeout, type FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { publicResultUrl } from "./result-url.ts";
import { sourcesFromResults } from "./results.ts";
import { reuseTransport } from "./reuse.ts";
import { isProviderError, providerError, type SearchResultDetail, type StreamResult } from "./types.ts";

// The documented v2 resolve/context endpoints preserve exact version pins and allow session reuse of the resolved library.
// https://context7.com/docs/api-guide
const ORIGIN = "https://context7.com";
export const CONTEXT7_LIBRARIES_URL = ORIGIN + "/api/v2/libs/search";
const LIBRARY_ID = /^\/\w[\w.-]*\/\w[\w.-]*(?:@[\w.+-]+)?$/u;

interface LibraryResponse { results?: { id?: unknown }[] }
interface InfoSnippet { pageId?: unknown; breadcrumb?: unknown; content?: unknown; rank?: unknown }
interface CodeSnippet { codeId?: unknown; codeTitle?: unknown; codeDescription?: unknown; codeList?: { code?: unknown }[]; rank?: unknown }
interface ContextResponse { libraryId?: unknown; version?: { requested?: unknown; served?: unknown; status?: unknown }; infoSnippets?: InfoSnippet[]; codeSnippets?: CodeSnippet[] }

const QUESTION_WORDS = new Set("a an and about can could do does for get how i in is my of on set show the to up use using what where which with would".split(" "));

export async function context7Search(req: SearchRequest, { fetchImpl }: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	const deadline = withTimeout(req.signal, req.settings.timeoutMs);
	const key = context7ApiKey();
	const request = <T>(url: URL, signal = deadline.signal) => getJson<T>(url.href, {
		fetchImpl, signal, timeoutMs: req.settings.timeoutMs, maxResponseBytes: 2 * 1024 * 1024,
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
		const libraryName = req.query.match(/[@\w][\w/@.+-]*/gu)?.find((term) => !QUESTION_WORDS.has(term.toLowerCase()));
		const library = req.library ?? (libraryName ? await resolveLibrary(libraryName, req, deadline.signal, request) : undefined);
		if (!library) return noLibrary();
		if (!LIBRARY_ID.test(library)) return noLibrary();

		const url = new URL("/api/v2/context", ORIGIN);
		url.search = new URLSearchParams({ libraryId: library, query: req.query || "Overview and examples", type: "json" }).toString();
		const body = await request<ContextResponse>(url).catch((error: unknown) => {
			if (isProviderError(error) && error.status === 404) {
				if (error.message.includes("version_not_found")) {
					throw providerError("unknown", "Context7 could not find the requested version. Check the library version pin.");
				}
				if (error.message.includes("no_snippets_found")) return { infoSnippets: [], codeSnippets: [] } as ContextResponse;
				return undefined;
			}
			throw error;
		});
		if (!body) return noLibrary();
		if (!Array.isArray(body.infoSnippets) || !Array.isArray(body.codeSnippets)) {
			throw providerError("parse_error", "Context7 returned an invalid context response.", { retryable: true });
		}
		const fallback = new URL(typeof body.libraryId === "string" && LIBRARY_ID.test(body.libraryId) ? body.libraryId : library, ORIGIN).href;
		const info = body.infoSnippets.flatMap((snippet) => documentation(snippet?.pageId, snippet?.breadcrumb, snippet?.content, snippet?.rank, fallback));
		const code = body.codeSnippets.flatMap((snippet) => {
			const example = Array.isArray(snippet?.codeList) ? snippet.codeList.find((item) => typeof item?.code === "string")?.code : undefined;
			return documentation(snippet?.codeId, snippet?.codeTitle, example ?? snippet?.codeDescription, snippet?.rank, fallback);
		});
		const searchResults = [...info, ...code].sort((a, b) => a.rank - b.rank).slice(0, req.settings.maxResults).map(({ hit }) => hit);
		const warnings = body.version?.status === "unverified"
			? ["Context7 could not verify the requested version. Returned evidence may be from another release."] : undefined;
		return { text: "", providerKind: "context7", searchResults, sources: sourcesFromResults(searchResults), warnings };
	} finally {
		deadline.dispose();
	}
}

async function resolveLibrary(name: string, req: SearchRequest, signal: AbortSignal, request: <T>(url: URL, signal: AbortSignal) => Promise<T>) {
	const result = await reuseTransport("context7", { ...req, query: name.toLowerCase(), signal }, async (resolution) => {
		const url = new URL(CONTEXT7_LIBRARIES_URL);
		url.search = new URLSearchParams({ libraryName: name, query: req.query }).toString();
		const body = await request<LibraryResponse>(url, resolution.signal ?? signal).catch((error: unknown) => {
			if (isProviderError(error) && error.status === 404 && error.message.includes("no_libraries_found")) return { results: [] };
			throw error;
		});
		if (!Array.isArray(body?.results)) throw providerError("parse_error", "Context7 returned an invalid library search response.", { retryable: true });
		const match = body.results.find((item) => typeof item?.id === "string" && LIBRARY_ID.test(item.id));
		return { text: "", providerKind: "context7", searchResults: match ? [{ title: match.id as string }] : [] };
	}, "library");
	return result.searchResults?.[0]?.title;
}

function noLibrary(): StreamResult {
	return { text: "", providerKind: "context7", searchResults: [], warnings: ["Context7: no library matched. Try library:/owner/name with code scope."] };
}

function documentation(url: unknown, title: unknown, content: unknown, rank: unknown, fallback: string): { hit: SearchResultDetail; rank: number }[] {
	if (typeof content !== "string" || !content.trim()) return [];
	return [{
		rank: typeof rank === "number" && Number.isFinite(rank) ? rank : Infinity,
		hit: { source: "context7", url: publicResultUrl(url) ?? fallback, title: typeof title === "string" ? title : undefined,
			citedText: content, type: "content" },
	}];
}
