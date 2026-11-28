import { getAgentDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleWebSearchCommand, WEB_SEARCH_COMMAND, webSearchCompletions } from "./command.ts";
import { enablePiAgentDirectory, enableStoredCredentials } from "./env.ts";
import type { WebSearchDetails } from "./format.ts";
import { maybeShowWelcome } from "./welcome.ts";
import { evidenceOwner, evidenceStore } from "./evidence.ts";
import { clearRetrievalCache } from "./providers/reuse.ts";
import { type SearchSchema, search } from "./search.ts";
import { searchGuidelines, searchTool } from "./tool.ts";
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
	enablePiAgentDirectory(getAgentDir);
	enableStoredCredentials();

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "fork") await maybeShowWelcome(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const owner = evidenceOwner(ctx);
		if (owner) { evidenceStore.clear(owner); clearRetrievalCache(owner); }
	});

	pi.registerTool<typeof SearchSchema, WebSearchDetails, TranscriptState>({
		...searchTool,
		label: "Search",
		promptSnippet: "Public web/code search, URL reading, and local evidence continuation.",
		promptGuidelines: searchGuidelines,
		namespace: { name: "search", description: "Cited public web and code retrieval." },
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
