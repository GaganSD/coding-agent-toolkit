/**
 * Terminal-control escaping for UI dialogs and log display.
 *
 * Display-only: stored rules, actions and logs always keep their original
 * bytes. Escaping happens exclusively at the render boundary so terminal
 * control sequences, bidi overrides and other invisible characters cannot
 * forge what the operator sees.
 */

const NAMED_ESCAPES: ReadonlyMap<number, string> = new Map([
	[0x07, "\\a"],
	[0x08, "\\b"],
	[0x09, "\\t"],
	[0x0b, "\\v"],
	[0x0c, "\\f"],
	[0x0d, "\\r"],
	[0x1b, "\\e"],
	[0x7f, "\\x7f"],
]);

/** Bidi / directional override code points that can disguise displayed text. */
const BIDI_CONTROLS: ReadonlySet<number> = new Set([
	0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

export interface EscapeOptions {
	/** Keep literal newlines (default: false, newlines become \n). */
	multiline?: boolean;
}

function escapeCodePoint(cp: number): string {
	const named = NAMED_ESCAPES.get(cp);
	if (named !== undefined) return named;
	return `\\u${cp.toString(16).padStart(4, "0")}`;
}

/**
 * Escape terminal control characters in text destined for the terminal.
 * Newlines are escaped unless `multiline` is set; every other C0/C1 control,
 * ESC, DEL and bidi overrides are always escaped.
 */
export function escapeTerminal(text: string, options: EscapeOptions = {}): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (ch === "\n") {
			out += options.multiline ? "\n" : "\\n";
			continue;
		}
		if (cp < 0x20 || (cp >= 0x80 && cp <= 0x9f) || cp === 0x7f || BIDI_CONTROLS.has(cp)) {
			out += escapeCodePoint(cp);
			continue;
		}
		out += ch;
	}
	return out;
}

/** Escape and collapse to a single display line. */
export function escapeOneLine(text: string, maxLength = 200): string {
	const escaped = escapeTerminal(text);
	if (escaped.length <= maxLength) return escaped;
	return `${escaped.slice(0, maxLength)}…`;
}
