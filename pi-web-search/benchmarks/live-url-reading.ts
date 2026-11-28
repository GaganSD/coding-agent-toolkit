import { applyConfig } from "../src/providers/config.ts";
import { readUrls } from "../src/read/index.ts";

const corpus = {
	docs: [
		"https://nodejs.org/api/fs.html",
		"https://docs.python.org/3/library/pathlib.html",
		"https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
		"https://developer.mozilla.org/en-US/docs/Web/API/AbortController",
		"https://docs.rust-lang.org/book/ch04-00-understanding-ownership.html",
		"https://go.dev/doc/effective_go",
		"https://doc.rust-lang.org/std/collections/struct.HashMap.html",
		"https://www.postgresql.org/docs/current/queries-with.html",
	],
	articles: [
		"https://go.dev/blog/context",
		"https://go.dev/blog/defer-panic-and-recover",
		"https://jvns.ca/blog/2021/12/15/mess-with-dns/",
		"https://jvns.ca/blog/2023/05/03/why-is-dns-still-hard-to-learn/",
		"https://www.joelonsoftware.com/2000/08/09/the-joel-test-12-steps-to-better-code/",
		"https://web.dev/articles/abortable-fetch",
		"https://hacks.mozilla.org/2017/02/a-crash-course-in-just-in-time-jit-compilers/",
		"https://react.dev/blog/2024/12/05/react-19",
	],
	pdfs: [
		"https://arxiv.org/pdf/1706.03762",
		"https://arxiv.org/pdf/1810.04805",
		"https://arxiv.org/pdf/2005.14165",
		"https://arxiv.org/pdf/2103.00020",
		"https://www.rfc-editor.org/rfc/rfc9110.pdf",
		"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
	],
	github: [
		"https://github.com/nodejs/node",
		"https://github.com/nodejs/node/tree/main/doc",
		"https://github.com/nodejs/node/blob/main/README.md",
		"https://github.com/microsoft/TypeScript",
		"https://github.com/microsoft/TypeScript/issues/202",
		"https://github.com/microsoft/TypeScript/pull/40336",
		"https://github.com/mozilla/readability",
		"https://github.com/mozilla/readability/blob/main/README.md",
	],
};

if (!process.argv.includes("--live")) {
	process.stderr.write("Run with --live to make outbound requests to the listed public URLs and enable the configured Jina fallback.\n");
	process.exitCode = 2;
} else {
	const settings = applyConfig("live-url-fixture", { fetch: { jinaFallback: true } });
	const rows: { group: string; url: string; source?: string; elapsedMs: number; error?: string }[] = [];
	for (const [group, urls] of Object.entries(corpus)) {
		for (const url of urls) {
			const start = performance.now();
			try {
				const result = await readUrls({ query: "", urls: [url], fetchOnly: true, settings });
				rows.push({ group, url, source: result.searchResults?.[0]?.source, elapsedMs: Math.round(performance.now() - start) });
			} catch (error) {
				rows.push({ group, url, error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - start) });
			}
		}
	}
	const locallyRead = rows.filter((row) => row.source && row.source !== "jina").length;
	const jinaRead = rows.filter((row) => row.source === "jina").length;
	process.stdout.write(JSON.stringify({
		recordedAt: new Date().toISOString(),
		attempted: rows.length,
		locallyRead,
		jinaRead,
		failed: rows.length - locallyRead - jinaRead,
		locallyReadShare: locallyRead / rows.length,
		jinaReadShare: jinaRead / rows.length,
		rows,
	}, null, 2) + "\n");
}
