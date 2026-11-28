import { searchTerms } from "./search-terms.ts";

export const PREVIEW_PASSAGE_CHARS = 400;

const K1 = 1.2;
const B = 0.75;

function passages(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (text.length - start > limit) {
		const window = text.slice(start, start + limit);
		const paragraph = [...window.matchAll(/\n[ \t\r]*\n/gu)].at(-1)?.index;
		const sentence = [...window.matchAll(/[.!?。！？](?=\s)/gu)].at(-1)?.index;
		const space = [...window.matchAll(/\s/gu)].at(-1)?.index;
		let length = paragraph !== undefined && paragraph >= limit / 3 ? paragraph
			: sentence !== undefined && sentence >= limit / 3 ? sentence + 1
			: space !== undefined && space >= limit / 3 ? space : limit;
		if (/[\uD800-\uDBFF]/u.test(window[length - 1])) length--;
		chunks.push(text.slice(start, start + length).trim());
		start += length;
		while (/\s/u.test(text[start] ?? "")) start++;
	}
	chunks.push(text.slice(start).trim());
	return chunks.filter(Boolean);
}

/** Select a verbatim passage, scoring its terms against the rest of this result. */
export function queryPreview(text: string, query: string, limit: number, highlight?: string): string | undefined {
	if (text.length <= limit) return undefined;
	const terms = new Set(searchTerms(query));
	if (!terms.size) return undefined;
	const chunks = passages(text, limit);
	const vector = (passage: string) => {
		const words = searchTerms(passage);
		const matches = new Map<string, number>();
		for (const term of words) {
			if (terms.has(term)) matches.set(term, (matches.get(term) ?? 0) + 1);
		}
		return { length: words.length, matches };
	};
	const vectors = chunks.map(vector);
	const average = vectors.reduce((sum, entry) => sum + entry.length, 0) / vectors.length || 1;
	const documents = new Map<string, number>();
	for (const { matches } of vectors) {
		for (const term of matches.keys()) documents.set(term, (documents.get(term) ?? 0) + 1);
	}
	const score = ({ length, matches }: ReturnType<typeof vector>) => {
		let total = 0;
		const normalization = K1 * (1 - B + B * length / average);
		for (const [term, frequency] of matches) {
			const count = documents.get(term) ?? 0;
			const weight = Math.log1p((vectors.length - count + 0.5) / (count + 0.5));
			total += weight * frequency * (K1 + 1) / (frequency + normalization);
		}
		return total;
	};
	// Retain the provider's highlight when it scores as well as our best
	// passage, provided it can be quoted verbatim from the retained evidence.
	const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
	const preferred = highlight?.trim();
	let best = preferred && preferred.length <= limit && normalized(text).includes(normalized(preferred))
		? preferred : undefined;
	let bestScore = best ? score(vector(best)) : 0;
	for (let i = 0; i < chunks.length; i++) {
		const candidateScore = score(vectors[i]);
		if (candidateScore <= bestScore) continue;
		best = chunks[i];
		bestScore = candidateScore;
	}
	return best;
}
