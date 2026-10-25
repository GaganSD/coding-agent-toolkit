import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { MAX_QUERY_CHARS } from "./providers/config.ts";
import { PARALLEL_MCP_SERVER } from "./providers/parallel.ts";
import { executeSearch, trimQuery } from "./execute.ts";
import type { WebSearchDetails } from "./format.ts";
import type { RunSearchOptions } from "./providers/index.ts";
import { providerError } from "./providers/types.ts";
import { type SearchToolName, formatSearchError } from "./utils.ts";
import { searchReadRef } from "./search_read.ts";

export const SEARCH_SCOPES = ["web", "code", "both"] as const;
export const SEARCH_EFFORTS = ["fast", "thorough"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export type SearchEffort = (typeof SEARCH_EFFORTS)[number];

export const SearchSchema = Type.Object({
	query: Type.Optional(Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_CHARS,
		description: "Search terms; code scope expects literal identifiers/snippets",
	})),
	scope: Type.Optional(StringEnum(SEARCH_SCOPES, {
		description: "web (default), code, or both",
	})),
	urls: Type.Optional(Type.Array(Type.String(), {
		description: "Fetch HTTP(S) pages instead of searching",
		maxItems: 20,
	})),
	ref: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 200,
		description: "Read a returned evidence ref locally; no network",
	})),
	find: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 200,
		description: "With ref: case-insensitive literal passage match",
	})),
	cursor: Type.Optional(Type.String({
		minLength: 1, maxLength: 200,
		description: "With ref: copy the cursor from a previous read",
	})),
	effort: Type.Optional(StringEnum(SEARCH_EFFORTS, {
		description: "fast (default), or thorough (opt-in multi-source)",
	})),
});

export type SearchInput = Static<typeof SearchSchema>;

export interface SearchReadRefInput {
	ref: string;
	find?: string;
	cursor?: string;
}

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

/** The registered unified tool; legacy names stay available to internal modules. */
const SEARCH_TOOL: SearchToolName = "search";

type ValidatedSearch =
	| { kind: "query"; query: string; scope: SearchScope; effort: SearchEffort }
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

	if (hasQuery) {
		if (typeof params.query !== "string" || trimQuery(params.query).length === 0) {
			return providerError("unknown", "query must not be blank.");
		}
		if (params.find !== undefined || params.cursor !== undefined) {
			return providerError("unknown", "find and cursor require ref.");
		}
		const scope = params.scope ?? "web";
		if (scope === "both" && params.effort === "fast") {
			return providerError("unknown", "scope both requires effort thorough.");
		}
		const effort = params.effort ?? (scope === "both" ? "thorough" : "fast");
		return { kind: "query", query: params.query, scope, effort };
	}

	if (hasUrls) {
		if (!Array.isArray(params.urls) || params.urls.length === 0) {
			return providerError("unknown", "urls must contain at least one URL.");
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
	if (params.scope !== undefined) {
		return providerError("unknown", "ref does not accept scope.");
	}
	if (params.effort !== undefined) {
		return providerError("unknown", "ref does not accept effort.");
	}
	return { kind: "ref", ref: params.ref };
}

/**
 * Parallel's native MCP namespace is reachable only by calls that can perform
 * web retrieval. Code-only and local ref reads do not wait for MCP startup.
 */
export function searchReachesTools(input: SearchInput): string[] {
	if (input.ref !== undefined) {
		return [];
	}
	if (input.urls === undefined && (input.scope ?? "web") === "code") {
		return [];
	}
	return [`mcp__${PARALLEL_MCP_SERVER}`];
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
				progress: `Fetching ${validated.urls.length} URL(s)...`,
			},
			signal,
			onUpdate,
			ctx,
			runOptions,
		);
	}

	const { query, scope, effort } = validated;

	return executeSearch(
		{
			query,
			scope,
			parallel: effort === "thorough",
			judge: effort === "thorough",
			tool: SEARCH_TOOL,
			rawParams: params,
			acceptedParams: SEARCH_PARAMS,
			requireResearch: effort === "thorough",
			progress: effort === "thorough"
				? `Searching multiple sources for "${query}" (${scope})...`
				: scope === "code"
					? `Searching public code for "${query}"...`
					: `Searching the web for "${query}"...`,
		},
		signal,
		onUpdate,
		ctx,
		runOptions,
	);
}
