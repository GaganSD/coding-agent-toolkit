/** Match a whole, unquoted qualifier, leaving code literals intact. */
export function parseLibraryQuery(query: string): { query: string; library?: string } {
	const tokens = query.match(/(?:[^\s"'\x60]+|"[^"]*"|'[^']*'|\x60[^\x60]*\x60)+/gu) ?? [];
	const kept: string[] = [];
	let library: string | undefined;
	for (const token of tokens) {
		const match = /^library:(\/[\w.-]+\/[\w.-]+(?:@[\w.+-]+)?)$/iu.exec(token);
		if (match) library ??= match[1];
		else kept.push(token);
	}
	return library ? { query: kept.join(" "), library } : { query };
}
