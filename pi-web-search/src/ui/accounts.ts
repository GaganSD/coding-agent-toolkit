import { CREDENTIAL_PROVIDER_IDS, credentialState, isLiteralApiKey, type CredentialProviderId } from "../env.ts";
import { BRAVE_CONTEXT_URL, BRAVE_SEARCH_URL } from "../providers/brave.ts";
import { CONTEXT7_LIBRARIES_URL } from "../providers/context7.ts";
import { resolveSettings, type ResolvedSettings } from "../providers/config.ts";
import { EXA_SEARCH_URL } from "../providers/exa.ts";
import { GITHUB_SEARCH_URL } from "../providers/github.ts";
import { getJson, postJson, withTimeout, type FetchLike, type JsonRequestOptions } from "../providers/http.ts";
import { probeParallelKey } from "../providers/parallel.ts";
import { isProviderError, type ProviderKind } from "../providers/types.ts";
import { providerName } from "./provider-names.ts";

export const PROVIDER_AUTH: Record<ProviderKind, "keyless" | "required"> = {
	exa: "keyless", parallel: "keyless", brave: "required", grep: "keyless", sourcegraph: "keyless", github: "required", searxng: "keyless", context7: "keyless",
};

export const providerHelp: Record<ProviderKind, { description: string; keyUrl?: string }> = {
	exa: { description: "Works without a key. A key turns on REST search with higher limits.", keyUrl: "dashboard.exa.ai/api-keys" },
	parallel: { description: "Works without a key. A key turns on higher limits.", keyUrl: "platform.parallel.ai" },
	github: { description: "Uses a GitHub token or an existing gh login.", keyUrl: "github.com/settings/tokens" },
	brave: { description: "Needs a Brave Search API key.", keyUrl: "api-dashboard.search.brave.com/app/keys" },
	grep: { description: "Works without a key." },
	sourcegraph: { description: "Works without a key." },
	searxng: { description: "Set searxng.url to your SearXNG origin in web-search.json." },
	context7: { description: "Versioned library docs. An optional API key raises limits.", keyUrl: "context7.com/dashboard" },
};

export function accountState(id: CredentialProviderId) {
	const { resolved, stored, editable } = credentialState(id);
	return { source: resolved?.source, variable: resolved?.source === "env" ? resolved.name : undefined, stored, editable };
}

export function providerReady(id: ProviderKind, settings?: ResolvedSettings) {
	if (id === "searxng") return settings?.searxng !== undefined;
	const account = CREDENTIAL_PROVIDER_IDS.find((candidate) => candidate === id);
	return PROVIDER_AUTH[id] === "keyless" || account !== undefined && accountState(account).source !== undefined;
}

export function accountValue(id: CredentialProviderId, short = false) {
	const { source, stored } = accountState(id);
	return source === "gh" ? "● gh auth" : source ? (short ? source === "env" ? "● Env" : "●" : "● Connected")
		: stored === "managed" ? "▲ Managed by Pi" : stored === "broken" ? "▲ Broken credential" : (short ? "○" : "○ No key");
}

export function accountsSummary() {
	return CREDENTIAL_PROVIDER_IDS.map((id) => `${providerName[id]} ${accountValue(id, true)}`).join("  ");
}

export type KeyCheck = "accepted" | "rejected" | "offline";

/** One lightweight provider operation. Never print or persist the response or candidate key. */
export async function checkApiKey(id: CredentialProviderId, key: string, signal?: AbortSignal, fetchImpl: FetchLike = fetch): Promise<KeyCheck> {
	if (!isLiteralApiKey(key)) return "rejected";
	const deadline = withTimeout(signal, 4000);
	let throttled = false;
	const options: Omit<JsonRequestOptions, "body"> = {
		signal: deadline.signal, fetchImpl, maxResponseBytes: 256 * 1024,
		onResponse: (response) => {
			throttled = response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after") !== null;
		},
	};
	try {
		if (id === "parallel") {
			await probeParallelKey(key, deadline.signal, fetchImpl);
			return "accepted";
		}
		if (id === "exa") {
			const result = await postJson<{ results?: unknown }>(EXA_SEARCH_URL, { ...options,
				headers: { "x-api-key": key }, body: { query: "example.com", numResults: 1 } });
			return Array.isArray(result?.results) ? "accepted" : "offline";
		}
		if (id === "brave") {
			const settings = await resolveSettings();
			const web = !("error" in settings) && settings.brave?.mode === "web";
			const endpoint = web ? BRAVE_SEARCH_URL : BRAVE_CONTEXT_URL;
			const result = await getJson<{ type?: string; web?: { results?: unknown }; grounding?: { generic?: unknown } }>(`${endpoint}?q=example.com&count=1`, { ...options,
				headers: { "X-Subscription-Token": key, Accept: "application/json" } });
			return result?.type === "search" || Array.isArray(result?.web?.results) || Array.isArray(result?.grounding?.generic) ? "accepted" : "offline";
		}
		if (id === "context7") {
			const result = await getJson<{ results?: unknown }>(`${CONTEXT7_LIBRARIES_URL}?libraryName=react&query=overview&fast=true`, { ...options,
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
			return Array.isArray(result?.results) ? "accepted" : "offline";
		}
		const url = new URL(GITHUB_SEARCH_URL);
		url.searchParams.set("q", "hello");
		url.searchParams.set("per_page", "1");
		const result = await getJson<{ items?: unknown; total_count?: unknown }>(url.href, { ...options,
			headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.github+json" } });
		return Array.isArray(result?.items) && typeof result.total_count === "number" ? "accepted" : "offline";
	} catch (error) {
		if (isProviderError(error) && (error.status === 401 || (error.status === 403 && !throttled) || error.status === 422)) return "rejected";
		return "offline";
	} finally {
		deadline.dispose();
	}
}
