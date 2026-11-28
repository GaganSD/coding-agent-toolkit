import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { ModelRegistry, ModelRuntime, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CREDENTIAL_ENV_ALIASES } from "../../src/env.ts";
import { approvedInput, checkPath, claimOutput, type Provenance } from "./provenance.ts";
import { Replay, retrieve, scrub } from "./replay.ts";
import { changeDeclaration, competitorPin, competitorTools, configure, makeSession, setup, taskReader, type Variant } from "./extension.ts";
import { textContent, trial, trialFingerprint, type Task } from "./tasks.ts";

const research = resolve(dirname(fileURLToPath(import.meta.url)), "../../research");
const [mode, ...args] = process.argv.slice(2);
const { values: flags } = parseArgs({ args, options: {
	help: { type: "boolean" }, live: { type: "boolean" }, draft: { type: "boolean" }, inputs: { type: "string" },
	output: { type: "string" }, version: { type: "string" }, extension: { type: "string" }, competitor: { type: "string" },
	baseline: { type: "string" }, variant: { type: "string" }, only: { type: "string" },
	model: { type: "string", multiple: true }, task: { type: "string", multiple: true },
	cassette: { type: "string" }, revision: { type: "string" }, catalog: { type: "string" },
} });
const provenance: Provenance = flags.draft ? "draft" : "final";
const variants: Variant[] = ["native", "baseline-fields", "string-first", "queries", "baseline-descriptions", "baseline-guideline", "no-filters"];
if (flags.help) {
	console.log(`npm run research:${mode} -- [--inputs=<dir>] [--draft] [--version=<lane>] [--output=<dir>]
 [--extension=<package-dir>] [--competitor=<pinned checkout>] [--revision=<lane source identity>]
 [--variant=${variants.join("|")}] [--baseline=<0.4.0 package-dir>]
 [--only=context|tasks] [--model=<provider>/<model>] [--task=<id>] [--cassette=<path>]
 [--catalog=<another Pi SDK dist/index.js>]
record and urls require --live. offline never makes network requests.`);
} else {
	try { await main(); }
	catch (error) {
		console.error(error instanceof Error ? scrub(error.message) : "Benchmark failed");
		process.exitCode = 1;
	}
}

async function main() {
	if (!["record", "offline", "urls"].includes(mode)) throw new Error("Unknown benchmark command");
	if ((mode === "offline") === Boolean(flags.live)) throw new Error("Use --live only with record or urls");
	const version = flags.version ?? "0.4.0";
	if (!/^[\w.-]+$/u.test(version) || version === "." || version === "..") throw new Error("Invalid lane name");
	const variant = (flags.variant ?? "native") as Variant;
	if (!variants.includes(variant)) throw new Error("Unknown variant");
	if (flags.only && !["context", "tasks"].includes(flags.only)) throw new Error("Use --only=context or --only=tasks");
	if (flags.task?.length && (!flags.output || flags.only !== "tasks")) throw new Error("Task selection requires --only=tasks and a separate --output");
	const inputs = approvedInput(resolve(flags.inputs ?? join(research, flags.draft ? "inputs-draft" : "inputs")), provenance);
	const output = claimOutput(resolve(flags.output ?? join(research, flags.draft ? "draft-results" : "results")), provenance);
	const raw = checkPath(join(checkPath(join(output, "raw")), version));
	mkdirSync(raw, { recursive: true, mode: 0o700 });
	const state = checkPath(join(raw, "tables.json"));
	const previous = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
	if (existsSync(state) && previous.provenance !== provenance) throw new Error("Benchmark tables have missing or different provenance.");
	const reportPath = checkPath(join(output, version + ".md"));
	const extension = resolve(flags.extension ?? join(research, ".."));
	const competitor = flags.competitor ? resolve(flags.competitor) : undefined;
	let option = flags.revision;
	if (!option) option = execFileSync("git", ["rev-parse", "HEAD"], { cwd: extension, encoding: "utf8" }).trim();
	if (competitor && (execFileSync("git", ["rev-parse", "HEAD"], { cwd: competitor, encoding: "utf8" }).trim() !== competitorPin
		|| execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: competitor, encoding: "utf8" }).trim())) {
		throw new Error("The pi-web-access checkout must be clean at " + competitorPin);
	}
	const auth = getAgentDir();
	const env = { ...process.env };
	if (previous.revision && previous.revision !== option) throw new Error("Choose another lane or output directory for a different revision");
	const cassette = resolve(flags.cassette ?? join(output, "responses.json"));
	const replay = mode === "urls" ? undefined : new Replay(cassette, mode === "record", provenance);
	const root = mkdtempSync(join(tmpdir(), "pi-search-research-"));
	const restore = replay?.install(mode === "offline" ? "deny" : "model");
	try {
		process.env.HOME = root;
		process.env.USERPROFILE = root;
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_WEB_SEARCH_CONFIG = join(root, "web-search.json");
		process.env.NODE_TEST_CONTEXT = "benchmark";
		for (const alias of Object.values(CREDENTIAL_ENV_ALIASES).flat()) delete process.env[alias];
		writeFileSync(join(root, "auth.json"), "{}");
		const runtime = await ModelRuntime.create({ authPath: join(mode === "record" ? auth : root, "auth.json"),
			modelsPath: join(mode === "record" ? auth : root, "models.json"), modelsStorePath: join(root, "models-cache.json"), allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		const catalog = mode === "record" && flags.catalog ? await loadCatalog(resolve(flags.catalog), auth, root) : undefined;
		let baselineSchema: Parameters<typeof changeDeclaration>[2];
		if (flags.baseline) {
			configure(root, false);
			const base = await setup(root, resolve(flags.baseline), ["search"]);
			baselineSchema = base.definitions.get("search")?.parameters as typeof baselineSchema;
		}
		const sections: Record<string, string> = {};
		let incomplete = false;
		if (mode === "urls") sections.urls = await urls(inputs, raw, root, extension, competitor);
		else {
			if (flags.only !== "tasks") {
				sections.context = await contextCost(inputs, root, runtime, extension, competitor, variant, baselineSchema, replay!);
			}
			if (flags.only !== "context") {
				const tasks = readTasks(inputs);
				const competitors = competitor ? [false, true] : [false];
				const rows = [];
				for (const other of competitors) {
					configure(root, other);
					const location = other ? competitor! : extension;
					const names = other ? competitorTools : ["search"];
					const loaded = await setup(root, location, names);
					if (!other) changeDeclaration(loaded.definitions.get("search")!, variant, baselineSchema);
					const reader = other ? undefined : await taskReader(extension);
					for (const tool of loaded.definitions.values()) {
						const execute = tool.execute;
						tool.execute = (id, args, signal, update, ctx) => retrieve(() => {
							const params = args as Record<string, unknown>;
							if (variant === "queries" && !other && Array.isArray(params.queries)) {
								const { queries, ...rest } = params;
								if (rest.query !== undefined) return Promise.resolve({ isError: true,
									content: [{ type: "text" as const, text: "Supply exactly one of query or queries." }], details: {} });
								args = { ...rest, query: queries };
							}
							if (reader && Array.isArray(params.urls)) return reader(id, args, signal, update, ctx);
							return execute(id, args, signal, update, ctx);
						});
					}
					const models = flags.model ?? [];
					if (!models.length || new Set(models).size !== models.length || models.some((name) => !/^[\w.-]+\/.+/u.test(name))) {
						throw new Error("Choose pinned model IDs with --model=<provider>/<model>; repeat for each vendor");
					}
					const labelsPath = join(inputs, "completed.json");
					const labels = !flags.draft && existsSync(labelsPath) ? JSON.parse(readFileSync(approvedInput(labelsPath, provenance), "utf8")) as Record<string, boolean> : {};
					for (const name of models) {
						const lane = other ? "pi-web-access" : version;
						const dir = checkPath(join(raw, trialFingerprint([lane, name, variant]).slice(0, 16)));
						mkdirSync(dir, { recursive: true, mode: 0o700 });
						const reports = [];
						for (const task of tasks) {
							replay!.errors.length = 0;
							replay!.misses.length = 0;
							const file = checkPath(join(dir, task.id + ".model.json"));
							const [provider, ...rest] = name.split("/");
							const model = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).model
								: (catalog?.find(provider, rest.join("/")) ?? registry.find(provider, rest.join("/")))) as Model<Api> | undefined;
							if (!model || (mode === "record" && !existsSync(file) && !registry.hasConfiguredAuth(model))) {
								throw new Error("Pi model is missing or lacks auth: " + name);
							}
							const session = await makeSession(root, loaded, runtime, names, model);
							const declaration = session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
							const fingerprint = trialFingerprint({ revision: other ? competitorPin : option, provenance, variant, version: VERSION,
								model: name, task, declaration, prompt: session.systemPrompt.replaceAll(root, "<root>") });
							const report = await trial(session, model, task, file, mode === "record", fingerprint, replay!);
							const transcript = join(dir, task.id + ".json");
							writeJson(transcript, report);
							replay!.save();
							reports.push(report);
							if (report.failure) {
								incomplete = true;
								console.error(lane + " " + name + " " + task.id + ": " + report.failure);
								if (mode === "offline") throw new Error("Offline replay failed for task " + task.id);
							}
						}
						const first = reports.filter((row) => row.firstValid).length;
						const noCalls = reports.filter((row) => row.firstValid === undefined).length;
						const multi = reports.filter((row) => row.multiPart);
						const known = reports.filter((row) => row.multiPart !== undefined).length;
						const completions = reports.map(({ task }) => labels[[lane, name, variant, task].join("/")]);
						rows.push([lane + " / " + variant + " / " + name, tasks.length,
							first + "/" + tasks.length + (noCalls ? " (" + noCalls + " no call)" : ""),
							reports.reduce((sum, row) => sum + row.attemptedToolCalls, 0), reports.reduce((sum, row) => sum + row.toolCalls, 0),
							reports.reduce((sum, row) => sum + row.totalTokens, 0),
							known ? multi.filter((row) => row.arrayCalls).length + "/" + multi.length : "Awaiting multi-part labels",
							completions.every((label) => typeof label === "boolean") ? completions.filter(Boolean).length + "/" + tasks.length : "Awaiting owner review",
							reports.filter((row) => row.failure).length, "[Transcripts](" + relative(output, dir) + ")"]);
					}
				}
				sections.tasks = table(["Lane / variant / model", "Tasks (one run each)", "Valid first calls", "Attempted calls", "Executed calls", "Total tokens",
					"Multi-part tasks using an array", "Completed", "Failed trials", "Raw", "Why it matters"],
					rows.map((row) => [...row, "Correct first calls and fewer turns reduce the time and tokens to reach an answer."]));
			}
		}
		const all = { ...previous, ...sections, revision: option, provenance };
		writeJson(state, all);
		const markdown = ["# Search benchmark " + version, "", flags.draft ? "**Draft owner inputs. Private evaluation only.**" : "",
			...(all.context ? ["## Context cost", "", all.context] : []),
			...(all.urls ? ["## URL reading", "", all.urls] : []),
			...(all.tasks ? ["## Real tasks", "", all.tasks] : []), "",
			"Context cost counts o200k_base declaration tokens plus Pi's system-prompt delta and direct result text.",
			"Real tasks use the selected models' reported total tokens and replay URL retrieval through Jina where supported.",
			"URL-reading route percentages use all submitted URLs as the denominator.", ""] .join("\n");
		writeFileSync(reportPath, markdown, { mode: 0o600 });
		console.log("Saved benchmark report to " + reportPath);
		if (incomplete) process.exitCode = 1;
	} finally {
		try { replay?.save(); }
		finally {
			restore?.();
			for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
				if (env[key] === undefined) delete process.env[key];
				else process.env[key] = env[key];
			}
			rmSync(root, { recursive: true, force: true });
		}
	}
}

function readTasks(inputs: string): Task[] {
	const seen = new Set<string>();
	const rows = lines(join(inputs, "tasks.jsonl")).map((line, index) => {
		let item: { id?: string; prompt?: string; multiPart?: boolean };
		try { item = JSON.parse(line); }
		catch { throw new Error("Malformed owner task JSON on row " + (index + 1)); }
		if (!item || typeof item !== "object") throw new Error("Invalid owner task on row " + (index + 1));
		if (!item.id || !/^[\w-]+$/u.test(item.id) || seen.has(item.id) || typeof item.prompt !== "string" || !item.prompt.trim()) {
			throw new Error("Invalid owner task on row " + (index + 1));
		}
		seen.add(item.id);
		return { id: item.id, prompt: item.prompt, multiPart: item.multiPart };
	});
	const selection = flags.task ? new Set(flags.task) : undefined;
	const tasks = selection ? rows.filter(({ id }) => selection.has(id)) : rows;
	if (!tasks.length || (selection && tasks.length !== selection.size)) throw new Error("Task selection is missing or unknown");
	return tasks;
}

function lines(path: string): string[] {
	if (!existsSync(path)) throw new Error("Owner input missing: " + path);
	return readFileSync(approvedInput(path, provenance), "utf8").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function table(headers: string[], rows: (number | string)[][]) {
	const join = (cells: (number | string)[]) => "| " + cells.join(" | ") + " |";
	return [join(headers), join(headers.map(() => "---")), ...rows.map(join)].join("\n");
}

function writeJson(path: string, data: unknown) { writeFileSync(checkPath(path), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); }

async function contextCost(inputs: string, root: string, runtime: ModelRuntime, extension: string, competitor: string | undefined,
	variant: Variant, baselineSchema: Parameters<typeof changeDeclaration>[2], replay: Replay) {
	const dependency = "js-tiktoken";
	const { encodingForModel } = await import(dependency).catch((cause: unknown) => {
		throw new Error("Install the pinned context tokenizer with npm ci --prefix benchmarks", { cause });
	}) as { encodingForModel(model: "gpt-4o"): { encode(text: string): number[] } };
	const tokenizer = encodingForModel("gpt-4o");
	const count = (value: string) => tokenizer.encode(value).length;
	const empty = await makeSession(root, await setup(root, undefined, []), runtime, []);
	const basePrompt = count(empty.systemPrompt);
	empty.dispose();
	const queries = lines(join(inputs, "searches.txt")).map((line) => line.replace(/^(?:web|code)(?:\t|\\t|\s*:\s*)/iu, ""));
	if (!queries.length) throw new Error("No owner search inputs");
	const rows = [];
	for (const other of competitor ? [false, true] : [false]) {
		configure(root, other, true);
		const names = other ? competitorTools : ["search"];
		const loaded = await setup(root, other ? competitor : extension, names);
		if (!other) changeDeclaration(loaded.definitions.get("search")!, variant, baselineSchema);
		const session = await makeSession(root, loaded, runtime, names);
		try {
			await session.bindExtensions({});
			const tools = session.agent.state.tools;
			const declaration = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
			const contextTokens = count(JSON.stringify(declaration)) + count(session.systemPrompt) - basePrompt;
			const active = tools.find(({ name }) => name === (other ? "web_search" : "search"));
			if (!active) throw new Error("Context target tool is not active");
			const totals = [];
			for (const [index, query] of queries.entries()) {
				const args = other ? { query, provider: "exa" } : { query };
				const result = await retrieve(() => active.execute("context-" + index, args, AbortSignal.timeout(30_000)));
				if (replay.misses.length) throw new Error("Context replay miss on query row " + (index + 1) + ": " + replay.misses.join("; "));
				if ((result as { isError?: boolean }).isError || !textContent(result)) throw new Error("No context result on query row " + (index + 1) +
					(replay.errors.length ? " (" + replay.errors.join("; ") + ")" : ""));
				totals.push(count(textContent(result)));
			}
			totals.sort((a, b) => a - b);
			const middle = Math.floor(totals.length / 2);
			const median = totals.length % 2 ? totals[middle] : (totals[middle - 1] + totals[middle]) / 2;
			rows.push([other ? "pi-web-access (keyless Exa)" : "pi-web-search (keyless Exa)", queries.length,
				contextTokens, median, totals.reduce((a, b) => a + b, 0), "Smaller declarations and responses leave more model context for the answer."]);
		} finally { session.dispose(); }
	}
	return table(["Extension", "Queries", "Declaration + prompt tokens", "Median returned tokens", "Total returned tokens", "Why it matters"], rows);
}

async function urls(inputs: string, raw: string, root: string, extension: string, competitor?: string) {
	const targets = lines(join(inputs, "urls.txt")).map((line) => line.replace(/^[\w-]+(?:\t|\\t)(?=https?:\/\/)/iu, ""));
	if (!targets.length) throw new Error("No owner URL inputs");
	if (new Set(targets).size !== targets.length) throw new Error("Owner URL inputs contain duplicates");
	for (const [index, text] of targets.entries()) {
		let url: URL;
		try { url = new URL(text); } catch { throw new Error("Invalid URL on input row " + (index + 1)); }
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("URL row " + (index + 1) + " must be public HTTP(S)");
		if (/\.pdf(?:\/|$)|^\/pdf\//iu.test(url.pathname)) throw new Error("Remove PDF URL from owner input row " + (index + 1));
	}
	const labelsFile = join(inputs, flags.draft ? "url-labels.draft.json" : "url-labels.json");
	const labels = existsSync(labelsFile) ? JSON.parse(readFileSync(approvedInput(labelsFile, provenance), "utf8")) as Record<string, string> : {};
	if (!flags.draft && targets.some((url) => typeof labels[url] !== "string" || !labels[url].trim())) {
		throw new Error("Owner URL labels missing: supply one exact phrase per URL");
	}
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false });
	const rows = [];
	for (const other of competitor ? [false, true] : [false]) {
		const file = join(raw, other ? "pi-web-access-urls.json" : "pi-web-search-urls.json");
		configure(root, other);
		const names = other ? competitorTools : ["search"];
		const session = await makeSession(root, await setup(root, other ? competitor : extension, names), runtime, names);
		try {
			await session.bindExtensions({});
			const tool = session.agent.state.tools.find(({ name }) => name === (other ? "fetch_content" : "search"));
			if (!tool) throw new Error("URL target tool is not active");
			const results = [];
			for (const [index, url] of targets.entries()) {
				const input = other ? { urls: [url], mode: "readable" } : { urls: [url] };
				try {
					const result = await tool.execute("url-" + index, input, AbortSignal.timeout(30_000));
					const details = result.details as { searchResults?: { source?: string; citedText?: string; ref?: string }[]; error?: unknown } | undefined;
					const structured = (result as { structuredContent?: { urls?: { content?: string; error?: string; mimeType?: string }[] } }).structuredContent;
					const hit = details?.searchResults?.find((item) => item.citedText?.trim());
					const fetched = structured?.urls?.[0];
					const isPdf = fetched?.mimeType?.toLowerCase().includes("pdf") || hit?.source === "pdf";
					const read = !details?.error && !(result as { isError?: boolean }).isError && !isPdf &&
						(other ? !!(fetched?.content?.trim() || textContent(result).trim()) : !!hit);
					const text = !read ? isPdf ? "PDF excluded from URL benchmark" : textContent(result)
						: other ? fetched?.content ?? textContent(result)
						: hit?.ref ? await storedPage(tool, hit.ref, index) : hit?.citedText ?? "";
					const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
					results.push({ url, read, source: hit?.source, main: labels[url] ? read && normalized(text).includes(normalized(labels[url])) : undefined,
						text: scrub(text) });
				} catch (error) {
					results.push({ url, read: false, source: undefined, main: labels[url] ? false : undefined,
						text: scrub(error instanceof Error ? error.message : "URL reader error") });
				}
				writeJson(file, results);
			}
			const rate = (n: number, d = targets.length) => d ? n + "/" + d + " (" + Math.round(n / d * 100) + "%)" : "—";
			const main = results.filter(({ main }) => main !== undefined);
			rows.push([other ? "pi-web-access" : "pi-web-search", targets.length, rate(results.filter(({ read }) => read).length),
				other ? "—" : rate(results.filter(({ read, source }) => read && (source === "local" || source === "github")).length),
				other ? "—" : rate(results.filter(({ read, source }) => read && source === "jina").length),
				main.length ? rate(main.filter(({ main }) => main).length, main.length) : "Awaiting owner labels",
				"[Read results](" + relative(dirname(dirname(raw)), file) + ")", "Open a page and get the expected passage in the tool output."]);
		} finally { session.dispose(); }
	}
	return table(["Extension", "URLs", "Read", "Local", "Jina", "Main content", "Raw", "Why it matters"], rows);
}

async function storedPage(tool: { execute(id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ details?: unknown }> },
	ref: string, index: number) {
	const chunks: string[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const result = await tool.execute("url-evidence-" + index + "-" + chunks.length,
			{ ref, ...(cursor ? { cursor } : {}) }, AbortSignal.timeout(10_000));
		const details = result.details as { cursor?: string; searchResults?: { citedText?: string }[] } | undefined;
		const next = details?.searchResults?.[0]?.citedText;
		if (!next) throw new Error("Could not read stored URL evidence");
		chunks.push(next);
		cursor = details?.cursor;
		if (cursor) {
			if (seen.has(cursor)) throw new Error("URL evidence cursor did not advance");
			seen.add(cursor);
		}
	} while (cursor);
	return chunks.join("");
}

async function loadCatalog(path: string, auth: string, root: string): Promise<Pick<ModelRegistry, "find">> {
	const sdk = await import(pathToFileURL(path).href) as {
		ModelRuntime: typeof ModelRuntime; ModelRegistry: typeof ModelRegistry;
	};
	const runtime = await sdk.ModelRuntime.create({ authPath: join(auth, "auth.json"), modelsPath: join(auth, "models.json"),
		modelsStorePath: join(root, "catalog-cache.json"), allowModelNetwork: false });
	return new sdk.ModelRegistry(runtime);
}
