import type { WebSearchDetails } from "../format.ts";
import type { EvidenceProvider, ProviderErrorCode, RetrievalEvent } from "../providers/types.ts";
import { providerName } from "./provider-names.ts";

/** Interpret factual retrieval events without affecting routing or model evidence. */
export function retrievalProgress(emit: (line: string) => void) {
	const attempted = new Set<EvidenceProvider>();
	const contributors = new Set<EvidenceProvider>();
	const unreadable = new Set<EvidenceProvider>();
	const failed = new Map<EvidenceProvider, ProviderErrorCode>();
	let withheldMatches = false, incompleteSearch = false, unparsedReply = false;
	let single = false;
	let previous: { kind: EvidenceProvider; code: ProviderErrorCode | "empty" | "unreadable" } | undefined;
	return {
		observe(event: RetrievalEvent) {
			if ("unparsed" in event) unparsedReply ||= event.unparsed === true;
			if ("coverage" in event) {
				withheldMatches ||= event.coverage?.withheld === true;
				incompleteSearch ||= event.coverage?.incomplete === true;
			}
			switch (event.type) {
				case "started": {
					for (const kind of event.kinds) attempted.add(kind);
					const names = event.kinds.map((kind) => providerName[kind]).join(" + ");
					const note = previous ? `${providerName[previous.kind]} ${reason(previous.kind, previous.code)} · trying ` : "";
					previous = undefined;
					single = event.kinds.length === 1;
					emit(`◌ ${note}${names}…`);
					break;
				}
				case "failed":
					failed.set(event.kind, event.code);
					if (single) previous = event;
					break;
				case "unreadable":
					unreadable.add(event.kind);
					if (single) previous = { kind: event.kind, code: "unreadable" };
					break;
				case "empty": if (single && !event.unparsed) previous = { kind: event.kind, code: "empty" }; break;
				case "contributed": contributors.add(event.kind); break;
			}
		},
		details(): WebSearchDetails {
			return { attempted: [...attempted], contributors: [...contributors], failedProviders: [...failed.keys()], unreadableProviders: [...unreadable],
				...(withheldMatches ? { withheldMatches } : {}), ...(incompleteSearch ? { incompleteSearch } : {}),
				...(unparsedReply ? { unparsedReply } : {}),
				allRateLimited: attempted.size > 0 && [...attempted].every((kind) => failed.get(kind) === "rate_limited") };
		},
	};
}

function reason(kind: EvidenceProvider, code: ProviderErrorCode | "empty" | "unreadable") {
	return code === "rate_limited" ? "is rate limited" : code === "timeout" ? "timed out" : code === "empty" ? "found no matches"
		: code === "unreadable" ? "returned an unreadable reply"
		: kind === "jina" ? "couldn't read the pages" : "couldn't search";
}
