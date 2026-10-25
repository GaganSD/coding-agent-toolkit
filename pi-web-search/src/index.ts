import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	handleWebSearchCommand,
	WEB_SEARCH_COMMAND,
	webSearchCompletions,
} from "./command.ts";
import { enableStoredCredentials, parallelApiKey } from "./env.ts";
import { PARALLEL_MCP_SERVER, PARALLEL_MCP_URL } from "./providers/parallel.ts";
import { SearchOutputSchema, type WebSearchDetails } from "./format.ts";
import { resolveSettingsSync } from "./providers/config.ts";
import { maybeShowWelcome } from "./welcome.ts";
import { evidenceOwner, evidenceStore } from "./evidence.ts";
import { clearRetrievalCache } from "./providers/reuse.ts";
import {
	type SearchInput,
	SearchSchema,
	search,
	searchReachesTools,
} from "./search.ts";

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
		if (event.reason === "fork") {
			return;
		}
		await maybeShowWelcome(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const owner = evidenceOwner(ctx);
		if (owner) { evidenceStore.clear(owner); clearRetrievalCache(owner); }
	});

	pi.registerTool<typeof SearchSchema, WebSearchDetails>({
		name: "search",
		label: "Search",
		reachesTools: searchReachesTools,
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
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			search(toolCallId, params, signal, onUpdate, ctx),
		renderCall(args: SearchInput, theme) {
			const target = args.query ?? args.ref ?? (args.urls?.length ? `${args.urls.length} URL(s)` : "…");
			const scope = args.scope ?? "web";
			const effort = args.effort ?? (scope === "both" ? "thorough" : "fast");
			const mode = args.ref ? "local ref" : `${scope}/${effort}`;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", target)} ${theme.fg("muted", mode)}`,
				0,
				0,
			);
		},
		renderResult,
	});

	// Pi gives an explicit same-name mcp.json entry precedence over this registration.
	// Register at load time only when the configured web/research policy can use it.
	const registered = resolveSettingsSync();
	if (!("error" in registered) &&
		(registered.web.provider === "parallel" || registered.web.fallback.includes("parallel") || registered.researchEnabled)) {
		const key = parallelApiKey();
		pi.registerMcpServer(PARALLEL_MCP_SERVER, {
			url: PARALLEL_MCP_URL,
			exposure: "codemode",
			...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
		});
	}

	const command = {
		description: "Search settings, provider keys, or classifier pin",
		getArgumentCompletions: webSearchCompletions,
		handler: (args: string, ctx: ExtensionContext) => handleWebSearchCommand(args, ctx, pi),
	};
	pi.registerCommand(WEB_SEARCH_COMMAND, command);
}

export { availableClassifiers } from "./command.ts";

type RenderTheme = {
	fg: (color: "error" | "toolOutput" | "muted", text: string) => string;
};

function renderResult(
	result: AgentToolResult<WebSearchDetails>,
	{ expanded }: { expanded: boolean },
	theme: RenderTheme,
	context: { isError: boolean },
) {
	const output = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const isError = context.isError;
	if (!expanded) {
		// A collapsed successful search still shows a compact count, so a run is
		// never an unexplained blank row.
		const collapsed = isError ? output : result.details?.provider ? compactSummary(result.details) : output;
		return new Text(theme.fg(isError ? "error" : "muted", collapsed), 0, 0);
	}
	return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}

function compactSummary(details: WebSearchDetails | undefined): string {
	if (!details) {
		return "";
	}
	const parts: string[] = [];
	const provider = details.providers?.length
		? details.providers.join(", ")
		: details.provider;
	if (provider) {
		parts.push(provider);
	}
	const count = details.resultCount ?? 0;
	parts.push(`${count} result${count === 1 ? "" : "s"}`);
	const warningCount = details.warnings?.length ?? 0;
	if (warningCount > 0) {
		parts.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
	}
	if (details.scope) {
		parts.push(details.scope);
	}
	if (details.jevStatus && details.jevStatus !== "disabled") {
		parts.push(`jev ${details.jevStatus}`);
	}
	return parts.join(" · ");
}
