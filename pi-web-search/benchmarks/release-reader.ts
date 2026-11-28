import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { pinnedRequestOptions, type PageTransport } from "../src/read/http.ts";
import { evidenceFor, type Fixture, type Replay } from "./replay.ts";
import { auditCitations } from "./corpus.ts";
import type { Result } from "./corpus.ts";
import type { SearchInput } from "../src/search.ts";

type Call = (input: SearchInput, transport?: PageTransport) => Promise<Result>;

const publicAddress = { address: "1.1.1.1", family: 4 };
const readerOrigin = "https://reader.example.org";
const repoUrl = "https://github.com/public-example/replay";
const githubApi = "https://api.github.com/repos/public-example/replay";
const recordText = "A stored fixture paragraph contains enough words for the local article extraction method. It includes an introduction, background information, and reproducible observations from a synthetic source.";
const pdfText = "Synthetic release PDF includes text from a page.";
const prText = "The example change updates initialization.";
const issueText = "The example issue documents observed behavior.";

function pdfBytes(text: string): string {
	const stream = `BT /F1 12 Tf 20 80 Td (${text}) Tj ET\n`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Contents 5 0 R /MediaBox [0 0 350 120] /Resources << /Font << /F1 4 0 R >> >> >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const offset = Buffer.byteLength(pdf);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return String(offset).padStart(10, "0") + " 00000 n \n";
	});
	const startxref = Buffer.byteLength(pdf);
	return pdf + `xref\n0 6\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${startxref}\n%%EOF\n`;
}

const reply = (content: string, type: string, status = 200, headers: IncomingHttpHeaders = {}) => ({
	status, headers: { "content-type": type, ...headers }, body: Readable.from([Buffer.from(content)]),
});

export async function measureLocalReading(call: Call, replay: Replay, mode: string) {
	let citations = 0;
	const sample: [string, string, string[], string][] = [
		[`${readerOrigin}/article`, recordText, [`${readerOrigin}/article`], "local"],
		[`${readerOrigin}/doc.md`, "# Reference\n\nReference body.", [`${readerOrigin}/doc.md`], "local"],
		[`${readerOrigin}/report.pdf`, pdfText, [`${readerOrigin}/report.pdf`], "pdf"],
		[`${repoUrl}/blob/main/example.txt`, "Public source code fixture.", ["https://raw.githubusercontent.com/public-example/replay/main/example.txt"], "github"],
		[`${repoUrl}/pull/1`, `# Example change\n\nPull request #1 (closed)\n\n${prText}`, [githubApi, githubApi + "/pulls/1"], "github"],
		[`${repoUrl}/issues/2`, `# Example issue\n\nIssue #2 (open)\n\n${issueText}`, [githubApi, githubApi + "/issues/2"], "github"],
	];
	for (const [url, text, expected, source] of sample) {
		const transport: PageTransport = {
			resolve: async () => [publicAddress],
			connect: async (target, address) => {
				assert.equal(target.href, expected.shift(), "Local reading made an unlisted request");
				assert.deepEqual(address, publicAddress);
				switch (target.pathname) {
					case "/article": return reply(`<!doctype html><html><head><title>Fixture</title></head><body><article><p>${recordText}</p></article></body></html>`, "text/html");
					case "/doc.md": return reply(text, "text/markdown");
					case "/report.pdf": return reply(pdfBytes(text), "application/pdf");
					case "/public-example/replay/main/example.txt": return reply(text, "text/plain");
					case "/repos/public-example/replay": return reply(JSON.stringify({ private: false, full_name: "public-example/replay" }), "application/json");
					case "/repos/public-example/replay/pulls/1": return reply(JSON.stringify({ html_url: url, title: "Example change", state: "closed", body: prText }), "application/json");
					case "/repos/public-example/replay/issues/2": return reply(JSON.stringify({ html_url: url, title: "Example issue", state: "open", body: issueText }), "application/json");
					default: assert.fail("Unexpected direct reader route");
				}
			},
		};
		replay.use([]);
		const result = await call({ urls: [url] }, transport);
		replay.assertClean();
		assert.equal(result.isError, false, `${mode}: local ${source} reader failed: ${url}`);
		assert.deepEqual(expected, []);
		assert.equal(replay.attempts.length, 0, "Local success leaked a request to a remote provider");
		const fixture: Fixture = { transport: "jina", evidence: [{ title: "Fixture", url, text }] };
		citations += auditCitations(result, [fixture], `${mode}: local ${source}`).hits;
		assert.equal((result.structuredContent as Result["details"]).searchResults?.[0]?.source, source);
	}
	return { directReads: sample.length, citations };
}

export async function measureAddressSafety(call: Call, replay: Replay, mode: string) {
	const blockedAddresses = [
		{ range: "loopback", address: "127.0.0.1", family: 4 },
		{ range: "private", address: "10.0.0.1", family: 4 },
		{ range: "link-local", address: "169.254.0.1", family: 4 },
		{ range: "CGNAT", address: "100.64.0.1", family: 4 },
		{ range: "metadata", address: "169.254.169.254", family: 4 },
		{ range: "IPv6 ULA", address: "fd00::1", family: 6 },
	];
	let blocked = 0;
	let attemptedConnections = 0;
	for (const candidate of blockedAddresses) {
		replay.use([]);
		const result = await call({ urls: [`${readerOrigin}/address-${blocked}`] }, {
			resolve: async () => [candidate],
			connect: async () => { attemptedConnections++; return reply("", "text/plain", 500); },
		});
		replay.assertClean();
		assert.equal(result.isError, true, `${mode}: ${candidate.range} was not rejected`);
		assert.match(result.details.error?.message ?? "", /non-public network address/u);
		blocked++;
	}
	assert.equal(attemptedConnections, 0, "Rejected address established a connection");

	replay.use([]);
	let privateRedirectConnects = 0;
	const redirect = await call({ urls: [`${readerOrigin}/cross-origin-redirect`] }, {
		resolve: async (host) => host === "reader.example.org" ? [publicAddress] : [blockedAddresses[1]],
		connect: async () => {
			privateRedirectConnects++;
			return reply("", "text/plain", 302, { location: "https://blocked.example.org/redirected" });
		},
	});
	replay.assertClean();
	assert.equal(redirect.isError, true);
	assert.match(redirect.details.error?.message ?? "", /non-public network address/u);
	assert.equal(privateRedirectConnects, 1, "Redirect to a private destination established a connection");
	blocked++;

	let firstConnections = 0;
	let lookups = 0;
	replay.use([]);
	const redirected = await call({ urls: [`${readerOrigin}/redirect`] }, {
		resolve: async () => ++lookups === 1 ? [publicAddress] : [blockedAddresses[0]],
		connect: async (_url, addr, headers, signal) => {
			firstConnections++;
			assert.deepEqual(addr, publicAddress);
			const options = pinnedRequestOptions(addr, headers, signal);
			assert.ok(options.lookup);
			options.lookup?.("fixture.example.org", {}, (error, address) => {
				assert.equal(error, null);
				assert.equal(address, publicAddress.address);
			});
			return reply("", "text/plain", 302, { location: "/redirected" });
		},
	});
	replay.assertClean();
	assert.equal(redirected.isError, true);
	assert.match(redirected.details.error?.message ?? "", /non-public network address/u);
	assert.equal(lookups, 2, "Redirect was not revalidated");
	assert.equal(firstConnections, 1, "Rebound redirect established a connection");
	blocked++;

	const pageUrl = `${readerOrigin}/fallback-eligible`;
	const jina: Fixture = { transport: "jina", target: pageUrl, evidence: evidenceFor("release-jina", 0, "html", "jina", pageUrl) };
	replay.use([jina]);
	const delegated = await call({ urls: [pageUrl] }, {
		resolve: async () => [publicAddress],
		connect: async () => reply("", "text/plain", 503),
	});
	replay.assertClean();
	assert.equal(delegated.isError, false, "An eligible public failure did not fall back");
	assert.equal(replay.attempts.length, 1, "An eligible public failure should use one Jina request");
	assert.equal(auditCitations(delegated, [jina], `${mode}: Jina fallback`).hits, 1);
	return { blockedAddresses: blocked, redirectRevalidated: true, pinnedLookup: true, jinaFallbackCases: 1 };
}
