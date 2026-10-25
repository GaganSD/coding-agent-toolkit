import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { isCodeSource } from "./providers/types.ts";
import type {
	SearchResultDetail,
	Source,
	StreamResult,
} from "./providers/types.ts";

/** Excerpts are a preview, not the document: keep them short. */
export const EXCERPT_MAX_CHARS = 400;

/** Rich renderer details are bounded separately; model-visible search snippets use EXCERPT_MAX_CHARS. */
export const STRUCTURED_EXCERPT_MAX_CHARS = 4_000;
export const STRUCTURED_EXCERPT_TOTAL_CHARS = 12_000;
export const PROVIDER_TEXT_MAX_CHARS = 8_000;
/** Conservative character budget for ordinary model text. No tokenizer dependency. */
export const OUTPUT_BUDGET_CHARS = 8_000;
export const CLIP_MARKER = "…";
const METADATA_MAX_CHARS = 1_000;
const METADATA_TOTAL_CHARS = 16_000;
const WARNINGS_TOTAL_CHARS = 8_000;

/** Heading text of each rendered section, exported so tests can assert on them. */
export const RESULTS_HEADING = "## Results";
export const SOURCES_HEADING = "## Sources";
export const WARNINGS_HEADING = "## Warnings";

const ProviderSchema = Type.Union([Type.Literal("exa"), Type.Literal("parallel"), Type.Literal("grep"), Type.Literal("sourcegraph"), Type.Literal("github"), Type.Literal("brave"), Type.Literal("jina")]);

/** One declared data contract for renderers, scripts, and failure results. */
const DetailsSchema = Type.Object({
	resultId: Type.Optional(Type.String()),
	storedCount: Type.Optional(Type.Integer({ minimum: 0 })),
	storedClipped: Type.Optional(Type.Boolean()),
	ref: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String()),
	more: Type.Optional(Type.Boolean()),
	truncated: Type.Optional(Type.Boolean()),
	passage: Type.Optional(Type.Object({ index: Type.Integer(), offset: Type.Integer(), nextOffset: Type.Optional(Type.Integer()), totalChars: Type.Integer(), matches: Type.Optional(Type.Integer()) })),
	provider: Type.Optional(ProviderSchema),
	providers: Type.Optional(Type.Array(ProviderSchema)),
	requestId: Type.Optional(Type.String()),
	resultCount: Type.Optional(Type.Integer({ minimum: 0 })),
	sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }))),
	searchResults: Type.Optional(Type.Array(Type.Object({
		title: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
		query: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
		pageAge: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		citedText: Type.Optional(Type.String()), status: Type.Optional(Type.String()), type: Type.Optional(Type.String()),
		ref: Type.Optional(Type.String()),
	}))),
	warnings: Type.Optional(Type.Array(Type.String())),
	usage: Type.Optional(Type.Array(Type.Object({ name: Type.String(), count: Type.Number() }))),
	grounded: Type.Optional(Type.Boolean()),
	jev: Type.Optional(Type.Object({
		sufficient: Type.Boolean(), lowConfidence: Type.Boolean(), suppressed: Type.Integer({ minimum: 0 }),
		suppressedUrls: Type.Array(Type.String()),
	})),
	scope: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("code"), Type.Literal("both")])),
	jevStatus: Type.Optional(Type.Union([Type.Literal("ran"), Type.Literal("disabled"), Type.Literal("unavailable"), Type.Literal("skipped")])),
	error: Type.Optional(Type.Object({
		code: Type.String(), message: Type.String(), status: Type.Optional(Type.Number()),
		rpcCode: Type.Optional(Type.Number()), retryable: Type.Optional(Type.Boolean()), configPath: Type.Optional(Type.String()),
	})),
}, { additionalProperties: false });

export type WebSearchDetails = Static<typeof DetailsSchema>;

export const SearchOutputSchema = Type.Object({
	status: Type.Union([Type.Literal("success"), Type.Literal("error")]),
	text: Type.Optional(Type.String()),
	...DetailsSchema.properties,
}, { additionalProperties: false });

export interface TruncationLimits {
	maxLines?: number;
	maxBytes?: number;
}

/** Stable one-based hit handle; refs are assigned before preview selection. */
export function hitRef(resultId: string, index: number): string {
	return `${resultId}:${index + 1}`;
}

/** Direct callers receive text; scripts receive evidence once, without renderer diagnostics. */
export function formatResult(text: string, details: WebSearchDetails, limits?: TruncationLimits): AgentToolResult<WebSearchDetails> {
	const { content, truncated } = truncateHead(text, {
		maxLines: limits?.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: limits?.maxBytes ?? DEFAULT_MAX_BYTES,
	});
	const rendered = content + (truncated ? "\n\n[Truncated]" : "");
	const finalDetails = truncated ? { ...details, truncated: true } : details;
	return {
		content: [{ type: "text", text: rendered }],
		details: finalDetails,
		structuredContent: structuredEvidence(finalDetails, rendered),
		isError: details.error !== undefined,
	};
}

function structuredEvidence(details: WebSearchDetails, text: string) {
	// Failure contracts retain diagnostics; successful evidence has one compact representation.
	if (details.error) return JSON.parse(JSON.stringify({ status: "error", text, ...details }));
	const hits = details.searchResults ?? [];
	return JSON.parse(JSON.stringify({
		status: "success",
		...(hits.length ? { searchResults: hits.map(({ title, url, citedText, ref, source, type }) => ({
			title, url, citedText, ref, source, type,
		})) } : { text }),
		...(hits.length ? { resultCount: hits.length } : {}),
		...(details.provider ? { provider: details.provider } : {}),
		...(details.resultId ? { resultId: details.resultId } : {}),
		...(details.ref ? { ref: details.ref } : {}),
		...(details.storedCount === undefined ? {} : { storedCount: details.storedCount }),
		...(details.cursor ? { cursor: details.cursor } : {}),
		...(details.more === undefined ? {} : { more: details.more }),
		...(details.truncated ? { truncated: true } : {}),
		...(details.storedClipped ? { storedClipped: true } : {}),
		...(details.warnings?.length ? { warnings: details.warnings } : {}),
	}));
}

/** Pack whole citation-bearing records once, then render that same evidence for both consumers. */
export function formatWebSearchResult(
	result: StreamResult,
	limits?: TruncationLimits,
	continuation?: Pick<WebSearchDetails, "resultId" | "storedCount" | "storedClipped">,
): AgentToolResult<WebSearchDetails> {
	const compact = compactResult(result);
	const hits = (compact.searchResults ?? []).map((hit, index) => ({
		...hit,
		...(hit.title ? { title: markedClip(hit.title, 120) } : {}),
		...(hit.ref ? {} : continuation && index < (continuation.storedCount ?? 0)
			? { ref: hitRef(continuation.resultId!, index) } : {}),
		citedText: previewText(hit),
	}));
	const warnings = (compact.warnings ?? []).filter((warning) => !/ skipped: not available\.$/u.test(warning));
	const notices = warnings.slice(0, 6).map((warning) => markedClip(warning, 200));
	if (warnings.length > notices.length) notices.push("Additional diagnostics omitted.");
	let omitted = 0;
	const selected: SearchResultDetail[] = [];
	const sources: Source[] = [];
	// Reserve room for truthful omission notices and a continuation instruction.
	const budget = OUTPUT_BUDGET_CHARS - 600;
	const prose = markedClip(compact.text, 1000);
	const buildDetails = (): WebSearchDetails => ({
		...continuation, provider: compact.providerKind,
		...(continuation?.resultId ? { ref: continuation.resultId } : {}),
		searchResults: selected, sources, warnings: notices,
	});
	const fits = () => {
		const rendered = renderEvidence(prose, selected, sources, notices, continuation?.resultId);
		return rendered.length <= budget && rendered.split("\n").length < DEFAULT_MAX_LINES - 10
			&& JSON.stringify(structuredEvidence(buildDetails(), prose)).length <= budget;
	};
	for (const hit of hits) {
		selected.push(hit);
		if (!fits()) { selected.pop(); omitted++; }
	}
	const cited = new Set(selected.flatMap((hit) => hit.url ? [hit.url] : []));
	const hitUrls = new Set(hits.flatMap((hit) => hit.url ? [hit.url] : []));
	for (const source of compact.sources ?? []) {
		// A source attached to an omitted result must not bypass the result budget.
		if (cited.has(source.url) || hitUrls.has(source.url)) continue;
		sources.push({ title: markedClip(source.title, 120), url: source.url });
		if (!fits()) { sources.pop(); omitted++; } else cited.add(source.url);
	}
	if (omitted) notices.push(`${omitted} result/citation(s) omitted to fit the output budget.`);
	const clipped = compact.text.length > 1000 || (compact.searchResults ?? []).some((hit) => normalizedText(hit).length > EXCERPT_MAX_CHARS);
	const text = renderEvidence(prose, selected, sources, notices, continuation?.resultId);
	const visible = buildDetails();
	visible.truncated = omitted > 0 || clipped || continuation?.storedClipped === true;
	const output = formatResult(text, {
		...visible,
		// Rich renderer details never become another copy of the model evidence.
		searchResults: compact.searchResults?.map((hit, index) => ({ ...hit, ...(hits[index]?.ref ? { ref: hits[index].ref } : {}) })),
		sources: compact.sources ?? [], warnings: compact.warnings ?? [],
		providers: compact.providers, requestId: compact.requestId, usage: compact.usage,
		grounded: cited.size > 0, scope: compact.scope, jev: compact.jev, jevStatus: compact.jevStatus,
		resultCount: selected.length || sources.length,
	}, limits);
	output.structuredContent = structuredEvidence(visible, text);
	return output;
}

function markedClip(text: string, limit: number): string {
	return text.length > limit ? clipText(text, limit) + CLIP_MARKER : text;
}

function normalizedText(hit: SearchResultDetail): string {
	const raw = hit.citedText ?? "";
	return isCodeSource(hit.source) ? raw.trimEnd() : raw.replace(/\s+/gu, " ").trim();
}

function previewText(hit: SearchResultDetail): string {
	return markedClip(normalizedText(hit), EXCERPT_MAX_CHARS);
}

function renderEvidence(prose: string, hits: SearchResultDetail[], sources: Source[], warnings: string[], resultId?: string): string {
	const blocks = hits.map((hit, index) => {
		const number = hit.ref?.split(":").at(-1) ?? String(index + 1);
		const label = markedClip(hit.title?.trim() || (hit.url ? hit.url : `Result ${number}`), 120);
		const heading = `${number}. ${hit.url ? `[${label}](${hit.url})` : label}${hit.ref ? ` ${hit.ref}` : ""}`;
		const code = isCodeSource(hit.source);
		return hit.citedText ? heading + "\n" + (code ? "```\n" + hit.citedText + "\n```" : "> " + hit.citedText) : heading;
	});
	const results = blocks.length ? RESULTS_HEADING + "\n\n" + blocks.join("\n\n") : "";
	const citations = sources.length ? SOURCES_HEADING + "\n\n" + sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})`).join("\n") : "";
	const notes = warnings.length ? WARNINGS_HEADING + "\n\n" + warnings.map((warning) => "- " + warning).join("\n") : "";
	const more = resultId ? `Read: search({ref: "${resultId}"})` : "";
	return [prose && prose.trim() !== results ? prose : "", results, citations, notes, more].filter(Boolean).join("\n\n");
}

function compactResult(result: StreamResult): StreamResult {
	let excerptBudget = STRUCTURED_EXCERPT_TOTAL_CHARS;
	let metadataBudget = METADATA_TOTAL_CHARS;
	let clippedExcerpts = 0;
	let clippedMetadata = false;
	const metadata = (value: string): string => {
		const clipped = clipText(value, Math.min(METADATA_MAX_CHARS, metadataBudget));
		metadataBudget -= clipped.length;
		clippedMetadata ||= clipped.length < value.length;
		return clipped;
	};
	const entries = result.searchResults ?? [];
	const searchResults = entries.map((entry, index) => {
		const compact: SearchResultDetail = { ...entry };
		if (entry.citedText !== undefined) {
			compact.citedText = clipText(entry.citedText, Math.min(STRUCTURED_EXCERPT_MAX_CHARS, Math.floor(excerptBudget / (entries.length - index))));
			excerptBudget -= compact.citedText.length;
			if (compact.citedText.length < entry.citedText.length) clippedExcerpts++;
		}
		for (const key of ["title", "query", "source", "pageAge", "status", "type"] as const) {
			const value = entry[key];
			if (typeof value === "string") {
				// Keep recognized provenance tags even if large titles consumed the
				// metadata budget: code rendering depends on these fixed-size tags.
				compact[key] = key === "source" && ["exa", "parallel", "grep", "sourcegraph", "github", "brave", "jina"].includes(value)
					? value : metadata(value);
			}
		}
		return compact;
	});
	const sources = (result.sources ?? []).map((source) => ({ title: metadata(source.title), url: source.url }));
	const requestId = result.requestId === undefined ? undefined : metadata(result.requestId);
	const usage = result.usage?.map((item) => ({ name: metadata(item.name), count: item.count }));
	const text = clipText(result.text, PROVIDER_TEXT_MAX_CHARS);
	let warningBudget = WARNINGS_TOTAL_CHARS;
	let clippedWarnings = false;
	const warnings: string[] = [];
	for (const warning of result.warnings ?? []) {
		if (warnings.length >= 100 || warningBudget === 0) {
			clippedWarnings = true;
			break;
		}
		const clipped = clipText(warning, Math.min(METADATA_MAX_CHARS, warningBudget));
		warningBudget -= clipped.length;
		clippedWarnings ||= clipped.length < warning.length;
		warnings.push(clipped);
	}
	if (clippedExcerpts) warnings.push(`Result excerpts truncated for ${clippedExcerpts} hit(s): citedText is a preview capped at ${STRUCTURED_EXCERPT_MAX_CHARS} characters per hit and ${STRUCTURED_EXCERPT_TOTAL_CHARS} in total. Follow citation URLs for full evidence.`);
	if (text.length < result.text.length) warnings.push(`Provider prose truncated to ${PROVIDER_TEXT_MAX_CHARS} characters; use the cited results for evidence.`);
	if (clippedMetadata) warnings.push(`Result metadata truncated to ${METADATA_MAX_CHARS} characters per field and ${METADATA_TOTAL_CHARS} in total; citation URLs are unchanged.`);
	if (clippedWarnings) warnings.push("Provider warnings truncated (100 entries, 1000 characters each, 8000 in total).");
	return { ...result, text, sources, searchResults, warnings, requestId, usage };
}

/** Do not split a surrogate pair when clipping a preview. */
function clipText(text: string, maxChars: number): string {
	let end = Math.min(text.length, Math.max(0, maxChars));
	if (end < text.length && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
	return text.slice(0, end);
}
