import type { EvidenceProvider } from "../providers/types.ts";

export const providerName: Record<EvidenceProvider, string> = {
	exa: "Exa", parallel: "Parallel", grep: "grep.app", sourcegraph: "Sourcegraph",
	github: "GitHub", brave: "Brave", jina: "Jina",
};
