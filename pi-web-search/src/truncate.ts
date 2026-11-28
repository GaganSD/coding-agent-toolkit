export const DEFAULT_MAX_LINES = 2000;

/** Preserve Pi's whole-line truncation semantics in the standalone server. */
export function truncateHead(text: string, { maxLines = DEFAULT_MAX_LINES, maxBytes = 50 * 1024 } = {}) {
	const lines = text.length ? text.split("\n") : [];
	if (text.endsWith("\n")) lines.pop();
	if (lines.length <= maxLines && Buffer.byteLength(text) <= maxBytes) return { content: text, truncated: false };

	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines.slice(0, maxLines)) {
		bytes += Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
		if (bytes > maxBytes) break;
		kept.push(line);
	}
	return { content: kept.join("\n"), truncated: true };
}
