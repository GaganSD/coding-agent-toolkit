import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfig } from "../src/providers/config.ts";
import { jinaFetch } from "../src/providers/jina.ts";
import type { SearchRequest } from "../src/providers/index.ts";
import { readUrls, type UrlReaderOptions } from "../src/read/index.ts";
import { fetchPinnedPage, MAX_BODY_BYTES, MAX_PDF_BODY_BYTES, PAGE_ACCEPT, pinnedRequestOptions, type PageTransport } from "../src/read/http.ts";
import { search } from "../src/search.ts";

const origin = "https://fixture.example";
const address = { address: "1.1.1.1", family: 4 };
const request = (urls: string[], config: Parameters<typeof applyConfig>[1] = {}): SearchRequest => ({
	query: "", urls, fetchOnly: true, settings: applyConfig("fixture", { timeoutMs: 2000, ...config }),
});
const response = (content: string | Buffer | Readable, contentType = "text/plain", status = 200, headers: IncomingHttpHeaders = {}) => ({
	status,
	headers: { "content-type": contentType, ...headers },
	body: content instanceof Readable ? content : Readable.from([Buffer.from(content)]),
});

function replay(serve: NonNullable<PageTransport["connect"]>): UrlReaderOptions & { requests: string[]; fallback: string[] } {
	const requests: string[] = [];
	const fallback: string[] = [];
	return {
		requests,
		fallback,
		transport: {
			resolve: async () => [address],
			connect: async (url, ip, headers, signal) => {
				assert.deepEqual(ip, address);
				requests.push(url.href);
				return serve(url, ip, headers, signal);
			},
		},
		githubToken: () => undefined,
		runGh: async () => undefined,
		jinaFetch: (req) => jinaFetch(req, { fetchImpl: async (url) => {
			fallback.push(url);
			const target = url.slice("https://r.jina.ai/".length);
			return Response.json({ data: { url: target, content: "Jina fixture content" } });
		} }),
	};
}

test("URL tool reads Markdown and an HTML article locally with one Accept header and no Jina", async () => {
	const markdown = "# Markdown\n\n[reference](https://links.example/a) ![image](https://images.example/a.png)\n[![image](https://images.example/wrapped.png)](https://links.example/wrapped)\n<a href='https://links.example/raw'>raw HTML link</a>\n";
	const html = `<!DOCTYPE html><html><head><title>Local article</title></head><body><article>
	<h1>Sample article</h1><p>${"These are the relevant words in a locally fetched article. ".repeat(8)}</p>
	<a href="https://links.example/b">Anchor label</a><img src="https://images.example/b.png"><script>script text</script>
	</article></body></html>`;
	const fixture = replay(async (url, _ip, headers) => {
		assert.equal(headers.Accept, PAGE_ACCEPT);
		if (url.pathname === "/markdown") return response(markdown, "text/markdown; charset=utf-8");
		assert.equal(url.pathname, "/article");
		return response(html, "text/html");
	});
	const context = { sessionManager: { getSessionId: () => "local-reading-fixture" } } as ExtensionContext;
	const result = await search("test", { urls: [`${origin}/markdown`, `${origin}/article`] }, undefined, undefined, context, {
		readUrls: async (req) => {
			const documents = await readUrls(req, fixture);
			assert.equal(documents.searchResults?.[0].citedText, "# Markdown\n\nreference \n\nraw HTML link\n");
			assert.equal(documents.searchResults?.[1].title, "Local article");
			assert.match(documents.searchResults?.[1].citedText ?? "", /# Sample article[\s\S]+Anchor label/u);
			assert.doesNotMatch(documents.searchResults?.[1].citedText ?? "", /script text|images\.example|links\.example/u);
			assert.deepEqual(documents.searchResults?.map(({ type, source }) => ({ type, source })), [
				{ type: "content", source: "local" }, { type: "content", source: "local" },
			]);
			return documents;
		},
	});
	assert.equal(result.isError, false);
	assert.deepEqual(fixture.fallback, []);
	assert.equal(result.details.urlsRead, 2);
	assert.deepEqual(result.details.attempted, ["local"]);
});

test("Structural extraction retains readable sections when Readability drops most of the page", async () => {
	const article = "Concise article text with a specific explanation and useful evidence. ".repeat(10);
	const reference = "Long API field reference visible to the user. ".repeat(35);
	const html = `<html><body><main><article><p>${article}</p></article>
		<form><label>${reference}</label></form></main></body></html>`;
	const fixture = replay(async () => response(html, "text/html"));
	const result = await readUrls(request([origin]), fixture);
	assert.match(result.searchResults?.[0].citedText ?? "", /Concise article text[\s\S]+Long API field reference/u);
	assert.deepEqual(fixture.fallback, []);
});

test("PDF magic bytes and content type both select local extraction", async () => {
	const pdf = fixturePdf("Words from the local PDF");
	const fixture = replay(async (url) => response(pdf, url.pathname === "/magic" ? "application/octet-stream" : "application/pdf"));
	const result = await readUrls(request([`${origin}/magic`, `${origin}/paper.pdf`]), fixture);
	assert.deepEqual(result.searchResults?.map(({ source, citedText }) => ({ source, citedText })), [
		{ source: "pdf", citedText: "Words from the local PDF" },
		{ source: "pdf", citedText: "Words from the local PDF" },
	]);
	assert.deepEqual(fixture.fallback, []);
});

test("A 12 MiB PDF is read through the local reader, including with a generic MIME type", async () => {
	const pdf = fixturePdf("Large PDF still readable", 12 * 1024 * 1024);
	const fixture = replay(async () => response(gzipSync(pdf, { level: 0 }), "application/octet-stream", 200, { "content-encoding": "gzip" }));
	const result = await readUrls(request([`${origin}/large-pdf`]), fixture);
	assert.equal(result.searchResults?.[0]?.source, "pdf");
	assert.equal(result.searchResults?.[0]?.citedText, "Large PDF still readable");
	assert.deepEqual(fixture.fallback, []);
});

function fixturePdf(text: string, padding = 0): string {
	const stream = `BT /F1 12 Tf 25 120 Td (${text}) Tj ET\n`;
	const entries = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = entries.map((entry, index) => {
		const offset = Buffer.byteLength(pdf);
		pdf += `${index + 1} 0 obj\n${entry}\nendobj\n`;
		return `${String(offset).padStart(10, "0")} 00000 n \n`;
	});
	if (padding) pdf += `%${" ".repeat(padding)}\n`;
	const xref = Buffer.byteLength(pdf);
	return `${pdf}xref\n0 6\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("GitHub routes blob, repository, tree, PR and issue reads without visiting Jina", async () => {
	const base = "https://github.com/versioned/fixture";
	const api = "https://api.github.com/repos/versioned/fixture";
	const raw = "https://raw.githubusercontent.com/versioned/fixture/main/readme.md";
	const publicRepository = () => response('{"private":false,"visibility":"public","full_name":"versioned/fixture"}', "application/json");
	const fixture = replay(async (url, _address, headers) => {
		switch (url.href) {
			case raw:
				assert.equal(headers.Authorization, undefined);
				return response("Raw Markdown");
			case api:
				assert.equal(headers.Authorization, "Bearer fixture-secret");
				return publicRepository();
			case `${api}/contents?ref=main`:
			case `${api}/contents`:
			case `${api}/contents/docs?ref=main`:
				assert.equal(headers.Authorization, "Bearer fixture-secret");
				return response('[{"name":"guide.md","type":"file"},{"name":"v1","type":"dir"}]', "application/json");
			case `${api}/readme`:
			case `${api}/readme/docs?ref=main`:
				assert.equal(headers.Accept, "application/vnd.github.raw+json");
				return response("[README label](https://links.example/private)");
			case `${api}/pulls/7`:
				assert.equal(headers.Authorization, undefined);
				return response(JSON.stringify({ title: "REST PR", body: "Fixes issue", state: "closed", html_url: `${base}/pull/7` }), "application/json");
			case `${api}/issues/8`:
				assert.equal(headers.Authorization, undefined);
				return response(JSON.stringify({ title: "REST issue", body: "Report", state: "open", html_url: `${base}/issues/8` }), "application/json");
			default: throw new Error(`Unreplayed request ${url.href}`);
		}
	});
	fixture.githubToken = () => "fixture-secret";
	const urls = [`${base}/blob/main/readme.md#L2`, base, `${base}/tree/main/docs`, `${base}/pull/7`, `${base}/issues/8`];
	const result = await readUrls(request(urls), fixture);
	assert.equal(result.searchResults?.length, urls.length);
	assert.deepEqual(result.searchResults?.map((hit) => hit.url), urls);
	assert.ok(result.searchResults?.every((hit) => hit.source === "github" && hit.type === "content"));
	assert.equal(result.searchResults?.[0].citedText, "Raw Markdown");
	for (const hit of [result.searchResults?.[1], result.searchResults?.[2]]) {
		assert.match(hit?.citedText ?? "", /guide\.md[\s\S]+v1\/[\s\S]+README label/u);
		assert.doesNotMatch(hit?.citedText ?? "", /links\.example/u);
	}
	assert.match(result.searchResults?.[3].citedText ?? "", /REST PR[\s\S]+Pull request #7 \(closed\)[\s\S]+Fixes issue/u);
	assert.match(result.searchResults?.[4].citedText ?? "", /REST issue[\s\S]+Issue #8 \(open\)[\s\S]+Report/u);
	assert.deepEqual(fixture.fallback, []);

	const ghFixture = replay(async (url) => {
		assert.equal(url.href, api, "the CLI path only requests public repository metadata via REST");
		return publicRepository();
	});
	const commands: string[][] = [];
	ghFixture.runGh = async (args) => {
		commands.push(args);
		return JSON.stringify({ title: "CLI fixture", state: "MERGED", body: "CLI evidence", url: args[2] });
	};
	const gh = await readUrls(request(urls.slice(3)), ghFixture);
	assert.deepEqual(commands, [
		["pr", "view", urls[3], "--json", "title,body,state,url"],
		["issue", "view", urls[4], "--json", "title,body,state,url"],
	]);
	assert.match(gh.searchResults?.[0].citedText ?? "", /CLI fixture[\s\S]+\(merged\)[\s\S]+CLI evidence/u);
	assert.deepEqual(ghFixture.requests, [api, api]);
	assert.deepEqual(ghFixture.fallback, []);
});

test("GitHub credentials cannot expose a private repository or a mismatched item", async () => {
	const base = "https://github.com/versioned/fixture";
	const api = "https://api.github.com/repos/versioned/fixture";
	const fixture = replay(async (url, _address, headers) => {
		assert.equal(url.href, api);
		assert.equal(headers.Authorization, "Bearer fixture-secret");
		return response('{"private":true,"full_name":"versioned/fixture"}', "application/json");
	});
	fixture.githubToken = () => "fixture-secret";
	fixture.runGh = async () => assert.fail("A private repository must not invoke gh");
	for (const path of ["", "/tree/main", "/pull/7", "/issues/8"]) {
		await assert.rejects(readUrls(request([base + path]), fixture), /verified public repository/u);
	}
	assert.deepEqual(fixture.fallback, []);

	const different = replay(async (url) => {
		assert.equal(url.href, api);
		return response('{"private":false,"full_name":"versioned/fixture"}', "application/json");
	});
	different.runGh = async () => JSON.stringify({ title: "Unrelated content", url: "https://github.com/other/repo/pull/7" });
	await assert.rejects(readUrls(request([`${base}/pull/7`]), different), /different issue or pull request/u);
	assert.deepEqual(different.fallback, []);
});

test("Jina fallback is URL-specific and restricted to retryable local outcomes", async () => {
	const fixture = replay(async (url) => {
		if (url.pathname === "/shell") return response("<html><body><div id=app></div><script>loadPage()</script></body></html>", "text/html");
		if (url.pathname === "/denied") return response("forbidden", "text/plain", 403);
		if (url.pathname === "/busy") return response("busy", "text/plain", 429);
		if (url.pathname === "/broken") return response("broken", "text/plain", 503);
		if (url.pathname === "/missing") return response("not found", "text/plain", 404);
		return response("local content");
	});
	const paths = ["/shell", "/ok", "/denied", "/missing", "/busy", "/broken"];
	const result = await readUrls(request(paths.map((path) => origin + path)), fixture);
	assert.deepEqual(result.searchResults?.map((hit) => hit.source), ["jina", "local", "jina", "jina", "jina"]);
	assert.deepEqual(new Set(fixture.fallback), new Set(["/shell", "/denied", "/busy", "/broken"].map((path) => "https://r.jina.ai/" + origin + path)));
	assert.match(result.warnings?.join("\n") ?? "", /URL 4: URL returned HTTP 404/u);

	fixture.fallback.length = 0;
	await assert.rejects(readUrls(request([`${origin}/denied`], { fetch: { jinaFallback: false } }), fixture),
		/HTTP 403.*Jina fallback is disabled by fetch\.jinaFallback/u);
	assert.deepEqual(fixture.fallback, []);
});

test("Reader honors the 5 MiB streamed cap and the character cap", async () => {
	const chunk = Buffer.alloc(1024 * 1024, "a");
	let chunksRead = 0;
	const fixture = replay(async (url) => {
		if (url.pathname === "/gzip") return response(gzipSync(Buffer.concat(Array(6).fill(chunk))), "text/plain", 200, { "content-encoding": "gzip" });
		return response(Readable.from((function* () {
			while (chunksRead < 10) { chunksRead++; yield chunk; }
		})()));
	});
	const result = await readUrls(request([`${origin}/large`, `${origin}/gzip`]), fixture);
	assert.ok(chunksRead < 10);
	for (const hit of result.searchResults ?? []) {
		assert.equal(hit.status, "provider_excerpt_clipped");
		assert.equal(hit.citedText?.length, 64_000);
	}
	assert.ok(result.warnings?.every((warning) => warning.includes("5 MiB")));
	assert.deepEqual(fixture.fallback, []);
});

test("Public-address validation blocks non-public literals and mixed DNS answers before opening a socket", async () => {
	const fixture = replay(async () => assert.fail("Blocked URL opened a connection"));
	fixture.transport!.resolve = async () => [address, { address: "192.168.1.9", family: 4 }];
	for (const url of [
		"http://127.1", "http://2130706433", "http://10.1.2.3", "http://100.100.100.200", "http://172.16.0.1",
		"http://192.168.0.1", "http://169.254.169.254", "http://168.63.129.16", "http://metadata.google.internal",
		"http://[::1]", "http://[fc00::1]", "http://[fe80::1]", "http://[::ffff:169.254.169.254]", "http://[64:ff9b::a9fe:a9fe]",
		"http://[2002:7f00:1::]", "http://localhost", "http://host.local", origin,
	]) {
		await assert.rejects(readUrls(request([url]), fixture), { code: "blocked_private_network", message: /blocked a non-public network address/u }, url);
	}
	assert.deepEqual(fixture.requests, []);
	assert.deepEqual(fixture.fallback, []);
});

test("Redirects revalidate each address, and the socket lookup uses only the validated address", async () => {
	const signal = new AbortController().signal;
	let lookups = 0;
	const hits: string[] = [];
	const transport: PageTransport = {
		resolve: async () => [++lookups === 1 ? address : { address: "127.0.0.1", family: 4 }],
		connect: async (url, ip, headers) => {
			hits.push(url.href);
			assert.equal(lookups, 1, "only the validation stage used DNS");
			const options = pinnedRequestOptions(ip, headers, signal);
			assert.equal(options.agent, false);
			assert.equal(options.autoSelectFamily, false);
			options.lookup?.(url.hostname, { family: 4 }, (error, validated, family) => {
				assert.ifError(error);
				assert.equal(validated, address.address);
				assert.equal(family, address.family);
			});
			return response("", "text/plain", 302, { location: "/next" });
		},
	};
	await assert.rejects(fetchPinnedPage(new URL(origin), signal, transport), { code: "blocked_private_network", message: /blocked a non-public network address/u });
	assert.deepEqual(hits, [origin + "/"]);
	assert.equal(lookups, 2, "the redirect DNS answer was validated independently");

	const fixture = replay(async () => response("", "text/plain", 302, { location: "http://169.254.169.254/metadata" }));
	await assert.rejects(readUrls(request([origin]), fixture), { code: "blocked_private_network", message: /blocked a non-public network address/u });
	assert.deepEqual(fixture.requests, [origin + "/"]);
	assert.deepEqual(fixture.fallback, []);
});

test("Redirect hop count and authorization are bounded across origins", async () => {
	const signal = new AbortController().signal;
	const headersSeen: string[] = [];
	const fixture = replay(async (url, _ip, headers) => {
		headersSeen.push(headers.Authorization ?? "");
		return response("", "text/plain", 302, { location: url.hostname === "fixture.example" ? "https://redirect.example" : "/next" });
	});
	await assert.rejects(fetchPinnedPage(new URL(origin), signal, fixture.transport, { Authorization: "Bearer fixture-secret" }), /5 redirects/u);
	assert.deepEqual(headersSeen, ["Bearer fixture-secret", "", "", "", "", ""]);
	assert.equal(fixture.requests.length, 6);
});

test("Cancellation destroys a pending body and never starts Jina", async () => {
	const controller = new AbortController();
	const body = new Readable({ read() {} });
	let started = false;
	const fixture = replay(async () => {
		started = true;
		setImmediate(() => controller.abort());
		return response(body);
	});
	await assert.rejects(readUrls({ ...request([origin]), signal: controller.signal }, fixture), { code: "aborted" });
	assert.equal(started, true);
	assert.equal(body.destroyed, true);
	assert.deepEqual(fixture.fallback, []);
});

test("A local timeout can use the remaining deadline only after address validation", async () => {
	const fixture = replay(async () => response(new Readable({ read() {} })));
	const req = request([origin]);
	req.settings.timeoutMs = 120;
	const result = await readUrls(req, fixture);
	assert.equal(result.searchResults?.[0].source, "jina");
	assert.deepEqual(fixture.fallback, ["https://r.jina.ai/" + origin + "/"]);

	fixture.fallback.length = 0;
	fixture.transport!.resolve = async () => await new Promise(() => {});
	await assert.rejects(readUrls(req, fixture), { code: "timeout" });
	assert.deepEqual(fixture.fallback, []);
});

test("An exactly 5 MiB streamed response is not marked download-clipped", async () => {
	const fixture = replay(async () => response(Buffer.alloc(MAX_BODY_BYTES, "a")));
	const page = await fetchPinnedPage(new URL(origin), new AbortController().signal, fixture.transport);
	assert.equal(page.bytes.length, MAX_BODY_BYTES);
	assert.equal(page.truncated, false);
});

test("Compressed input is clipped even when its decoded size fits the byte cap", async () => {
	const encoded = gzipSync(Buffer.alloc(MAX_BODY_BYTES, "a"), { level: 0 });
	assert.ok(encoded.length > MAX_BODY_BYTES);
	const fixture = replay(async () => response(encoded, "text/plain", 200, { "content-encoding": "gzip" }));
	const page = await fetchPinnedPage(new URL(origin), new AbortController().signal, fixture.transport);
	assert.equal(page.truncated, true);
	assert.ok(page.bytes.length > 0 && page.bytes.length < MAX_BODY_BYTES);
});

test("Decoded expansion stops at the applicable byte cap without a stream error", async () => {
	for (const [signature, limit] of [["plain text", MAX_BODY_BYTES], ["%PDF-1.4", MAX_PDF_BODY_BYTES]] as const) {
		const decoded = Buffer.alloc(limit + 1, "a");
		decoded.write(signature);
		const encoded = gzipSync(decoded);
		const input = Readable.from([encoded.subarray(0, 23), encoded.subarray(23)]);
		const fixture = replay(async () => response(input, "application/octet-stream", 200, { "content-encoding": "gzip" }));
		const page = await fetchPinnedPage(new URL(origin), new AbortController().signal, fixture.transport);
		assert.equal(page.bytes.length, limit);
		assert.equal(page.truncated, true);
	}
});
