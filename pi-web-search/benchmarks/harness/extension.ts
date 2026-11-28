import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export const competitorPin = "4427fb2044adcd176ced091dc82ff787f3b039ff";
export const competitorTools = ["web_search", "fetch_content", "get_search_content", "source_check"];

type Property = { description?: string; anyOf?: Property[]; type?: string; [key: string]: unknown };
type Schema = { properties: Record<string, Property>; [key: string]: unknown };
export type Variant = "native" | "baseline-fields" | "string-first" | "queries" | "baseline-descriptions" | "baseline-guideline" | "no-filters";
const baselineDescriptions: Record<string, string> = {
	query: "Search terms; code scope expects literal identifiers/snippets",
	scope: "web (default), code, or both",
	effort: "fast (default), or thorough (opt-in multi-source)",
	urls: "Fetch HTTP(S) pages instead of searching",
	ref: "Read a returned evidence ref locally; no network",
	find: "With ref: case-insensitive literal passage match",
	cursor: "With ref: copy the cursor from a previous read",
};

export function changeDeclaration(tool: ToolDefinition, variant: Variant, baselineSchema?: Schema) {
	if (variant === "native") return;
	const schema = { ...tool.parameters, properties: { ...(tool.parameters as unknown as Schema).properties } } as unknown as Schema;
	const properties = schema.properties;
	const query = properties.query;
	const string = query.anyOf?.find((entry) => entry.type === "string");
	const array = query.anyOf?.find((entry) => entry.type === "array");
	if (variant === "baseline-fields") {
		if (!baselineSchema) throw new Error("Use --baseline=<0.4.0 extension root> with baseline-fields");
		schema.properties = { ...baselineSchema.properties, ...Object.fromEntries(
			["recency", "domains"].flatMap((key) => properties[key] ? [[key, properties[key]]] : [])) };
	}
	if (variant === "queries" || variant === "string-first") {
		if (!array || !string) throw new Error("This variant needs the feature revision's batched query declaration");
		if (variant === "string-first") properties.query = { ...query, anyOf: [string, array] };
		else {
			properties.query = { ...string, description: "Search terms" };
			properties.queries = { ...array, description: "Run up to 3 related searches" };
		}
	}
	if (variant === "baseline-descriptions") {
		for (const [key, description] of Object.entries(baselineDescriptions)) if (properties[key]) {
			properties[key] = { ...properties[key], description: key === "query" && array ? description + "; accepts up to 3 queries" : description };
		}
	}
	if (variant === "no-filters") {
		delete properties.domains;
		delete properties.recency;
	}
	if (variant === "baseline-guideline" || variant === "queries") {
		const lines = [...(tool.promptGuidelines ?? [])];
		lines[0] = variant === "queries"
			? "Supply exactly one of `query`, `queries`, `urls`, or `ref`; refs stay offline."
			: "Supply exactly one of `query`, `urls`, or `ref`; refs read stored evidence without network access.";
		tool.promptGuidelines = lines;
	}
	tool.parameters = schema as unknown as typeof tool.parameters;
}

export function configure(root: string, competitor: boolean, contextOnly = false) {
	const file = join(root, "web-search.json");
	const config = competitor
		? { provider: "exa", searchProvider: "exa", toolActivation: "eager", toolExposure: "direct", tools: competitorTools }
		: { classifier: { enabled: false }, research: { enabled: true }, ...(contextOnly ? { web: { provider: "exa", fallback: [] } } : {}) };
	writeFileSync(file, JSON.stringify(config));
}

export async function setup(root: string, extension: string | undefined, names: string[]) {
	const settings = SettingsManager.inMemory({ defaultTools: names,
		compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
		additionalExtensionPaths: extension ? [extension] : [] });
	await loader.reload();
	if (loader.getExtensions().errors.length) throw new Error("Pi could not load the benchmark extension: " + JSON.stringify(loader.getExtensions().errors));
	const definitions = new Map(loader.getExtensions().extensions.flatMap((item) => [...item.tools.values()])
		.map(({ definition }) => [definition.name, definition]));
	for (const name of names) if (!definitions.has(name)) throw new Error("Tool missing from benchmark extension: " + name);
	return { settings, loader, definitions };
}

export async function makeSession(root: string, setupResult: Awaited<ReturnType<typeof setup>>,
	runtime: ModelRuntime, names: string[], model?: Model<Api>) {
	const { session } = await createAgentSession({ model, cwd: root, agentDir: root, settingsManager: setupResult.settings, modelRuntime: runtime,
		resourceLoader: setupResult.loader, sessionManager: SessionManager.inMemory(root), tools: names, thinkingLevel: "off" });
	session.agent.toolExecution = "sequential";
	return session;
}

export async function taskReader(extension: string) {
	const { version } = JSON.parse(readFileSync(join(extension, "package.json"), "utf8"));
	const root = join(extension, "src");
	const { existsSync } = await import("node:fs");
	if (!version || !existsSync(join(root, "read/index.ts"))) return undefined;
	const { search } = await import(pathToFileURL(join(root, "search.ts")).href);
	const { jinaFetch } = await import(pathToFileURL(join(root, "providers/jina.ts")).href);
	return (id: string, args: unknown, signal: AbortSignal | undefined, update: unknown, context: unknown) =>
		search(id, args, signal, update, context, { readUrls: jinaFetch });
}
