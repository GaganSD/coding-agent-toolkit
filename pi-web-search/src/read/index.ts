import { awaitWithSignal, withTimeout } from "../providers/http.ts";
import type { SearchRequest, SearchTransport } from "../providers/index.ts";
import { jinaFetch } from "../providers/jina.ts";
import { sourcesFromResults } from "../providers/results.ts";
import { isProviderError, providerError, type EvidenceProvider, type SearchResultDetail, type StreamResult } from "../providers/types.ts";
import { capDocument, documentFromPage } from "./document.ts";
import { githubResource, readGitHub, type GitHubReaderOptions } from "./github.ts";
import { fetchPinnedPage, publicHttpUrl, type FetchPage, type PageTransport } from "./http.ts";

const CONCURRENCY = 3;
const MAX_URLS = 20;

export interface UrlReaderOptions extends GitHubReaderOptions {
	transport?: PageTransport;
	jinaFetch?: SearchTransport;
}

interface ReadOutcome { hit?: SearchResultDetail; warnings?: string[]; error?: unknown }

/** Read each URL locally. A retryable failure uses only the configured Jina fallback. */
export async function readUrls(req: SearchRequest, options: UrlReaderOptions = {}): Promise<StreamResult> {
	const urls = [...new Set(req.urls ?? [])].slice(0, MAX_URLS);
	if (!urls.length) throw providerError("parse_error", "URL reading requires at least one URL.");
	const operation = withTimeout(req.signal, req.settings.timeoutMs);
	const { signal } = operation;
	const jinaEnabled = req.settings.fetch?.jinaFallback !== false;
	const outcomes = new Array<ReadOutcome>(urls.length);
	const started = new Set<EvidenceProvider>();
	const start = (kind: EvidenceProvider) => {
		if (started.has(kind)) return;
		started.add(kind);
		req.onRetrieval?.({ type: "started", kinds: [kind] });
	};
	let next = 0;
	try {
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
			while (next < urls.length) {
				signal.throwIfAborted();
				const index = next++;
				outcomes[index] = await readOne(urls[index], index);
			}
		}));
		signal.throwIfAborted();
		const searchResults = outcomes.flatMap(({ hit }) => hit ? [hit] : []);
		const warnings = outcomes.flatMap((outcome) => outcome.warnings ?? []);
		const sources = sourcesFromResults(searchResults);
		const providers = [...new Set(searchResults.map((hit) => hit.source as EvidenceProvider))];
		for (const kind of providers) {
			start(kind);
			req.onRetrieval?.({ type: "contributed", kind });
		}
		if (!providers.length) throw outcomes[0].error ?? providerError("parse_error", "No URLs returned readable content.");
		return {
			text: "", searchResults, sources, providerKind: providers[0],
			...(providers.length > 1 ? { providers } : {}),
			...(warnings.length ? { warnings } : {}),
		};
	} finally {
		operation.dispose();
	}

	async function readOne(raw: string, index: number): Promise<ReadOutcome> {
		let validated = false;
		let kind: EvidenceProvider = "local";
		let localError: unknown;
		// Save part of the shared operation deadline for Jina. An exhausted
		// deadline or a lookup that never validated an address cannot trigger egress.
		const local = jinaEnabled
			? withTimeout(signal, Math.max(1, Math.floor(req.settings.timeoutMs * 0.65)))
			: { signal, dispose() {} };
		try {
			const url = publicHttpUrl(raw);
			const resource = githubResource(url);
			if (resource) kind = "github";
			start(kind);
			let byteCapped = false;
			const fetchPage: FetchPage = async (target, headers) => {
				const page = await fetchPinnedPage(target, local.signal, options.transport, headers, (passed) => { validated = passed; });
				byteCapped ||= page.truncated;
				return page;
			};
			const document = resource
				? await readGitHub(resource, fetchPage, local.signal, options)
				: await documentFromPage(await fetchPage(url), url, local.signal);
			local.signal.throwIfAborted();
			if (!document.text.trim()) {
				if (byteCapped) throw providerError("parse_error", "URL returned no readable text within the 5 MiB download limit.");
				throw providerError("parse_error", document.source === "pdf" ? "PDF contains no extractable text." : "URL returned no readable text.",
					{ retryable: document.source !== "pdf" });
			}
			const capped = capDocument(document.text);
			const clipped = document.truncated || capped.truncated;
			const limits = [
				...(byteCapped ? [document.source === "pdf" ? "the PDF download limit" : "the 5 MiB download limit"] : []),
				...(capped.truncated ? ["the 64000-character evidence limit"] : []),
			].join(" and ");
			return {
				hit: { url: raw, title: document.title, source: document.source ?? kind, type: "content", citedText: capped.text,
					...(clipped ? { status: "provider_excerpt_clipped" } : {}),
				},
				...(clipped ? { warnings: [`URL ${index + 1} evidence clipped at ${limits}.`] } : {}),
			};
		} catch (error) {
			signal.throwIfAborted();
			localError = error;
		} finally {
			local.dispose();
		}

		const failure = isProviderError(localError) ? localError : providerError("parse_error", "Local URL reading failed.");
		start(kind);
		req.onRetrieval?.({ type: "failed", kind, code: failure.code });
		const retryable = validated && failure.retryable;
		if (!retryable || !jinaEnabled) {
			const message = retryable && !jinaEnabled ? `${failure.message} Jina fallback is disabled by fetch.jinaFallback.` : failure.message;
			const error = providerError(failure.code, message, { status: failure.status, retryable: false });
			return { error, warnings: [`URL ${index + 1}: ${message}`] };
		}

		start("jina");
		try {
			signal.throwIfAborted();
			const result = await awaitWithSignal((options.jinaFetch ?? jinaFetch)({ ...req, urls: [raw], signal }), signal);
			const hit = result.searchResults?.find((row) => row.citedText?.trim());
			if (!hit) throw providerError("parse_error", "Jina Reader returned no identified page content.");
			return { hit, warnings: [`URL ${index + 1} used Jina after local reading failed (${failure.code}).`, ...(result.warnings ?? [])] };
		} catch (error) {
			signal.throwIfAborted();
			const fallback = isProviderError(error) ? error : providerError("parse_error", "Jina URL reading failed.");
			req.onRetrieval?.({ type: "failed", kind: "jina", code: fallback.code });
			const message = `Local URL reading failed (${failure.code}). Jina fallback failed (${fallback.code}).`;
			return {
				error: providerError(fallback.code, message, { status: fallback.status, retryable: false }),
				warnings: [`URL ${index + 1}: ${message}`],
			};
		}
	}
}
