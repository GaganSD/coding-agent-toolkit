import { SearchOutputSchema } from "./format.ts";
import { SearchSchema } from "./search.ts";

export const searchTool = {
	name: "search",
	description: "Search public web/code, fetch URLs, or read stored evidence refs.",
	parameters: SearchSchema,
	outputSchema: SearchOutputSchema,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
} as const;

export const searchGuidelines = [
	"Supply one of `query`, `urls`, or `ref`; ref reads stay offline.",
	"Use code scope for public code (repo:, language:, library:); use local rg for workspace files.",
	"Thorough opts into multi-source retrieval; both implies thorough.",
];
