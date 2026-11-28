import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import dgram from "node:dgram";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import { CREDENTIAL_ENV_ALIASES } from "../src/env.ts";
import { search, type SearchInput } from "../src/search.ts";
import { jinaFetch } from "../src/providers/jina.ts";
import { parseLibraryQuery } from "../src/library-query.ts";
import { loadTasks, taskFixtures, type Step, type Task } from "./corpus.ts";
import { assertSanitizedFixtures, directory, evidenceFor, Replay } from "./replay.ts";
import { formatSearchError } from "../src/utils.ts";

const replayContext = new AsyncLocalStorage<{ replay: Replay; blocked: string[] }>();

const args = process.argv.slice(2);
const values = (name: string) => args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
const trialsPerTask = 3;
const callBudget = 8;
const timeoutMs = 90_000;
const maxOutputTokens = 800;
const retryDelayMs = [12_000, 30_000];
if (args.includes("--help")) {
	console.log("npm run research:ergonomics -- --live --model=<provider>/<model> [--model=<other-provider>/<model>] [--concurrency=1] [--output=<directory>] [--task=<id>]\nRuns three billed trials per public task and model using Pi authentication. Retrieval responses are replayed. Run one process per output directory. Re-running the same command resumes successful trials there.");
} else {
	assert.ok(args.includes("--live"), "This run bills model usage to your Pi authentication. Pass --live explicitly.");
	const requested = values("model");
	assert.ok(requested.every((name) => /^[^/]+\/.+/u.test(name)), "Models must use --model=<provider>/<model>");
	assert.ok(requested.length > 0, "Choose at least one pinned model");
	assert.equal(new Set(requested).size, requested.length, "Each model must be listed once");
	const concurrency = Number(values("concurrency")[0] ?? 1);
	assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 24, "Concurrency must be an integer from 1 to 24");
	const selected = new Set(values("task"));
	assert.ok(!selected.size || values("output")[0], "--task requires a separate --output directory");
	const cases = loadTasks().filter((task) => !selected.size || selected.has(task.id));
	assert.ok(cases.length && (!selected.size || cases.length === selected.size), "Unknown task ID");
	assertSanitizedFixtures();
	await run(requested, cases, concurrency, resolve(values("output")[0] ?? join(directory, "../research/results")));
}

function benchmarkFingerprint(): string {
	const hash = createHash("sha256");
	const add = (path: string) => {
		hash.update(path).update("\0").update(readFileSync(join(directory, path))).update("\0");
	};
	for (const file of ["ergonomics.ts", "corpus.ts", "replay.ts", "../package.json", "../package-lock.json"]) add(file);
	for (const folder of ["tasks", "fixtures", "../src"]) {
		const files = readdirSync(join(directory, folder), { withFileTypes: true, recursive: true });
		for (const path of files.filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name)).sort()) {
			add(folder + path.slice(resolve(directory, folder).length));
		}
	}
	return hash.digest("hex");
}

function guardReplay() {
	const fetchOriginal = globalThis.fetch;
	const connect = net.Socket.prototype.connect;
	const send = dgram.Socket.prototype.send;
	globalThis.fetch = (input, init) => {
		const state = replayContext.getStore();
		return state ? state.replay.fetch(input, init) : fetchOriginal(input, init);
	};
	const denyDirectNetwork = (operation: string) => {
		const state = replayContext.getStore();
		if (!state) return;
		state.blocked.push(operation);
		throw new Error("Direct network access is disabled during retrieval replay");
	};
	net.Socket.prototype.connect = function (...args: unknown[]) {
		denyDirectNetwork("socket connection");
		return Reflect.apply(connect, this, args);
	};
	dgram.Socket.prototype.send = function (...args: unknown[]) {
		denyDirectNetwork("datagram");
		return Reflect.apply(send, this, args);
	};
	return () => {
		globalThis.fetch = fetchOriginal;
		net.Socket.prototype.connect = connect;
		dgram.Socket.prototype.send = send;
	};
}

async function run(requested: string[], cases: Task[], concurrency: number, output: string): Promise<void> {
	const agentDir = getAgentDir();
	const root = mkdtempSync(join(tmpdir(), "pi-web-search-model-benchmark-"));
	const previousEnv = { ...process.env };
	const restoreNetwork = guardReplay();
	try {
		// Retain Pi model auth separately from retrieval, which sees only the
		// temporary settings and auth file. Use the static/local model catalog.
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(root, "models-cache.json"), allowModelNetwork: false,
		});
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_WEB_SEARCH_CONFIG = join(root, "web-search.json");
		process.env.NODE_TEST_CONTEXT = "benchmark";
		for (const alias of Object.values(CREDENTIAL_ENV_ALIASES).flat()) delete process.env[alias];
		writeFileSync(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify({ research: { enabled: true }, classifier: { enabled: false } }));
		writeFileSync(join(root, "auth.json"), "{}");

		const registry = new ModelRegistry(runtime);
		const models = requested.map((name) => {
			const slash = name.indexOf("/");
			const model = registry.find(name.slice(0, slash), name.slice(slash + 1));
			assert.ok(model && registry.hasConfiguredAuth(model), `Model is missing or lacks Pi authentication: ${name}`);
			return model;
		});
		mkdirSync(output, { recursive: true });
		const checkpoint = join(output, "ergonomics-checkpoint.jsonl");
		const metadata = { fingerprint: benchmarkFingerprint(), piVersion: VERSION, models: requested,
			tasks: cases.map(({ id }) => id), trialsPerTask, callBudget, timeoutMs, maxOutputTokens, retryDelayMs,
			thinking: "off", toolExecution: "sequential", urlReplay: "jina" };
		const header = JSON.stringify(metadata);
		const known = new Map<string, Trial>();
		if (existsSync(checkpoint)) {
			const [saved, ...rows] = readFileSync(checkpoint, "utf8").trimEnd().split("\n");
			assert.equal(saved, header, "Checkpoint settings differ. Choose a new --output directory.");
			for (const row of rows) {
				const { key, result } = JSON.parse(row) as { key: string; result: Trial };
				assert.ok(!known.has(key), `Duplicate checkpoint trial: ${key}`);
				known.set(key, result);
			}
		} else {
			writeFileSync(checkpoint, header + "\n", { flag: "wx" });
		}
		const jobs = cases.flatMap((task) => Array.from({ length: trialsPerTask }, (_, i) => i + 1)
			.flatMap((trial) => models.map((model) =>
				({ model, task, trial, key: `${model.provider}/${model.id} ${task.id} ${trial}` }))));
		const pending = jobs.filter(({ key }) => !known.has(key));
		const failures: Record<string, number> = {};
		let next = 0;
		let cooldownUntil = 0;
		let consecutiveRateLimits = 0;
		console.log(`Trials: ${known.size}/${jobs.length} already complete, concurrency ${concurrency}.`);
		await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
			for (;;) {
				if (consecutiveRateLimits >= 3) return;
				const job = pending[next++];
				if (!job) return;
				const { model, task, trial, key } = job;
				let result: Trial | string = "model request";
				for (let attempt = 0; attempt <= retryDelayMs.length; attempt++) {
					while (Date.now() < cooldownUntil) await wait(cooldownUntil - Date.now());
					result = await runTrial(runtime, model, task, trial, root);
					if (typeof result !== "string") break;
					failures[result] = (failures[result] ?? 0) + 1;
					const delay = retryDelayMs[attempt];
					if (!delay || !["model HTTP 429", "model HTTP 502", "model HTTP 503", "model HTTP 504"].includes(result)) break;
					cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
					console.error(`Retrying trial after ${result}: ${key}`);
				}
				consecutiveRateLimits = result === "model HTTP 429" ? consecutiveRateLimits + 1 : 0;
				if (typeof result === "string") {
					console.error(`Trial incomplete (${result}): ${key}`);
					continue;
				}
				appendFileSync(checkpoint, JSON.stringify({ key, result }) + "\n");
				known.set(key, result);
				if (known.size % 12 === 0) console.log(`Trials: ${known.size}/${jobs.length} complete.`);
			}
		}));
		if (consecutiveRateLimits >= 3) console.error("Paused queued trials after repeated rate limits. Resume the same command later.");
		const reports = models.map((model) => {
			const trials = jobs.filter((job) => job.model === model).flatMap(({ key }) => known.get(key) ?? []);
			return { model: `${model.provider}/${model.id}`, trials, summary: averages(trials) };
		});
		const timestamp = new Date().toISOString();
		const report = { timestamp, ...metadata, completed: known.size, expected: jobs.length, failures, models: reports };
		const lines = ["# Live agent ergonomics", "", timestamp, "", `Trials complete: ${known.size}/${jobs.length}.`, "",
			"| Model | Metric | Mean | 95% interval |", "| --- | --- | ---: | --- |",
			...reports.flatMap(({ model, summary }) => Object.entries(summary).map(([name, statistics]) =>
				`| ${model} | ${name} | ${statistics.mean?.toFixed(3) ?? "–"} | ${statistics.interval?.map((value) => value.toFixed(3)).join(" to ") ?? "–"} |`))];
		for (const [name, content] of [["ergonomics.json", JSON.stringify(report, null, 2)], ["ergonomics.md", lines.join("\n")]]) {
			const path = join(output, name);
			writeFileSync(path + ".tmp", content + "\n");
			renameSync(path + ".tmp", path);
		}
		console.log(lines.join("\n"));
		if (known.size !== jobs.length) process.exitCode = 1;
	} finally {
		restoreNetwork();
		for (const key of ["PI_CODING_AGENT_DIR", "PI_WEB_SEARCH_CONFIG", "NODE_TEST_CONTEXT", ...Object.values(CREDENTIAL_ENV_ALIASES).flat()]) {
			if (previousEnv[key] === undefined) delete process.env[key];
			else process.env[key] = previousEnv[key];
		}
		rmSync(root, { recursive: true, force: true });
	}
}

async function runTrial(runtime: ModelRuntime, model: NonNullable<ReturnType<ModelRegistry["find"]>>, task: Task, trial: number, root: string): Promise<Trial | string> {
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["search"],
		compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ["mcp"],
		additionalExtensionPaths: [resolve(directory, "..")] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const tool = loader.getExtensions().extensions.flatMap((ext) => [...ext.tools.values()]).find(({ definition }) => definition.name === "search");
	assert.ok(tool);
	const execute = tool.definition.execute;
	const urlAllowlist = new Set(task.steps.flatMap((step) => "urls" in step ? step.urls : []));
	const replays: Replay[] = [];
	const blocked: string[] = [];
	let fixtureIndex = 0;
	tool.definition.execute = async (id, params: SearchInput, signal, update, context) => {
		if (Array.isArray(params.urls) && params.urls.some((url) => !urlAllowlist.has(url))) {
			return formatSearchError("search", new Error("No replay fixture for this URL."));
		}
		const replay = new Replay();
		replays.push(replay);
		const steps: Step[] = [];
		if (params.query && !params.urls && !params.ref) {
			for (const query of Array.isArray(params.query) ? params.query : [params.query]) {
				if (typeof query === "string") steps.push({ query: query.trim(), scope: params.scope ?? "web" });
			}
		} else if (Array.isArray(params.urls)) {
			steps.push({ urls: params.urls });
		}
		replay.use(steps.flatMap((step) => {
			const index = fixtureIndex++;
			if (!("query" in step) || step.scope === "web") return taskFixtures(task, index, step, true);
			const { query, library } = parseLibraryQuery(step.query);
			const fixtures = taskFixtures(task, index, { ...step, query }, true);
			if (library) fixtures.push({ transport: "context7", query, evidence: evidenceFor(task.fixture, index, task.category, "context7") });
			return fixtures;
		}));
		return replayContext.run({ replay, blocked }, () => params.urls
			? search(id, params, signal, update, context, { readUrls: jinaFetch })
			: execute(id, params, signal, update, context));
	};
	const { session } = await createAgentSession({ model, cwd: root, agentDir: root, settingsManager, modelRuntime: runtime,
		resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: ["search"], thinkingLevel: "off" });
	session.agent.toolExecution = "sequential";
	const stream = session.agent.streamFunction;
	session.agent.streamFunction = (streamModel, context, options) => stream(streamModel, context, {
		...options, maxTokens: Math.min(options?.maxTokens ?? maxOutputTokens, maxOutputTokens),
	});
	const calls: { id: string; key: string; ref: boolean; turn: number; failed?: boolean }[] = [];
	let turn = 0;
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, timeoutMs);
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_start") turn++;
		if (event.type === "tool_execution_start") {
			calls.push({ id: event.toolCallId, key: canonicalCall(event.args), ref: typeof event.args?.ref === "string", turn });
		}
		if (event.type === "tool_execution_end") {
			const call = calls.find(({ id }) => id === event.toolCallId);
			if (call) call.failed = event.isError;
			if (calls.length >= callBudget) session.agent.abort();
		}
	});
	try {
		await session.bindExtensions({});
		try {
			await session.prompt(task.prompt);
		} catch {
			if (!timedOut && calls.length < callBudget) return "model request";
		}
		if (blocked.length) return "blocked direct retrieval";
		if (replays.some((replay) => {
			try {
				replay.assertClean();
				return false;
			} catch {
				console.error(`Unmatched replay transports: ${[...new Set(replay.attempts.map(({ host }) => host))].join(", ")}`);
				return true;
			}
		})) return "replay miss";
		if (timedOut) return "deadline";
		const modelFailure = lastModelFailure(session);
		if (calls.length < callBudget && modelFailure) return modelFailure;
		const invalid = calls.findIndex(({ failed }) => failed !== false);
		const recovered = invalid < 0 ? undefined : calls.slice(invalid + 1).find(({ failed, turn }) => failed === false && turn > calls[invalid].turn);
		return {
			task: task.id, split: task.split, trial, firstValid: calls[0]?.failed === false ? 1 : 0,
			calls: calls.length, refReads: calls.filter(({ ref, failed }) => ref && failed === false).length,
			repeatBadCalls: calls.filter(({ key, failed }, i) => i > 0 && failed !== false && calls[i - 1].failed !== false && calls[i - 1].key === key).length,
			recoveryTurns: recovered && recovered.turn - calls[invalid].turn, hitCallBudget: calls.length >= callBudget,
		};
	} finally {
		clearTimeout(deadline);
		unsubscribe();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}

function lastModelFailure(session: AgentSession): string | undefined {
	const last = session.agent.state.messages.at(-1);
	if (last?.role === "assistant" && !["error", "aborted"].includes(last.stopReason)) return undefined;
	const message = last?.role === "assistant" ? last.errorMessage ?? "" : "";
	// Never record raw provider errors, which may contain request credentials.
	const status = /\b(?:401|402|403|404|429|500|502|503|504)\b/u.exec(message)?.[0];
	return status ? `model HTTP ${status}` : "model request";
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
