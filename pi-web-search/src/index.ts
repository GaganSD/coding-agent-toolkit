import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleWebSearchCommand, WEB_SEARCH_COMMAND, webSearchCompletions } from "./command.ts";
import { enableStoredCredentials } from "./env.ts";
import { SearchOutputSchema, type WebSearchDetails } from "./format.ts";
import { maybeShowWelcome } from "./welcome.ts";
import { evidenceOwner, evidenceStore } from "./evidence.ts";
import { clearRetrievalCache } from "./providers/reuse.ts";
import { SearchSchema, search } from "./search.ts";
import { renderCall, renderResult, type TranscriptState } from "./ui/transcript.ts";

/** Fail closed on unsupported or malformed host versions. */
export function assertSupportedPiVersion(version: string): void {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(version);
	if (!match || (Number(match[1]) === 0 &&
		(Number(match[2]) < 99 || (Number(match[2]) === 99 && Number(match[3]) === 0 && match[4])))) {
		throw new Error("pi-web-search requires Pi >=0.99.0.");
	}
}

export default function webSearchExtension(pi: ExtensionAPI) {
	assertSupportedPiVersion(VERSION);

	// Pi's auth.json is the one secret store. Enabling it here (not at import)
	// keeps a bare import of the tools, and the test suite, off the operator's
	// secrets; every read still goes to the current file.
	enableStoredCredentials();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "fork") await maybeShowWelcome(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const owner = evidenceOwner(ctx);
		if (owner) { evidenceStore.clear(owner); clearRetrievalCache(owner); }
	});

	pi.registerTool<typeof SearchSchema, WebSearchDetails, TranscriptState>({
		name: "search",
		label: "Search",
		description:
			"Search public web/code, fetch URLs, or read stored evidence refs.",
		promptSnippet:
			"Public web/code search, URL reading, and local evidence continuation.",
		promptGuidelines: [
			"Supply exactly one of `query`, `urls`, or `ref`; refs read stored evidence without network access.",
			"Use `scope: \"code\"` for public identifiers/snippets (`repo:` and `language:` filters); use local `rg` for workspace files.",
			"`effort: \"thorough\"` enables opt-in multi-source retrieval; `scope: \"both\"` implies thorough.",
		],
		parameters: SearchSchema,
		outputSchema: SearchOutputSchema,
		namespace: { name: "search", description: "Cited public web and code retrieval." },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		execute: (id, params, signal, onUpdate, ctx) => search(id, params, signal, onUpdate, ctx),
		renderCall,
		renderResult,
	});

	const panel = { first: true };
	pi.registerCommand(WEB_SEARCH_COMMAND, {
		description: "Search settings, provider keys, or classifier pin",
		getArgumentCompletions: webSearchCompletions,
		handler: (args, ctx) => handleWebSearchCommand(args, ctx, pi, panel),
	});
}

export { availableClassifiers } from "./ui/classifiers.ts";
