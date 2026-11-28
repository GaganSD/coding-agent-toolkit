import { Type, type Static } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { PREVIEW_PASSAGE_CHARS } from "./previews.ts";
import { DEFAULT_MAX_LINES, truncateHead } from "./truncate.ts";
import { isCodeSource, PROVIDER_KINDS, sourceFamily } from "./providers/types.ts";
import { providerName } from "./ui/provider-names.ts";
import type {
	EvidenceProvider,
	SearchResultDetail,
	Source,
	StreamResult,
} from "./providers/types.ts";

/** Excerpts are a preview, not the document: keep them short. */
export const EXCERPT_MAX_CHARS = PREVIEW_PASSAGE_CHARS;

/** Rich renderer details are bounded separately; model-visible search snippets use EXCERPT_MAX_CHARS. */
export const STRUCTURED_EXCERPT_MAX_CHARS = 4_000;
export const STRUCTURED_EXCERPT_TOTAL_CHARS = 12_000;
export const PROVIDER_TEXT_MAX_CHARS = 8_000;
/** Conservative character budget for ordinary model text. No tokenizer dependency. */
export const OUTPUT_BUDGET_CHARS = 8_000;
export const CLIP_MARKER = "…";
const SOURCE_TAGS = new Set<string>([...PROVIDER_KINDS, "jina", "local", "pdf"]);
const METADATA_MAX_CHARS = 1_000;
const METADATA_TOTAL_CHARS = 16_000;
const WARNINGS_TOTAL_CHARS = 8_000;

/** Heading text of each rendered section, exported so tests can assert on them. */
export const RESULTS_HEADING = "## Results";
export const SOURCES_HEADING = "## Sources";
export const WARNINGS_HEADING = "## Warnings";

const ProviderSchema = Type.Union([
	Type.Literal("exa"), Type.Literal("parallel"), Type.Literal("grep"), Type.Literal("sourcegraph"),
	Type.Literal("github"), Type.Literal("brave"), Type.Literal("searxng"), Type.Literal("context7"),
	Type.Literal("jina"), Type.Literal("local"), Type.Literal("pdf"),
]);

interface TranscriptDetails {
	durationMs?: number;
	cached?: boolean;
	attempted?: EvidenceProvider[];
	contributors?: EvidenceProvider[];
	withheldMatches?: boolean;
	incompleteSearch?: boolean;
	unreadableProviders?: EvidenceProvider[];
	failedProviders?: EvidenceProvider[];
	webUnavailable?: boolean;
	allRateLimited?: boolean;
	configIssue?: string;
	urlsRequested?: number;
	urlsRead?: number;
	clippedExcerptRows?: number[];
	thoroughOff?: boolean;
	passageSource?: string;
	unparsedRows?: number[];
	unparsedReply?: boolean;
	parallelHttpStatus?: number;
}

const EvidenceDetailsSchema = Type.Object({
	resultId: Type.Optional(Type.String({ description: "Pass this bare handle as ref to list stored results." })),
	storedCount: Type.Optional(Type.Integer({ minimum: 0 })),
	storedClipped: Type.Optional(Type.Boolean()),
	ref: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String({ description: "Pass with the same ref to read the next page." })),
	more: Type.Optional(Type.Boolean({ description: "Whether another page is available using cursor." })),
	truncated: Type.Optional(Type.Boolean()),
	matches: Type.Optional(Type.Integer({ minimum: 0 })),
	passage: Type.Optional(Type.Object({ index: Type.Integer(), offset: Type.Integer(), nextOffset: Type.Optional(Type.Integer()), totalChars: Type.Integer(), matches: Type.Optional(Type.Integer()) })),
	provider: Type.Optional(ProviderSchema),
	providers: Type.Optional(Type.Array(ProviderSchema)),
	requestId: Type.Optional(Type.String()),
	resultCount: Type.Optional(Type.Integer({ minimum: 0 })),
	sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }))),
	queryGroups: Type.Optional(Type.Array(Type.Object({
		query: Type.String(), duplicates: Type.Optional(Type.Integer()), failed: Type.Optional(Type.Boolean()),
		resultCount: Type.Optional(Type.Integer({ minimum: 0 })),
		previewCount: Type.Optional(Type.Integer({ minimum: 0 })),
		providers: Type.Optional(Type.Array(ProviderSchema)),
		text: Type.Optional(Type.String()),
		sources: Type.Optional(Type.Array(Type.Object({ title: Type.String(), url: Type.String() }))),
	}))),
	searchResults: Type.Optional(Type.Array(Type.Object({
		title: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
		query: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
		pageAge: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		citedText: Type.Optional(Type.String()), status: Type.Optional(Type.String()), type: Type.Optional(Type.String()),
		ref: Type.Optional(Type.String({ description: "Pass this numbered ref to read one stored result." })),
		queryGroup: Type.Optional(Type.Integer({ minimum: 0 })),
		preview: Type.Optional(Type.Object({
			shownChars: Type.Integer({ minimum: 0 }), totalChars: Type.Integer({ minimum: 1 }),
		})),
	}))),
	warnings: Type.Optional(Type.Array(Type.String())),
	usage: Type.Optional(Type.Array(Type.Object({ name: Type.String(), count: Type.Number() }))),
	grounded: Type.Optional(Type.Boolean()),
	classifier: Type.Optional(Type.Object({
		sufficient: Type.Boolean(), lowConfidence: Type.Boolean(), suppressed: Type.Integer({ minimum: 0 }),
		suppressedUrls: Type.Array(Type.String()),
	})),
	scope: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("code"), Type.Literal("both")])),
	classifierStatus: Type.Optional(Type.Union([Type.Literal("ran"), Type.Literal("disabled"), Type.Literal("unavailable"), Type.Literal("skipped")])),
	error: Type.Optional(Type.Object({
		code: Type.String(), message: Type.String(), status: Type.Optional(Type.Number()),
		rpcCode: Type.Optional(Type.Number()), retryable: Type.Optional(Type.Boolean()), configPath: Type.Optional(Type.String()),
	})),
}, { additionalProperties: false });

export type WebSearchDetails = Static<typeof EvidenceDetailsSchema> & TranscriptDetails;
type EvidenceHit = NonNullable<WebSearchDetails["searchResults"]>[number];

export const SearchOutputSchema = Type.Object({
	status: Type.Union([Type.Literal("success"), Type.Literal("error")]),
	text: Type.Optional(Type.String()),
	...EvidenceDetailsSchema.properties,
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
	const { content, truncated } = truncateHead(text, limits);
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
	if (details.error) {
		const evidence = Object.fromEntries(Object.entries(details).filter(([key]) => Object.hasOwn(EvidenceDetailsSchema.properties, key)));
		return JSON.parse(JSON.stringify({ status: "error", text, ...evidence }));
	}
	const hits = details.searchResults ?? [];
	return JSON.parse(JSON.stringify({
		status: "success",
		...(hits.length ? { searchResults: hits.map(({ title, url, citedText, ref, source, type, queryGroup, preview }) => ({
			title, url, citedText, ref, source, type, queryGroup, preview,
		})) } : details.queryGroups ? {} : { text }),
		// These citations are not attached to a hit; omitting them would lose
		// evidence for scripts even though direct callers see the Sources block.
		...((hits.length || details.queryGroups) && details.sources?.length ? { sources: details.sources } : {}),
		...(hits.length ? { resultCount: hits.length } : {}),
		...(details.queryGroups ? { queryGroups: details.queryGroups } : {}),
		...(details.provider ? { provider: details.provider } : {}),
		...(details.providers && details.providers.length > 1 ? { providers: details.providers } : {}),
		...(details.resultId ? { resultId: details.resultId } : {}),
		...(details.ref ? { ref: details.ref } : {}),
		...(details.storedCount === undefined ? {} : { storedCount: details.storedCount }),
		...(details.cursor ? { cursor: details.cursor } : {}),
		...(details.more === undefined ? {} : { more: details.more }),
		...(details.passage?.matches === undefined ? {} : { matches: details.passage.matches }),
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
	maxBatchResults = 8,
): AgentToolResult<WebSearchDetails> {
	const compact = compactResult(result);
	const hits = (compact.searchResults ?? []).map((hit, index) => {
		const original = result.searchResults![index];
		const fullText = normalizedText(original.citedText ?? "", hit.source);
		const text = original.previewText === undefined ? fullText : normalizedText(original.previewText, hit.source);
		return {
			...hit,
			...(hit.title ? { title: markedClip(hit.title, 120) } : {}),
			...(hit.ref ? {} : continuation?.resultId && index < (continuation.storedCount ?? 0)
				? { ref: hitRef(continuation.resultId, index) } : {}),
			...previewFields(text, Math.max(fullText.length, text.length), EXCERPT_MAX_CHARS),
		};
	});
	const warnings = (compact.warnings ?? []).filter((warning) => !/ skipped: not available\.$/u.test(warning));
	const notices: string[] = [];
	let omitted = 0;
	const selected: typeof hits = [];
	const sources: Source[] = [];
	// Reserve room for truthful omission notices and a continuation instruction.
	const batchGroups = compact.queryGroups;
	const groups = batchGroups?.map(({ query, duplicates, failed, providers, sources }, index) => ({
		query: markedClip(query.replace(/\s+/gu, " "), 160), duplicates, failed,
		providers: providers?.length ? [...new Set(providers)] : undefined,
		resultCount: countGroupResults(hits, index) + (sources?.length ?? 0),
		text: "", sources: [] as Source[],
	}));
	const providers = [...new Set(compact.providers?.length ? compact.providers : [compact.providerKind])];
	const empty = !groups && !hits.length && !compact.sources?.length && !compact.text.trim();
	const emptyStatus = !empty ? "" : compact.unreadable ? "Unreadable reply" : "0 results";
	const budget = OUTPUT_BUDGET_CHARS - 600;
	let prose = "";
	const buildDetails = (): WebSearchDetails => ({
		...continuation, provider: compact.providerKind, providers,
		...(continuation?.resultId ? { ref: continuation.resultId } : {}),
		searchResults: selected, sources, warnings: notices,
		queryGroups: groups?.map(({ text, sources, ...group }, index) => ({
			...group,
			previewCount: countGroupResults(selected, index) + sources.length,
			...(text ? { text } : {}),
			...(sources.length ? { sources } : {}),
		})),
	});
	const measure = () => {
		const details = buildDetails();
		const rendered = renderEvidence(prose, details, emptyStatus);
		return { text: rendered.length, lines: rendered.split("\n").length, json: JSON.stringify(structuredEvidence(details, rendered)).length };
	};
	const fits = (size = measure()) => size.text <= budget && size.lines < DEFAULT_MAX_LINES - 10 && size.json <= budget;
	// Fit fixed fields too: JSON escaping counts, including text-only responses.
	let hiddenWarnings = warnings.length;
	for (const warning of warnings.slice(0, 6)) {
		notices.push(markedClip(warning, 200));
		if (!fits()) notices.pop(); else hiddenWarnings--;
	}
	if (hiddenWarnings) {
		notices.push("Additional diagnostics omitted.");
		while (!fits() && notices.length > 1) notices.splice(notices.length - 2, 1);
	}
	for (let limit = 1000; ; limit = Math.floor(limit / 2)) {
		prose = limit ? markedClip(compact.text, limit) : "";
		if (fits()) break;
	}
	// Reserve mixed-family records atomically. Only crowded previews use shorter
	// snippets; a large first web hit must not silently consume the code slot.
	const shorten = ({ citedText, preview }: (typeof hits)[number]) => previewFields(citedText, preview?.totalChars ?? citedText.length, 80);
	if (!groups && compact.scope === "both") {
		const representatives = ["web", "code"].map((family) => hits.find((hit) => sourceFamily(hit.source) === family)).filter((hit) => hit !== undefined);
		if (representatives.length === 2) {
			selected.push(...representatives);
			if (!fits()) {
				const originals = representatives.map(({ citedText, preview }) => ({ citedText, preview }));
				for (const hit of representatives) Object.assign(hit, shorten(hit));
				if (!fits()) {
					representatives.forEach((hit, index) => Object.assign(hit, originals[index]));
					selected.length = 0;
				}
			}
		}
	}
	if (groups && batchGroups) {
		const fixed = measure();
		const share = Math.floor((budget - Math.max(fixed.text, fixed.json)) / groups.length);
		const candidates = groups.map((_, index) => batchCandidates(hits.filter((hit) => hit.queryGroup === index), compact.scope === "both"));
		const offer = (index: number, equalShare: boolean) => {
			const group = groups[index];
			const base = measure();
			const available = () => {
				const size = measure();
				return fits(size) && (!equalShare || size.text - base.text <= share && size.json - base.json <= share);
			};
			let remainingSlots = maxBatchResults - selected.filter((hit) => hit.queryGroup === index).length;
			for (const hit of candidates[index]) {
				if (remainingSlots === 0) break;
				if (selected.includes(hit)) continue;
				selected.push(hit);
				if (!available()) {
					const original = { citedText: hit.citedText, preview: hit.preview };
					Object.assign(hit, shorten(hit));
					if (!available()) {
						Object.assign(hit, original);
						selected.pop();
						continue;
					}
				}
				remainingSlots--;
			}
			for (const source of batchGroups[index].sources ?? []) {
				if (group.sources.some((selected) => selected.url === source.url)) continue;
				group.sources.push({ title: markedClip(source.title, 120), url: source.url });
				if (!available()) group.sources.pop();
			}
			const text = batchGroups[index].text ?? "";
			for (let limit = 1000; !group.text && text && limit > 0; limit = Math.floor(limit / 2)) {
				group.text = markedClip(text, limit);
				if (!available()) group.text = "";
			}
		};
		for (let index = 0; index < groups.length; index++) offer(index, true);
		for (let index = 0; index < groups.length; index++) offer(index, false);
		omitted += hits.length - selected.length;
		omitted += groups.reduce((total, group, index) => total + (batchGroups[index].sources?.length ?? 0) - group.sources.length, 0);
	} else {
		for (const hit of hits) {
			if (selected.includes(hit)) continue;
			selected.push(hit);
			if (!fits()) { selected.pop(); omitted++; }
		}
	}
	selected.sort((left, right) => hits.indexOf(left) - hits.indexOf(right));
	if (!groups && compact.scope === "both" && ["web", "code"].some((family) =>
		hits.some((hit) => sourceFamily(hit.source) === family) && !selected.some((hit) => sourceFamily(hit.source) === family))) {
		notices.push("Mixed coverage limited by the output budget.");
	}
	const cited = new Set([
		...selected.flatMap((hit) => hit.url ? [hit.url] : []), ...(groups ?? []).flatMap(({ sources }) => sources.map(({ url }) => url)),
	]);
	const hitUrls = new Set(hits.flatMap((hit) => hit.url ? [hit.url] : []));
	for (const source of compact.sources ?? []) {
		// A source attached to an omitted result must not bypass the result budget.
		if (cited.has(source.url) || hitUrls.has(source.url)) continue;
		sources.push({ title: markedClip(source.title, 120), url: source.url });
		if (!fits()) { sources.pop(); omitted++; } else cited.add(source.url);
	}
	if (omitted) notices.push(`${omitted} result/citation(s) omitted to fit the output budget.`);
	const clipped = selected.some((hit) => hit.preview) || prose !== result.text ||
		groups?.some(({ text }, index) => text !== (result.queryGroups?.[index].text ?? ""));
	const visible = buildDetails();
	visible.truncated = omitted > 0 || !!clipped || continuation?.storedClipped === true;
	const text = renderEvidence(prose, visible, emptyStatus);
	const clippedExcerptRows = compact.searchResults?.flatMap((hit, index) =>
		(hit.citedText?.length ?? 0) < (result.searchResults?.[index].citedText?.length ?? 0) ? [index] : []);
	const output = formatResult(text, {
		...visible,
		// Rich renderer details never become another copy of the model evidence.
		searchResults: compact.searchResults?.map(({ highlight: _highlight, previewText: _previewText, ...hit }, index) => ({
			...hit, ...(hits[index]?.ref ? { ref: hits[index].ref } : {}),
		})),
		...(clippedExcerptRows?.length ? { clippedExcerptRows } : {}),
		queryGroups: visible.queryGroups?.map((group, index) => ({ ...group, sources: batchGroups?.[index]?.sources })),
		sources: compact.sources ?? [], warnings: compact.warnings ?? [],
		requestId: compact.requestId, usage: compact.usage,
		grounded: cited.size > 0, scope: compact.scope, classifier: compact.classifier, classifierStatus: compact.classifierStatus,
		resultCount: selected.length || sources.length,
	}, limits);
	output.structuredContent = structuredEvidence(visible, text);
	return output;
}

function markedClip(text: string, limit: number): string {
	return text.length > limit ? clipText(text, limit) + CLIP_MARKER : text;
}

function normalizedText(text: string, source?: string): string {
	return isCodeSource(source) ? text.trimEnd() : text.replace(/\s+/gu, " ").trim();
}

function previewFields(text: string, totalChars: number, limit: number): { citedText: string; preview?: EvidenceHit["preview"] } {
	const shown = clipText(text, limit);
	return {
		citedText: text.length > shown.length ? shown + CLIP_MARKER : shown,
		preview: shown.length > 0 && shown.length < totalChars ? { shownChars: shown.length, totalChars } : undefined,
	};
}

function countGroupResults(hits: EvidenceHit[], index: number): number {
	return hits.filter(({ queryGroup, type }) => queryGroup === index && type !== "unparsed").length;
}

/** Preserve mixed-family coverage within each query while allocating its slots. */
function batchCandidates<T extends SearchResultDetail>(hits: T[], mixed: boolean): T[] {
	if (!mixed || !hits.length) return hits;
	const firstFamily = sourceFamily(hits[0].source);
	const other = hits.findIndex((hit) => {
		const family = sourceFamily(hit.source);
		return family !== undefined && family !== firstFamily;
	});
	if (other <= 1) return hits;
	return [hits[0], hits[other], ...hits.slice(1, other), ...hits.slice(other + 1)];
}

export function renderQueryGroupHeading(query: string, index: number, resultCount: number, previewCount: number, providers?: EvidenceProvider[]): string {
	const label = markedClip(query.replace(/\s+/gu, " "), 160);
	const count = previewCount === resultCount
		? `${resultCount} ${resultCount === 1 ? "result" : "results"}`
		: `${previewCount} of ${resultCount} results shown`;
	const via = providers?.length ? ` · ${providers.map((provider) => providerName[provider]).join(", ")}` : "";
	return `## Query ${index + 1} — ${label}\n\n${count}${via}`;
}

function renderEvidence(prose: string, {
	searchResults: hits = [], sources = [], warnings = [], resultId, storedCount, storedClipped, queryGroups: groups, providers = [],
}: WebSearchDetails, emptyStatus: string): string {
	const names = providers.map((provider) => providerName[provider]).join(", ");
	const attribution = names ? ` — ${names}` : "";
	const blocks = hits.map((hit, index) => {
		const number = hit.ref?.split(":").at(-1) ?? String(index + 1);
		const unparsed = hit.type === "unparsed";
		const label = unparsed ? "Unparsed provider reply" : markedClip(hit.title?.trim() || hit.url || `Result ${number}`, 120);
		const title = (unparsed ? "" : `${number}. `) + (hit.url ? `[${label}](${hit.url})` : label);
		const heading = hit.ref ? `${title} ${hit.ref}` : title;
		const code = isCodeSource(hit.source);
		const excerpt = code ? "```\n" + hit.citedText + "\n```" : "> " + hit.citedText;
		const hint = hit.preview ? `Preview: ${hit.preview.shownChars} of ${hit.preview.totalChars} chars` : "";
		return [heading, hit.citedText && excerpt, hint].filter(Boolean).join("\n");
	});
	const results = groups
		? groups.map((group, index) => {
			const rows = blocks.filter((_, hitIndex) => hits[hitIndex].queryGroup === index);
			const notes = [group.failed ? "Query failed." : "", group.duplicates ? `${group.duplicates} duplicate result(s) appeared earlier.` : ""];
			const heading = renderQueryGroupHeading(group.query, index, group.resultCount ?? 0, group.previewCount ?? 0, group.providers);
			return [heading, group.text, ...rows,
				...((group.sources ?? []).map((source) => `[${source.title}](${source.url})`)), ...notes].filter(Boolean).join("\n\n");
		}).join("\n\n")
		: blocks.length ? RESULTS_HEADING + attribution + "\n\n" + blocks.join("\n\n") : "";
	const citations = sources.length ? SOURCES_HEADING + (results ? "" : attribution) + "\n\n" + sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})`).join("\n") : "";
	const notes = warnings.length ? WARNINGS_HEADING + "\n\n" + warnings.map((warning) => "- " + warning).join("\n") : "";
	const savedPreviews = resultId ? hits.filter(({ ref }) => ref?.startsWith(`${resultId}:`)) : [];
	const shown = !groups && storedCount !== undefined && savedPreviews.length < storedCount
		? `${savedPreviews.length} of ${storedCount} stored results shown. ` : "";
	const refs = resultId ? `${shown}List ref ${resultId} · Read id:N` : "";
	const storage = storedClipped ? "Local storage limits clipped evidence." : "";
	const lead = emptyStatus ? emptyStatus + attribution : prose && !results && !citations && names ? `Via ${names}` : "";
	return [lead, prose && prose.trim() !== results ? prose : "", results, citations, notes, refs, storage].filter(Boolean).join("\n\n");
}

function compactResult(result: StreamResult): StreamResult {
	let excerptBudget = STRUCTURED_EXCERPT_TOTAL_CHARS;
	let metadataBudget = METADATA_TOTAL_CHARS;
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
		}
		for (const key of ["title", "query", "source", "pageAge", "status", "type"] as const) {
			const value = entry[key];
			if (typeof value === "string") {
				// Keep recognized provenance tags even if large titles consumed the
				// metadata budget: code rendering depends on these fixed-size tags.
				compact[key] = key === "source" && value.split(", ").every((tag) => SOURCE_TAGS.has(tag))
					? value : metadata(value);
			}
		}
		return compact;
	});
	const compactSource = (source: Source) => ({ title: metadata(source.title), url: source.url });
	const sources = (result.sources ?? []).map(compactSource);
	const queryGroups = result.queryGroups?.map((group) => ({ ...group, sources: group.sources?.map(compactSource) }));
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
	if (text.length < result.text.length) warnings.push(`Provider prose truncated to ${PROVIDER_TEXT_MAX_CHARS} characters; use the cited results for evidence.`);
	if (clippedMetadata) warnings.push(`Result metadata truncated to ${METADATA_MAX_CHARS} characters per field and ${METADATA_TOTAL_CHARS} in total; citation URLs are unchanged.`);
	if (clippedWarnings) warnings.push("Provider warnings truncated (100 entries, 1000 characters each, 8000 in total).");
	return { ...result, text, sources, queryGroups, searchResults, warnings, requestId, usage };
}

/** Do not split a surrogate pair when clipping a preview. */
function clipText(text: string, maxChars: number): string {
	let end = Math.min(text.length, Math.max(0, maxChars));
	if (end < text.length && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
	return text.slice(0, end);
}
