import { domainToASCII } from "node:url";
import type { StreamResult } from "./types.ts";

export const RECENCIES = ["day", "week", "month", "year"] as const;
export type Recency = (typeof RECENCIES)[number];
export const MAX_DOMAINS = 10;
export interface WebFilters {
	recency?: Recency;
	domains?: string[];
}

type FilterCapability = "native" | "local" | "unsupported";

/** Transport capabilities; every domain policy is also enforced locally. */
export const WEB_FILTER_CAPABILITIES = {
	// https://exa.ai/docs/reference/search
	"Exa REST": { recency: "native", domains: "native" },
	// https://exa.ai/docs/reference/exa-mcp
	"Exa keyless MCP": { recency: "native", domains: "native" },
	// https://docs.parallel.ai/integrations/mcp/search-mcp#configure-search-behavior
	"Parallel authenticated MCP": { recency: "native", domains: "native" },
	"Parallel anonymous MCP": { recency: "unsupported", domains: "local" },
	// https://api-dashboard.search.brave.com/api-reference/web/search/get
	"Brave Web": { recency: "native", domains: "local" },
	// https://api-dashboard.search.brave.com/api-reference/ai/llm_context/get
	"Brave LLM Context": { recency: "native", domains: "local" },
	// https://docs.searxng.org/dev/search_api.html
	SearXNG: { recency: { day: "native", week: "unsupported", month: "native", year: "native" }, domains: "local" },
} as const satisfies Record<string, { recency: FilterCapability | Record<Recency, FilterCapability>; domains: FilterCapability }>;

export function recencyWarning(provider: keyof typeof WEB_FILTER_CAPABILITIES, recency?: Recency): string | undefined {
	if (!recency) return;
	const capability = WEB_FILTER_CAPABILITIES[provider].recency;
	if ((typeof capability === "string" ? capability : capability[recency]) === "unsupported") {
		return `${provider} cannot apply recency "${recency}".`;
	}
}

export function recencyStart(recency: Recency, now = Date.now()): string {
	const days = { day: 1, week: 7, month: 31, year: 365 };
	return new Date(now - days[recency] * 86_400_000).toISOString();
}

/** Normalize a hostname as supplied in a search-level domain policy. */
export function normalizeDomain(value: string): string | undefined {
	const trimmed = value.trim().toLowerCase().replace(/\.$/u, "");
	const excluded = trimmed.startsWith("-");
	const input = excluded ? trimmed.slice(1) : trimmed;
	if (!input || /[\s/\\:@?#%]/u.test(input)) return;
	const host = domainToASCII(input);
	if (!host || host.length > 253 || host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return;
	return (excluded ? "-" : "") + host;
}

export function domainPolicy(domains: readonly string[] = []): { includes: string[]; excludes: string[] } {
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const domain of domains) {
		if (domain.startsWith("-")) excludes.push(domain.slice(1));
		else includes.push(domain);
	}
	return { includes, excludes };
}

export function domainMatcher(domains: readonly string[]): (value?: string) => boolean {
	const { includes, excludes } = domainPolicy(domains);
	return (value) => {
		if (!value) return false;
		try {
			const url = new URL(value);
			if (url.protocol !== "http:" && url.protocol !== "https:") return false;
			const host = url.hostname.replace(/\.$/u, "");
			const matches = (domain: string) => host === domain || host.endsWith("." + domain);
			return !excludes.some(matches) && (includes.length === 0 || includes.some(matches));
		} catch { return false; }
	};
}

export function applyDomainFilter(result: StreamResult, domains?: string[]): StreamResult {
	if (!domains?.length) return result;
	const allows = domainMatcher(domains);
	return {
		...result,
		// Provider summaries are not individually bound to an allowed source.
		text: "",
		searchResults: result.searchResults?.filter((hit) => allows(hit.url)),
		sources: result.sources?.filter((source) => allows(source.url)),
	};
}
