import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "../scripts/validation.ts";
import { evidenceStore } from "../src/evidence.ts";
import type { WebSearchDetails } from "../src/format.ts";
import type { SearchSchema, SearchInput } from "../src/search.ts";
import { assertHosts, auditCitations, directText, loadTasks, taskFixtures, type Search } from "./corpus.ts";
import { assertSanitizedFixtures, directory, Replay, type Evidence, type Fixture } from "./replay.ts";

const pkg = resolve(directory, "..");
const baseline = join(directory, "results", "baseline.json");
const configPath = process.env.PI_WEB_SEARCH_CONFIG;
const args = process.argv.slice(2);
const child = args.includes("--child");
const output = args.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? join(pkg, "research", "results", "offline.json");

if (!child) {
	const gitRevision = runCommand("git", ["rev-parse", "HEAD"], pkg, process.env).trim();
	withTemporaryDirectory("pi-web-search-offline-", (root) => {
		const env = { ...isolatedEnvironment(root), npm_config_cache: join(root, "npm-cache"), NODE_TEST_CONTEXT: "benchmark",
			PI_BENCHMARK_GIT_REVISION: gitRevision, npm_execpath: process.env.npm_execpath };
		process.stdout.write(runCommand(process.execPath, ["--disable-warning=ExperimentalWarning", process.argv[1], "--child", ...args], pkg, env));
	});
} else {
	assert.ok(configPath, "Run the benchmark through npm to use an isolated configuration");
	const replay = new Replay();
	replay.installGuard();
	assertSanitizedFixtures();
	const start = performance.now();
	const { default: register } = await import("../src/index.ts");
	let execute: Search | undefined;
	let context = {} as ExtensionToolContext;
	let callNumber = 0;
	function selectSession(id: string): void {
		context = { sessionManager: { getSessionId: () => id } } as ExtensionToolContext;
	}
	const registered: string[] = [];
	register({
		on() {},
		registerCommand() {},
		registerTool(tool: ToolDefinition<typeof SearchSchema, WebSearchDetails>) {
			registered.push(tool.name);
			execute = (input: SearchInput, signal?: AbortSignal) => tool.execute(`bench-${++callNumber}`, input, signal, undefined, context);
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(registered, ["search"]);
	assert.ok(execute);
	const search = execute;
	const coldStartMs = performance.now() - start;
	const { percentile, reliability, safety, setup } = await import("./suites.ts");

	const tasks = loadTasks();
	let resultTokens = 0;
	let directChars = 0;
	let citationChecks = 0;
	let duplicateCount = 0;
	let evidenceChars = 0;
	let refChecks = 0;
	let cursorChecks = 0;
	const taskMetrics: Record<string, { calls: number; resultTokens: number; evidenceDensity: number; hits: number; egressByHost: Record<string, number> }> = {};
	const overheadMs: number[] = [];
	for (const task of tasks) {
		selectSession(task.id);
		writeFileSync(configPath, JSON.stringify({ research: { enabled: true } }));
		const metrics = { calls: 0, resultTokens: 0, evidenceDensity: 0, hits: 0, egressByHost: {} as Record<string, number> };
		let taskDirectChars = 0;
		let taskEvidenceChars = 0;
		let evidence: Evidence[] = [];
		let lastFixtures: Fixture[] = [];
		let ref: string | undefined;
		let cursor: string | undefined;
		let offset = 0;
		for (const [index, step] of task.steps.entries()) {
			const active = taskFixtures(task, index, step);
			replay.use(active);
			let input: SearchInput;
			if ("ref" in step) {
				assert.ok(ref && (!step.cursor || cursor), `${task.id}: missing prior ref or cursor`);
				input = { ref, ...(step.cursor ? { cursor } : {}) };
			} else {
				input = step;
				lastFixtures = active;
				evidence = active.flatMap((fixture) => fixture.evidence);
				offset = 0;
			}
			const callStart = performance.now();
			const result = await search(input);
			const wallMs = performance.now() - callStart;
			replay.assertClean();
			assert.equal(result.isError, false, `${task.id} call ${index + 1}: ${directText(result)}`);
			const text = directText(result);
			assert.ok(text, `${task.id} produced empty direct output`);
			const citation = auditCitations(result, lastFixtures, task.id);
			const outputHit = (result.structuredContent as { searchResults: { url: string; ref?: string }[] }).searchResults[0];
			if ("ref" in step) {
				const hit = result.details.searchResults?.[0];
				const original = evidence.find(({ url }) => hit?.url === url)?.text;
				assert.ok(original && hit?.citedText && result.details.passage, `${task.id}: missing stored evidence`);
				assert.equal(result.details.passage.offset, offset, `${task.id}: continuation skipped evidence`);
				assert.equal(result.details.passage.totalChars, original.length, `${task.id}: stored evidence size changed`);
				assert.equal(hit.citedText, original.slice(offset, offset + hit.citedText.length), `${task.id}: stored passage changed`);
				assert.ok(text.startsWith(hit.citedText), `${task.id}: direct output differs from stored passage`);
				assert.equal(outputHit.ref, ref, `${task.id}: changed evidence identity`);
				offset += hit.citedText.length;
				cursor = result.details.cursor;
				refChecks++;
				if (step.cursor) cursorChecks++;
				assert.equal(replay.attempts.length, 0, `${task.id}: local evidence read made a network request`);
			} else {
				ref = outputHit.ref;
				assert.ok(replay.attempts.length > 0, `${task.id}: expected provider transport was not exercised`);
				if ("urls" in step) assert.equal(result.details.urlsRead, step.urls.length, `${task.id}: URL read did not return requested evidence`);
			}
			assertHosts(replay.attempts, active, task.id);
			for (const { host } of replay.attempts) metrics.egressByHost[host] = (metrics.egressByHost[host] ?? 0) + 1;
			metrics.calls++;
			metrics.resultTokens += Math.ceil(text.length / 4);
			metrics.hits += citation.hits;
			taskDirectChars += text.length;
			taskEvidenceChars += citation.snippetChars;
			citationChecks += citation.hits;
			duplicateCount += citation.duplicates;
			overheadMs.push(Math.max(0, wallMs - replay.replayMs));
		}
		metrics.evidenceDensity = taskEvidenceChars / taskDirectChars;
		taskMetrics[task.id] = metrics;
		resultTokens += metrics.resultTokens;
		evidenceChars += taskEvidenceChars;
		directChars += taskDirectChars;
		evidenceStore.clear(task.id);
	}
	assert.ok(cursorChecks > 0, "Corpus must exercise cursor pagination");

	selectSession("suites");
	const reliabilityReport = await reliability(replay, search, configPath);
	const safetyReport = await safety(replay, search, configPath, context);
	const setupReport = await setup(replay, search, configPath, pkg);
	const { measureFootprint } = await import("../scripts/footprint.ts");
	const footprint = await measureFootprint();
	replay.assertClean();
	const footprintMode = footprint.modes.default;
	assert.ok(footprintMode.estimatedTokens <= 380, "Search declaration exceeded 380 estimated tokens");
	assert.equal(footprint.result.previewCount, 8);
	assert.ok(footprint.result.directChars <= 4500);
	assert.ok(footprint.result.structuredChars <= 6000);

	const report = {
		schemaVersion: 1,
		gitRevision: process.env.PI_BENCHMARK_GIT_REVISION,
		node: process.version,
		taskCount: tasks.length,
		context: {
			declarationTokens: footprintMode.estimatedTokens,
			resultTokens,
			averageResultTokens: resultTokens / tasks.length,
			evidenceDensity: evidenceChars / directChars,
			duplicateRate: duplicateCount / citationChecks,
		},
		citation: { citedHits: citationChecks, missingUrls: 0, inventedUrls: 0, alteredSnippets: 0, refChecks, cursorChecks },
		reliability: reliabilityReport,
		safety: safetyReport,
		setup: setupReport,
		overhead: { replayAdjustedP50Ms: percentile(overheadMs, 0.5), replayAdjustedP95Ms: percentile(overheadMs, 0.95),
			coldRegistrationMs: Number(coldStartMs.toFixed(2)), peakRssKiB: process.resourceUsage().maxRSS },
		tasks: taskMetrics,
	};
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
	const markdownPath = output.endsWith(".json") ? output.replace(/\.json$/u, ".md") : output + ".md";
	const previous: typeof report | undefined = !args.includes("--initialize-baseline") && existsSync(baseline) ? JSON.parse(readFileSync(baseline, "utf8")) : undefined;
	const rows = [
		["Task count", report.taskCount, previous?.taskCount],
		["Declaration tokens", report.context.declarationTokens, previous?.context.declarationTokens],
		["Average result tokens per task", report.context.averageResultTokens, previous?.context.averageResultTokens],
		["Evidence density", report.context.evidenceDensity * 100, previous && previous.context.evidenceDensity * 100],
		["Duplicate rate (%)", report.context.duplicateRate * 100, previous && previous.context.duplicateRate * 100],
		["Cited hits", report.citation.citedHits, previous?.citation.citedHits],
		["Ref passages", report.citation.refChecks, previous?.citation.refChecks],
		["Cursor reads", report.citation.cursorChecks, previous?.citation.cursorChecks],
		["Retryable faults recovered", report.reliability.retryableRecovered, previous?.reliability.retryableRecovered],
		["Partial success cases preserved", report.reliability.partialSuccess, previous?.reliability.partialSuccess],
		["Deadline p99 (ms)", report.reliability.deadlineP99Ms, previous?.reliability.deadlineP99Ms],
		["Abort (ms)", report.reliability.abortMs, previous?.reliability.abortMs],
		["Wrapper over replay p50 (ms)", report.overhead.replayAdjustedP50Ms, previous?.overhead.replayAdjustedP50Ms],
		["Wrapper over replay p95 (ms)", report.overhead.replayAdjustedP95Ms, previous?.overhead.replayAdjustedP95Ms],
		["Cold registration (ms)", report.overhead.coldRegistrationMs, previous?.overhead.coldRegistrationMs],
		["Peak RSS (KiB)", report.overhead.peakRssKiB, previous?.overhead.peakRssKiB],
	] as const;
	const formatted = (value: number) => Number(value.toFixed(2)).toString();
	const markdown = [
		"# Offline search wrapper benchmark", "",
		`Package source commit \`${process.env.PI_BENCHMARK_SOURCE_COMMIT}\`. Node \`${report.node}\`.`, "",
		"| Metric | Current | Baseline | Delta |", "| --- | ---: | ---: | ---: |",
		...rows.map(([name, current, old]) => `| ${name} | ${formatted(current)} | ${old === undefined ? "–" : formatted(old)} | ${old === undefined ? "–" : formatted(current - old)} |`),
		"", "Evidence density and duplicate rate are percentages. Timing and memory are advisory.", "",
		"No ranking, answer-quality, live provider or model measurements are included.", "",
	];
	writeFileSync(markdownPath, markdown.join("\n"));

	if (!args.includes("--initialize-baseline")) {
		assert.ok(previous, "Versioned offline baseline is missing");
		const comparable = Object.entries(previous.tasks);
		assert.ok(comparable.length > 0, "Baseline has no comparable tasks");
		for (const [id, old] of comparable) {
			const current = report.tasks[id];
			assert.ok(current, `Baseline task missing: ${id}`);
			assert.ok(current.evidenceDensity >= old.evidenceDensity * 0.95, `${id}: evidence density regressed by more than 5%`);
			assert.ok(current.resultTokens <= old.resultTokens * 1.05, `${id}: result tokens regressed by more than 5%`);
		}
	}
	console.log(markdown.join("\n"));
	console.log(`Reports: ${output} and ${markdownPath}`);
}
