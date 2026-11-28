import type { EvidenceProvider } from "../providers/types.ts";

export const providerName: Record<EvidenceProvider, string> = {
	exa: "Exa", parallel: "Parallel", grep: "grep.app", sourcegraph: "Sourcegraph",
	github: "GitHub", brave: "Brave", searxng: "SearXNG", context7: "Context7",
	jina: "Jina", local: "Local", pdf: "PDF",
};
