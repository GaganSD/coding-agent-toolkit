import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
	CLIP_MARKER,
	COVERAGE_HEADING,
	EXCERPT_MAX_CHARS,
	OUTPUT_BUDGET_CHARS,
	SearchOutputSchema,
	formatResult,
	formatWebSearchResult,
	hitRef,
} from "../src/format.ts";
import { mergeStreamResults, previewEvidence, uniqueEvidence } from "../src/providers/results.ts";

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const part = result.content[0];
	return part?.type === "text" ? (part.text ?? "") : "";
}

const resultId = "11111111-1111-1111-1111-111111111111";

test("hit refs are one-based, identical in rendered text and structured data", () => {
	const output = formatWebSearchResult({
		text: "",
		providerKind: "exa",
		searchResults: [
			{ title: "A", url: "https://a.example", citedText: "alpha" },
			{ title: "B", url: "https://b.example", citedText: "beta" },
		],
	}, undefined, { resultId, storedCount: 2, storedClipped: false });

	assert.equal(Check(SearchOutputSchema, output.structuredContent), true);
	const data = output.structuredContent as { text?: string; searchResults: Array<{ ref?: string; citedText?: string }> };
	assert.equal("text" in data, false);
	assert.deepEqual(data.searchResults.map((hit) => hit.ref), [hitRef(resultId, 0), hitRef(resultId, 1)]);
	assert.equal(data.searchResults[0].citedText, "alpha");
	assert.equal(output.details.searchResults?.[0].citedText, "alpha");
	assert.equal(output.details.searchResults?.[0].ref, hitRef(resultId, 0));
	assert.match(textOf(output), new RegExp(`1\\. \\[A\\]\\(https://a\\.example\\) ${resultId}:1`));
	assert.match(textOf(output), new RegExp(`2\\. \\[B\\]\\(https://b\\.example\\) ${resultId}:2`));
	assert.ok(textOf(output).includes(`More: search({ref: "${resultId}"})`));
});

test("budget omission keeps stored-order refs, not visible-array indexes", () => {
	const huge = `https://example.com/huge?q=${"u".repeat(OUTPUT_BUDGET_CHARS)}`;
	const output = formatWebSearchResult({
		text: "",
		providerKind: "exa",
		searchResults: [
			{ title: "Keep", url: "https://example.com/keep", citedText: "small" },
			{ title: "Huge", url: huge, citedText: "payload" },
			{ title: "After", url: "https://example.com/after", citedText: "later" },
		],
	}, undefined, { resultId, storedCount: 5, storedClipped: false });

	const rendered = textOf(output);
	const data = output.structuredContent as { searchResults: Array<{ ref?: string; url?: string }>; cursor?: string; more?: boolean };
	assert.equal(data.searchResults[0].ref, `${resultId}:1`);
	assert.equal(data.searchResults[1].ref, `${resultId}:3`);
	assert.equal(data.searchResults.length, 2);
	assert.equal(output.details.searchResults?.[1].url, huge);
	assert.match(rendered, new RegExp(`${resultId}:1`));
	assert.match(rendered, new RegExp(`${resultId}:3`));
	assert.equal(rendered.includes(huge), false);
	assert.equal(rendered.includes(`${resultId}:2`), false);
	assert.ok(rendered.length <= OUTPUT_BUDGET_CHARS);
	assert.ok(JSON.stringify(data).length <= OUTPUT_BUDGET_CHARS);
	assert.match(rendered, /omitted/);
	assert.equal(data.more, true);
	assert.equal(data.cursor, undefined, "search listings use refs, not passage cursors");
	assert.match(rendered, /search\(\{ref: "/);
});

test("ordinary model text drops coverage boilerplate and keeps material clipping", () => {
	const output = formatWebSearchResult({
		text: "",
		providerKind: "exa",
		scope: "web",
		jevStatus: "disabled",
		providers: ["exa"],
		skipped: ["parallel skipped: not available."],
		searchResults: [{ title: "Doc", url: "https://example.com", citedText: "word ".repeat(200) }],
		warnings: ["Result excerpts truncated for 1 hit(s): citedText is a preview."],
	});
	const rendered = textOf(output);
	assert.equal(rendered.includes(COVERAGE_HEADING), false);
	assert.equal(rendered.includes("jev: disabled"), false);
	assert.equal(rendered.includes("consulted:"), false);
	assert.equal(rendered.includes("scope: web"), false);
	assert.match(rendered, /excerpts truncated/);
	assert.match(rendered, new RegExp(CLIP_MARKER));
});

test("structured listing includes useful bounded evidence once; errors keep text", () => {
	const listing = formatWebSearchResult({
		text: "summary",
		providerKind: "exa",
		searchResults: [{ title: "Doc", url: "https://example.com", citedText: "x".repeat(800) }],
	});
	const listed = listing.structuredContent as { text?: string; searchResults: Array<{ citedText?: string; url?: string }> };
	assert.equal(Check(SearchOutputSchema, listing.structuredContent), true);
	assert.equal("text" in listed, false);
	assert.equal(listed.searchResults[0].citedText, "x".repeat(EXCERPT_MAX_CHARS) + CLIP_MARKER);
	assert.equal(listed.searchResults[0].url, "https://example.com");
	assert.equal(listing.details.searchResults?.[0].citedText?.length, 800);

	const failure = formatResult("web_search failed (timeout): boom", {
		resultCount: 0, grounded: false, sources: [], searchResults: [],
		error: { code: "timeout", message: "web_search failed (timeout): boom" },
	});
	assert.equal(Check(SearchOutputSchema, failure.structuredContent), true);
	assert.equal((failure.structuredContent as { text: string }).text, textOf(failure));
});

test("code excerpts keep newlines and do not split surrogate pairs", () => {
	const citedText = `function x() {\n  return "😀";\n}\n${"tail".repeat(200)}`;
	const output = formatWebSearchResult({
		text: "",
		providerKind: "github",
		searchResults: [{ title: "Code", url: "https://example.com/code", source: "github", citedText }],
	});
	const rendered = textOf(output);
	assert.match(rendered, /```\nfunction x\(\) \{\n {2}return "😀";/);
	assert.match(rendered, new RegExp(`${CLIP_MARKER}\n\`\`\``));
	const clipped = formatWebSearchResult({
		text: "",
		providerKind: "exa",
		searchResults: [{ citedText: `${"x".repeat(EXCERPT_MAX_CHARS - 1)}😀tail` }],
	});
	assert.equal(clipped.details.searchResults?.[0].citedText?.endsWith("😀"), false);
	assert.doesNotMatch(textOf(clipped), /\uD800|\uDFFF/u);
});

test("previewEvidence reserves both families and stamps stored indexes when it omits", () => {
	const hits = [
		...Array.from({ length: 5 }, (_, index) => ({ title: `W${index}`, url: `https://w.example/${index}`, source: "exa", citedText: `web ${index}`, ref: `stored:${index + 1}` })),
		...Array.from({ length: 3 }, (_, index) => ({ title: `C${index}`, url: `https://c.example/${index}`, source: "grep", citedText: `code ${index}`, ref: `stored:${index + 6}` })),
	];
	const preview = previewEvidence({ text: "", providerKind: "exa", searchResults: hits }, 3, [], true);
	assert.equal(preview.searchResults?.length, 3);
	assert.ok(preview.searchResults?.some((hit) => hit.source === "exa"));
	assert.ok(preview.searchResults?.some((hit) => hit.source === "grep"));
	assert.equal(preview.searchResults?.find((hit) => hit.source === "grep")?.ref, "stored:6");
	assert.match(preview.warnings?.join(" ") ?? "", /5 additional/);
	assert.match(preview.warnings?.join(" ") ?? "", /search\(\{ref\}\)/);

	const unique = uniqueEvidence({
		text: "",
		providerKind: "exa",
		searchResults: [
			{ url: "https://example.com", citedText: "same", type: "search", source: "exa" },
			{ url: "https://example.com", citedText: "same", type: "search", source: "parallel" },
			{ url: "https://example.com", citedText: "other", type: "search", source: "exa" },
		],
	});
	assert.equal(unique.searchResults?.length, 2);
	assert.equal(unique.searchResults?.[0].source, "exa, parallel");
});

test("mergeStreamResults drops exact duplicate provider prose", () => {
	const merged = mergeStreamResults([
		{ kind: "exa", result: { text: "same prose", providerKind: "exa", searchResults: [{ url: "https://a.example" }] } },
		{ kind: "parallel", result: { text: "same prose", providerKind: "parallel", searchResults: [{ url: "https://b.example" }] } },
	]);
	assert.equal(merged.text, "same prose");
	assert.equal(merged.searchResults?.length, 2);
});

test("an oversized first URL cannot bypass either output budget", () => {
	const giant = `https://example.com/${"x".repeat(20_000)}`;
	const output = formatWebSearchResult({ text: "", providerKind: "exa",
		searchResults: [{ url: giant, citedText: "oversized" }, { url: "https://example.com/ok", citedText: "useful" }],
		sources: [{ title: "duplicate citation", url: giant }],
	}, undefined, { resultId: "stored", storedCount: 2, storedClipped: false });
	assert.ok(textOf(output).length <= OUTPUT_BUDGET_CHARS);
	assert.ok(JSON.stringify(output.structuredContent).length <= OUTPUT_BUDGET_CHARS);
	assert.ok(!textOf(output).includes(giant.slice(0, 200)), "never emit a partial citation URL");
	assert.ok(textOf(output).includes("stored:2"));
	assert.match(textOf(output), /omitted/);
	assert.ok(JSON.stringify(output.structuredContent).includes("useful"));
});

test("oversized standalone sources are omitted whole, never sliced mid-URL", () => {
	const url = `https://example.com/${"z".repeat(9000)}`;
	const output = formatWebSearchResult({ text: "", providerKind: "exa", sources: [{ title: "long", url }] });
	assert.ok(!textOf(output).includes("https://example.com/"));
	assert.match(textOf(output), /omitted/);
	assert.ok(textOf(output).length <= OUTPUT_BUDGET_CHARS);
});

test("URL citations stay complete when titles and prose consume the budget", () => {
	const url = `https://example.com/path?q=${"a".repeat(1200)}`;
	const output = formatWebSearchResult({
		text: "z".repeat(10_000),
		providerKind: "exa",
		searchResults: [{ title: "t".repeat(2000), url, citedText: "evidence" }],
		sources: [{ title: "t".repeat(2000), url }],
	});
	assert.equal(output.details.searchResults?.[0].url, url);
	assert.match(textOf(output), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(textOf(output).length <= OUTPUT_BUDGET_CHARS);
	assert.ok(JSON.stringify(output.structuredContent).length <= OUTPUT_BUDGET_CHARS);
});
