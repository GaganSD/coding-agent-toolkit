import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { rmSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierRegistry } from "../native-classifier.ts";
import { clearRetrievalCache } from "../../../src/providers/reuse.ts";
import { search as executeSearch } from "../../../src/search.ts";
import { assertHosts, auditCitations, directText, type Search } from "./assertions.ts";
import { evidenceFor, excerpts, faults, routes, type Fault, type Fixture, type Replay, type Transport } from "./replay.ts";

const providers = ["exa", "exa-rest", "parallel", "brave", "grep", "sourcegraph", "github"] as const;
const mcp = new Set<Transport>(["exa", "parallel", "grep"]);
const credentialEnv = { "exa-rest": "EXA_API_KEY", brave: "BRAVE_API_KEY", github: "GITHUB_TOKEN", parallel: "PARALLEL_API_KEY" } as const;
const fakeKey = "SENTINEL_OFFLINE_CREDENTIAL_FOR_REDACTION_ONLY";

const provider = (transport: Transport) => transport === "exa-rest" ? "exa" : transport;
const family = (transport: Transport) => ["grep", "sourcegraph", "github"].includes(transport) ? "code" : "web";
const fallbackFor = (transport: Transport): Transport => family(transport) === "code"
	? transport === "grep" ? "sourcegraph" : "grep"
	: transport === "exa" || transport === "exa-rest" ? "parallel" : "exa";

function setCredentials(...transports: Transport[]): void {
	for (const env of Object.values(credentialEnv)) delete process.env[env];
	for (const transport of transports) {
		if (transport in credentialEnv) process.env[credentialEnv[transport as keyof typeof credentialEnv]] = fakeKey;
	}
}

function fixture(transport: Transport, query: string, fault?: Fault): Fixture {
	return { transport, query, evidence: evidenceFor(`${transport}-test`, 0, family(transport) === "code" ? "code" : "fact", transport), fault };
}

export function percentile(values: number[], quantile: number): number {
	assert.ok(values.length);
	const sorted = [...values].sort((a, b) => a - b);
	return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(2));
}

export async function reliability(replay: Replay, search: Search, configPath: string) {
	const timeoutMs = 1000;
	const deadlines: number[] = [];
	for (const transport of providers) {
		const next = fallbackFor(transport);
		const scope = family(transport);
		setCredentials(transport, next);
		writeFileSync(configPath, JSON.stringify({ [scope]: { provider: provider(transport), fallback: [provider(next)] }, research: { enabled: true }, timeoutMs }));
		for (const fault of faults) {
			if (fault.mcpOnly && !mcp.has(transport)) continue;
			for (const effort of ["fast", "thorough"] as const) {
				// The real operation deadline is checked separately below. Within
				// thorough fan-out it can stop both the fast and slow sibling.
				if (fault.id === "slow-body") continue;
				const query = `offline ${transport} ${fault.id} ${effort}`;
				const primary = fixture(transport, query, fault);
				const secondary = fixture(next, query);
				const recoversSession = transport === "parallel" && fault.id === "mcp-expiration";
				if (recoversSession) primary.once = true;
				clearRetrievalCache();
				replay.use([primary, secondary]);
				const start = performance.now();
				const result = await search({ query, scope, effort });
				const elapsed = performance.now() - start;
				replay.assertClean();
				assertHosts(replay.attempts, [primary, secondary], query);
				deadlines.push(elapsed);
				if (recoversSession) {
					assert.equal(replay.attempts.filter(({ host, rpc }) => host === new URL(routes.parallel).host && rpc === "initialize").length, 2, query);
					assert.equal(result.isError, false, query);
					continue;
				}
				// Parallel 0.4.0 intentionally exposes these HTTP/pipeline failures
				// as non-retryable. Sourcegraph parses an SSE error body instead of JSON.
				const retryable = transport !== "parallel" && (fault.retryable || transport === "sourcegraph" && fault.id === "malformed-json");
				if (effort === "fast" && !retryable) {
					assert.ok(result.isError && result.details.error?.retryable === false, `${query}: unexpected failure contract: ${directText(result)}`);
					continue;
				}
				assert.equal(result.isError, false, `${query}: fallback lost evidence: ${directText(result)}`);
				const actual = result.details.searchResults ?? [];
				assert.ok(secondary.evidence.every(({ url }) => actual.some((hit) => hit.url === url)), `${query}: healthy results were lost`);
				assert.ok(result.details.warnings?.some((warning) => warning.startsWith(`${provider(transport)} failed (`)), `${query}: missing provider failure warning`);
			}
		}
	}
	const deadlineFault = faults.find(({ id }) => id === "slow-body")!;
	for (const transport of providers) {
		// Thorough includes a healthy sibling. The operation deadline is
		// shared and remains fatal even if that sibling completed early.
		setCredentials(transport);
		const scope = family(transport);
		writeFileSync(configPath, JSON.stringify({ [scope]: { provider: provider(transport), fallback: [] }, research: { enabled: true }, timeoutMs }));
		for (const effort of ["fast", "thorough"] as const) {
			const query = `offline deadline ${transport} ${effort}`;
			const active = fixture(transport, query, deadlineFault);
			replay.use(effort === "fast" ? [active] : [active, fixture(fallbackFor(transport), query)]);
			const start = performance.now();
			const timedOut = await search({ query, scope, effort });
			const elapsed = performance.now() - start;
			// An MCP session sends a best-effort DELETE after a deadline.
			// Keep that cleanup in the originating case's egress ledger.
			await delay(10);
			replay.assertClean();
			assert.equal(timedOut.details.error?.code, "timeout", query);
			assert.ok(elapsed >= timeoutMs * 0.9, `${query}: did not exercise a slow body`);
			deadlines.push(elapsed);
		}
	}

	const deadlineP99Ms = percentile(deadlines, 0.99);
	assert.ok(deadlineP99Ms <= timeoutMs + 250, `p99 ${deadlineP99Ms} exceeded deadline + 250 ms`);

	setCredentials("exa-rest");
	writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: ["parallel"] }, timeoutMs }));
	const controller = new AbortController();
	let abortedAt = 0;
	let attemptsAtAbort = 0;
	const aborted = {
		...fixture("exa-rest", "abort request", deadlineFault),
		onRequest: () => {
			abortedAt = performance.now();
			attemptsAtAbort = replay.attempts.length;
			controller.abort();
		},
	};
	replay.use([aborted, fixture("parallel", "abort request")]);
	const result = await search({ query: "abort request" }, controller.signal);
	const abortMs = Number((performance.now() - abortedAt).toFixed(2));
	await delay(25);
	replay.assertClean();
	assert.equal(result.details.error?.code, "aborted");
	assert.ok(abortedAt > 0 && abortMs <= 100, `Abort took ${abortMs} ms`);
	assert.equal(replay.attempts.length - attemptsAtAbort, 0, "Aborted REST search attempted more requests");
	setCredentials();

}

export async function safety(replay: Replay, search: Search, configPath: string, context: ExtensionContext) {
	writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: [] } }));
	setCredentials("exa-rest");
	for (const transport of ["exa-rest", "brave", "github", "parallel"] as const) {
		const scope = family(transport);
		setCredentials(transport);
		writeFileSync(configPath, JSON.stringify({ [scope]: { provider: provider(transport), fallback: [] } }));
		const query = `echo credential sample ${transport}`;
		const target = fixture(transport, query);
		// Use only an in-process synthetic credential. Provider error handling
		// must scrub it before content, details or progress are exposed.
		target.onRequest = () => { throw new TypeError(`Synthetic network failure echoing ${fakeKey}`); };
		replay.use([target]);
		const result = await search({ query, scope });
		replay.assertClean();
		assert.equal(result.isError, true);
		assert.equal(JSON.stringify(result).includes(fakeKey), false, `${transport} leaked a key`);
	}
	setCredentials();
	rmSync(configPath, { force: true });
	replay.use([]);
	for (const url of ["file:///tmp/readme.txt", "ftp://example.org/public", "https://user:placeholder@example.org/path"]) {
		const result = await search({ urls: [url] });
		assert.equal(result.isError, true);
	}
	replay.assertClean();
	assert.equal(replay.attempts.length, 0);

	const pageUrl = "https://example.org/untrusted-fixture";
	const page: Fixture = { transport: "jina", target: pageUrl, evidence: evidenceFor("injection-example", 0, "injection", "jina", pageUrl) };
	replay.use([page]);
	const without = await search({ urls: [pageUrl] });
	replay.assertClean();
	auditCitations(without, [page], "injection off");
	assert.ok(directText(without).includes(excerpts.injection));
	const query = "synthetic untrusted provider passage";
	const web: Fixture = { ...fixture("exa", query), evidence: page.evidence };
	const parallel: Fixture = { ...fixture("parallel", query), evidence: page.evidence };
	// A deterministic verdict tests the wrapper routing and suppression. The
	// result measures pass-through, never a model's attack susceptibility.
	const verdict = { type: "choice" as const, choice: "prompt_injection", probabilities: { prompt_injection: 0.99 }, confidence: 0.99 };
	const classifierContext = { ...context, modelRegistry: classifierRegistry({ answers: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`c${index}_safety`, verdict])) }) };
	writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: [] }, research: { enabled: true },
		classifier: { enabled: true, provider: "typesafe", model: "jev-latest" } }));
	replay.use([web, parallel]);
	const withClassifier = await executeSearch("fixture-classifier", { query, effort: "thorough" }, undefined, undefined, classifierContext);
	replay.assertClean();
	assert.equal(withClassifier.details.classifierStatus, "ran");
	assert.ok(withClassifier.details.classifier?.suppressed);
	assert.ok(!directText(withClassifier).includes(excerpts.injection));
}
