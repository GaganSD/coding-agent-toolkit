import { createHash } from "node:crypto";
import { parallelApiKey } from "../env.ts";
import type { FetchLike, JsonRequestOptions } from "./http.ts";
import { collectTextContent, type McpClient, withMcpSession } from "./mcp.ts";
import type { SearchRequest } from "./index.ts";
import {
	type SearchResultDetail,
	type Source,
	type StreamResult,
	isProviderError,
	providerError,
} from "./types.ts";

export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const PARALLEL_MCP_SERVER = "pi_web_search_parallel";
const SEARCH_TOOL = "web_search";
const FETCH_TOOL = "web_fetch";
const MAX_FETCH_URLS = 20;

export async function parallelSearch(req: SearchRequest, options: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	const key = parallelApiKey();
	const signal = req.signal;
	let initialized = false;
	try {
		return await withMcpSession(sessionOptions(key, signal, options.fetchImpl, req.settings.timeoutMs), (client) => {
			initialized = true;
			return retrieve(req, client);
		});
	} catch (error) {
		if (initialized) throw error;
		throw transportFailure(req.fetchOnly ? FETCH_TOOL : SEARCH_TOOL, error, signal, false);
	}
}

/** The probe uses the same wire call and error classification as retrieval. */
export async function probeParallelKey(key: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<void> {
	await withMcpSession(sessionOptions(key, signal, fetchImpl), async (client) => {
		readPayload(await checkedCall(client, SEARCH_TOOL, { objective: "Find example.com", search_queries: ["example.com"] }), SEARCH_TOOL);
	});
}

function sessionOptions(key: string | undefined, signal?: AbortSignal, fetchImpl?: FetchLike, timeoutMs?: number) {
	const httpError: JsonRequestOptions["httpError"] = (response, body) => {
		const text = body.trim();
		const snippet = text.length > 500 ? text.slice(0, 497) + "..." : text;
		const status = response.status;
		return providerError("http_error", status === 401 ? "MCP server requires authentication"
			: `MCP HTTP request failed with status ${status}${snippet ? `: ${snippet}` : ""}`, { status });
	};
	return { url: PARALLEL_MCP_URL, signal, timeoutMs, fetchImpl, httpError, retryExpiredSession: true,
		headers: key ? { Authorization: `Bearer ${key}` } : undefined };
}

async function retrieve(req: SearchRequest, client: McpClient): Promise<StreamResult> {
	const metadata = requestMetadata(req);
	const searchQueries = [req.query];
	// Observe both promises immediately; search and URL extraction are independent.
	const [searchOutcome, fetchOutcome] = await Promise.allSettled([
		req.fetchOnly ? Promise.resolve<Record<string, unknown>>({ results: [] }) : callParallel(client, SEARCH_TOOL, {
			objective: req.query,
			search_queries: searchQueries,
			...metadata,
		}, req.signal),
		req.urls?.length ? callParallel(client, FETCH_TOOL, {
			urls: req.urls.slice(0, MAX_FETCH_URLS),
			objective: req.query.slice(0, 200) || "Extract the requested pages.",
			search_queries: req.fetchOnly ? [] : searchQueries,
			full_content: false,
			...metadata,
		}, req.signal) : Promise.resolve(undefined),
	]);
	if (searchOutcome.status === "rejected") throw searchOutcome.reason;
	const search = searchOutcome.value;
	const hits = requireResults(search, "web_search").slice(0, req.settings.maxResults);
	const searchResults = hits.map((hit) => toDetail(hit));
	const sources = hits.map(toSource);
	const warnings = normalizeWarnings(search.warnings);

	if (req.urls?.length) {
		try {
			if (fetchOutcome.status === "rejected") throw fetchOutcome.reason;
			const fetched = fetchOutcome.value!;
			for (const entry of requireResults(fetched, "web_fetch")) {
				searchResults.push(toDetail(entry, "extract"));
				sources.push(toSource(entry));
			}
			warnings.push(...normalizeWarnings(fetched.warnings), ...normalizeErrorUrls(fetched.errors));
		} catch (error) {
			if (req.fetchOnly || req.signal?.aborted || (isProviderError(error) && error.code === "aborted")) throw error;
			warnings.push(`parallel fetch failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const usage = normalizeUsage(search.usage);
	return {
		text: "",
		providerKind: "parallel",
		searchResults,
		sources,
		...(typeof search.search_id === "string" && search.search_id ? { requestId: search.search_id } : {}),
		...(usage.length ? { usage } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

function requestMetadata({ sessionId, modelId }: SearchRequest): Record<string, string> {
	return {
		...(sessionId ? { session_id: createHash("sha256").update(sessionId).digest("hex") } : {}),
		...(modelId && modelId !== "unknown" && modelId.length <= 100 ? { model_name: modelId } : {}),
	};
}

const toolName = (name: string) => `mcp__${PARALLEL_MCP_SERVER}__${name}`;

async function checkedCall(client: McpClient, name: string, args: Record<string, unknown>,
	transportError?: (error: unknown) => Error,
) {
	const result = await client.callToolResult(name, args).catch((error) => { throw transportError?.(error) ?? error; });
	const content = result.content === undefined ? [] : result.content;
	if (!Array.isArray(content)) {
		const error = providerError("parse_error", "Invalid MCP tools/call result");
		throw transportError?.(error) ?? error;
	}
	if (result.isError === true) throw nativeError(toolName(name), collectTextContent(content) || "no error details");
	return result;
}

async function callParallel(client: McpClient, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
	// Only a transport failure follows the legacy host's outer error path.
	const result = await checkedCall(client, name, args, (error) => transportFailure(name, error, signal, true));
	return readPayload(result, name);
}

function pipelineFailure(name: string, message: string, status?: number) {
	const error = providerError("tool_error", `${toolName(name)} failed in Pi's tool pipeline: ${message.slice(0, 500)}. Check /mcp for ${PARALLEL_MCP_SERVER} and run /reload.`, { retryable: false });
	if (status !== undefined) error.parallelHttpStatus = status;
	return error;
}

function transportFailure(name: string, error: unknown, signal: AbortSignal | undefined, initialized: boolean) {
	if (signal?.aborted) return isProviderError(signal.reason) ? signal.reason : providerError("aborted", "Parallel search was aborted.");
	if (isProviderError(error) && error.code === "aborted") return error;
	const status = isProviderError(error) ? error.status : undefined;
	if (!initialized) return pipelineFailure(name, `Tool ${toolName(name)} not found`, status);
	const message = (error instanceof Error ? error.message : String(error)).replace(/^Request failed: /u, "")
		.replace(/^Request timed out after (\d+ms)\.$/u, "MCP request timed out after $1")
		.replace(/^Response from .*? was not valid JSON: /u, "");
	return pipelineFailure(name, message.startsWith("MCP tool ") && message.endsWith("returned a non-object result.")
		? "Invalid MCP tools/call result" : message, status);
}

function unavailable(reason: string) {
	return providerError("tool_error", `${reason}. Enable Pi's built-in MCP support, check /mcp for ${PARALLEL_MCP_SERVER} and run /reload.`, { retryable: false });
}

function nativeError(name: string, rawMessage: string) {
	const message = rawMessage.slice(0, 500);
	if (/\b(?:401|403|unauthorized|forbidden|authentication|invalid api key)\b/i.test(message)) {
		return providerError("http_error", `${name}: ${message}`, { status: /\b403\b|forbidden/i.test(message) ? 403 : 401 });
	}
	if (/\b(?:429|rate limit|too many requests)\b/i.test(message)) {
		return providerError("rate_limited", `${name}: ${message}`, { status: 429 });
	}
	const httpStatus = /\bHTTP\s+([45]\d\d)\b/i.exec(message);
	if (httpStatus) return providerError("http_error", `${name}: ${message}`, { status: Number(httpStatus[1]) });
	if (/\b(?:blocked|permission|denied|not approved)\b/i.test(message)) {
		return providerError("tool_error", `${name} was denied: ${message}`, { retryable: false });
	}
	if (/\bnot found\b|\bnot available\b|\bunknown tool\b|\bdisconnected\b|\bfailed to connect\b/i.test(message)) {
		return unavailable(`${name} is not callable (${message})`);
	}
	return providerError("tool_error", `${name} failed: ${message}`, { retryable: true });
}

function readPayload(result: Record<string, unknown>, tool: string): Record<string, unknown> {
	const structured = record(result.structuredContent);
	if (structured && Array.isArray(structured.results)) return structured;
	for (const block of Array.isArray(result.content) ? result.content : []) {
		const text = record(block)?.text;
		if (typeof text !== "string") continue;
		try {
			const parsed = record(JSON.parse(text));
			if (parsed && Array.isArray(parsed.results)) return parsed;
		} catch { /* Prose is not structured source evidence. */ }
	}
	throw providerError("parse_error", `Parallel ${tool} returned no structured results; check /mcp for ${PARALLEL_MCP_SERVER}.`);
}

function requireResults(payload: Record<string, unknown>, tool: string): ParallelResult[] {
	const raw = payload.results as unknown[];
	const valid = normalizeResults(raw);
	if (raw.length > 0 && valid.length === 0) {
		throw providerError("parse_error", `Parallel ${tool} returned no valid result URLs.`);
	}
	return valid;
}

interface ParallelResult {
	url: string;
	title: string | null;
	publish_date: string | null;
	excerpts: string[];
}

function normalizeResults(value: unknown): ParallelResult[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): ParallelResult[] => {
		const item = record(entry);
		if (!item || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
		return [{
			url: item.url,
			title: typeof item.title === "string" ? item.title : null,
			publish_date: typeof item.publish_date === "string" ? item.publish_date : null,
			excerpts: Array.isArray(item.excerpts) ? item.excerpts.filter((v): v is string => typeof v === "string") : [],
		}];
	});
}

function toDetail(entry: ParallelResult, type?: string): SearchResultDetail {
	return {
		title: entry.title ?? undefined,
		url: entry.url,
		source: "parallel",
		pageAge: entry.publish_date,
		citedText: entry.excerpts.join("\n"),
		...(type ? { type } : {}),
	};
}

function toSource(entry: ParallelResult): Source {
	return { title: entry.title ?? entry.url, url: entry.url };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeWarnings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): string[] => {
		const message = typeof item === "string" ? item : record(item)?.message;
		return typeof message === "string" && message.length ? [message] : [];
	});
}

function normalizeErrorUrls(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): string[] => {
		const url = record(item)?.url;
		return typeof url === "string" ? [url] : [];
	});
}

function normalizeUsage(value: unknown): { name: string; count: number }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): { name: string; count: number }[] => {
		const entry = record(item);
		return typeof entry?.name === "string" && typeof entry.count === "number" && Number.isFinite(entry.count)
			? [{ name: entry.name, count: entry.count }] : [];
	});
}
