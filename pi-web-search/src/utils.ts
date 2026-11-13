import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatResult, OUTPUT_BUDGET_CHARS, type WebSearchDetails } from "./format.ts";
import { isProviderError } from "./providers/types.ts";

export type SearchToolName = "search" | "web_search" | "code_search" | "multi_search" | "search_read";

/**
 * Names parameters the tool does not declare. The host validates arguments
 * before `execute` but leaves undeclared keys in place, so they arrive here and
 * can be reported. A model that sends `top_n` and has it silently dropped
 * believes a filter ran that never did; ignoring the key keeps the search,
 * and saying so keeps the model honest.
 */
export function droppedParamsWarning(
	params: object,
	accepted: readonly string[],
): string | undefined {
	const dropped = Object.keys(params).filter((key) => !accepted.includes(key));
	if (dropped.length === 0) return undefined;
	const keys = dropped.map((key) => `\`${key}\``).join(", ");
	return `Ignored unknown parameter${dropped.length === 1 ? "" : "s"} ${keys}. This tool accepts only the parameters in its schema.`;
}

/** Keep machine-readable failures intact instead of discarding data on throw. */
export function formatSearchError(tool: SearchToolName, error: unknown): AgentToolResult<WebSearchDetails> {
	const provider = isProviderError(error) ? error : undefined;
	const code = provider?.code ?? "unknown";
	const fullMessage = `${tool} failed (${code}): ${error instanceof Error ? error.message : String(error)}`;
	const path = typeof error === "object" && error !== null && "configPath" in error && typeof error.configPath === "string" ? error.configPath : undefined;
	// Preserve optional paths whole, or omit them; never expose an unbounded field.
	const configPath = path !== undefined && JSON.stringify(path).length <= 1000 ? path : undefined;
	for (let limit = 1000; ; limit = Math.floor(limit / 2)) {
		let end = Math.min(limit, fullMessage.length);
		if (end > 0 && /[\uD800-\uDBFF]/u.test(fullMessage[end - 1])) end--;
		const truncated = end < fullMessage.length;
		const message = fullMessage.slice(0, end) + (truncated ? "\n[Truncated]" : "");
		const output = formatResult(message, {
			resultCount: 0, grounded: false, sources: [], searchResults: [],
			warnings: [
				...(truncated ? ["Error message truncated; the error code and status are unchanged."] : []),
				...(path !== undefined && configPath === undefined ? ["Configuration path omitted: exceeds output budget."] : []),
			],
			error: {
				code, message,
				...(provider ? { status: provider.status, rpcCode: provider.rpcCode, retryable: provider.retryable } : {}),
				...(configPath === undefined ? {} : { configPath }),
			},
		});
		if (JSON.stringify(output.structuredContent).length <= OUTPUT_BUDGET_CHARS) return output;
	}
}
