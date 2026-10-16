import { constants as fsConstants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";

import { AutomodeBlockError, type Gate, type GuardExecution, type GateUiContext } from "./gate.js";
import { isSupportedTool, type SupportedTool } from "./runtime/freeze.js";
import type { HostShellOptions } from "./runtime/host.js";

/**
 * Wrapped built-in tool definitions. Registering these replaces the stock
 * read/edit/write/bash definitions by name; the wrapper execute() runs at the
 * final boundary, AFTER every tool_call hook, so it sees and enforces the
 * final post-hook arguments.
 *
 * - Off: delegate to a stock definition built with the host's configured
 *   options (bash commandPrefix/shellPath, read autoResizeImages + stock
 *   fallback path variants) with the original args object untouched — no
 *   policy, no logs, stock behavior.
 * - On: delegate to a plain factory definition (no shell prefix, no spawn
 *   hook) and only after the gate approves the frozen final args. For read,
 *   the On delegate enforces the reviewed literal/canonical target at the
 *   native IO boundary (access/readFile/mime-detect) via custom operations,
 *   so the helper's AM/PM, NFD or curly-quote fallback variants can NEVER
 *   read a file that was not reviewed — even if the reviewed target vanishes
 *   after the gate's checks.
 *
 * No prepareArguments shim: a definition's own prepareArguments runs before
 * hooks and would not reflect the final arguments anyway.
 */

/** Structural minimum of Pi's ToolDefinition we rely on. */
export interface StockToolDefinition {
	name: string;
	execute(
		toolCallId: string,
		params: never,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<unknown>;
}

/** Structural match of Pi's public ReadOperations (createReadToolDefinition options). */
export interface ReadOperationsLike {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

export interface ReadFactoryOptions {
	autoResizeImages?: boolean;
	operations?: ReadOperationsLike;
}

export interface StockToolFactories {
	read(cwd: string, options?: ReadFactoryOptions): StockToolDefinition;
	edit(cwd: string): StockToolDefinition;
	write(cwd: string): StockToolDefinition;
	bash(cwd: string, options?: { commandPrefix?: string; shellPath?: string }): StockToolDefinition;
}

export interface WrappedToolsDeps {
	cwd: string;
	gate: Gate;
	factories: StockToolFactories;
	host: () => HostShellOptions;
	/**
	 * Native image MIME detection (Pi's detectSupportedImageMimeTypeFromFile),
	 * used by the On read operations so supported native image behavior is
	 * preserved. Optional: without it, images read as text notes while On.
	 */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const WRAPPED_TOOLS: readonly SupportedTool[] = ["read", "edit", "write", "bash"];

export function createWrappedTools(deps: WrappedToolsDeps): StockToolDefinition[] {
	// Registration-time definitions carry the model-facing schema/metadata.
	// Built from plain factories only — no host settings access at load time.
	const registrationDefs = new Map<SupportedTool, StockToolDefinition>();
	for (const name of WRAPPED_TOOLS) {
		registrationDefs.set(name, buildStock(deps.factories, deps.cwd, name, "on", {}));
	}

	// Execute-time stock delegates, memoized by mode + frozen session cwd +
	// relevant host options so a settings change is picked up without
	// rebuilding unaffected variants. The cwd is part of the cache key: a
	// delegate built for one session cwd must never resolve relative args
	// against another. Read while On is NOT memoized: its operations bind the
	// per-call reviewed target (see buildOnRead).
	const delegateCache = new Map<string, StockToolDefinition>();
	const delegate = (mode: "on" | "off", name: SupportedTool, cwd: string): StockToolDefinition => {
		const host = deps.host();
		const key = `${mode}:${name}:${cwd}:${JSON.stringify({
			p: mode === "off" ? (host.shellCommandPrefix ?? "") : "",
			s: mode === "off" ? (host.shellPath ?? "") : "",
			r: host.imageAutoResize ?? true,
		})}`;
		const cached = delegateCache.get(key);
		if (cached) return cached;
		const def = buildStock(deps.factories, cwd, name, mode, host);
		delegateCache.set(key, def);
		return def;
	};

	return WRAPPED_TOOLS.map((name) => {
		const base = registrationDefs.get(name) as StockToolDefinition;
		const wrapped: StockToolDefinition = {
			...base,
			name,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				// Freeze the session cwd NOW, before any await: ctx is a shared
				// mutable object, and review + stock execution must resolve
				// relative args against the SAME directory — the one that was
				// reviewed. Falls back to the registration cwd when absent.
				const rawCwd = (ctx as { cwd?: unknown } | null | undefined)?.cwd;
				const sessionCwd = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : deps.cwd;
				if (deps.gate.state === "off") {
					// Deliberate Off: stock execution, original args, session cwd,
					// no policy, no logs.
					return delegate("off", name, sessionCwd).execute(toolCallId, params, signal, onUpdate, ctx);
				}
				return deps.gate.executeGuarded({
					tool: name,
					args: params,
					requestId: toolCallId,
					ctx: toGateContext(ctx),
					...(signal !== undefined ? { turnSignal: signal } : {}),
					run: (frozenArgs, guard) => {
						// The gate-frozen entry cwd wins; the wrapper-frozen session
						// cwd is the fallback for gates that do not thread a guard.
						const execCwd = guard?.cwd ?? sessionCwd;
						// On bash: the plain factory, never a host prefix/shellPath.
						// On read: a per-call definition whose operations enforce the
						// reviewed target at the native IO boundary.
						const def = name === "read" ? buildOnRead(deps, frozenArgs, guard, execCwd) : delegate("on", name, execCwd);
						// Never hand stock execute the mutable shared ctx: Pi's helpers
						// resolve against ctx?.cwd AT EXECUTION TIME, so a late ctx.cwd
						// mutation would retarget a reviewed command. Pass a frozen
						// shallow copy pinned to the gate-frozen cwd (other ctx fields
						// kept). The Off path deliberately keeps the stock ctx.
						const execCtx = Object.freeze({ ...(ctx as Record<string, unknown> | null | undefined), cwd: execCwd });
						return def.execute(toolCallId, frozenArgs as never, guard?.signal ?? signal, onUpdate, execCtx);
					},
				});
			},
		};
		return wrapped;
	});
}

/**
 * On-mode read definition with IO-boundary enforcement. Every native IO op
 * (access, readFile, image mime detection) receives the path the helper
 * actually resolved — after its AM/PM, NFD and curly-quote fallback variants
 * — and only the reviewed literal target (whose canonical identity was
 * fingerprinted into the evidence) may be touched. Any deviation throws,
 * so a disappearing reviewed target can never become an unreviewed read of
 * a fallback variant.
 */
function buildOnRead(
	deps: WrappedToolsDeps,
	frozenArgs: Record<string, unknown>,
	guard: GuardExecution | undefined,
	cwd: string,
): StockToolDefinition {
	const reviewedPath = typeof frozenArgs.path === "string" ? frozenArgs.path : "";
	const reviewedCanonical = guard?.canonicalPath;
	const assertReviewed = async (absolutePath: string): Promise<void> => {
		if (absolutePath !== reviewedPath) {
			throw new AutomodeBlockError(
				`read IO boundary: the helper resolved "${absolutePath}", which was never reviewed; fallback path variants are not reviewable while Automode is on`,
			);
		}
		if (reviewedCanonical !== undefined) {
			// Canonical-to-canonical comparison: a post-review symlink retarget
			// keeps the literal bytes but redirects the real file — fail closed
			// rather than read through a swapped link.
			const now = await fsRealpath(absolutePath).catch(() => undefined);
			if (now === undefined) {
			throw new AutomodeBlockError("read IO boundary: target vanished after review; fallback variants are not reviewable");
			}
			if (now !== reviewedCanonical) {
				throw new AutomodeBlockError("read IO boundary: canonical target changed after review");
			}
		}
	};
	const operations: ReadOperationsLike = {
		access: async (absolutePath) => {
			await assertReviewed(absolutePath);
			await fsAccess(absolutePath, fsConstants.R_OK);
		},
		readFile: async (absolutePath) => {
			await assertReviewed(absolutePath);
			return fsReadFile(absolutePath);
		},
	};
	if (deps.detectImageMimeType !== undefined) {
		const detect = deps.detectImageMimeType;
		operations.detectImageMimeType = async (absolutePath) => {
			await assertReviewed(absolutePath);
			return detect(absolutePath);
		};
	}
	const host = deps.host();
	const options: ReadFactoryOptions = { operations };
	if (typeof host.imageAutoResize === "boolean") options.autoResizeImages = host.imageAutoResize;
	// Per-call frozen cwd: the helper's relative-path resolution must match
	// the directory the gate reviewed against, never the registration cwd.
	return deps.factories.read(cwd, options);
}

function buildStock(
	factories: StockToolFactories,
	cwd: string,
	name: SupportedTool,
	mode: "on" | "off",
	host: HostShellOptions,
): StockToolDefinition {
	switch (name) {
		case "read": {
			const options: ReadFactoryOptions = {};
			if (typeof host.imageAutoResize === "boolean") options.autoResizeImages = host.imageAutoResize;
			return factories.read(cwd, options);
		}
		case "edit":
			return factories.edit(cwd);
		case "write":
			return factories.write(cwd);
		case "bash": {
			// On: plain factory, never a shell prefix or spawn transformation.
			// Off: exactly the host-configured stock behavior.
			if (mode === "on") return factories.bash(cwd);
			const options: { commandPrefix?: string; shellPath?: string } = {};
			if (typeof host.shellCommandPrefix === "string") options.commandPrefix = host.shellCommandPrefix;
			if (typeof host.shellPath === "string") options.shellPath = host.shellPath;
			return factories.bash(cwd, options);
		}
	}
}

function toGateContext(ctx: unknown): GateUiContext {
	const source = (ctx ?? {}) as {
		mode?: unknown;
		hasUI?: unknown;
		ui?: GateUiContext["ui"];
		modelRegistry?: unknown;
		cwd?: unknown;
	};
	return {
		mode: typeof source.mode === "string" ? source.mode : "print",
		hasUI: source.hasUI === true,
		ui: source.ui as GateUiContext["ui"],
		modelRegistry: source.modelRegistry,
		cwd: source.cwd,
	};
}

export { isSupportedTool };
