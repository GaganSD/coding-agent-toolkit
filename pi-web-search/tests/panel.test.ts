import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CREDENTIAL_ENV_ALIASES, disableStoredCredentials, enableStoredCredentials, removeApiKey, storeApiKey } from "../src/env.ts";
import { resolveSettings, saveSearchSetting, type SearchSettingEdit } from "../src/providers/config.ts";
import { checkApiKey, PROVIDER_AUTH, type KeyCheck } from "../src/ui/accounts.ts";
import { editorInvocation, WebSearchPanel, type PanelContext, type PanelRow } from "../src/ui/panel.ts";
import { bindings, plainTheme, terminal } from "./fixtures/panel.ts";
import { parallelHttp } from "./fixtures/parallel-http.ts";
import { withFileLock } from "../src/file-write.ts";
import { providerName } from "../src/ui/provider-names.ts";

const [up, down, right, enter, esc, del, left] = ["\x1b[A", "\x1b[B", "\x1b[C", "\r", "\x1b", "\x1b[3~", "\x1b[D"];
const screen = (panel: WebSearchPanel, width = 88) => panel.render(width).join("\n");
const press = async (panel: WebSearchPanel, ...keys: string[]) => { for (const key of keys) await panel.handleInput(key); };
async function isolated(run: (env: { auth: string; config: string; make: typeof make }) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi web search panel-"));
	const auth = join(dir, "auth.json"), config = join(dir, "web-search.json");
	const env = new Map(["PI_CODING_AGENT_DIR", "PI_WEB_SEARCH_CONFIG", ...Object.values(CREDENTIAL_ENV_ALIASES).flat()].map((id) => [id, process.env[id]]));
	for (const id of env.keys()) delete process.env[id];
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_WEB_SEARCH_CONFIG = config;
	enableStoredCredentials(auth);
	try { await writeFile(auth, JSON.stringify({ unrelated: { type: "oauth", access: "keep" } })); await run({ auth, config, make }); }
	finally {
		disableStoredCredentials();
		for (const [id, value] of env) { if (value === undefined) delete process.env[id]; else process.env[id] = value; }
		await rm(dir, { recursive: true, force: true });
	}
}

async function make(row: PanelRow, opts: {
	check?: ConstructorParameters<typeof WebSearchPanel>[7]; registry?: PanelContext["modelRegistry"];
	keys?: ReturnType<typeof bindings>; rows?: number; done?: () => void;
	tui?: typeof terminal;
} = {}) {
	const base = opts.tui ?? terminal;
	const tui = opts.rows === undefined ? base : { ...base, terminal: { ...base.terminal, rows: opts.rows } };
	return new WebSearchPanel(await resolveSettings(), row, tui, () => plainTheme, opts.keys ?? bindings(), { modelRegistry: opts.registry } as PanelContext, opts.done ?? (() => {}), opts.check);
}

test("panel uses host keybindings, skips section headers, and fits narrow and tiny terminals", () => isolated(async ({ make }) => {
	let closed = 0;
	const panel = await make("results", { keys: bindings({ "tui.select.down": "j", "tui.select.up": "k", "tui.select.cancel": "q" }), done: () => closed++ });
	assert.match(screen(panel), /Settings 5\/11/);
	assert.match(screen(panel), /── Search.*\n.*› Results.*8/s);
	await panel.handleInput(down);
	assert.equal(panel.selected, "results");
	await panel.handleInput("j");
	assert.equal(panel.selected, "exa");
	assert.match(screen(panel), /── Accounts/);
	await panel.handleInput("k");
	assert.equal(panel.selected, "results");
	for (const width of [1, 12, 23, 24, 55, 67, 68, 88]) assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
	const tiny = await make("thorough", { rows: 8 });
	assert.ok(tiny.render(35).length <= 6);
	assert.match(screen(tiny, 35), /Multi-source · .*Off/);
	await panel.handleInput("q");
	assert.equal(closed, 1);
}));

test("two-pane navigation saves choices only on selection, including backup order", () => isolated(async ({ make }) => {
	const panel = await make("web");
	await panel.handleInput(right);
	assert.equal(panel.right, true);
	assert.equal(panel.settings.web.provider, "exa");
	assert.match(screen(panel), /│\s+› Exa\s+current/);
	assert.doesNotMatch(screen(panel), /› Web search/);
	assert.match(screen(panel), /↑↓ Move · Enter Choose · ← Back/);
	await press(panel, down, enter);
	assert.deepEqual(panel.settings.web, { provider: "parallel", fallback: ["exa"] });
	await press(panel, left, down, right, down, " ");
	assert.equal(panel.selected, "fallback");
	assert.deepEqual(panel.settings.web.fallback, ["exa", "brave"]);
	await panel.handleInput("\x1b[1;2A");
	assert.deepEqual(panel.settings.web.fallback, ["brave", "exa"]);
	assert.match(screen(panel), /Skipped until you add a key/);
	await panel.handleInput("a");
	assert.equal(panel.selected, "brave");
	assert.match(screen(panel), /› Add key/);

	const code = await make("code");
	await press(code, enter, down, enter);
	assert.equal(code.settings.code.provider, "sourcegraph");
	await press(code, down, down, down, enter, " ");
	assert.deepEqual(code.settings.code.fallback, ["github"]);
	await press(code, esc, down, right, up, " ", esc, down, right, down);
	assert.equal(code.settings.maxResults, 8);
	await code.handleInput(enter);
	assert.equal(code.settings.researchEnabled, true);
	assert.equal(code.settings.maxResults, 9);
	assert.match(screen(code), /✓ Saved — applies to the next search/);
}));

test("pasting a key masks it, validates once, and removal needs two deliberate presses", () => isolated(async ({ auth, make }) => {
	let checks = 0;
	let complete!: (value: KeyCheck) => void;
	const panel = await make("exa", { check: async (id, key) => {
		assert.equal(id, "exa"); assert.equal(key, "hidden-key"); checks++;
		return new Promise((done) => { complete = done; });
	} });
	await press(panel, right, enter, "\x1b[200~ hidden-key\n\x1b[201~");
	assert.match(screen(panel), /••••/);
	assert.doesNotMatch(screen(panel), /hidden-key/);
	let wait = panel.handleInput(enter);
	assert.match(screen(panel), /◌ Checking…/);
	complete("rejected"); await wait;
	assert.match(screen(panel), /✕ Exa rejected this key/);
	assert.equal(JSON.parse(await readFile(auth, "utf8")).exa, undefined);
	await panel.handleInput("hidden-key");
	wait = panel.handleInput(enter); complete("offline"); await wait;
	assert.equal(checks, 2);
	assert.match(screen(panel), /▲ Saved, couldn't check — offline\?/);
	assert.doesNotMatch(screen(panel), /hidden-key/);
	process.env.EXA_API_KEY = "from-shell";
	assert.match(screen(panel), /\[ EXA_API_KEY \]/);
	assert.doesNotMatch(screen(panel), /from-shell|Replace|Remove/);
	for (const key of [enter, del, del]) await panel.handleInput(key);
	assert.equal(panel.editor, undefined);
	delete process.env.EXA_API_KEY;
	await press(panel, down, enter);
	assert.match(screen(panel), /Press Enter or Space again to remove the Exa key/);
	await panel.handleInput(esc);
	assert.equal(JSON.parse(await readFile(auth, "utf8")).exa.key, "hidden-key");
	await press(panel, right, enter, " ");
	assert.deepEqual(JSON.parse(await readFile(auth, "utf8")), { unrelated: { type: "oauth", access: "keep" } });
}));

test("classifier picker preserves Multi-source and links to the toggle", () => isolated(async ({ make }) => {
	const registry = {
		getModelsOfType: () => [{ provider: "openrouter", id: "~typesafe/jev-latest" }, { provider: "opencode", id: "jev-1.13" }],
		getAvailableOfType: async () => [{ provider: "opencode", id: "jev-1.13" }],
		getProviderAuthStatus: () => ({ configured: false }),
	} as unknown as PanelContext["modelRegistry"];
	const panel = await make("classifier", { registry });
	await panel.handleInput(enter);
	assert.match(screen(panel, 112), /openrouter\/~typesafe\/jev-latest.*▲ unavailable/);
	await panel.handleInput(down); await panel.handleInput(down); await panel.handleInput(enter);
	assert.equal(panel.pin, "openrouter/~typesafe/jev-latest");
	assert.equal(panel.settings.researchEnabled, false);
	assert.match(screen(panel), /▲ Turn on Multi-source to use it/);
	assert.match(screen(panel), /▲ Run \/login openrouter to use this/);
	await press(panel, down, enter);
	assert.equal(panel.selected, "thorough");
	await panel.handleInput(" ");
	assert.equal(panel.settings.researchEnabled, true);
	await press(panel, left, up, up, up, up, right, up, up, enter);
	assert.equal(panel.pin, undefined);
	assert.equal(panel.settings.researchEnabled, true);
}));

test("malformed config only changes after explicit confirmation of a single property fix", () => isolated(async ({ config, make }) => {
	const original = '{\n    "timeoutMs": 7000,\n    "web": { "provider": "parallel" },\n    "maxResult" : 12\n}\n';
	await writeFile(config, original);
	await assert.rejects(saveSearchSetting({ kind: "set", field: "maxResults", value: 9 }), { code: "invalid_config" });
	const panel = await make("exa");
	assert.equal(panel.selected, "results");
	assert.match(screen(panel), /✕ web-search\.json line 4: unknown setting "maxResult" — did you mean "maxResults"\?/);
	await panel.handleInput(right);
	assert.equal(await readFile(config, "utf8"), original);
	await panel.handleInput(enter);
	assert.equal(await readFile(config, "utf8"), original.replace('"maxResult"', '"maxResults"'));
	assert.equal(panel.settings.maxResults, 12);
	await writeFile(config, '{\n    "timeoutMs":\n}');
	const invalid = await make("web");
	assert.match(screen(invalid), /web-search\.json: invalid JSON/);
	assert.doesNotMatch(screen(invalid), /Apply fix/);
	await invalid.handleInput(enter);
	assert.equal(await readFile(config, "utf8"), '{\n    "timeoutMs":\n}');
}));

test("live key checks distinguish a credential rejection from an unverified service", async () => {
	assert.equal(await checkApiKey("exa", "test-key", undefined, async (_url, init) => {
		assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
		assert.equal(JSON.parse(String(init?.body)).numResults, 1);
		return new Response(null, { status: 401 });
	}), "rejected");
	assert.equal(await checkApiKey("github", "test-key", undefined, async () => { throw new Error("offline"); }), "offline");
	const parallel = parallelHttp();
	assert.equal(await checkApiKey("parallel", "test-key", undefined, parallel.fetch), "accepted");
	assert.equal(parallel.calls.length, 1);
	assert.ok(parallel.headers.every((v) => v === "Bearer test-key"));
});

test("secret entry owns printable shortcuts and Escape ignores a late key check", () => isolated(async ({ auth, make }) => {
	let complete!: (value: KeyCheck) => void;
	let signal: AbortSignal | undefined;
	const panel = await make("parallel", {
		keys: bindings({ "tui.select.confirm": "j", "tui.select.cancel": "q" }),
		check: async (_id, value, pending) => {
			assert.equal(value, "jq-pasted");
			signal = pending;
			return new Promise((done) => { complete = done; });
		},
	});
	await press(panel, "j", "j");
	for (const chunk of ["j", "q", "\x1b[200~-pasted\x1b[201~"]) await panel.handleInput(chunk);
	const check = panel.handleInput(enter);
	assert.match(screen(panel), /Checking/);
	await panel.handleInput(esc);
	assert.equal(panel.editor, undefined);
	assert.equal(signal?.aborted, true);
	await panel.handleInput("j");
	const replacement = panel.editor;
	assert.ok(replacement);
	complete("accepted");
	await check;
	assert.equal(panel.editor, replacement);
	assert.equal(JSON.parse(await readFile(auth, "utf8")).parallel, undefined);
}));

test("Escape releases the panel while Parallel's MCP cleanup is still pending", () => isolated(async ({ auth, make }) => {
	const fixture = parallelHttp();
	let cleanupStarted!: () => void, completeCleanup!: () => void;
	const cleaning = new Promise<void>((done) => { cleanupStarted = done; });
	const cleanup = new Promise<void>((done) => { completeCleanup = done; });
	const panel = await make("parallel", { check: (id, key, signal) => checkApiKey(id, key, signal, async (url, options) => {
		if (options?.method === "DELETE") { cleanupStarted(); await cleanup; }
		return fixture.fetch(url, options);
	}) });
	await press(panel, right, enter, "fixture-key");
	const check = panel.handleInput(enter);
	await cleaning;
	assert.match(screen(panel), /Checking/);
	await panel.handleInput(esc);
	assert.equal(panel.editor, undefined);
	await press(panel, esc, down);
	assert.equal(panel.selected, "github");
	completeCleanup();
	await check;
	assert.equal(JSON.parse(await readFile(auth, "utf8")).parallel, undefined);
}));

test("classifier discovery survives a focus change and ignores catalogs after leaving its row or Ctrl+C", () => isolated(async ({ make }) => {
	let delivered!: (models: unknown[]) => void;
	let closed = 0;
	const registry = {
		getAvailableOfType: async () => new Promise((done) => { delivered = done; }),
		getModelsOfType: () => [],
	} as unknown as PanelContext["modelRegistry"];
	const panel = await make("classifier", { registry, done: () => { closed++; } });
	let discovery = panel.handleInput(enter);
	await panel.handleInput(esc);
	assert.equal(panel.classifierLoading, true);
	await panel.handleInput(down);
	delivered([{ provider: "late", id: "model" }]);
	await discovery;
	assert.doesNotMatch(screen(panel), /late/);
	await panel.handleInput(up);
	discovery = panel.handleInput(enter);
	await panel.handleInput("\x03");
	assert.equal(closed, 1);
	await discovery;
	assert.equal(panel.editor, undefined);
}));

test("OAuth-managed credentials cannot be replaced or deleted in Accounts", () => isolated(async ({ auth, make }) => {
	const original = JSON.stringify({ exa: { type: "oauth", access: "SENTINEL_OAUTH_TOKEN" } });
	await writeFile(auth, original);
	const panel = await make("exa");
	assert.match(screen(panel), /Managed by Pi/);
	assert.doesNotMatch(screen(panel), /Add key|Replace|Remove|SENTINEL_OAUTH_TOKEN/);
	for (const key of [enter, del, del]) await panel.handleInput(key);
	assert.equal(panel.editor, undefined);
	assert.equal(await readFile(auth, "utf8"), original);
}));

test("config repair focuses the owning row and never prints a secret typo value", () => isolated(async ({ config, make }) => {
	await writeFile(config, '{"classifier":{"enable":true}}');
	const enabled = await make("thorough");
	assert.equal(enabled.selected, "classifier");
	assert.match(screen(enabled), /Open file/);
	const original = '{"classifier":{"mode":"SENTINEL_SECRET_VALUE"}}';
	await writeFile(config, original);
	const secret = await make("web");
	assert.equal(secret.selected, "classifier");
	assert.doesNotMatch(screen(secret), /SENTINEL_SECRET_VALUE/);
	assert.match(screen(secret), /<hidden>/);
	await secret.handleInput(enter);
	assert.equal(await readFile(config, "utf8"), original.replace('"mode"', '"model"'));
}));

test("broken entries render read-only while environment keys take precedence over stored ownership", () => isolated(async ({ auth, config, make }) => {
	const original = JSON.stringify({ exa: null, github: { type: "oauth", access: "managed-hidden" }, brave: { type: "api_key", key: "saved-brave" } });
	await writeFile(auth, original);
	const broken = await make("exa");
	assert.match(screen(broken), /Broken credential/);
	assert.doesNotMatch(screen(broken), /Add key|Replace|Remove/);
	for (const key of [enter, del, del]) await broken.handleInput(key);
	assert.equal(await readFile(auth, "utf8"), original);
	process.env.GITHUB_TOKEN = "fixture-env";
	await writeFile(config, '{"code":{"provider":"github"},"web":{"provider":"brave"}}');
	const account = await make("github");
	assert.match(screen(account), /GITHUB_TOKEN/);
	assert.match(screen(account), /Managed by Pi/);
	assert.doesNotMatch(screen(account), /managed-hidden|fixture-env|Add key|Replace|Remove/);
	const github = await make("code");
	assert.match(screen(github), /GitHub.*Connected/);
	const brave = await make("web");
	assert.match(screen(brave), /Brave.*Connected/);
	assert.match(screen(brave), /── Keyless/);
}));

test("key editor rejects Pi commands and references before probing", () => isolated(async ({ auth, make }) => {
	let probes = 0;
	const panel = await make("exa", { check: async () => { probes++; return "offline"; } });
	await panel.handleInput(right);
	for (const expression of ["!fixture", "$EXA_FROM_SHELL", "prefix-${EXA_FROM_SHELL}"]) {
		await panel.handleInput(enter);
		await panel.handleInput(expression);
		await panel.handleInput(enter);
		assert.match(screen(panel), /literal API key/);
		await panel.handleInput(esc);
	}
	assert.equal(probes, 0);
	assert.equal(JSON.parse(await readFile(auth, "utf8")).exa, undefined);
}));

test("GitHub verifies access to code search rather than user identity or any HTTP 200", async () => {
	const valid = await checkApiKey("github", "install-token", undefined, async (raw, init) => {
		const url = new URL(raw);
		assert.equal(url.pathname, "/search/code");
		assert.equal(url.searchParams.get("per_page"), "1");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer install-token");
		return Response.json({ items: [], total_count: 0, incomplete_results: false });
	});
	assert.equal(valid, "accepted");
	for (const body of ["<html>proxy page</html>", '{"login":"proxy"}', '{"items":[]}']) {
		assert.equal(await checkApiKey("github", "install-token", undefined, async () => new Response(body)), "offline");
	}
	assert.equal(await checkApiKey("github", "install-token", undefined, async () => new Response(null, { status: 403 })), "rejected");
	assert.equal(await checkApiKey("github", "install-token", undefined, async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })), "offline");
});

test("panel promotions and fallback edits preserve a second writer's changes", () => isolated(async ({ config, make }) => {
	await writeFile(config, '{"web":{"provider":"exa","fallback":["parallel"]}}');
	const primary = await make("web");
	await saveSearchSetting({ kind: "include", family: "web", provider: "brave" });
	await press(primary, right, down, enter);
	assert.deepEqual(primary.settings.web, { provider: "parallel", fallback: ["exa", "brave"] });

	const fallback = await make("fallback");
	await fallback.handleInput(enter);
	await fallback.handleInput(down);
	// A second writer promotes the originally selected primary and moves the old one into the chain.
	const promote: SearchSettingEdit = { kind: "promote", family: "web", provider: "exa" };
	await saveSearchSetting(promote);
	await fallback.handleInput(" ");
	assert.deepEqual(fallback.settings.web, { provider: "exa", fallback: ["parallel"] });

	await saveSearchSetting({ kind: "include", family: "web", provider: "brave" });
	const ordering = await make("fallback");
	await ordering.handleInput(enter);
	assert.match(screen(ordering), /Shift ↓ Reorder/);
	await saveSearchSetting({ kind: "remove", family: "web", provider: "brave" });
	await ordering.handleInput("\x1b[1;2B");
	assert.deepEqual(ordering.settings.web.fallback, ["parallel"]);
	assert.doesNotMatch(screen(ordering), /Saved|Reorder/);
}));

test("tiny fallback editor always shows the option Space will edit", () => isolated(async ({ make }) => {
	const panel = await make("fallback", { rows: 6 });
	await panel.handleInput(enter);
	await panel.handleInput(down);
	assert.match(screen(panel, 60), /› – {2}Brave/);
	await panel.handleInput(" ");
	assert.match(screen(panel, 60), /› 2 {2}Brave/);
	assert.deepEqual(panel.settings.web.fallback, ["parallel", "brave"]);
}));

test("Open file passes a quoted editor and a separate config argument, without using the shell", () => isolated(async ({ config, make }) => {
	const script = join(config, "..", "test editor.mjs");
	await writeFile(script, 'import { writeFileSync } from "node:fs"; await new Promise((done) => setTimeout(done, 100)); if (process.argv[2] === "--wait") writeFileSync(process.argv[3], "{}");');
	await writeFile(config, "{invalid");
	const env = { VISUAL: process.env.VISUAL, SHELL: process.env.SHELL };
	process.env.VISUAL = `"${process.execPath}" "${script}" --wait`;
	process.env.SHELL = "nonexistent-fish";
	try {
		const lifecycle: string[] = [];
		const panel = await make("web", { tui: { ...terminal, stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start") } });
		const editing = panel.handleInput("o");
		await new Promise<void>((done) => setImmediate(done));
		assert.equal(panel.busy, true);
		assert.deepEqual(lifecycle, ["stop"]);
		await editing;
		assert.deepEqual(lifecycle, ["stop", "start"]);
		assert.equal(await readFile(config, "utf8"), "{}");
		assert.equal(panel.error, undefined);
	} finally {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}));

test("Windows editor arguments preserve executable and config paths containing spaces", () => {
	const path = String.raw`C:\Users\Test User\web-search.json`;
	assert.deepEqual(editorInvocation("code --wait", path, undefined, "win32"), ["code", "--wait", path]);
	const vim = String.raw`C:\Program Files\Vim\vim.exe`;
	assert.deepEqual(editorInvocation(`"${vim}" -f`, path, 4, "win32"), [vim, "-f", "+4", path]);
	assert.equal(editorInvocation('code "--wait', path, undefined, "win32"), undefined);
});

test("Open file launches an extensionless command through its Windows .cmd shim", { skip: process.platform !== "win32" && "requires Windows cmd.exe" }, () => isolated(async ({ config, make }) => {
	const shim = join(config, "..", "test editor");
	await writeFile(`${shim}.cmd`, '@echo off\r\nif not "%~1"=="--wait" exit /b 1\r\n>"%~2" echo {}\r\n');
	await writeFile(config, "{invalid");
	const visual = process.env.VISUAL;
	process.env.VISUAL = `"${shim}" --wait`;
	try {
		const panel = await make("web");
		await panel.handleInput("o");
		assert.equal((await readFile(config, "utf8")).trim(), "{}");
		assert.equal(panel.error, undefined);
	} finally { if (visual === undefined) delete process.env.VISUAL; else process.env.VISUAL = visual; }
}));

test("a failed editor launch restores and redraws the TUI", () => isolated(async ({ config, make }) => {
	await writeFile(config, "{invalid");
	const visual = process.env.VISUAL;
	process.env.VISUAL = `"${join(config, "..", "missing editor")}"`;
	try {
		const lifecycle: string[] = [];
		const tui = { ...terminal, stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start"), requestRender: (force?: boolean) => { if (force) lifecycle.push("redraw"); } };
		const panel = await make("web", { tui });
		await panel.handleInput("o");
		assert.deepEqual(lifecycle, ["stop", "start", "redraw"]);
		assert.equal(panel.busy, false);
		assert.match(panel.message?.text ?? "", /Couldn't open/);
	} finally { if (visual === undefined) delete process.env.VISUAL; else process.env.VISUAL = visual; }
}));

test("tiny classifier editor shows the option Enter will select", () => isolated(async ({ make }) => {
	const models = [{ provider: "opencode", id: "jev-1.13" }];
	const registry = { getModelsOfType: () => models, getAvailableOfType: async () => models } as unknown as PanelContext["modelRegistry"];
	const panel = await make("classifier", { rows: 5, registry });
	await panel.handleInput(enter);
	assert.match(screen(panel, 50), /› None/);
	await panel.handleInput(down);
	assert.match(screen(panel, 50), /› .*jev/);
	assert.doesNotMatch(screen(panel, 50), /› None/);
	await panel.handleInput(enter);
	assert.match(panel.pin ?? "", /jev/);
}));

test("delete confirmation cannot move to another account or remove a changed key", () => isolated(async ({ auth, make }) => {
	await writeFile(auth, JSON.stringify({ exa: { type: "api_key", key: "old" }, parallel: { type: "api_key", key: "another" } }));
	const panel = await make("exa");
	await press(panel, right, down, enter);
	assert.equal(panel.removing, true);
	await removeApiKey("exa", auth);
	await press(panel, left, down);
	assert.equal(panel.selected, "parallel");
	assert.equal(panel.removing, false);
	await press(panel, right, down, enter);
	assert.equal(panel.removing, true);
	assert.equal(JSON.parse(await readFile(auth, "utf8")).parallel.key, "another");
	await storeApiKey("parallel", "new", auth);
	await panel.handleInput(enter);
	assert.match(panel.message?.text ?? "", /key.*changed/);
	assert.equal(JSON.parse(await readFile(auth, "utf8")).parallel.key, "new");
	await press(panel, enter, enter);
	assert.deepEqual(JSON.parse(await readFile(auth, "utf8")), {});
}));

test("a five-row panel shows masked xterm key input and checking status", () => isolated(async ({ make }) => {
	let checked: string | undefined, finish!: (status: KeyCheck) => void;
	const panel = await make("exa", { rows: 5, check: async (_id, key) => {
		checked = key; return new Promise((resolve) => { finish = resolve; });
	} });
	await press(panel, right, enter, "\x1b[27;2;65~");
	await panel.handleInput("\x1b[27;3;66~");
	await panel.handleInput("\x1b[27;5;68~");
	await panel.handleInput("\x1b[200~demo\x1b[201~");
	assert.match(screen(panel, 50), /Key.*•••••/);
	assert.doesNotMatch(screen(panel, 50), /Ademo|No key/);
	const saving = panel.handleInput(enter);
	assert.equal(checked, "Ademo");
	assert.match(screen(panel, 50), /Checking…/);
	finish("accepted");
	await saving;
}));

test("cancelling the panel kills the editor and restores the TUI before completion", () => isolated(async ({ config, make }) => {
	const script = join(config, "..", "wait.mjs");
	await writeFile(script, 'await new Promise((resolve) => setTimeout(resolve, 2000)); process.exitCode = 1;');
	await writeFile(config, "{invalid");
	const visual = process.env.VISUAL;
	process.env.VISUAL = `"${process.execPath}" "${script}"`;
	try {
		const lifecycle: string[] = [];
		const tui = { ...terminal, stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start") };
		const panel = await make("web", { tui, done: () => lifecycle.push("done") });
		const editing = panel.handleInput("o");
		const start = Date.now();
		panel.finish();
		assert.deepEqual(lifecycle, ["stop", "start", "done"]);
		await editing;
		assert.ok(Date.now() - start < 1600);
		assert.deepEqual(lifecycle, ["stop", "start", "done"]);
		assert.equal(panel.message, undefined);
	} finally { if (visual === undefined) delete process.env.VISUAL; else process.env.VISUAL = visual; }
}));

test("ranking readiness checks the exact pin on load and after changing it", () => isolated(async ({ config, make }) => {
	const retired = { provider: "opencode", id: "jev-retired" };
	const ready = { provider: "opencode", id: "jev-ready" };
	await writeFile(config, JSON.stringify({ research: { enabled: true }, classifier: { enabled: true, provider: retired.provider, model: retired.id } }));
	let release!: () => void;
	const delayed = new Promise<void>((done) => { release = done; });
	const checks: string[] = [];
	const registry = {
		findOfType: (_type: string, _provider: string, model: string) => { checks.push(model); return [retired, ready].find((entry) => entry.id === model); },
		getModelsOfType: () => [retired, ready],
		getAvailableOfType: async () => { await delayed; return [ready]; },
		getProviderAuthStatus: () => ({ configured: true }),
	} as unknown as PanelContext["modelRegistry"];
	const panel = await make("classifier", { registry });
	assert.match(screen(panel), /◌ Checking…/);
	assert.equal(panel.classifierAvailable, undefined);
	assert.deepEqual(checks, ["jev-retired"]);
	release();
	await new Promise<void>((done) => setImmediate(done));
	assert.match(screen(panel), /Pinned classifier unavailable/);
	assert.doesNotMatch(screen(panel), /● Ready/);
	await panel.handleInput(enter);
	await panel.handleInput(up);
	await panel.handleInput(enter);
	assert.equal(panel.pin, "opencode/jev-ready");
	assert.deepEqual(checks, ["jev-retired", "jev-ready"]);
	await new Promise<void>((done) => setImmediate(done));
	assert.match(screen(panel), /● Ready/);
}));

test("grouped provider options leave keyless rows quiet and align keyed status glyphs", () => isolated(async ({ auth, make }) => {
	await writeFile(auth, JSON.stringify({ exa: { type: "api_key", key: "saved-exa" }, parallel: { type: "api_key", key: "saved-parallel" } }));
	const panel = await make("web");
	const rows = () => panel.render(100);
	const column = (line: string, marker: string) => {
		const index = line.indexOf(marker);
		assert.ok(index >= 0, `Missing ${marker} in ${line}`);
		return visibleWidth(line.slice(0, index));
	};
	const leftRow = (id: string) => rows().find((line) => new RegExp(`^│\\s+${id}\\s+(?:●|○)`).test(line))!;
	const cols = ["Exa", "Parallel", "GitHub", "Brave"].map((id) => column(leftRow(id), id === "Exa" || id === "Parallel" ? "●" : "○"));
	assert.equal(new Set(cols).size, 1);
	assert.match(screen(panel), /↑↓ Move · → Open · Esc Close/);
	assert.match(screen(panel), /› Web search/);

	await panel.handleInput(right);
	const pane = () => rows().map((line) => line.split("│")[2] ?? "");
	assert.match(pane().join("\n"), /── Keyless.*\n.*› Exa.*current.*\n.*Parallel.*\n.*── Needs a key.*\n.*Brave.*○ No key/s);
	assert.doesNotMatch(pane().find((line) => line.includes("Parallel"))!, /●|○|works without a key/i);
	assert.equal(column(pane().find((line) => line.includes("› Exa"))!, "Exa"), column(pane().find((line) => line.includes("● Ready"))!, "●"));
	// Simulate a second keyed web provider without changing production routing.
	const prior = PROVIDER_AUTH.parallel;
	PROVIDER_AUTH.parallel = "required";
	try {
		const connected = pane().find((line) => line.includes("Parallel"))!;
		const missing = pane().find((line) => line.includes("Brave"))!;
		assert.match(connected, /● Connected/);
		assert.equal(column(connected, "●"), column(missing, "○"));
		await panel.handleInput(down);
		assert.match(pane().join("\n"), /› Parallel/);
		assert.doesNotMatch(pane().join("\n"), /› ──/);
	} finally { PROVIDER_AUTH.parallel = prior; }
	for (const width of [1, 12, 23, 24, 55, 67, 68, 88]) {
		assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
	}
	await panel.handleInput(esc);
	assert.equal(panel.right, false);
	assert.equal(panel.selected, "web");
	assert.match(screen(panel), /› Web search/);
}));

test("Check key checks the saved literal without changing it, and Escape ignores late results", () => isolated(async ({ auth, make }) => {
	const original = '{"exa":{"type":"api_key","key":"saved-fixture-key"}}';
	await writeFile(auth, original);
	let signal: AbortSignal | undefined, complete!: (value: KeyCheck) => void;
	const panel = await make("exa", { check: async (provider, key, pending) => {
		assert.equal(provider, "exa"); assert.equal(key, "saved-fixture-key");
		signal = pending;
		return new Promise((done) => { complete = done; });
	} });
	await press(panel, right, up);
	assert.match(screen(panel), /› Check key/);
	let pending = panel.handleInput(enter);
	assert.match(screen(panel), /◌ Checking…/);
	await panel.handleInput(esc);
	assert.equal(panel.right, true);
	assert.equal(signal?.aborted, true);
	complete("accepted");
	await pending;
	assert.doesNotMatch(screen(panel), /Key verified|saved-fixture-key/);
	pending = panel.handleInput(" ");
	complete("accepted");
	await pending;
	assert.match(screen(panel), /✓ Key verified/);
	assert.equal(await readFile(auth, "utf8"), original);
}));

test("Add and Replace refuse stale entries changed during key validation", () => isolated(async ({ auth, make }) => {
	for (const existing of [undefined, "original"]) {
		await writeFile(auth, JSON.stringify(existing ? { exa: { type: "api_key", key: existing } } : {}));
		let complete!: (status: KeyCheck) => void;
		const panel = await make("exa", { check: async () => new Promise((resolve) => { complete = resolve; }) });
		await press(panel, right, enter, "candidate");
		const pending = panel.handleInput(enter);
		await storeApiKey("exa", "second-writer", auth);
		complete("accepted");
		await pending;
		assert.match(screen(panel), /stored credential changed/);
		assert.doesNotMatch(screen(panel), /Saved and verified|candidate|second-writer/);
		assert.equal(JSON.parse(await readFile(auth, "utf8")).exa.key, "second-writer");
	}
}));

test("closing the panel while a verified save waits on the auth lock prevents the write", () => isolated(async ({ auth, make }) => {
	let pending!: Promise<void>;
	let closed = 0;
	const panel = await make("exa", { check: async () => "accepted", done: () => closed++ });
	await press(panel, right, enter, "candidate");
	await withFileLock(await realpath(auth), async () => {
		pending = panel.handleInput(enter);
		await new Promise<void>((done) => setImmediate(done));
		assert.equal(panel.busy, true);
		await panel.handleInput("\x03");
		assert.equal(closed, 1);
	}, 30_000);
	await pending;
	assert.equal(JSON.parse(await readFile(auth, "utf8")).exa, undefined);
	assert.equal(panel.message, undefined);
}));

test("a single backup has no reorder action or save notification", () => isolated(async ({ config, make }) => {
	const panel = await make("fallback");
	await panel.handleInput(right);
	assert.doesNotMatch(screen(panel), /Reorder/);
	await press(panel, "\x1b[1;2A", "\x1b[1;2B");
	assert.doesNotMatch(screen(panel), /Saved/);
	assert.equal(await saveSearchSetting({ kind: "reorder", family: "web", provider: "parallel", delta: 1 }), false);
	await assert.rejects(readFile(config), { code: "ENOENT" });
}));

test("focus changes do not move content in any right pane, including classifier and read-only accounts", () => isolated(async ({ auth, config, make }) => {
	process.env.EXA_API_KEY = "fixture";
	await writeFile(auth, '{"parallel":{"type":"api_key","key":"fixture"}}');
	await writeFile(config, '{"research":{"enabled":true},"classifier":{"enabled":true,"provider":"test","model":"jev"}}');
	const models = [{ provider: "test", id: "jev" }];
	const registry = { getModelsOfType: () => models, getAvailableOfType: async () => models, findOfType: () => models[0] } as unknown as PanelContext["modelRegistry"];
	const pane = (panel: WebSearchPanel) => panel.render(100).map((line) => line.split("│")[2] ?? "").join("\n");
	for (const row of ["web", "fallback", "code", "thorough", "results", "exa", "parallel", "github", "brave", "classifier"] as const) {
		const panel = await make(row, { rows: 30, registry });
		await new Promise<void>((done) => setImmediate(done));
		const before = pane(panel);
		await panel.handleInput(right);
		const after = pane(panel);
		assert.match(after, /›/u, row);
		assert.equal(after.replace("›", " "), before, row);
		if (row === "web" || row === "classifier") {
			const option = after.split("\n").find((line) => line.includes(row === "web" ? "› Exa" : "› test/jev"))!;
			const status = after.split("\n").find((line) => line.includes("● Ready"))!;
			assert.equal(visibleWidth(option.slice(0, option.indexOf("›"))) + 2, visibleWidth(status.slice(0, status.indexOf("●"))));
		}
		await panel.handleInput(left);
		assert.equal(pane(panel), before, row);
	}
	const tiny = await make("exa", { rows: 6 });
	await tiny.handleInput(right);
	assert.match(screen(tiny, 50), /› Read-only/);
	assert.doesNotMatch(screen(tiny, 50), /Choose/);
	const single = await make("web", { rows: 3 });
	assert.match(screen(single, 50), /› Web search/);
	await single.handleInput(down);
	assert.match(screen(single, 50), /› Backup/);
}));

test("wide provider names cannot hide the aligned status glyphs or GitHub's current marker", () => isolated(async ({ auth, config, make }) => {
	await writeFile(auth, '{"parallel":{"type":"api_key","key":"fixture"},"github":{"type":"api_key","key":"fixture"}}');
	await writeFile(config, '{"code":{"provider":"github"}}');
	const original = providerName.exa, authKind = PROVIDER_AUTH.parallel;
	providerName.exa = "界".repeat(24);
	PROVIDER_AUTH.parallel = "required";
	try {
		for (const [width, rows] of [[100, 30], [70, 20], [50, 6]]) {
			const panel = await make("web", { rows });
			await press(panel, right, down);
			const lines = () => panel.render(width).map((line) => width >= 68 ? line.split("│")[2] ?? "" : line);
			const connected = lines().find((line) => /Parallel.*● Connected/.test(line))!;
			assert.ok(connected, `Missing connected status at ${width}×${rows}`);
			await panel.handleInput(down);
			const missing = lines().find((line) => /Brave.*○ No key/.test(line))!;
			assert.ok(missing, `Missing no-key status at ${width}×${rows}`);
			assert.equal(visibleWidth(connected.slice(0, connected.indexOf("●"))), visibleWidth(missing.slice(0, missing.indexOf("○"))));
			const code = await make("code", { rows });
			await code.handleInput(right);
			assert.match(screen(code, width), /› GitHub\s+● Connected\s+current/u);
		}
	} finally {
		providerName.exa = original;
		PROVIDER_AUTH.parallel = authKind;
	}
}));


test("held keys repeat in the key editor while repeated commands stay blocked", () => isolated(async ({ make }) => {
	let checked = 0;
	const panel = await make("parallel", { check: async () => { checked++; return "accepted"; } });
	await press(panel, right, enter);
	for (const chunk of ["a", "\x1b[97;1:2u", "\x1b[97;1:2u", "\x1b[127;1:2u"]) await panel.handleInput(chunk);
	assert.equal((panel.editor as { value?: string } | undefined)?.value, "aa");
	await panel.handleInput("\x1b[13;1:2u");
	assert.equal(checked, 0);
	assert.ok(panel.editor);
}));
