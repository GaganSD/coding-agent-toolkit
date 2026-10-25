import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EvidenceStore, evidenceOwner, evidenceStore, sliceText } from "./evidence.ts";
import { formatResult, type WebSearchDetails } from "./format.ts";
import { providerError } from "./providers/types.ts";
import { formatSearchError } from "./utils.ts";

/** Stored hits listed per ref page; bounded so a listing stays small. */
export const REF_LIST_PAGE = 10;
/** Fixed passage window for ref reads; continuation cursors page the rest. */
export const REF_PASSAGE_CHARS = 4000;
const REF_MAX_INDEX = 256;

export interface SearchReadRefInput { ref: string; find?: string; cursor?: string }

/** Argument/ref/cursor validation failures are caller errors, not provider failures. */
const argError = (message: string) => providerError("parse_error", message);

/** Each consumption path (direct content and structured JSON) stays under this; consumers are mutually exclusive. */
export const REF_OUTPUT_CHARS = 8000;
/** Cumulative budget for complete citation URLs in one listing page. */
const REF_LIST_URL_CHARS = 5000;
/** Per-citation cap on a passage read; longer URLs are omitted whole with an explicit notice. */
const REF_URL_CHARS = 2000;
/** Title caps: 100 in listing text, 200 in structured data. */
const REF_DETAILS_TITLE_CHARS = 200;
/** Headroom for the cursor field added after the structured fit; the token is fixed-length. */
const REF_CURSOR_FIELD_CHARS = 32;
const STRUCTURED_FIT_CHARS = REF_OUTPUT_CHARS - REF_CURSOR_FIELD_CHARS;
const URL_OMITTED = "[citation URL omitted: exceeds output budget]";
const displayTitle = (title: string, limit: number) => sliceText(title.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim(), limit);
/** A citation URL is kept whole or dropped entirely: a cut URL is a wrong address. */
const keptUrl = (url: string | undefined, allowance: number): string | undefined =>
	url !== undefined && url.length <= allowance && !/[\r\n\u0000]/u.test(url) ? url : undefined;
/** JSON escaping can multiply payload length (quotes, backslashes, control chars): always measure, never assume. */
const structuredSize = (details: WebSearchDetails) => JSON.stringify({ status: "success", ...details }).length;

/** find is a literal substring search, never a regex; /iu keeps offsets in the original string. */
function literalPattern(find: string): RegExp {
	return new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

function unavailableError() {
	return argError("Evidence is unavailable: expired, evicted, reloaded, or from another session. Retrieve the URL again.");
}

function cursorError() {
	return argError("Cursor is invalid, forged, or bound to a different ref. Read the ref again without cursor.");
}

/** Copyable continuation the model can paste verbatim; the cursor also lives in details for scripts. */
function continuationInstruction(ref: string, cursor: string): string {
	return `Continue: search({ref: "${ref}", cursor: "${cursor}"}).`;
}

function parseRef(raw: string): { id: string; index?: number } | undefined {
	const match = /^([A-Za-z0-9_-]{1,64})(?::([0-9]{1,3}))?$/.exec(raw.trim());
	if (!match) return undefined;
	if (match[2] === undefined) return { id: match[1] };
	const index = Number(match[2]);
	return index >= 1 && index <= REF_MAX_INDEX ? { id: match[1], index } : undefined;
}

/**
 * Stable-ref continuation for unified search: a bare resultId lists bounded
 * results with `${resultId}:${oneBasedIndex}` refs and cursor pagination; a hit
 * ref reads one stored passage. Local only: no network, session-owned, idle
 * expiry with a maximum lifetime.
 */
export function searchReadRef(
	params: SearchReadRefInput,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	store: EvidenceStore = evidenceStore,
) {
	try {
		if (signal?.aborted) throw providerError("aborted", "Reading evidence was aborted.");
		if (params.find !== undefined && params.cursor !== undefined) throw argError("find cannot combine with cursor: search a stored excerpt with find, or page it with cursor.");
		const parsed = parseRef(params.ref);
		if (!parsed) throw argError("Invalid evidence ref: expected resultId or resultId:index with a one-based index.");
		const owner = evidenceOwner(ctx);
		if (!owner) throw unavailableError();
		if (parsed.index === undefined) {
			if (params.find !== undefined) throw argError("find reads one stored excerpt: use a hit ref (resultId:index) from the listing.");
			return listRefEvidence(store, owner, parsed.id, params.cursor);
		}
		return readRefEvidence(store, owner, parsed.id, parsed.index, params);
	} catch (error) { return formatSearchError("search", error); }
}

function listRefEvidence(store: EvidenceStore, owner: string, id: string, cursorParam?: string) {
	if (!store.has(owner, id)) throw unavailableError();
	let offset = 0;
	if (cursorParam !== undefined) {
		const fromCursor = store.openCursor(id, cursorParam);
		if (fromCursor === undefined) throw cursorError();
		offset = fromCursor;
	}
	const listing = store.list(owner, id, offset, REF_LIST_PAGE);
	if (!listing) throw unavailableError();
	const shown = listing.hits;
	const nextOffset = offset + shown.length;
	const more = nextOffset < listing.total;
	// Complete URLs only, in order, until the cumulative budget is spent; the
	// same kept/omitted decision drives both the listing text and structured data.
	let urlBudget = REF_LIST_URL_CHARS;
	const kept = shown.map((hit) => {
		const url = keptUrl(hit.url, urlBudget);
		if (url !== undefined) urlBudget -= url.length;
		return url;
	});
	const buildDetails = (): WebSearchDetails => {
		let omittedUrls = 0;
		return {
			ref: id, resultId: id,
			storedCount: listing.total, storedClipped: listing.clipped,
			resultCount: shown.length, grounded: shown.some((hit) => !!hit.url),
			searchResults: shown.map((hit, i) => {
				if (hit.url !== undefined && kept[i] === undefined) omittedUrls++;
				return {
					...(hit.title === undefined ? {} : { title: displayTitle(hit.title, REF_DETAILS_TITLE_CHARS) }),
					...(kept[i] === undefined ? {} : { url: kept[i] }),
					ref: `${id}:${hit.index}`,
				};
			}),
			...(omittedUrls ? { warnings: [`${omittedUrls} citation URL(s) omitted: exceeds output budget; URLs are kept whole or not at all, and the hit ref still reads the evidence.`] } : {}),
			more, truncated: listing.clipped,
		};
	};
	let details = buildDetails();
	// Exact JSON fit: escaping can inflate measured size, so drop the longest
	// kept URL (whole, never cut) until the structured candidate fits.
	while (structuredSize(details) > STRUCTURED_FIT_CHARS) {
		let longest = -1;
		for (let i = 0; i < kept.length; i++) {
			if (kept[i] !== undefined && (longest === -1 || kept[i]!.length > kept[longest]!.length)) longest = i;
		}
		if (longest === -1) break; // defensive: bounded base fields alone cannot exceed the budget
		kept[longest] = undefined;
		details = buildDetails();
	}
	const cursor = more ? store.sealCursor(id, nextOffset) : undefined;
	if (cursor !== undefined) details = { ...details, cursor };
	const range = shown.length ? `${offset + 1}-${offset + shown.length}` : "none";
	const header = `Stored evidence ${id}: ${listing.total} result(s), showing ${range}.`;
	const caveat = `Memory-only evidence: idle expiry, lost on reload. Provider-returned; not guaranteed full pages.${listing.clipped ? " Local storage limits clipped evidence." : ""}`;
	const continuation = cursor === undefined ? "" : ` ${continuationInstruction(id, cursor)}`;
	const lines = shown.map((hit, i) => {
		const title = displayTitle(hit.title || "(no title)", 100);
		const url = kept[i] ?? (hit.url === undefined ? "(no URL)" : URL_OMITTED);
		return `${id}:${hit.index} ${title} — ${url} (${hit.chars} chars stored)`;
	});
	const text = `${header}\n\n${lines.join("\n")}\n\n${caveat}${continuation}`;
	store.refresh(owner, id);
	return formatResult(text, details);
}

function readRefEvidence(store: EvidenceStore, owner: string, id: string, index: number, params: { find?: string; cursor?: string }) {
	const fullRef = `${id}:${index}`;
	// Authenticate owner/existence before any cursor check: failures must not
	// refresh idle expiry, and a foreign cursor must not distinguish ref states.
	const read = store.readHit(owner, id, index - 1);
	if (read.status === "unavailable") throw unavailableError();
	if (read.status === "no-hit") throw argError(`No stored result at index ${index}; ${id} stores ${read.total} result(s). List ${id} for valid refs.`);
	const hit = read.hit;
	const text = hit.citedText ?? "";
	let offset = 0;
	let matches: number | undefined;
	if (params.find !== undefined) {
		if (!params.find.trim()) throw argError("find must be nonblank.");
		const pattern = literalPattern(params.find);
		matches = 0;
		let first = 0;
		for (const match of text.matchAll(pattern)) { if (matches === 0) first = match.index; matches++; }
		if (matches === 0) throw argError(`${JSON.stringify(params.find)} not found in stored excerpt. Stored text is provider-returned evidence, not a full page.`);
		const contextChars = Math.min(200, Math.floor(Math.max(0, REF_PASSAGE_CHARS - params.find.length) / 2));
		offset = Math.max(0, first - contextChars);
	} else if (params.cursor !== undefined) {
		const cursorOffset = store.openCursor(fullRef, params.cursor);
		if (cursorOffset === undefined || cursorOffset > text.length) throw cursorError();
		offset = cursorOffset;
	}
	if (offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] ?? "")) offset--;
	// Stay below the host line cap too, so truncation cannot hide the next cursor.
	const window = sliceText(text.slice(offset), REF_PASSAGE_CHARS).split("\n").slice(0, 1000).join("\n");
	let detailUrl = keptUrl(hit.url, REF_URL_CHARS);
	const buildDetails = (passage: string): WebSearchDetails => {
		const nextOffset = offset + passage.length;
		const more = nextOffset < text.length;
		return {
			ref: fullRef, resultId: id,
			storedCount: read.total, storedClipped: read.clipped,
			provider: read.provider, resultCount: 1, grounded: !!hit.url,
			searchResults: [{
				...(hit.title === undefined ? {} : { title: displayTitle(hit.title, REF_DETAILS_TITLE_CHARS) }),
				...(detailUrl === undefined ? {} : { url: detailUrl }),
				citedText: passage, ref: fullRef,
			}],
			passage: { index, offset, totalChars: text.length, ...(matches === undefined ? {} : { matches }), ...(more ? { nextOffset } : {}) },
			...(hit.url !== undefined && detailUrl === undefined ? { warnings: ["Citation URL omitted: exceeds output budget; URLs are kept whole or not at all."] } : {}),
			more, truncated: read.clipped,
		};
	};
	// Exact fit: JSON escaping multiplies payload length (control chars 6x), so
	// measure. Base size excludes the passage payload; the largest prefix whose
	// quoted form fits becomes the page, and the cursor derives from it, so no
	// stored text is skipped and direct content matches structured citedText.
	let detailSize = structuredSize(buildDetails(""));
	if (detailSize - 2 > STRUCTURED_FIT_CHARS - 8 && detailUrl !== undefined) {
		detailUrl = undefined; // escaping pathology in the URL itself: omit it whole
		detailSize = structuredSize(buildDetails(""));
	}
	const quoted = (value: string) => JSON.stringify(value).length;
	const budget = STRUCTURED_FIT_CHARS - (detailSize - 2);
	let passage = window;
	if (quoted(window) > budget) {
		let lo = 1;
		let hi = window.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (quoted(sliceText(window, mid)) <= budget) lo = mid; else hi = mid - 1;
		}
		passage = sliceText(window, lo);
	}
	let details = buildDetails(passage);
	const nextOffset = offset + passage.length;
	const more = nextOffset < text.length;
	const cursor = more ? store.sealCursor(fullRef, nextOffset) : undefined;
	if (cursor !== undefined) details = { ...details, cursor };
	store.refresh(owner, id);
	// The passage leads so global output limits can only ever cut the citation
	// line; direct content and structured citedText carry the identical passage.
	const matchNote = matches === undefined ? "" : `${matches} match(es); `;
	const citation = hit.url === undefined ? "(no URL)" : detailUrl ?? URL_OMITTED;
	const shownText = `${passage}\n\n${matchNote}${read.clipped ? "Local storage limits clipped evidence. " : ""}Provider-returned evidence; not guaranteed to be a full page.${cursor === undefined ? "" : ` ${continuationInstruction(fullRef, cursor)}`}\n\nSource: ${citation}`;
	return formatResult(shownText, details);
}
