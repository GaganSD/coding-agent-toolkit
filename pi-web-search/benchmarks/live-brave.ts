import { join } from "node:path";
import { agentDirectory, enableStoredCredentials, resolveCredential } from "../src/env.ts";
import { BRAVE_CONTEXT_URL, BRAVE_SEARCH_URL, braveSearch } from "../src/providers/brave.ts";
import { applyConfig } from "../src/providers/config.ts";
import { isProviderError } from "../src/providers/types.ts";

const usage = "npm run research:brave -- --live";
const query = "Apollo 11 NASA site:nasa.gov";
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--help") {
	console.log(usage);
} else if (args.length !== 1 || args[0] !== "--live") {
	console.error(`Pass --live to send two public test requests to Brave. Usage: ${usage}`);
	process.exitCode = 2;
} else {
	enableStoredCredentials(join(agentDirectory(), "auth.json"));
	const credential = resolveCredential("brave");
	if (!credential) {
		console.error("Brave requires BRAVE_API_KEY, BRAVE_SEARCH_API_KEY or a stored brave key.");
		process.exitCode = 2;
	} else {
		for (const mode of ["context", "web"] as const) {
			const endpoint = mode === "context" ? BRAVE_CONTEXT_URL : BRAVE_SEARCH_URL;
			let status: number | undefined;
			try {
				const result = await braveSearch({
					query,
					settings: applyConfig("Brave live smoke", {
						maxResults: 3,
						timeoutMs: 15_000,
						...(mode === "web" ? { brave: { mode } } : {}),
					}),
				}, {
					fetchImpl: async (input, init) => {
						const url = new URL(input);
						const expected = new URL(endpoint);
						if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password ||
							url.searchParams.get("q") !== query || init.method !== "GET" ||
							init.redirect !== "error" || init.headers?.["X-Subscription-Token"] !== credential.key) {
							throw new Error("Unexpected Brave request");
						}
						const response = await fetch(url, init);
						status = response.status;
						return response;
					},
				});
				const citedHits = (result.searchResults ?? []).filter(({ url, citedText }) =>
					url && /^https?:\/\//u.test(url) && citedText?.trim() && result.sources?.some((source) => source.url === url)).length;
				console.log(JSON.stringify({ mode, status, credentialSource: credential.source, citedHits }));
				if (!citedHits) process.exitCode = 1;
			} catch (error) {
				// Report the transport outcome without serializing provider data or credentials.
				console.error(JSON.stringify({ mode, status, credentialSource: credential.source,
					error: isProviderError(error) ? error.code : "unexpected_error" }));
				process.exitCode = 1;
			}
		}
	}
}
