import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PARALLEL_MCP_URL } from "../src/providers/parallel.ts";
import { parallelHttp } from "./fixtures/parallel-http.ts";
import { classifierRegistry } from "./fixtures/native-classifier.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const mode of ["anonymous", "stub", "openrouter-stored", "openrouter-runtime", "vercel-stored"] as const) {
	const judge = mode !== "anonymous";
	const nativeClassifier = mode !== "anonymous" && mode !== "stub";
	const backend = mode === "vercel-stored" ? "vercel" : "openrouter";
	const provider = backend === "vercel" ? "vercel-ai-gateway" : "openrouter";
	const key = "isolated-harness-classifier-key";
	test(`Pi SDK direct Parallel search with ${mode} classifier authentication`, { timeout: 20000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-native-sdk-search-"));
		const configPath = join(root, "web-search.json");
		const parallel = parallelHttp();
		const toolCalls: string[] = [];
		const prior = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_WEB_SEARCH_CONFIG, fetch: globalThis.fetch };
		let classifyCalls = 0;
		// Use Pi’s real classifier auth pipeline with fake network I/O.
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url === PARALLEL_MCP_URL) return parallel.fetch(input, init);
			const origin = backend === "vercel" ? "https://ai-gateway.vercel.sh/" : "https://openrouter.ai/";
			if (!nativeClassifier || !url.startsWith(origin) || !url.endsWith("/systemone")) throw new Error("offline MCP fixture");
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, backend === "vercel" ? "typesafe-ai/jev" : "~typesafe/jev-latest");
			assert.equal(body.state.query, "fixture question");
			classifyCalls++;
			const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: Record<string, string> }>).map(([id, question]) => [id,
				question.type === "choice" ? { type: "choice", choice: "safe", confidence: 1,
					probabilities: Object.fromEntries(Object.keys(question.criteria).map((choice) => [choice, choice === "safe" ? 1 : 0])) }
					: { type: "noul", noul: 0.9 },
			]));
			return new Response(JSON.stringify({ answers, usage: { input_tokens: 11, output_tokens: 0 } }), { headers: { "content-type": "application/json" } });
		};
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_WEB_SEARCH_CONFIG = configPath;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await writeFile(join(root, "auth.json"), JSON.stringify(mode.endsWith("stored") ? { [provider]: { type: "api_key", key } } : {}));
			await writeFile(configPath, JSON.stringify({ web: { provider: "parallel", fallback: [] },
				research: { enabled: judge }, classifier: { enabled: judge, ...(judge ? {
					provider: nativeClassifier ? provider : "typesafe",
					model: nativeClassifier ? (backend === "vercel" ? "typesafe-ai/jev" : "~typesafe/jev-latest") : "jev-latest",
				} : {}) }, timeoutMs: 5000, maxResults: 2 }));
			const settingsManager = SettingsManager.inMemory({ defaultTools: ["search"],
				compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				additionalExtensionPaths: [packageRoot],
				extensionFactories: [createMcpExtension(), createCodemodeExtension(), (pi) => {
					pi.on("tool_call", (event) => { toolCalls.push(event.toolName); });
				}],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
			if (mode === "openrouter-runtime") await modelRuntime.setRuntimeApiKey(provider, key);
			({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
				settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root) }));
			await session.bindExtensions({});
			const query = "fixture question";
			const args = { query };
			// A seeded assistant tool call allows Pi to run the real search pipeline without model credentials.
			session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fixture-call", name: "search", arguments: args }],
				api: "openai-responses", provider: "openai", model: "fixture", usage: zeroUsage, stopReason: "toolUse", timestamp: Date.now() });
			session.refreshContext();
			const ctx = session.extensionRunner.createToolContext("fixture-call", AbortSignal.timeout(6000));
			if (mode === "stub") {
				const stub = classifierRegistry({ answers: {} });
				ctx.modelRegistry.findOfType = stub.findOfType.bind(stub);
				ctx.modelRegistry.getAvailableOfType = stub.getAvailableOfType.bind(stub);
				ctx.modelRegistry.classify = async (...input) => {
				classifyCalls++;
				const response = await stub.classify(...input);
				return { ...response, usage: { ...zeroUsage, input: 11, totalTokens: 11 } };
			};
			}
			const ordinary = await ctx.executeTool("search", args);
			assert.equal(ordinary.isError, false, JSON.stringify(ordinary.result));
			assert.ok(!session.getCallableToolNames().some((name) => name.startsWith("mcp__")));
			assert.deepEqual(toolCalls, ["search"]);
			const ordinaryData = ordinary.result.structuredContent as { resultId?: string; provider?: string; searchResults?: { type?: string; url?: string; citedText?: string }[] };
			assert.equal(ordinaryData.provider, "parallel");
			assert.ok(ordinaryData.searchResults?.some((hit) => hit.url === "https://example.test/result" && hit.citedText === "Search citation"));
			assert.equal(classifyCalls, 0, "ordinary search never judges");
			assert.ok(ordinaryData.resultId, "search returns a local continuation handle");
			const beforeRead = parallel.calls.length;
			const directRead = await ctx.executeTool("search", { ref: ordinaryData.resultId + ":1" });
			assert.equal(directRead.isError, false, JSON.stringify(directRead.result));
			assert.match(JSON.stringify(directRead.result.content), /Search citation/);
			assert.equal(parallel.calls.length, beforeRead, "direct continuation stays local");
			session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
			const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode")!;
			assert.ok(codemode);
			// Codemode is model-only, so exercise its host-wrapped direct execute entrypoint.
			const continued = await codemode.execute("continuation-code", { code: `const value = await tools.search({ ref: ${JSON.stringify(ordinaryData.resultId + ":1")} }); text({ count: value.resultCount, url: value.searchResults[0].url });` }, AbortSignal.timeout(6000));
			assert.equal(continued.isError ?? false, false, JSON.stringify(continued));
			assert.match(JSON.stringify(continued.content), /example.test/);
			assert.equal(parallel.calls.length, beforeRead, "continuation makes no MCP/network call");
			if (judge) {
				const judged = await ctx.executeTool("search", { query, scope: "web", effort: "thorough" });
				assert.equal(judged.isError, false, JSON.stringify(judged.result));
				assert.equal((judged.result.details as { classifierStatus?: string }).classifierStatus, "ran");
				assert.equal("classifierStatus" in (judged.result.structuredContent as object), false, "classifier diagnostics stay outside model evidence");
				assert.equal(judged.result.usage?.totalTokens, 11, "own classifier usage reaches AgentToolResult");
				assert.equal(classifyCalls, 1);
			}
			const { calls } = parallel;
			assert.equal(calls[0].name, "web_search");
			assert.equal(calls[0].arguments.model_name, nativeClassifier ? ctx.model?.id : undefined, "analytics uses only the known runtime model ID, not the seeded transcript model");
			if (judge) {
				assert.equal(calls[1].name, "web_search");
				assert.equal(calls[0].arguments.session_id, calls[1].arguments.session_id);
			}
		} finally {
			if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
			globalThis.fetch = prior.fetch;
			if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prior.agent;
			if (prior.config === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
			else process.env.PI_WEB_SEARCH_CONFIG = prior.config;
			await rm(root, { recursive: true, force: true });
		}
	});
}
