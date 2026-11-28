// Common function words; keep numbers, Unicode words, and identifier fragments.
const STOPWORDS = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our should so that the their them then there these they this to up us was we were what when where which who why will with would you your".split(" "));

export function searchTerms(query: string): string[] {
	return (query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((term) => !STOPWORDS.has(term));
}
