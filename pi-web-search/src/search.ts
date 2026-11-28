import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MAX_DOMAINS, RECENCIES, normalizeDomain, type WebFilters } from "./providers/filters.ts";
import { MAX_QUERY_CHARS } from "./providers/config.ts";
import { executeSearch, trimQuery } from "./execute.ts";
import type { WebSearchDetails } from "./format.ts";
import type { RunSearchOptions } from "./providers/index.ts";
import { providerError } from "./providers/types.ts";
import { type SearchToolName, formatSearchError } from "./utils.ts";
import { searchReadRef, type SearchReadRefInput } from "./search_read.ts";

export const SEARCH_SCOPES = ["web", "code", "both"] as const;
export const SEARCH_EFFORTS = ["fast", "thorough"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export type SearchEffort = (typeof SEARCH_EFFORTS)[number];

function stringEnum<const T extends readonly string[]>(values: T, description?: string) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
}

const queryString = Type.String({ minLength: 1, maxLength: MAX_QUERY_CHARS });
export const SearchSchema = Type.Object({
	query: Type.Optional(Type.Union([queryString, Type.Array(queryString, { minItems: 1, maxItems: 3 })], { description: "Search terms or up to 3 queries" })),
	recency: Type.Optional(stringEnum(RECENCIES, "Limit web results by age")),
	domains: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_DOMAINS, description: "Web hostnames with subdomains; prefix - to exclude" })),
	scope: Type.Optional(stringEnum(SEARCH_SCOPES, "Default web")),
	urls: Type.Optional(Type.Array(Type.String(), {
		description: "Fetch HTTP(S) pages",
		maxItems: 20,
	})),
	ref: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 200,
		description: "Read stored evidence",
	})),
	find: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 200,
		description: "Case-insensitive match within ref",
	})),
	cursor: Type.Optional(Type.String({
		minLength: 1, maxLength: 200,
		description: "Continue a ref read",
	})),
	effort: Type.Optional(stringEnum(SEARCH_EFFORTS, "Default fast")),
});

export type SearchInput = Static<typeof SearchSchema>;

export type SearchReadRefResult =
	| AgentToolResult<WebSearchDetails>
	| Promise<AgentToolResult<WebSearchDetails>>;

export type SearchReadRef = (
	params: SearchReadRefInput,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) => SearchReadRefResult;

export interface UnifiedSearchOptions extends RunSearchOptions {
	/** Test seam; production reads the evidence worker's local ref reader. */
	readRef?: SearchReadRef;
}

const SEARCH_PARAMS = Object.keys(SearchSchema.properties);

/** The registered unified tool. */
const SEARCH_TOOL: SearchToolName = "search";

type ValidatedSearch =
	| { kind: "query"; query: string | string[]; scope: SearchScope; effort: SearchEffort; filters?: WebFilters }
	| { kind: "urls"; urls: string[] }
	| { kind: "ref"; ref: string };

/**
 * Local ref reads must stay local: this tool never resolves settings or starts
 * a provider for them. Everything else validates before any retrieval begins.
 */
function validateSearchParams(params: SearchInput): ValidatedSearch | Error {
	for (const key of Object.keys(params)) {
		if (!SEARCH_PARAMS.includes(key)) {
			return providerError("unknown", `Unknown parameter: ${key}.`);
		}
	}

	const hasQuery = params.query !== undefined;
	const hasUrls = params.urls !== undefined;
	const hasRef = params.ref !== undefined;
	if ([hasQuery, hasUrls, hasRef].filter(Boolean).length !== 1) {
		return providerError("unknown", "Use exactly one of query, urls, or ref.");
	}

	const filter = params.recency !== undefined ? "recency" : params.domains !== undefined ? "domains" : undefined;
	if (filter && !hasQuery) {
		return providerError("unknown", `${filter} requires query and web scope.`);
	}

	if (params.scope !== undefined && !SEARCH_SCOPES.includes(params.scope)) {
		return providerError("unknown", "scope must be web, code, or both.");
	}
	if (params.effort !== undefined && !SEARCH_EFFORTS.includes(params.effort)) {
		return providerError("unknown", "effort must be fast or thorough.");
	}

	if (hasQuery) {
		const query = params.query!;
		if (Array.isArray(query) && (query.length < 1 || query.length > 3)) {
			return providerError("unknown", "query accepts 1 to 3 strings.");
		}
		const queries = Array.isArray(query) ? query : [query];
		if (queries.some((part) => typeof part !== "string" || !trimQuery(part))) {
			return providerError("unknown", "query must not be blank.");
		}
		if (queries.some((part) => part.length > MAX_QUERY_CHARS)) {
			return providerError("unknown", `query accepts at most ${MAX_QUERY_CHARS} characters per string.`);
		}
		if (params.find !== undefined || params.cursor !== undefined) {
			return providerError("unknown", "find and cursor require ref.");
		}
		const scope = params.scope ?? "web";
		if (filter && scope === "code") {
			return providerError("unknown", `${filter} requires query and web scope.`);
		}
		const { recency } = params;
		if (recency !== undefined && !RECENCIES.includes(recency)) {
			return providerError("unknown", "recency must be day, week, month, or year.");
		}
		let domains: string[] | undefined;
		if (params.domains !== undefined) {
			if (!Array.isArray(params.domains) || params.domains.length > MAX_DOMAINS) {
				return providerError("unknown", `domains accepts at most ${MAX_DOMAINS} hostnames.`);
			}
			const normalized = params.domains.map((domain) => typeof domain === "string" ? normalizeDomain(domain) : undefined);
			if (normalized.some((domain) => domain === undefined)) {
				return providerError("unknown", "domains must contain hostnames, optionally prefixed with '-'.");
			}
			domains = [...new Set(normalized as string[])];
		}
		if (scope === "both" && params.effort === "fast") {
			return providerError("unknown", "scope both requires effort thorough.");
		}
		const effort = params.effort ?? (scope === "both" ? "thorough" : "fast");
		return { kind: "query", query, scope, effort, ...(filter ? { filters: { recency, domains } } : {}) };
	}

	if (hasUrls) {
		if (!Array.isArray(params.urls) || params.urls.length === 0) {
			return providerError("unknown", "urls must contain at least one URL.");
		}
		if (params.urls.some((url) => typeof url !== "string")) {
			return providerError("unknown", "urls must contain strings.");
		}
		if (params.urls.length > 20) {
			return providerError("unknown", "urls accepts at most 20 URLs.");
		}
		if (params.scope !== undefined && params.scope !== "web") {
			return providerError("unknown", "urls accept only web scope.");
		}
		if (params.effort !== undefined) {
			return providerError("unknown", "urls do not accept effort.");
		}
		if (params.find !== undefined || params.cursor !== undefined) {
			return providerError("unknown", "find and cursor require ref.");
		}
		return { kind: "urls", urls: params.urls };
	}

	if (typeof params.ref !== "string" || params.ref.trim().length === 0) {
		return providerError("unknown", "ref must not be blank.");
	}
	for (const field of ["ref", "find", "cursor"] as const) {
		const value = params[field];
		if (value !== undefined && (typeof value !== "string" || !value.length || value.length > 200)) {
			return providerError("unknown", `${field} must contain 1 to 200 characters.`);
		}
	}
	if (params.scope !== undefined) {
		return providerError("unknown", "ref does not accept scope.");
	}
	if (params.effort !== undefined) {
		return providerError("unknown", "ref does not accept effort.");
	}
	return { kind: "ref", ref: params.ref };
}

/** Unified model-facing search: query, URL extraction, or local evidence read. */
export async function search(
	_toolCallId: string,
	params: SearchInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	ctx: ExtensionContext,
	options: UnifiedSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	const start = performance.now();
	const result = await run(params, signal, onUpdate, ctx, options);
	return { ...result, details: { ...result.details, durationMs: Math.round(performance.now() - start) } };
}

async function run(
	params: SearchInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	ctx: ExtensionContext,
	options: UnifiedSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	const validated = validateSearchParams(params);
	if (validated instanceof Error) {
		return formatSearchError(SEARCH_TOOL, validated);
	}

	const { readRef, ...runOptions } = options;
	if (validated.kind === "ref") {
		try {
			const reader = readRef ?? searchReadRef;
			return await reader({
				ref: validated.ref,
				...(params.find === undefined ? {} : { find: params.find }),
				...(params.cursor === undefined ? {} : { cursor: params.cursor }),
			}, ctx, signal);
		} catch (error) {
			return formatSearchError(SEARCH_TOOL, error);
		}
	}

	if (validated.kind === "urls") {
		return executeSearch(
			{
				query: "",
				fetchOnly: true,
				urls: validated.urls,
				scope: "web",
				parallel: false,
				judge: false,
				tool: SEARCH_TOOL,
				rawParams: params,
				acceptedParams: SEARCH_PARAMS,
			},
			signal,
			onUpdate,
			ctx,
			runOptions,
		);
	}

	const { query, scope, effort, filters } = validated;

	return executeSearch(
		{
			query,
			filters,
			scope,
			parallel: effort === "thorough",
			judge: effort === "thorough",
			tool: SEARCH_TOOL,
			rawParams: params,
			acceptedParams: SEARCH_PARAMS,
			requireResearch: effort === "thorough",
		},
		signal,
		onUpdate,
		ctx,
		runOptions,
	);
}
