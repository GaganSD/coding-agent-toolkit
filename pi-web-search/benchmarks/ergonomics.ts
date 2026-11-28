import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CREDENTIAL_ENV_ALIASES } from "../src/env.ts";
import { search, type SearchInput } from "../src/search.ts";
import { jinaFetch } from "../src/providers/jina.ts";
import { loadTasks, taskFixtures, type Step } from "./corpus.ts";
import { directory, Replay } from "./replay.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log("npm run research:ergonomics -- --live --model=<provider>/<model> --model=<other-provider>/<model>\nRuns three billed trials per public task and model using Pi authentication. Retrieval responses are replayed.");
} else {
	assert.ok(args.includes("--live"), "This run bills model usage to your Pi authentication. Pass --live explicitly.");
	const requested = args.filter((arg) => arg.startsWith("--model=")).map((arg) => arg.slice("--model=".length));
	assert.ok(requested.every((name) => /^[^/]+\/.+/u.test(name)), "Models must use --model=<provider>/<model>");
	assert.ok(new Set(requested.map((name) => name.split("/", 1)[0])).size >= 2, "Choose at least two different model providers");
	await run(requested);
}

async function run(requested: string[]): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-web-search-model-benchmark-"));
	const fetchOriginal = globalThis.fetch;
	const replayContext = new AsyncLocalStorage<Replay>();
	const runtime = await ModelRuntime.create();
	try {
		// Model authentication stays with Pi. Retrieval in the benchmark does
		// not read the operator's search config, stored keys or GitHub login.
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_WEB_SEARCH_CONFIG = join(root, "web-search.json");
		process.env.NODE_TEST_CONTEXT = "benchmark";
		for (const alias of Object.values(CREDENTIAL_ENV_ALIASES).flat()) delete process.env[alias];
		writeFileSync(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify({ research: { enabled: true } }));
		writeFileSync(join(root, "auth.json"), "{}");
		globalThis.fetch = (input, init) => {
			const replay = replayContext.getStore();
			return replay ? replay.fetch(input, init) : fetchOriginal(input, init);
		};
		const registry = new ModelRegistry(runtime);
		const models = requested.map((name) => {
			const slash = name.indexOf("/");
			const model = registry.find(name.slice(0, slash), name.slice(slash + 1));
			assert.ok(model && registry.hasConfiguredAuth(model), `Model is missing or lacks Pi authentication: ${name}`);
			return model;
		});
		const cases = loadTasks();
		const reports = [];
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["search"],
			compaction: { enabled: false }, retry: { enabled: false } });
		for (const model of models) {
			const trials: Trial[] = [];
			for (const task of cases) {
				for (let trial = 0; trial < 3; trial++) {
					const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true,
						noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [resolve(directory, "..")] });
					await loader.reload();
					assert.deepEqual(loader.getExtensions().errors, []);
					const tool = loader.getExtensions().extensions.flatMap((ext) => [...ext.tools.values()]).find(({ definition }) => definition.name === "search");
					assert.ok(tool);
					const execute = tool.definition.execute;
					const replays: Replay[] = [];
					const urlAllowlist = new Set(task.steps.flatMap((step) => "urls" in step ? step.urls : []));
					tool.definition.execute = (id, params: SearchInput, signal, update, context) => {
						const replay = new Replay();
						replays.push(replay);
						const steps: Step[] = [];
						if (params.query && !params.urls && !params.ref) {
							for (const query of Array.isArray(params.query) ? params.query : [params.query]) {
								steps.push({ query: query.trim(), scope: params.scope ?? "web" });
							}
						} else if (params.urls?.every((url) => urlAllowlist.has(url))) steps.push({ urls: params.urls });
						replay.use(steps.flatMap((step, index) => taskFixtures(task, replays.length + index - 1, step, params.effort === "thorough")));
						return replayContext.run(replay, () => params.urls
							? search(id, params, signal, update, context, { readUrls: jinaFetch })
							: execute(id, params, signal, update, context));
					};
					const { session } = await createAgentSession({ model, cwd: root, agentDir: root, settingsManager, modelRuntime: runtime,
						resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: ["search"] });
					const calls: { id: string; key: string; ref: boolean; turn: number; failed?: boolean }[] = [];
					let turn = 0;
					const deadline = setTimeout(() => { void session.abort(); }, 120_000);
					const unsubscribe = session.subscribe((event) => {
						if (event.type === "turn_start") turn++;
						if (event.type === "tool_execution_start") {
							calls.push({ id: event.toolCallId, key: canonicalCall(event.args), ref: typeof event.args?.ref === "string", turn });
							if (calls.length >= 8) queueMicrotask(() => { void session.abort(); });
						}
						if (event.type === "tool_execution_end") {
							const call = calls.find(({ id }) => id === event.toolCallId);
							if (call) call.failed = event.isError;
						}
					});
					try {
						await session.bindExtensions({});
						await session.prompt(task.prompt);
						const last = session.agent.state.messages.at(-1);
						assert.ok(calls.length >= 8 || last?.role === "assistant" && last.stopReason !== "error", `Model did not finish ${model.provider}/${model.id} ${task.id}`);
						// Requests for out-of-scope URLs are failed calls rather than
						// fixture misses in the offline benchmark's scripted corpus.
						const invalid = calls.findIndex(({ failed }) => failed !== false);
						const recovered = invalid < 0 ? undefined : calls.slice(invalid + 1).find(({ failed }) => failed === false);
						trials.push({
							task: task.id, split: task.split, trial: trial + 1, firstValid: calls[0]?.failed === false ? 1 : 0,
							calls: calls.length, refReads: calls.filter(({ ref, failed }) => ref && failed === false).length,
							repeatBadCalls: calls.filter(({ key, failed }, i) => i > 0 && failed !== false && calls[i - 1].failed !== false && calls[i - 1].key === key).length,
							recoveryTurns: recovered && recovered.turn - calls[invalid].turn, hitCallBudget: calls.length >= 8,
						});
					} finally {
						clearTimeout(deadline);
						unsubscribe();
						await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
						session.dispose();
					}
				}
			}
			reports.push({ model: `${model.provider}/${model.id}`, trials, summary: averages(trials) });
		}
		const output = resolve(directory, "../research", "results");
		mkdirSync(output, { recursive: true });
		const now = new Date().toISOString();
		writeFileSync(join(output, "ergonomics.json"), JSON.stringify({ timestamp: now, models: reports }, null, 2) + "\n");
		const lines = ["# Live agent ergonomics", "", now, "", "| Model | Metric | Mean | 95% interval |", "| --- | --- | ---: | --- |",
			...reports.flatMap(({ model, summary }) => Object.entries(summary).map(([name, statistics]) =>
				`| ${model} | ${name} | ${statistics.mean?.toFixed(3) ?? "–"} | ${statistics.interval?.map((value) => value.toFixed(3)).join(" to ") ?? "–"} |`))];
		writeFileSync(join(output, "ergonomics.md"), lines.join("\n") + "\n");
		console.log(lines.join("\n"));
	} finally {
		globalThis.fetch = fetchOriginal;
		rmSync(root, { recursive: true, force: true });
	}
}

interface Trial {
	task: string;
	split: string;
	trial: number;
	firstValid: number;
	calls: number;
	refReads: number;
	repeatBadCalls: number;
	recoveryTurns?: number;
	hitCallBudget: boolean;
}

function canonicalCall(args: Record<string, unknown> = {}): string {
	return JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
}

function averages(trials: Trial[]) {
	const count = (metric: "firstValid" | "calls" | "refReads" | "repeatBadCalls" | "recoveryTurns") => {
		// Trials for one task are correlated. Use each task's trial mean as
		// one observation for the interval.
		const groups = new Map<string, Trial[]>();
		for (const trial of trials) {
			const group = groups.get(trial.task);
			if (group) group.push(trial);
			else groups.set(trial.task, [trial]);
		}
		const taskMeans = [...groups.values()].flatMap((runs) => {
			const mean = interval(runs.flatMap((trial) => trial[metric] === undefined ? [] : [trial[metric]])).mean;
			return mean === undefined ? [] : [mean];
		});
		return interval(taskMeans, metric === "firstValid" ? 1 : Infinity);
	};
	return { firstValid: count("firstValid"), calls: count("calls"), refReads: count("refReads"),
		repeatBadCalls: count("repeatBadCalls"), recoveryTurns: count("recoveryTurns") };
}

function interval(values: number[], maximum = Infinity) {
	if (!values.length) return { mean: undefined, interval: undefined };
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
	const halfWidth = 1.96 * Math.sqrt(variance / values.length);
	return { mean, interval: [Math.max(0, mean - halfWidth), Math.min(maximum, mean + halfWidth)] };
}
