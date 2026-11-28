import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverAndLoadExtensions, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCommand, runNpmCommand } from "../scripts/validation.ts";
import { classifierRegistry } from "../tests/fixtures/native-classifier.ts";
import { clearRetrievalCache } from "../src/providers/reuse.ts";
import { search as executeSearch } from "../src/search.ts";
import { assertHosts, auditCitations, directText, type Search } from "./corpus.ts";
import { evidenceFor, excerpts, faults, routes, type Fault, type Fixture, type Replay, type Transport } from "./replay.ts";

const providers = [
	"exa", "exa-rest", "parallel", "brave", "brave-context", "searxng", "grep", "sourcegraph", "github", "context7",
] as const;
const mcp = new Set<Transport>(["exa", "parallel", "grep"]);
const credentialEnv = {
	"exa-rest": "EXA_API_KEY", brave: "BRAVE_API_KEY", "brave-context": "BRAVE_API_KEY", github: "GITHUB_TOKEN",
	parallel: "PARALLEL_API_KEY", context7: "CONTEXT7_API_KEY",
} as const;
const fakeKey = "SENTINEL_OFFLINE_CREDENTIAL_FOR_REDACTION_ONLY";

const provider = (transport: Transport) => transport === "exa-rest" ? "exa" : transport === "brave-context" ? "brave" : transport;
const configuration = (transport: Transport) => ({
	brave: { mode: transport === "brave-context" ? "context" : "web" },
	...(transport === "searxng" ? { searxng: { url: new URL(routes.searxng).origin } } : {}),
});
const family = (transport: Transport) => ["grep", "sourcegraph", "github", "context7"].includes(transport) ? "code" : "web";
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
	let cases = 0;
	let retryableRecovered = 0;
	let partialSuccess = 0;
	let sessionRecovered = 0;
	const observedErrors: Record<string, string> = {};
	for (const transport of providers) {
		const next = fallbackFor(transport);
		const scope = family(transport);
		setCredentials(transport, next);
		writeFileSync(configPath, JSON.stringify({ ...configuration(transport), [scope]: { provider: provider(transport), fallback: [provider(next)] }, research: { enabled: true }, timeoutMs }));
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
				cases++;
				if (recoversSession) {
					assert.equal(replay.attempts.filter(({ host, rpc }) => host === new URL(routes.parallel).host && rpc === "initialize").length, 2, query);
					assert.equal(result.isError, false, query);
					sessionRecovered++;
					continue;
				}
				// Parallel 0.4.0 intentionally exposes these HTTP/pipeline failures
				// as non-retryable. Sourcegraph parses an SSE error body instead of JSON.
				const retryable = transport !== "parallel" && (fault.retryable || transport === "sourcegraph" && fault.id === "malformed-json");
				if (effort === "fast" && !retryable) {
					assert.ok(result.isError && result.details.error?.retryable === false, `${query}: unexpected failure contract: ${directText(result)}`);
					observedErrors[`${transport}/${fault.id}`] = result.details.error.code;
					continue;
				}
				assert.equal(result.isError, false, `${query}: fallback lost evidence: ${directText(result)}`);
				const actual = result.details.searchResults ?? [];
				assert.ok(secondary.evidence.every(({ url }) => actual.some((hit) => hit.url === url)), `${query}: healthy results were lost`);
				assert.ok(result.details.warnings?.some((warning) => warning.startsWith(`${provider(transport)} failed (`)), `${query}: missing provider failure warning`);
				if (effort === "fast") retryableRecovered++;
				else partialSuccess++;
			}
		}
	}
	const deadlineFault = faults.find(({ id }) => id === "slow-body")!;
	let deadlineCases = 0;
	for (const transport of providers) {
		// Thorough includes a healthy sibling. The operation deadline is
		// shared and remains fatal even if that sibling completed early.
		setCredentials(transport);
		const scope = family(transport);
		writeFileSync(configPath, JSON.stringify({ ...configuration(transport), [scope]: { provider: provider(transport), fallback: [] }, research: { enabled: true }, timeoutMs }));
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
			deadlineCases++;
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
	return { cases: cases + deadlineCases, retryableRecovered, partialSuccess, sessionRecovered,
		deadlineCases, timeoutMs, deadlineP99Ms, abortMs, outboundAfterAbort: 0, nonRetryableFastFailures: observedErrors };
}

export async function safety(replay: Replay, search: Search, configPath: string, context: ExtensionContext) {
	writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: [] } }));
	setCredentials("exa-rest");
	let credentialCases = 0;
	for (const transport of ["exa-rest", "brave", "brave-context", "github", "parallel", "context7"] as const) {
		const scope = family(transport);
		setCredentials(transport);
		writeFileSync(configPath, JSON.stringify({ ...configuration(transport), [scope]: { provider: provider(transport), fallback: [] } }));
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
		credentialCases++;
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
	const injectionWithoutClassifier = directText(without).includes(excerpts.injection);
	const query = "synthetic untrusted provider passage";
	const web: Fixture = { ...fixture("exa", query), evidence: page.evidence };
	const parallel: Fixture = { ...fixture("parallel", query), evidence: page.evidence };
	// A deterministic verdict tests the wrapper routing and suppression. The
	// result measures pass-through, never a model's attack susceptibility.
	const verdict = { type: "choice" as const, choice: "prompt_injection", probabilities: { prompt_injection: 0.99 }, confidence: 0.99 };
	const classifierContext = { ...context, modelRegistry: classifierRegistry({ answers: { c0_safety: verdict, c1_safety: verdict } }) };
	writeFileSync(configPath, JSON.stringify({ web: { provider: "exa", fallback: [] }, research: { enabled: true },
		classifier: { enabled: true, provider: "typesafe", model: "jev-latest" } }));
	replay.use([web, parallel]);
	const withClassifier = await executeSearch("fixture-classifier", { query, effort: "thorough" }, undefined, undefined, classifierContext);
	replay.assertClean();
	assert.equal(withClassifier.details.classifierStatus, "ran");
	const injectionWithClassifier = directText(withClassifier).includes(excerpts.injection);
	return { credentialCases, leakedKeys: 0, rejectedUnsafeUrlSyntax: 3, refEgress: 0,
		injectionWithoutClassifier, injectionWithClassifier };
}

export async function setup(replay: Replay, search: Search, configPath: string, pkg: string) {
	rmSync(configPath, { force: true });
	const query = "zero configuration test";
	const exa = fixture("exa", query);
	replay.use([exa]);
	const result = await search({ query });
	replay.assertClean();
	assert.equal(result.isError, false, "Zero-config search did not succeed");
	auditCitations(result, [exa], "zero configuration");

	let actionableErrors = 0;
	for (const [config, pattern] of [
		['{"maxResult":2}', /unsupported configuration keys.*use web\/code provider chains/iu],
		['{"code":{"provider":"unknown"}}', /code.*must contain.*valid provider/iu],
		['{"timeoutMs":"quick"}', /timeoutMs.*must be a finite number/iu],
		['{"research":{"enabled":"yes"}}', /research.*must be an object.*boolean/iu],
	] as const) {
		writeFileSync(configPath, config);
		replay.use([]);
		const invalid = await search({ query });
		replay.assertClean();
		assert.equal(invalid.details.error?.code, "invalid_config");
		assert.match(directText(invalid), pattern);
		actionableErrors++;
	}
	rmSync(configPath, { force: true });
	replay.use([]);
	const disabled = await search({ query, effort: "thorough" });
	assert.equal(disabled.details.error?.code, "invalid_config");
	assert.match(directText(disabled), /Set "research": \{ "enabled": true \} in /u);
	actionableErrors++;

	const staging = join(dirname(configPath), "benchmark-artifact");
	mkdirSync(staging);
	const packed = JSON.parse(runNpmCommand(["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", staging], pkg, process.env));
	const metadata = (Array.isArray(packed) ? packed : Object.values(packed))[0] as { filename: string; files: { path: string }[] };
	assert.ok(metadata.files.every(({ path }) => !/^(research|benchmarks)\//u.test(path)), "Research files were published in the package");
	// Package validation separately runs npm install. Here the network-free
	// packed-source smoke confirms registration inside the isolated agent HOME.
	runCommand("tar", ["-xzf", join(staging, metadata.filename), "-C", staging], pkg, process.env);
	const artifact = join(staging, "package");
	symlinkSync(join(pkg, "node_modules"), join(artifact, "node_modules"), "junction");
	const loaded = await discoverAndLoadExtensions([artifact], artifact, dirname(configPath));
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0].tools.keys()], ["search"]);
	replay.assertClean();
	return { zeroConfigSearch: true, actionableErrors, cleanHomePackedLoad: true, excludedFromTarball: true };
}
