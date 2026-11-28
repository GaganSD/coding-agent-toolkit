import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebSearchPanel } from "../src/ui/panel.ts";
import { bindings, plainTheme, terminal } from "./fixtures/panel.ts";

import {
	parseWebSearchArgs,
	webSearchCompletions,
	WEB_SEARCH_USAGE,
} from "../src/command.ts";
import {
	disableStoredCredentials,
	enableStoredCredentials,
} from "../src/env.ts";
import webSearchExtension from "../src/index.ts";
import { CONFIG_PATH_ENV_VAR } from "../src/providers/config.ts";

test("parseWebSearchArgs routes menu, provider, classifier, and compat pins", () => {
	assert.deepEqual(parseWebSearchArgs(""), { kind: "menu" });
	assert.deepEqual(parseWebSearchArgs("status"), { kind: "status" });
	assert.deepEqual(parseWebSearchArgs("provider"), { kind: "provider" });
	assert.deepEqual(parseWebSearchArgs("provider exa"), { kind: "provider", id: "exa" });
	assert.deepEqual(parseWebSearchArgs("provider github remove"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("classifier"), { kind: "classifier", action: "pick" });
	assert.deepEqual(parseWebSearchArgs("classifier none"), { kind: "classifier", action: "off" });
	assert.deepEqual(parseWebSearchArgs("classifier typesafe/jev-latest"), {
		kind: "classifier",
		action: { provider: "typesafe", id: "jev-latest" },
	});
	assert.deepEqual(parseWebSearchArgs("off"), { kind: "classifier", action: "off" });
	assert.deepEqual(parseWebSearchArgs("openrouter/~typesafe/jev-latest"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("accidentally-pasted-secret"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("provider exa sk-secret"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("abcd efgh"), { kind: "usage" });
});

test("completions cover the new command surface", () => {
	assert.deepEqual(webSearchCompletions("").map((item) => item.value), [
		"status", "provider", "classifier", "on", "off",
	]);
	assert.deepEqual(webSearchCompletions("pro").map((item) => item.value), ["provider"]);
	assert.deepEqual(webSearchCompletions("provider ").map((item) => item.value), [
		"exa", "parallel", "grep", "sourcegraph", "github", "brave",
	]);
	assert.deepEqual(webSearchCompletions("provider github ").map((item) => item.value), []);
	assert.deepEqual(webSearchCompletions("classifier ").map((item) => item.value), ["none"]);
});

interface Harness {
	handler: (args: string, ctx: CommandCtx) => Promise<void>;
	messages: Array<{ customType: string; content: string }>;
	dir: string;
}

interface CommandCtx {
	mode?: "tui" | "print";
	hasUI: boolean;
	ui: {
		notify: (message: string) => void;
		custom?: (factory: (tui: typeof terminal, theme: typeof plainTheme, keys: ReturnType<typeof bindings>, done: () => void) => WebSearchPanel) => Promise<void>;
		theme?: typeof plainTheme;
	};
	modelRegistry?: {
		getModelsOfType?: (type: string) => Array<{ provider: string; id: string }>;
		getAvailableOfType?: () => Promise<Array<{ provider: string; id: string }>>;
		getProviderAuthStatus?: (provider: string) => { configured: boolean };
		findOfType?: (type: string, provider: string, id: string) => { provider: string; id: string } | undefined;
	};
}

async function withCommand(
	run: (harness: Harness) => Promise<void>,
	storedAuth: unknown = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-command-"));
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env[CONFIG_PATH_ENV_VAR] = join(dir, "web-search.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	await writeFile(join(dir, "auth.json"), JSON.stringify(storedAuth));
	const messages: Harness["messages"] = [];
	const commands: Array<{ name: string; handler: Harness["handler"] }> = [];
	webSearchExtension({
		on: () => () => {},
		registerMcpServer: () => {},
		sendMessage: (message: Harness["messages"][number]) => messages.push(message),
		registerTool: () => {},
		registerCommand: (name: string, options: { handler: Harness["handler"] }) => {
			commands.push({ name, handler: options.handler });
		},
	} as never);
	enableStoredCredentials(join(dir, "auth.json"));
	try {
		const command = commands.find((entry) => entry.name === "web-search");
		assert.ok(command);
		await run({ handler: command.handler, messages, dir });
	} finally {
		disableStoredCredentials();
		if (previous === undefined) delete process.env[CONFIG_PATH_ENV_VAR];
		else process.env[CONFIG_PATH_ENV_VAR] = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
}

test("one custom panel opens Accounts first, then Search, and honors subcommand focus", async () => {
	await withCommand(async ({ handler }) => {
		const focused: string[] = [];
		const ctx: CommandCtx = { mode: "tui", hasUI: true, ui: {
			theme: plainTheme, notify: () => assert.fail("unexpected notification"),
			custom: async (factory) => {
				const panel = factory(terminal, plainTheme, bindings(), () => {});
				focused.push(panel.selected);
				assert.match(panel.render(88).join("\n"), /Settings [0-9]+\/10/);
				await panel.handleInput("\x1b");
			},
		} };
		for (const args of ["", "", "provider parallel", "provider grep", "classifier"]) await handler(args, ctx);
		assert.deepEqual(focused, ["exa", "web", "parallel", "code", "classifier"]);
	});
});

test("a remove argument is usage and does not change auth.json", async () => {
	await withCommand(async ({ handler, dir, messages }) => {
		await handler("provider parallel remove", {
			hasUI: false,
			ui: { notify: () => { throw new Error("headless"); } },
		});
		const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
		assert.deepEqual(auth.parallel, { type: "api_key", key: "keep-parallel" });
		assert.equal(messages[0]?.content, WEB_SEARCH_USAGE);
	}, { parallel: { type: "api_key", key: "keep-parallel" } });
});

test("a pasted key after provider is usage, not storage", async () => {
	await withCommand(async ({ handler, dir }) => {
		let report = "";
		await handler("provider exa pasted-secret", {
			mode: "tui", hasUI: true,
			ui: { notify: (message) => { report = message; } },
		});
		assert.equal(report, WEB_SEARCH_USAGE);
		assert.doesNotMatch(report, /pasted-secret/);
		assert.deepEqual(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")), {});
	});
});

test("status and the default command have the concise print summary", async () => {
	await withCommand(async ({ handler, messages }) => {
		for (const args of ["", "status"]) await handler(args, {
			mode: "print", hasUI: false, ui: { notify: () => assert.fail("not interactive") },
		});
		assert.equal(messages.length, 2);
		assert.equal(messages[0].content, messages[1].content);
		assert.equal(messages[0].content, [
			"Web search", "Web     Exa", "Backup  Parallel", "Code    grep.app → Sourcegraph → GitHub",
			"Multi-source  Off     Classifier  None", "", "Exa ○  Parallel ○  GitHub ○  Brave ○",
			"Open /web-search in the terminal UI to change these.",
		].join("\n"));
	});
});

test("pinning a classifier without credentials keeps Thorough off and gives the login step", async () => {
	await withCommand(async ({ handler }) => {
		let report = "";
		await handler("classifier opencode/jev-1.13", {
			mode: "tui", hasUI: true, ui: { notify: (message) => { report = message; } },
			modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
		});
		assert.match(report, /✓ Saved — applies to the next search/);
		assert.match(report, /▲ Turn on Multi-source to use it/);
		assert.match(report, /▲ Run \/login opencode to use this/);
		assert.doesNotMatch(report, /\/reload/);
	});
});

test("enabling Thorough shows login for the default classifier selected by the command", async () => {
	await withCommand(async ({ handler }) => {
		let report = "", checked = "";
		await handler("on", {
			mode: "tui", hasUI: true, ui: { notify: (message) => { report = message; } },
			modelRegistry: { getAvailableOfType: async () => [], getProviderAuthStatus: (provider: string) => { checked = provider; return { configured: false }; } },
		});
		assert.ok(checked);
		assert.ok(report.includes(`▲ Run /login ${checked} to use this`));
		assert.doesNotMatch(report, /Turn on Multi-source/);
	});
});
