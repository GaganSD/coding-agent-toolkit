import type { Usage } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseLibraryQuery } from "./library-query.ts";
import { queryPreview } from "./previews.ts";
import type { WebFilters } from "./providers/filters.ts";
import { evidenceOwner, evidenceStore } from "./evidence.ts";
import { evidenceKey, extractedDocuments, extractionUrlKey, mergeStreamResults, previewEvidence, uniqueEvidence } from "./providers/results.ts";
import { EXCERPT_MAX_CHARS, type WebSearchDetails, formatWebSearchResult } from "./format.ts";
import { augmentResults, type AugmentedStreamResult } from "./classifier/augment.ts";
import { assessOffTopic } from "./classifier/offtopic.ts";
import { resolveSettings } from "./providers/config.ts";
import { awaitWithSignal, withTimeout } from "./providers/http.ts";
import { retrievalProgress } from "./ui/search-progress.ts";
import { reuseTransport } from "./providers/reuse.ts";
import { readUrls } from "./read/index.ts";
import {
	NO_WEB_PROVIDER_MESSAGE,
	type RunSearchOptions,
	type SearchRequest,
	outcome,
	providerAvailability,
	runParallelSearch,
	runSearch,
} from "./providers/index.ts";
import {
	type ProviderFamily,
	type ProviderKind,
	type QueryGroup,
	type StreamResult,
	isProviderError,
	providerError,
} from "./providers/types.ts";
import { type SearchToolName, droppedParamsWarning, formatSearchError } from "./utils.ts";

export type SearchScope = ProviderFamily | "both";

export interface ExecuteSearchParams {
	query: string | string[];
	filters?: WebFilters;
	fetchOnly?: boolean;
	urls?: string[];
	scope: SearchScope;
	parallel: boolean;
	judge: boolean;
	/** The registered tool this run belongs to; used in every failure message. */
	tool: SearchToolName;
	/**
	 * The argument object the host passed to the tool. Undeclared keys survive
	 * host validation, so it is where hallucinated parameters are observed.
	 */
	rawParams: object;
	/** The parameter names this tool declares; anything else is reported, not used. */
	acceptedParams: readonly string[];
	/** Thorough retrieval requires explicit operator opt-in. */
	requireResearch?: boolean;
}

export function trimQuery(query: string): string {
	return query.trim();
}

export function normalizeUrls(urls: string[] | undefined): {
	urls: string[];
	warnings: string[];
} {
	if (!urls || urls.length === 0) {
		return { urls: [], warnings: [] };
	}
	const kept: string[] = [];
	const warnings: string[] = [];
	for (const raw of urls) {
		const value = raw.trim();
		if (value.length === 0) {
			continue;
		}
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			warnings.push(`Ignored invalid URL: ${value}`);
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			warnings.push(`Ignored non-HTTP URL: ${value}`);
			continue;
		}
		kept.push(value);
	}
	return { urls: kept, warnings };
}

/**
 * Best-effort progress observer owned by the runner. Cancellation is checked
 * before every emit, a throwing callback never fails or reshapes the search,
 * and nothing is emitted after `finish()`.
 */
interface ProgressObserver {
	emit(text: string): void;
	finish(): void;
}

function createProgressObserver(
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	signal: AbortSignal | undefined,
): ProgressObserver {
	let finished = false;
	return {
		emit(text) {
			if (finished || !onUpdate || signal?.aborted) {
				return;
			}
			try {
				onUpdate({ content: [{ type: "text", text }], details: {} });
			} catch {
				// A progress observer is advisory; its failure is not a search failure.
			}
		},
		finish() {
			finished = true;
		},
	};
}

/**
 * Shared tool runner. Family and cost policy are fixed by the caller; the
 * agent never chooses a provider or a classifier backend here.
 *
 * Failures return `isError: true` with a typed error payload for scripts and
 * renderers. The whole operation — retrieval plus optional classification — shares one
 * bounded deadline composed with the caller's cancellation.
 */
export async function executeSearch(
	params: ExecuteSearchParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	const progress = createProgressObserver(onUpdate, signal);
	const retrieval = retrievalProgress((line) => progress.emit(line));
	let configIssue: string | undefined;
	let thoroughOff = false;
	let failedQueries: string[] | undefined;
	try {
		if (signal?.aborted) throw abortedError(signal.reason);
		const resolved = await resolveSettings();
		if ("error" in resolved) {
			configIssue = resolved.error.issue?.summary.slice(0, 240);
			throw resolved.error;
		}
		if (params.requireResearch && !resolved.researchEnabled && !options.standalone) {
			thoroughOff = true;
			throw providerError(
				"invalid_config",
				`${params.tool === "search" ? "thorough search" : "multi_search"} is disabled. Set "research": { "enabled": true } in ${resolved.configPath}.`,
			);
		}

		const queries = Array.isArray(params.query) ? params.query : [params.query];
		const batched = Array.isArray(params.query);
		if (queries.some((query) => !trimQuery(query)) && !params.fetchOnly) {
			throw providerError("unknown", "query must not be empty.");
		}

		const urls = params.scope === "code"
			? { urls: [] as string[], warnings: params.urls?.length
				? ["Ignored urls: code_search does not fetch pages."]
				: [] }
			: normalizeUrls(params.urls);

		if (signal?.aborted) {
			throw abortedError(signal.reason);
		}
		if (params.fetchOnly && urls.urls.length === 0) {
			throw providerError("invalid_input", "Supply a query or at least one valid HTTP(S) URL.");
		}
		const family = params.scope === "both" ? undefined : params.scope;
		const composed = withTimeout(signal, resolved.timeoutMs);
		try {
			const request = {
				filters: params.filters,
				fetchOnly: params.fetchOnly,
				reuseScope: options.transports || options.loadTransports ? undefined : evidenceOwner(ctx),
				urls: urls.urls.length > 0 ? urls.urls : undefined,
				signal: composed.signal,
				settings: resolved,
				sessionId: ctx.sessionManager?.getSessionId?.(),
				modelId: ctx.model?.id,
				onRetrieval: retrieval.observe,
			};
			const availability = options.availability ?? providerAvailability(family, resolved);
			const urlOnly = params.fetchOnly && (options.readUrls || options.fetchUrls || (!options.transports && !options.loadTransports));
			const wantJudge = params.judge && resolved.classifier.enabled && !options.standalone;
			const offTopicPin = !params.parallel && family === "web" && !params.fetchOnly
				? resolved.offTopicFallback : undefined;
			const classifierUnavailable = options.standalone && (params.judge || offTopicPin !== undefined);
			const transportLimit = batched ? Math.floor(6 / queries.length) : undefined;
			const retrieveQuery = async (original: string): Promise<QueryResult> => {
				const trimmed = trimQuery(original);
				const parsed = family === "web" ? { query: trimmed } : parseLibraryQuery(trimmed);
				if (parsed.library && !parsed.query) throw providerError("invalid_input", "library: requires search terms.");
				const req: SearchRequest = {
					...request,
					...parsed,
					...(!parsed.library && trimmed !== original ? { objective: original } : {}),
				};
				let fastClassifierUsage: Usage | undefined;
				const reviewRelevance: RunSearchOptions["reviewRelevance"] = offTopicPin && !options.standalone
					? async (result) => {
						const assessment = await assessOffTopic(req.query, result, resolved.classifier.maxStateChars, {
							provider: offTopicPin.provider, model: offTopicPin.model,
							modelRegistry: ctx.modelRegistry, signal: composed.signal,
						});
						if (assessment.usage) {
							fastClassifierUsage = fastClassifierUsage ? sumUsage(fastClassifierUsage, assessment.usage) : assessment.usage;
						}
						return assessment;
					}
					: undefined;
				const raw = urlOnly
					? await runUrlOnly(req, options, availability)
					: params.parallel
					? await runParallelSearch(req, { ...options, family, availability, transportLimit })
					: await runSearch(req, { ...options, family: family ?? "web", availability, reviewRelevance });
				const deadlineExpired = () => composed.signal.aborted &&
					isProviderError(composed.signal.reason) && composed.signal.reason.code === "timeout";
				if (composed.signal.aborted && !(reviewRelevance && deadlineExpired())) throw abortedError(composed.signal.reason);

				const withScope = { ...raw, scope: params.scope, classifierUsage: fastClassifierUsage };
				const judged = wantJudge ? await augmentResults(req, withScope, {
					signal: composed.signal,
					modelRegistry: ctx.modelRegistry,
					provider: resolved.classifier.provider,
					model: resolved.classifier.model,
				}) : withScope;
				// Preserve retrieved evidence if optional judging exhausted the deadline.
				if (composed.signal.aborted && !((wantJudge || reviewRelevance) && deadlineExpired())) {
					throw abortedError(composed.signal.reason);
				}
				return { raw, judged, query: parsed.query };
			};
			const settled = batched ? await Promise.allSettled(queries.map(retrieveQuery)) : undefined;
			if (settled?.every((entry) => entry.status === "rejected")) {
				if (signal?.aborted) throw abortedError(signal.reason);
				failedQueries = queries.map(trimQuery);
				throw settled[0].reason;
			}
			const result = settled ? combineQueryResults(queries, settled) : await retrieveQuery(queries[0]);
			if (signal?.aborted) throw abortedError(signal.reason);

			const { raw, judged } = result;
			const dropped = droppedParamsWarning(params.rawParams, params.acceptedParams);

			progress.finish();
			// Store only post-policy evidence. Suppressed passages must never reappear.
			const unique = batched ? judged : previewEvidence(uniqueEvidence(judged), Number.MAX_SAFE_INTEGER, urls.urls);
			const owner = evidenceOwner(ctx);
			const continuation = owner ? evidenceStore.put(owner, unique) : undefined;
			// Assign refs once, in stored order, before family selection or output budgeting.
			const referenced = continuation ? {
				...unique,
				searchResults: unique.searchResults?.map((hit, index) => ({
					...hit,
					...(index < continuation.storedCount ? { ref: `${continuation.resultId}:${index + 1}` } : {}),
				})),
			} : unique;
			const selected = batched ? referenced : previewEvidence(referenced, resolved.maxResults, urls.urls, !!continuation);
			const preview = {
				...selected,
				searchResults: selected.searchResults?.map((hit) => {
					const query = result.previewQueries?.[hit.queryGroup ?? 0] ?? result.query;
					if (!query || !hit.citedText) return hit;
					const stored = continuation && hit.ref
						? evidenceStore.readHit(owner!, continuation.resultId, Number(hit.ref.split(":").at(-1)) - 1)
						: undefined;
					const text = stored?.status === "ok" ? stored.hit.citedText ?? "" : hit.citedText;
					const selectedText = queryPreview(text, query, EXCERPT_MAX_CHARS, hit.highlight);
					if (selectedText === undefined && text === hit.citedText) return hit;
					return { ...hit, previewText: selectedText ?? text };
				}),
			};
			const formatted = formatWebSearchResult({
				...preview,
				// Local policy notices are not upstream evidence. Add them after
				// judging so suppression can redact untrusted provider diagnostics
				// without hiding scope/config/argument guidance.
				warnings: [
					...resolved.notices,
					...urls.warnings,
					...(dropped ? [dropped] : []),
					...(classifierUnavailable ? ["Classifier unavailable without Pi."] : []),
					...(preview.warnings ?? []),
				],
				classifierStatus: options.standalone && params.judge ? "unavailable" : classifierStatus(wantJudge, judged),
			}, undefined, continuation, resolved.maxResults);
			if (judged.classifierUsage) {
				formatted.usage = judged.classifierUsage;
			}
			Object.assign(formatted.details, retrieval.details(), { cached: raw.cached ?? false,
				...(params.scope !== "code" && params.urls?.length ? {
					urlsRequested: (params.urls?.length ?? 0) - urls.urls.length + new Set(urls.urls.map(extractionUrlKey)).size,
					// A preview cap is not an extraction failure: count before preview selection.
					urlsRead: extractedDocuments(raw, urls.urls),
				} : {}) });
			return formatted;
		} finally {
			composed.dispose();
		}
	} catch (error) {
		progress.finish();
		const result = formatSearchError(params.tool, error, failedQueries);
		Object.assign(result.details, retrieval.details(), { configIssue, thoroughOff,
			...(isProviderError(error) && error.code === "missing_credentials" && error.message.endsWith(NO_WEB_PROVIDER_MESSAGE) ? { webUnavailable: true } : {}) });
		return result;
	}
}

interface QueryResult {
	raw: StreamResult;
	judged: AugmentedStreamResult;
	query: string;
	previewQueries?: string[];
}

function combineQueryResults(queries: string[], settled: PromiseSettledResult<QueryResult>[]): QueryResult {
	const successful = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);

	const groups: QueryGroup[] = [];
	const hits: NonNullable<StreamResult["searchResults"]> = [];
	const seenEvidence = new Set<string>();
	const seenSources = new Set<string>();
	const warnings: string[] = [];
	for (let index = 0; index < settled.length; index++) {
		const entry = settled[index];
		const group: QueryGroup = { query: trimQuery(queries[index]) };
		groups.push(group);
		if (entry.status === "rejected") {
			const error = entry.reason;
			group.failed = true;
			warnings.push(`Query ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const result = uniqueEvidence(entry.value.judged);
		group.providers = result.providers?.length ? result.providers : [result.providerKind];
		const attached = new Set<string>();
		let duplicates = 0;
		for (const hit of result.searchResults ?? []) {
			if (hit.url) attached.add(hit.url);
			const key = evidenceKey(hit);
			if (key && seenEvidence.has(key)) {
				duplicates++;
				continue;
			}
			if (key) seenEvidence.add(key);
			hits.push({ ...hit, queryGroup: index });
		}
		group.sources = (result.sources ?? []).filter(({ url }) => {
			const seen = seenSources.has(url);
			seenSources.add(url);
			if (attached.has(url)) return false;
			if (seen) duplicates++;
			return !seen;
		});
		group.text = result.text;
		if (duplicates) group.duplicates = duplicates;
	}
	const raw = mergeStreamResults(successful.map(({ raw }) => ({ kind: raw.providerKind, result: raw })));
	const judged = mergeStreamResults(successful.map(({ judged }) => ({ kind: judged.providerKind, result: judged })), warnings);
	const usage = successful.flatMap(({ judged }) => judged.classifierUsage ? [judged.classifierUsage] : []);
	const classifierUsage = usage.length ? usage.reduce(sumUsage) : undefined;
	const reports = successful.flatMap(({ judged }) => judged.classifier ? [judged.classifier] : []);
	const classifier = reports.length ? {
		sufficient: reports.length === successful.length && reports.every((report) => report.sufficient),
		lowConfidence: reports.some((report) => report.lowConfidence),
		suppressed: reports.reduce((total, report) => total + report.suppressed, 0),
		suppressedUrls: [...new Set(reports.flatMap((report) => report.suppressedUrls))],
	} : undefined;
	return {
		raw,
		judged: {
			...judged, text: "", sources: [], searchResults: hits, queryGroups: groups, scope: successful[0].judged.scope,
			classifier, classifierUsage, classifierStatus: classifier ? "ran" : successful[0].judged.classifierStatus,
		},
		query: "",
		previewQueries: settled.map((entry) => entry.status === "fulfilled" ? entry.value.query : ""),
	};
}

function sumUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input, output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cacheWrite1h: optionalSum(left.cacheWrite1h, right.cacheWrite1h),
		reasoning: optionalSum(left.reasoning, right.reasoning),
		cost: {
			input: left.cost.input + right.cost.input, output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead, cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function optionalSum(left?: number, right?: number): number | undefined {
	return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

/** Keep URL-only reads keyless and independent of the selected search provider. */
async function runUrlOnly(req: SearchRequest, options: RunSearchOptions, availability: Partial<Record<ProviderKind, boolean>>): Promise<StreamResult> {
	if (options.readUrls) return options.readUrls(req);
	if (!options.fetchUrls) return readUrls(req);
	req.onRetrieval?.({ type: "started", kinds: ["jina"] });
	try {
		const pending = reuseTransport("jina", req, options.fetchUrls);
		const result = req.signal ? await awaitWithSignal(pending, req.signal) : await pending;
		req.onRetrieval?.(outcome("jina", result));
		return result;
	} catch (error) {
		if (isProviderError(error)) req.onRetrieval?.({ type: "failed", kind: "jina", code: error.code });
		if (req.signal?.aborted || !isProviderError(error) || !error.retryable) throw error;
		// Brave also delegates extraction to Jina: never retry it through that path.
		const chain = [req.settings.web.provider, ...req.settings.web.fallback];
		if (chain.every((kind) => kind === "brave")) throw error;
		const result = await runSearch(req, { ...options, family: "web", availability: { ...availability, brave: false } });
		return { ...result, warnings: [`Jina URL extraction failed (${error.code}); used fallback.`, ...(result.warnings ?? [])] };
	}
}

function classifierStatus(
	requested: boolean,
	result: StreamResult,
): NonNullable<StreamResult["classifierStatus"]> {
	if (!requested) {
		return "disabled";
	}
	return result.classifierStatus ?? (result.classifier ? "ran" : "disabled");
}

function abortedError(reason: unknown): unknown {
	// Preserve any ProviderError, including `timeout` from a parent deadline:
	// an operation timeout must never be reported as a user abort.
	if (isProviderError(reason)) {
		return reason;
	}
	return providerError("aborted", "search was aborted.");
}
