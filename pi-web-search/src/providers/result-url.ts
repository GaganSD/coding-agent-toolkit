export function publicResultUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return value;
	} catch {
		return undefined;
	}
}
