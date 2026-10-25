import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { SearchOutputSchema, type WebSearchDetails } from "../src/format.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EVIDENCE_MAX_LIFETIME_MS, EVIDENCE_TTL_MS, EvidenceStore, evidenceStore } from "../src/evidence.ts";
import { REF_LIST_PAGE, REF_OUTPUT_CHARS, REF_PASSAGE_CHARS, searchReadRef } from "../src/search_read.ts";
import type { StreamResult } from "../src/providers/types.ts";

const detailsOf = (output: { details: WebSearchDetails; structuredContent?: unknown }) => {
	assert.equal(Check(SearchOutputSchema, output.structuredContent), true, "continuation satisfies the public output schema");
	return output.details;
};
const textOf = (output: { content: { type: string; text?: string }[] }) => output.content.map((part) => part.text ?? "").join("\n");
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const structuredOf = (output: { structuredContent?: unknown }) => JSON.stringify(output.structuredContent);

const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } }) as ExtensionContext;
const docs = (count: number): StreamResult => ({
	text: "", providerKind: "exa",
	searchResults: Array.from({ length: count }, (_, i) => ({ url: `https://example.com/doc-${i + 1}`, title: `Doc ${i + 1}`, citedText: `evidence ${i + 1}` })),
});

test("bare ref lists bounded results with stable one-based refs and cursor pagination", () => {
	const store = new EvidenceStore();
	const handle = store.put("s", docs(12))!;
	const first = searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store);
	assert.equal(first.isError, false);
	const d1 = detailsOf(first);
	assert.equal(d1.ref, handle.resultId);
	assert.equal(d1.resultId, handle.resultId);
	assert.equal(d1.storedCount, 12);
	assert.equal(d1.resultCount, REF_LIST_PAGE);
	assert.equal(d1.more, true);
	assert.ok(d1.cursor, "first page issues a cursor");
	assert.deepEqual(d1.searchResults!.map((hit) => hit.ref), Array.from({ length: REF_LIST_PAGE }, (_, i) => `${handle.resultId}:${i + 1}`));
	assert.equal(d1.searchResults![0].citedText, undefined, "listings stay bounded: no excerpts");
	assert.match(textOf(first), new RegExp(`${handle.resultId}:1 `));
	// P1: the cursor must be copyable from the model-visible text, not details-only.
	assert.match(textOf(first), new RegExp(escaped(d1.cursor!)), "cursor appears in direct content");
	assert.ok(textOf(first).includes(`search({ref: "${handle.resultId}", cursor: "${d1.cursor}"})`), "copyable continuation instruction");
	const second = searchReadRef({ ref: handle.resultId, cursor: d1.cursor! }, ctx("s"), undefined, store);
	const d2 = detailsOf(second);
	assert.equal(second.isError, false);
	assert.deepEqual(d2.searchResults!.map((hit) => hit.ref), [`${handle.resultId}:11`, `${handle.resultId}:12`]);
	assert.equal(d2.more, false);
	assert.equal(d2.cursor, undefined, "last page issues no cursor");
	assert.ok(!textOf(second).includes("Continue:"), "no dangling continuation on the last page");
	const replay = searchReadRef({ ref: handle.resultId, cursor: d1.cursor! }, ctx("s"), undefined, store);
	assert.deepEqual(detailsOf(replay).searchResults!.map((hit) => hit.ref), d2.searchResults!.map((hit) => hit.ref), "cursors are deterministic");
	const relisted = detailsOf(searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store));
	assert.equal(relisted.cursor, d1.cursor, "identical ref+offset reuses the same cursor token");
});

test("hit ref reads a bounded passage and pages it with a ref-bound cursor", () => {
	const store = new EvidenceStore();
	const long = "alpha " + "β".repeat(5000);
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [
		{ url: "https://example.com/a", title: "A", citedText: "short one" },
		{ url: "https://example.com/b", title: "B", citedText: long },
	] })!;
	const one = searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store);
	assert.equal(detailsOf(one).ref, `${handle.resultId}:1`);
	assert.equal(detailsOf(one).searchResults![0].citedText, "short one");
	assert.equal(detailsOf(one).searchResults![0].ref, `${handle.resultId}:1`);
	assert.equal(detailsOf(one).more, false);
	const two = searchReadRef({ ref: `${handle.resultId}:2` }, ctx("s"), undefined, store);
	const d = detailsOf(two);
	assert.equal(d.passage!.index, 2, "ref indexes are one-based");
	assert.equal(d.passage!.offset, 0);
	assert.equal(d.passage!.totalChars, long.length);
	assert.equal(d.more, true);
	assert.match(textOf(two), new RegExp(escaped(d.cursor!)), "passage cursor appears in direct content");
	assert.ok(textOf(two).includes(`search({ref: "${handle.resultId}:2", cursor: "${d.cursor}"})`), "copyable passage continuation");
	const firstPage = d.searchResults![0].citedText!;
	assert.equal(firstPage.length, REF_PASSAGE_CHARS);
	const cont = searchReadRef({ ref: `${handle.resultId}:2`, cursor: d.cursor! }, ctx("s"), undefined, store);
	const dCont = detailsOf(cont);
	assert.equal(dCont.passage!.offset, firstPage.length);
	assert.equal(dCont.more, false);
	assert.equal(dCont.cursor, undefined);
	assert.equal(firstPage + dCont.searchResults![0].citedText!, long, "pages reassemble the stored excerpt exactly");
	assert.match(textOf(cont), /not guaranteed to be a full page/);
});

test("refs are session-owned and give no cross-session signal", () => {
	const store = new EvidenceStore();
	const handle = store.put("alice", docs(2))!;
	for (const ref of [handle.resultId, `${handle.resultId}:1`]) {
		const denied = searchReadRef({ ref }, ctx("bob"), undefined, store);
		assert.equal(denied.isError, true);
		assert.match(textOf(denied), /unavailable/);
	}
	const noSession = { sessionManager: { getSessionId: () => undefined } } as unknown as ExtensionContext;
	assert.equal(searchReadRef({ ref: handle.resultId }, noSession, undefined, store).isError, true);
});

test("forged, tampered, and cross-ref cursors are rejected", () => {
	const store = new EvidenceStore();
	const result = docs(12);
	result.searchResults![0].citedText = "start " + "x".repeat(9000);
	const handle = store.put("s", result)!;
	const listed = detailsOf(searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store));
	const good = listed.cursor!;
	assert.match(good, /^[A-Za-z0-9_-]{11}$/, "cursors are short opaque tokens");
	assert.equal(searchReadRef({ ref: handle.resultId, cursor: "not-a-cursor" }, ctx("s"), undefined, store).isError, true);
	assert.equal(searchReadRef({ ref: handle.resultId, cursor: `${good}x` }, ctx("s"), undefined, store).isError, true);
	assert.equal(searchReadRef({ ref: handle.resultId, cursor: `${good}=` }, ctx("s"), undefined, store).isError, true, "base64 padding junk is rejected by the token shape");
	assert.equal(searchReadRef({ ref: handle.resultId, cursor: "!!!!!!!!!!!" }, ctx("s"), undefined, store).isError, true, "malformed tokens are rejected");
	const tampered = good.replace(good[4], /[A-Z]/.test(good[4]) ? good[4].toLowerCase() : "A");
	assert.notEqual(tampered, good);
	assert.equal(searchReadRef({ ref: handle.resultId, cursor: tampered }, ctx("s"), undefined, store).isError, true, "unknown tokens never resolve");
	const crossRef = searchReadRef({ ref: `${handle.resultId}:1`, cursor: good }, ctx("s"), undefined, store);
	assert.equal(crossRef.isError, true, "list cursor is bound to the bare ref");
	const passage = detailsOf(searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store));
	assert.ok(passage.cursor);
	assert.equal(searchReadRef({ ref: handle.resultId, cursor: passage.cursor! }, ctx("s"), undefined, store).isError, true, "passage cursor is bound to the hit ref");
	assert.equal(searchReadRef({ ref: `${handle.resultId}:2`, cursor: passage.cursor! }, ctx("s"), undefined, store).isError, true, "cursor cannot move between hit refs");
});

test("find is literal and case-insensitive; a miss reports not found in stored excerpt", () => {
	const store = new EvidenceStore();
	const citedText = "Intro .* literal\nNEEDLE deep evidence " + "tail ".repeat(2000);
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [{ url: "https://example.com/f", citedText }] })!;
	const found = searchReadRef({ ref: `${handle.resultId}:1`, find: "needle" }, ctx("s"), undefined, store);
	assert.equal(found.isError, false);
	assert.equal(detailsOf(found).passage!.matches, 1);
	assert.match(detailsOf(found).searchResults![0].citedText!, /NEEDLE deep evidence/);
	assert.match(textOf(found), /1 match\(es\)/, "match count is model-visible");
	assert.ok(detailsOf(found).cursor, "find positions the window; the cursor continues reading");
	const many = searchReadRef({ ref: `${handle.resultId}:1`, find: "tail" }, ctx("s"), undefined, store);
	assert.equal(detailsOf(many).passage!.matches, 2000);
	assert.match(textOf(many), /2000 match\(es\)/, "repeated matches are counted in the text");
	const literal = searchReadRef({ ref: `${handle.resultId}:1`, find: ".*" }, ctx("s"), undefined, store);
	assert.equal(detailsOf(literal).passage!.matches, 1);
	assert.match(detailsOf(literal).searchResults![0].citedText!, /\.\* literal/);
	const miss = searchReadRef({ ref: `${handle.resultId}:1`, find: "absent phrase" }, ctx("s"), undefined, store);
	assert.equal(miss.isError, true);
	assert.match(textOf(miss), /not found in stored excerpt/);
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1`, find: "needle", cursor: detailsOf(found).cursor! }, ctx("s"), undefined, store).isError, true, "find + cursor is rejected");
	assert.equal(searchReadRef({ ref: handle.resultId, find: "needle" }, ctx("s"), undefined, store).isError, true, "find needs a hit ref");
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1`, find: " " }, ctx("s"), undefined, store).isError, true, "blank find is rejected");
});

test("passage paging never splits surrogate pairs and pages reassemble the excerpt", () => {
	const store = new EvidenceStore();
	const citedText = "a" + "😀".repeat(2500) + "z".repeat(100);
	const handle = store.put("u", { text: "", providerKind: "exa", searchResults: [{ url: "https://example.com/u", citedText }] })!;
	const parts: string[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 5; i++) {
		const out = searchReadRef(cursor === undefined ? { ref: `${handle.resultId}:1` } : { ref: `${handle.resultId}:1`, cursor }, ctx("u"), undefined, store);
		assert.equal(out.isError, false);
		const d = detailsOf(out);
		const piece = d.searchResults![0].citedText!;
		assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(piece), false, "no lone surrogates at page edges");
		parts.push(piece);
		if (!d.more) break;
		cursor = d.cursor;
	}
	assert.ok(parts.length > 1, "excerpt spans multiple pages");
	assert.equal(parts.join(""), citedText);
	const found = searchReadRef({ ref: `${handle.resultId}:1`, find: "😀z😀" }, ctx("u"), undefined, store);
	assert.equal(found.isError, true, "find matches literal sequences only");
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1`, find: "😀😀" }, ctx("u"), undefined, store).isError, false);
});

test("evidence reads never touch the network", () => {
	const store = new EvidenceStore();
	const handle = store.put("s", docs(3))!;
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => { calls++; throw new Error("network disabled"); }) as typeof fetch;
	try {
		assert.equal(searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store).isError, false);
		assert.equal(searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store).isError, false);
		assert.equal(searchReadRef({ ref: `${handle.resultId}:1`, find: "evidence" }, ctx("s"), undefined, store).isError, false);
		assert.equal(calls, 0);
	} finally { globalThis.fetch = originalFetch; }
});

test("reads return isolated copies; caller mutation cannot corrupt stored evidence", () => {
	const store = new EvidenceStore();
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [{ url: "https://example.com/m", title: "M", citedText: "original excerpt" }] })!;
	const first = searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store);
	detailsOf(first).searchResults![0].citedText = "mutated";
	const again = searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store);
	assert.equal(detailsOf(again).searchResults![0].citedText, "original excerpt");
	const list = searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store);
	detailsOf(list).searchResults![0].title = "mutated";
	assert.equal(detailsOf(searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store)).searchResults![0].title, "M");
});

test("successful reads refresh idle expiry but never beyond the maximum lifetime", () => {
	let now = 0;
	const store = new EvidenceStore(() => now);
	const handle = store.put("s", docs(1))!;
	const read = () => searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store);
	assert.equal(read().isError, false);
	// Stay inside the idle window the whole way: each read must succeed, which
	// proves the previous one refreshed expiry (the initial expiry was one TTL).
	for (now = EVIDENCE_TTL_MS - 1; now < EVIDENCE_MAX_LIFETIME_MS; now += EVIDENCE_TTL_MS - 1) {
		assert.equal(read().isError, false, `read at ${now}`);
	}
	now = EVIDENCE_MAX_LIFETIME_MS;
	assert.equal(read().isError, true, "maximum lifetime caps idle refresh");

	now = 0;
	const plain = store.put("s", docs(1))!;
	now = EVIDENCE_TTL_MS - 1;
	searchReadRef({ ref: plain.resultId }, ctx("other"), undefined, store);
	now = EVIDENCE_TTL_MS;
	assert.equal(searchReadRef({ ref: plain.resultId }, ctx("s"), undefined, store).isError, true, "failed reads do not refresh expiry");
});

test("a failed find or cursor does not refresh idle expiry", () => {
	let now = 0;
	const store = new EvidenceStore(() => now);
	const handle = store.put("s", docs(1))!;
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store).isError, false);
	now = EVIDENCE_TTL_MS - 10;
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1`, find: "absent phrase" }, ctx("s"), undefined, store).isError, true);
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1`, cursor: "AAAAAAAAAAA" }, ctx("s"), undefined, store).isError, true);
	now = EVIDENCE_TTL_MS + 1;
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store).isError, true, "failed reads leave the original expiry in place");

	now = 0;
	const refreshed = new EvidenceStore(() => now);
	const kept = refreshed.put("s", docs(1))!;
	now = EVIDENCE_TTL_MS - 10;
	assert.equal(searchReadRef({ ref: `${kept.resultId}:1`, find: "evidence" }, ctx("s"), undefined, refreshed).isError, false, "control: a successful find refreshes");
	now = EVIDENCE_TTL_MS + 1;
	assert.equal(searchReadRef({ ref: `${kept.resultId}:1` }, ctx("s"), undefined, refreshed).isError, false, "successful find slid expiry forward");
});

test("eviction follows recency: a recently read ref survives new insertions", () => {
	const store = new EvidenceStore();
	const a = store.put("s", docs(1))!;
	for (let i = 0; i < 30; i++) store.put("s", docs(1));
	assert.equal(searchReadRef({ ref: `${a.resultId}:1` }, ctx("s"), undefined, store).isError, false);
	// 33 entries in a 32-entry store: exactly one eviction, and it must not be the entry just read.
	for (let i = 0; i < 2; i++) store.put("s", docs(1));
	assert.equal(searchReadRef({ ref: `${a.resultId}:1` }, ctx("s"), undefined, store).isError, false, "recently read entry is not the eviction victim");
});

test("cursor table is bounded, deterministic, and pruned with its evidence", () => {
	const store = new EvidenceStore();
	const handle = store.put("s", docs(1))!;
	const tokens: string[] = [];
	for (let offset = 0; offset < 300; offset++) tokens.push(store.sealCursor(`${handle.resultId}:1`, offset));
	assert.equal(new Set(tokens).size, 300, "distinct ref+offset pairs mint distinct tokens");
	assert.equal(store.openCursor(`${handle.resultId}:1`, tokens[0]), undefined, "oldest cursors are evicted past the table bound");
	assert.equal(store.openCursor(`${handle.resultId}:1`, tokens[299]), 299, "recent cursors stay live");
	assert.equal(store.sealCursor(`${handle.resultId}:1`, 299), tokens[299], "re-sealing a live ref+offset reuses its token");
	assert.equal(store.openCursor(`${handle.resultId}:2`, tokens[299]), undefined, "tokens are bound to their exact ref");
	store.clear("s");
	assert.equal(store.openCursor(`${handle.resultId}:1`, tokens[299]), undefined, "cursors are pruned with their evidence");
	const afterReload = new EvidenceStore();
	afterReload.put("s", docs(1));
	assert.equal(afterReload.openCursor(`${handle.resultId}:1`, tokens[100]), undefined, "cursors never transfer across stores (reload)");
});

test("citation URLs are kept whole or omitted with an explicit marker, never cut", () => {
	const store = new EvidenceStore();
	const giantUrl = `https://example.com/${"g".repeat(9020)}`;
	const mediumUrl = `https://example.com/${"m".repeat(1880)}`; // 1900 chars: fits every budget
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [
		{ url: giantUrl, title: "Giant", citedText: "giant url evidence" },
		{ url: mediumUrl, title: "Medium", citedText: "medium url evidence" },
		{ url: "https://short.example/x", title: "Short", citedText: "short url evidence" },
	] })!;
	const list = searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store);
	const listText = textOf(list);
	assert.ok(listText.length <= REF_OUTPUT_CHARS, `listing text stays in budget (${listText.length})`);
	assert.ok(structuredOf(list).length <= REF_OUTPUT_CHARS, `listing JSON stays in budget (${structuredOf(list).length})`);
	assert.match(listText, /\[citation URL omitted: exceeds output budget\]/, "oversized URLs are explicitly omitted");
	assert.ok(!listText.includes("g".repeat(201)), "no fabricated URL prefix reaches the model");
	assert.match(listText, new RegExp(`${handle.resultId}:1 `), "the hit ref survives URL omission");
	assert.ok(listText.includes(mediumUrl), "URLs that fit are retained complete");
	assert.ok(listText.includes("https://short.example/x"));
	const ld = detailsOf(list);
	assert.equal(ld.searchResults![0].url, undefined, "giant URL is omitted from structured data, not shortened");
	assert.equal(ld.searchResults![1].url, mediumUrl, "URLs inside the cumulative budget are kept complete");
	assert.equal(ld.searchResults![2].url, "https://short.example/x");
	assert.ok(ld.warnings?.some((warning) => warning.includes("omitted")), "omissions are announced");
	assert.ok(!structuredOf(list).includes(giantUrl), "structured data cannot bypass the budget");

	const read = searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store);
	const readText = textOf(read);
	assert.ok(readText.length <= REF_OUTPUT_CHARS);
	assert.ok(structuredOf(read).length <= REF_OUTPUT_CHARS);
	assert.ok(readText.indexOf("giant url evidence") < readText.indexOf("[citation URL omitted"), "passage leads; the citation line follows it");
	assert.equal(detailsOf(read).searchResults![0].url, undefined);
	assert.ok(detailsOf(read).warnings?.some((warning) => warning.includes("omitted")));
	assert.ok(!structuredOf(read).includes(giantUrl));

	const kept = searchReadRef({ ref: `${handle.resultId}:2` }, ctx("s"), undefined, store);
	assert.ok(textOf(kept).includes(mediumUrl), "a URL that fits the read response is retained complete");
	assert.equal(detailsOf(kept).searchResults![0].url, mediumUrl);

	const cumulative = new EvidenceStore();
	const wide = (seed: string, length: number) => `https://example.com/${seed}${"u".repeat(length)}`;
	const wideHandle = cumulative.put("s", { text: "", providerKind: "exa", searchResults: [
		{ url: wide("a", 4900), title: "A", citedText: "a" }, // 4921 chars: consumes nearly the whole 5000 budget
		{ url: wide("b", 400), title: "B", citedText: "b" }, // over the remainder: omitted whole
		{ url: "https://short.example/c", title: "C", citedText: "c" }, // fits the remainder: kept
	] })!;
	const wideList = searchReadRef({ ref: wideHandle.resultId }, ctx("s"), undefined, cumulative);
	const wideText = textOf(wideList);
	assert.ok(wideText.includes(wide("a", 4900)), "first complete URL fits the cumulative budget");
	assert.ok(!wideText.includes(wide("b", 400)), "the URL over the cumulative budget is omitted whole");
	assert.ok(wideText.includes("https://short.example/c"), "a later URL that fits the remainder is still kept");
	assert.ok(wideText.length <= REF_OUTPUT_CHARS);
	assert.ok(structuredOf(wideList).length <= REF_OUTPUT_CHARS);
});

test("JSON-escaping inflation shrinks the window; the cursor continues from the emitted passage", () => {
	const store = new EvidenceStore();
	// Control chars escape to \u00XX (6x), quotes and backslashes to 2x: a raw
	// 4000-char window would far exceed the structured budget if measured naively.
	const tricky = "\u0001\"\\\n".repeat(3000);
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [{ url: "https://example.com/t", citedText: tricky }] })!;
	const parts: string[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 20; i++) {
		const out = searchReadRef(cursor === undefined ? { ref: `${handle.resultId}:1` } : { ref: `${handle.resultId}:1`, cursor }, ctx("s"), undefined, store);
		assert.equal(out.isError, false);
		const d = detailsOf(out);
		const piece = d.searchResults![0].citedText!;
		assert.ok(piece.length > 0, "pages always advance");
		assert.ok(structuredOf(out).length <= REF_OUTPUT_CHARS, `structured fits with escaping (${structuredOf(out).length})`);
		assert.ok(textOf(out).length <= REF_OUTPUT_CHARS, "direct content fits");
		assert.ok(textOf(out).includes(piece), "direct content and structured citedText carry the identical passage");
		if (d.more) assert.ok(textOf(out).includes(`search({ref: "${handle.resultId}:1", cursor: "${d.cursor}"})`), "copyable continuation matches the emitted page");
		parts.push(piece);
		if (!d.more) break;
		cursor = d.cursor;
	}
	assert.ok(parts.length > 1, "escaping inflation forces multiple pages");
	assert.ok(parts.some((part) => part.length < REF_PASSAGE_CHARS), "the window shrank below the raw cap");
	assert.equal(parts.join(""), tricky, "cursor-derived pages reassemble the excerpt with no skipped offsets");
});

test("cancellation and malformed refs fail closed", () => {
	const store = new EvidenceStore();
	const handle = store.put("s", docs(1))!;
	const controller = new AbortController();
	controller.abort();
	const aborted = searchReadRef({ ref: handle.resultId }, ctx("s"), controller.signal, store);
	assert.equal(aborted.isError, true);
	assert.match(textOf(aborted), /aborted/);
	for (const bad of ["", `${handle.resultId}:0`, `${handle.resultId}:-1`, "!!", `${handle.resultId}:1234`, `${handle.resultId}:1:2`]) {
		assert.equal(searchReadRef({ ref: bad }, ctx("s"), undefined, store).isError, true, `malformed ref: ${JSON.stringify(bad)}`);
	}
	const ghost = searchReadRef({ ref: "unknownhandle1" }, ctx("s"), undefined, store);
	assert.equal(ghost.isError, true);
	assert.match(textOf(ghost), /unavailable/);
	assert.equal(searchReadRef({ ref: `${handle.resultId}:2` }, ctx("s"), undefined, store).isError, true, "one-based index past the stored count");
});

test("local clipping and unknown full-page completeness are marked", () => {
	const store = new EvidenceStore();
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [{ url: "https://example.com/c", citedText: "y".repeat(300_000) }] })!;
	assert.equal(handle.storedClipped, true);
	const list = searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store);
	assert.equal(detailsOf(list).truncated, true);
	assert.equal(detailsOf(list).storedClipped, true);
	assert.match(textOf(list), /Local storage limits clipped evidence/);
	assert.match(textOf(list), /not guaranteed full pages/);
	const page = searchReadRef({ ref: `${handle.resultId}:1` }, ctx("s"), undefined, store);
	assert.equal(detailsOf(page).truncated, true);
	assert.match(textOf(page), /Local storage limits clipped evidence/);
	assert.match(textOf(page), /not guaranteed to be a full page/);
});

test("newline-heavy evidence stays below host line limits without skipping text", () => {
	const store = new EvidenceStore();
	const original = "\n".repeat(8000) + "final evidence";
	const handle = store.put("s", { text: "", providerKind: "exa", searchResults: [{ citedText: original }] })!;
	let cursor: string | undefined;
	const parts: string[] = [];
	for (let page = 0; page < 20; page++) {
		const out = searchReadRef({ ref: `${handle.resultId}:1`, ...(cursor ? { cursor } : {}) }, ctx("s"), undefined, store);
		const details = detailsOf(out);
		const piece = details.searchResults![0].citedText!;
		parts.push(piece);
		assert.ok(textOf(out).includes(piece));
		assert.doesNotMatch(textOf(out), /\[Truncated\]/);
		if (!details.more) break;
		assert.ok(details.cursor);
		assert.ok(textOf(out).includes(details.cursor));
		cursor = details.cursor;
	}
	assert.equal(parts.join(""), original);
});

test("control-heavy listing titles cannot exhaust the structured budget", () => {
	const store = new EvidenceStore();
	const result = docs(10);
	for (const hit of result.searchResults!) hit.title = "\u0001\n".repeat(500);
	const handle = store.put("s", result)!;
	const out = searchReadRef({ ref: handle.resultId }, ctx("s"), undefined, store);
	detailsOf(out);
	assert.ok(textOf(out).length <= REF_OUTPUT_CHARS);
	assert.ok(structuredOf(out).length <= REF_OUTPUT_CHARS);
});

test("default store is the shared session evidence store", () => {
	const handle = evidenceStore.put("shared", docs(1))!;
	const out = searchReadRef({ ref: `${handle.resultId}:1` }, ctx("shared"));
	assert.equal(out.isError, false);
	assert.match(detailsOf(out).searchResults![0].citedText!, /evidence 1/);
	evidenceStore.clear("shared");
	assert.equal(searchReadRef({ ref: `${handle.resultId}:1` }, ctx("shared")).isError, true, "cleared sessions lose their handles");
});
