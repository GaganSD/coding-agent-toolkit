/**
 * pi-automode verified SDK launcher.
 *
 * Starts Pi 1.1.0 through the exported SDK (`createAgentSessionRuntime` +
 * `InteractiveMode`) with an isolated resource set:
 *
 * - exactly one inline extension: the Automode gate (`createAutomodeExtension`
 *   from `./index.js`, injected by `bin/pi-automode.js`);
 * - exactly four model-facing tools: read, bash, edit, write, all reviewed by
 *   the gate's `tool_call` hook;
 * - no user or project executable extensions, no built-in MCP/codemode/
 *   tool-search/llama.cpp extensions, no project settings (project trust is
 *   never requested and project settings are never merged).
 *
 * The launcher verifies the gate BEFORE the TUI starts and after every
 * runtime replacement (`/new`, `/resume`, `/fork`, import). A gate that fails
 * to load or fails to report a valid health receipt at `session_start`
 * (startup or `/reload`) aborts the process instead of running unguarded.
 *
 * This is a supervision boundary, not a sandbox: see README.md "Limits".
 */

import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	InteractiveMode,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionFactory,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

/** Tools the gate covers and the launcher allowlists. Order is stable. */
export const GUARDED_TOOLS = ["read", "bash", "edit", "write"] as const;

/** Built-in Pi extensions the launcher never loads. */
export const DISABLED_BUILTIN_EXTENSIONS = ["mcp", "codemode", "tool-search", "llama.cpp"] as const;

/** Name of the inline gate extension; appears as `<inline:automode>` in load results. */
export const GATE_EXTENSION_NAME = "automode";

/**
 * Health receipt reported by the gate through `onHealth`.
 * Contract confirmed with the runtime worker: the gate reports after its
 * `session_start` handler completes initialization (it may also report from
 * the factory). `enabled` is the operator On/Off state; Off is a valid,
 * healthy state. `initialized`/`error` describe gate load health only.
 */
export interface AutomodeHealth {
	initialized: boolean;
	guardedTools: string[];
	enabled: boolean;
	error?: string;
}

/** Options the launcher passes to `createAutomodeExtension`. */
export interface AutomodeExtensionOptions {
	agentDir: string;
	workspace: string;
	extensionDir: string;
	onHealth: (health: AutomodeHealth) => void;
}

/** Matches `createAutomodeExtension(options)` exported by `./index.js`. */
export type AutomodeExtensionFactoryProvider = (options: AutomodeExtensionOptions) => ExtensionFactory;

export interface LauncherDeps {
	/** The gate factory provider. Production: `createAutomodeExtension` from `./index.js`. */
	createAutomodeExtension: AutomodeExtensionFactoryProvider;
	/** Working directory for the session. Default: `process.cwd()`. */
	cwd?: string;
	/** Pi agent directory. Default: `getAgentDir()` (respects `PI_CODING_AGENT_DIR`). */
	agentDir?: string;
	/**
	 * Directory passed to the gate as `extensionDir` (its own resource root).
	 * Default: this package's root directory.
	 */
	extensionDir?: string;
	/**
	 * Additional inline extensions loaded next to the gate. Exists for offline
	 * tests (fake provider, argument mutators); production bin passes none.
	 */
	extraInlineExtensions?: InlineExtension[];
	/**
	 * Invoked when the gate fails outside launcher-controlled checkpoints
	 * (e.g. a failed `/reload`). Default: print to stderr, stop the TUI,
	 * dispose the runtime, exit 1. Tests inject a recorder.
	 */
	onFatal?: (message: string) => void;
	/** Output sinks (test seam). */
	out?: (line: string) => void;
	err?: (line: string) => void;
}

export interface GateVerification {
	ok: boolean;
	problems: string[];
	/** 1-based generation of the current gate load; 0 when never loaded. */
	generation: number;
	health?: AutomodeHealth;
}

interface GateGeneration {
	id: number;
	workspace: string;
	health?: AutomodeHealth;
	factoryError?: string;
	/** True once the factory completed and the receipt passed validation at session_start. */
	sessionVerified: boolean;
}

/** Pure health-receipt validation. Shared by every checkpoint. */
export function evaluateHealth(health: AutomodeHealth | undefined): string[] {
	const problems: string[] = [];
	if (health === undefined) {
		return ["gate did not report a health receipt"];
	}
	if (typeof health.initialized !== "boolean" || !Array.isArray(health.guardedTools) || typeof health.enabled !== "boolean") {
		problems.push("gate health receipt has an invalid shape");
		return problems;
	}
	if (!health.initialized) {
		problems.push("gate reported initialized=false");
	}
	if (health.error !== undefined && health.error !== "") {
		problems.push(`gate reported error: ${health.error}`);
	}
	const guarded = new Set(health.guardedTools);
	for (const tool of GUARDED_TOOLS) {
		if (!guarded.has(tool)) {
			problems.push(`gate does not guard tool "${tool}"`);
		}
	}
	return problems;
}

/**
 * Tracks gate generations across startup, `/reload`, and runtime
 * replacement. The gate factory is re-created per generation so `workspace`
 * follows the effective cwd of each runtime.
 */
export class GateSupervisor {
	private readonly generations: GateGeneration[] = [];
	private current: GateGeneration | undefined;
	private fatalNotified = false;
	private readonly deps: LauncherDeps;
	private readonly onFatal: (message: string) => void;

	constructor(deps: LauncherDeps, onFatal: (message: string) => void) {
		this.deps = deps;
		this.onFatal = onFatal;
	}

	/** Inline extension entry handed to the resource loader. */
	inlineExtension(): InlineExtension {
		return { name: GATE_EXTENSION_NAME, factory: (pi) => this.loadGeneration(pi) };
	}

	/** Called by the runtime factory before services are created for a cwd. */
	prepareGeneration(workspace: string): void {
		this.pendingWorkspace = workspace;
	}

	private pendingWorkspace: string | undefined;

	private async loadGeneration(pi: Parameters<ExtensionFactory>[0]): Promise<void> {
		const agentDir = this.deps.agentDir ?? getAgentDir();
		const generation: GateGeneration = {
			id: this.generations.length + 1,
			workspace: this.pendingWorkspace ?? this.deps.cwd ?? process.cwd(),
			sessionVerified: false,
		};
		this.generations.push(generation);
		this.current = generation;
		try {
			// Provider construction AND factory execution share one failure
			// path: the SDK loader swallows a provider throw exactly like a
			// factory throw, so both must be recorded and escalated here.
			const gateFactory = this.deps.createAutomodeExtension({
				agentDir,
				workspace: generation.workspace,
				extensionDir: this.deps.extensionDir ?? defaultExtensionDir(),
				onHealth: (health) => {
					generation.health = health;
				},
			});
			await gateFactory(pi);
		} catch (error) {
			generation.factoryError = errorMessage(error);
			// Reload path: the loader swallows factory errors and would continue
			// unguarded, so escalate asynchronously. Startup/replacement paths
			// additionally surface this through extensionsResult.errors.
			this.failAsync(generation, `gate factory failed: ${generation.factoryError}`);
			throw error;
		}
		// The gate registers its handlers above; ours runs after them, so a
		// session_start-time health receipt is visible when this handler runs.
		pi.on("session_start", () => {
			const problems = evaluateHealth(generation.health);
			if (problems.length > 0) {
				this.failAsync(generation, `gate health check failed at session_start: ${problems.join("; ")}`);
				return;
			}
			generation.sessionVerified = true;
		});
	}

	private failAsync(generation: GateGeneration, message: string): void {
		generation.factoryError ??= message;
		// Never throw across the loader boundary here; the loader would only
		// record and continue. Fail the process on the next tick instead.
		queueMicrotask(() => {
			if (this.fatalNotified) return;
			this.fatalNotified = true;
			this.onFatal(message);
		});
	}

	currentGeneration(): number {
		return this.current?.id ?? 0;
	}

	currentHealth(): AutomodeHealth | undefined {
		return this.current?.health;
	}

	/**
	 * Checkpoint A (load boundary): runs inside the runtime factory, before any
	 * TUI or prompt. Verifies the loader recorded no errors, the gate extension
	 * is present, and it registered its tool_call enforcement hook.
	 */
	verifyLoad(extensionsResult: {
		extensions: Array<{ path: string; tools: Map<string, unknown>; handlers: Map<string, unknown[]> }>;
		errors: Array<{ path: string; error: string }>;
	}): GateVerification {
		const problems: string[] = [];
		const generation = this.current;
		if (generation?.factoryError !== undefined) {
			problems.push(`gate factory failed: ${generation.factoryError}`);
		}
		for (const { path, error } of extensionsResult.errors) {
			problems.push(`extension load error at ${path}: ${error}`);
		}
		const gate = extensionsResult.extensions.find((extension) => extension.path === `<inline:${GATE_EXTENSION_NAME}>`);
		if (gate === undefined) {
			problems.push(`gate extension <inline:${GATE_EXTENSION_NAME}> is not loaded`);
		} else if ((gate.handlers.get("tool_call") ?? []).length === 0) {
			problems.push("gate did not register its tool_call enforcement hook");
		}
		// Health may legitimately arrive later (at session_start); if the gate
		// already reported, validate now and fail early on a bad receipt.
		if (generation?.health !== undefined) {
			problems.push(...evaluateHealth(generation.health));
		}
		const result: GateVerification = {
			ok: problems.length === 0,
			problems,
			generation: generation?.id ?? 0,
		};
		if (generation?.health !== undefined) {
			result.health = generation.health;
		}
		return result;
	}

	/**
	 * Checkpoint B (post-session_start): used by `--check`, which binds
	 * extensions headlessly. Requires a valid health receipt.
	 */
	verifySessionStart(): GateVerification {
		const generation = this.current;
		const problems = generation === undefined ? ["gate factory never ran"] : evaluateHealth(generation.health);
		// A recorded factory error fails the generation even when a (partial)
		// valid health receipt was already sent: a failed generation is never
		// treated as healthy.
		if (generation?.factoryError !== undefined) {
			problems.unshift(`gate factory failed: ${generation.factoryError}`);
		}
		const result: GateVerification = {
			ok: problems.length === 0,
			problems,
			generation: generation?.id ?? 0,
		};
		if (generation?.health !== undefined) {
			result.health = generation.health;
		}
		return result;
	}
}

/** Error thrown by the runtime factory when the gate cannot be verified. */
export class GateVerificationError extends Error {
	readonly verification: GateVerification;
	constructor(verification: GateVerification) {
		super(`pi-automode gate verification failed:\n${verification.problems.map((p) => `  - ${p}`).join("\n")}`);
		this.name = "GateVerificationError";
		this.verification = verification;
	}
}

export interface VerifiedRuntime {
	runtime: AgentSessionRuntime;
	supervisor: GateSupervisor;
}

function defaultExtensionDir(): string {
	// src/launcher.ts (dev) and dist/launcher.js (built) both sit one level
	// below the package root.
	return fileURLToPath(new URL("..", import.meta.url));
}

/**
 * Build the `CreateAgentSessionRuntimeFactory` with the isolated resource
 * set and verified gate. Reused for the initial runtime and every later
 * `/new`, `/resume`, `/fork`, and import replacement.
 */
export function createVerifiedRuntimeFactory(
	deps: LauncherDeps,
	supervisor: GateSupervisor,
): CreateAgentSessionRuntimeFactory {
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		supervisor.prepareGeneration(cwd);
		// Project settings are never merged: no project defaultTools widening,
		// project package/extension declarations, or project credential
		// commands can affect this session.
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			resourceLoaderOptions: {
				// No discovered user/project extensions and no built-in
				// extensions; the only executable extension code is the gate
				// (plus the test-only extraInlineExtensions seam).
				noExtensions: true,
				disabledBuiltinExtensions: [...DISABLED_BUILTIN_EXTENSIONS],
				extensionFactories: [supervisor.inlineExtension(), ...(deps.extraInlineExtensions ?? [])],
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
			// Plain-name allowlist: exactly the four guarded tools are active.
			tools: [...GUARDED_TOOLS],
		});
		const verification = supervisor.verifyLoad(services.resourceLoader.getExtensions());
		if (!verification.ok) {
			throw new GateVerificationError(verification);
		}
		return { ...created, services, diagnostics: services.diagnostics };
	};
}

/**
 * Create a verified runtime: the gate is checked inside the factory, before
 * this resolves and before any TUI or model prompt exists.
 */
export async function createVerifiedRuntime(
	deps: LauncherDeps,
	options?: { sessionManager?: SessionManager },
): Promise<VerifiedRuntime> {
	const cwd = deps.cwd ?? process.cwd();
	const agentDir = deps.agentDir ?? getAgentDir();
	const onFatal = deps.onFatal ?? defaultFatal(() => undefined, () => undefined);
	const supervisor = new GateSupervisor(deps, onFatal);
	const runtime = await createAgentSessionRuntime(createVerifiedRuntimeFactory(deps, supervisor), {
		cwd,
		agentDir,
		sessionManager: options?.sessionManager ?? SessionManager.create(cwd),
	});
	return { runtime, supervisor };
}

export interface CheckResult {
	code: number;
	lines: string[];
}

/**
 * `pi-automode --check`: verified startup without the TUI, without session
 * files, and without any model call. Binds extensions headlessly so the
 * gate's session_start-time health receipt is validated too.
 */
export async function runCheck(deps: LauncherDeps): Promise<CheckResult> {
	const lines: string[] = [];
	const cwd = deps.cwd ?? process.cwd();
	let runtime: AgentSessionRuntime | undefined;
	try {
		const verified = await createVerifiedRuntime(deps, {
			sessionManager: SessionManager.inMemory(cwd),
		});
		runtime = verified.runtime;
		// Emit session_start so the gate initializes and reports health.
		// onError keeps the binding set non-empty, which is what makes
		// session.reload() re-emit session_start on this code path as well.
		await runtime.session.bindExtensions({ onError: () => {} });
		const verification = verified.supervisor.verifySessionStart();
		if (!verification.ok) {
			for (const problem of verification.problems) lines.push(`gate: ${problem}`);
			return { code: 1, lines };
		}
		const active = runtime.session.getActiveToolNames().slice().sort();
		const expected = [...GUARDED_TOOLS].slice().sort();
		if (active.join(",") !== expected.join(",")) {
			lines.push(`tools: active tools are [${active.join(", ")}], expected [${expected.join(", ")}]`);
			return { code: 1, lines };
		}
		const health = verification.health;
		lines.push(`pi-automode gate verified (generation ${verification.generation})`);
		lines.push(`state: ${health?.enabled ? "ON" : "OFF"}`);
		lines.push(`tools: ${expected.join(", ")} (guarded)`);
		lines.push(`workspace: ${cwd}`);
		return { code: 0, lines };
	} catch (error) {
		if (error instanceof GateVerificationError) {
			lines.push(error.message);
		} else {
			lines.push(`pi-automode startup failed: ${errorMessage(error)}`);
		}
		return { code: 1, lines };
	} finally {
		if (runtime !== undefined) {
			await runtime.dispose().catch(() => {});
		}
	}
}

const USAGE = `pi-automode — verified Pi launcher with the Automode permission gate

Usage:
  pi-automode           Start the Pi TUI after verifying the gate
  pi-automode --check   Verify gate startup and exit (no TUI, no model calls)
  pi-automode --help    Show this help

The launcher loads only the Automode gate extension and the four guarded
tools (read, bash, edit, write). User/project extensions, built-in MCP and
codemode, and project settings are not loaded. This is supervision, not a
sandbox; see README.md.
`;

type ParsedArgs = { kind: "help" } | { kind: "check" } | { kind: "tui" } | { kind: "error"; message: string };

export function parseArgs(argv: string[]): ParsedArgs {
	let check = false;
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (arg === "--check") {
			check = true;
			continue;
		}
		return { kind: "error", message: `unknown argument: ${arg}` };
	}
	return check ? { kind: "check" } : { kind: "tui" };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultFatal(
	getTui: () => InteractiveMode | undefined,
	getRuntime: () => AgentSessionRuntime | undefined,
): (message: string) => void {
	return (message) => {
		process.stderr.write(`\npi-automode: gate lost — aborting instead of running unguarded.\n  ${message}\n`);
		const tui = getTui();
		const runtime = getRuntime();
		try {
			tui?.stop();
		} catch {
			// best effort
		}
		void (runtime?.dispose() ?? Promise.resolve()).finally(() => {
			process.exit(1);
		});
	};
}

/**
 * CLI entry. Returns the process exit code; never makes a paid model call
 * for `--help` or `--check`.
 */
export async function runLauncher(argv: string[], deps: LauncherDeps): Promise<number> {
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
	const parsed = parseArgs(argv);
	switch (parsed.kind) {
		case "help":
			out(USAGE);
			return 0;
		case "error":
			err(`pi-automode: ${parsed.message}`);
			err(USAGE);
			return 2;
		case "check": {
			const result = await runCheck(deps);
			for (const line of result.lines) (result.code === 0 ? out : err)(line);
			return result.code;
		}
	}

	// TUI mode.
	let runtime: AgentSessionRuntime | undefined;
	let tui: InteractiveMode | undefined;
	const fatal = deps.onFatal ?? defaultFatal(() => tui, () => runtime);
	const supervisedDeps: LauncherDeps = { ...deps, onFatal: fatal };
	try {
		const verified = await createVerifiedRuntime(supervisedDeps);
		runtime = verified.runtime;
		// Fail before the TUI on host diagnostics errors, like the stock CLI.
		const errors = runtime.diagnostics.filter((d: AgentSessionRuntimeDiagnostic) => d.type === "error");
		if (errors.length > 0) {
			for (const d of errors) err(`pi-automode: ${d.message}`);
			await runtime.dispose().catch(() => {});
			return 1;
		}
		// Re-verify the gate after every runtime replacement. The replacement
		// factory already re-ran checkpoint A; a bad gate here means the
		// session must not continue.
		runtime.setRebindSession(async () => {
			if (runtime === undefined) return;
			const verification = verified.supervisor.verifyLoad(runtime.services.resourceLoader.getExtensions());
			if (!verification.ok) {
				fatal(`gate verification failed after session replacement: ${verification.problems.join("; ")}`);
			}
		});
		const startupDiagnostics = [...runtime.diagnostics];
		tui = new InteractiveMode(runtime, {
			startupDiagnostics,
			...(runtime.modelFallbackMessage !== undefined ? { modelFallbackMessage: runtime.modelFallbackMessage } : {}),
		});
		await tui.run();
		await runtime.dispose();
		return 0;
	} catch (error) {
		if (error instanceof GateVerificationError) {
			err(error.message);
		} else {
			err(`pi-automode startup failed: ${errorMessage(error)}`);
		}
		if (runtime !== undefined) {
			await runtime.dispose().catch(() => {});
		}
		return 1;
	}
}
