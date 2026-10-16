import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "./settings.js";
import { LogStore } from "./logs.js";
import { buildEvidence } from "./evidence.js";
import { evaluatePolicy } from "./policy.js";
import { NativeReviewer } from "./reviewer.js";
import { ApprovalManager } from "./approval.js";
import { Gate, type GateReviewer, type GateUiContext } from "./gate.js";
import { createCommandHandler, refreshStatus, type CommandCtx } from "./ui.js";
import { EpochController } from "./runtime/epoch.js";
import { reportHealth, type AutomodeHealth } from "./runtime/health.js";
import type { HostShellOptions } from "./runtime/host.js";

/**
 * pi-automode extension entrypoint.
 *
 * Supervised beta, verified on macOS and Linux only (path protection assumes
 * Unix semantics; Windows alias behavior is unproven): while enabled on an
 * unsupported platform the gate fails closed (everything blocks) and the
 * health receipt carries the error so the verified launcher aborts.
 *
 * Stock Pi may silently skip a failed extension, so guarded operation expects
 * the SDK launcher, which verifies this gate's health receipt before starting
 * the TUI and after each runtime replacement. Neither entry point is a
 * sandbox; nothing here claims unattended operation.
 */
export interface AutomodeOptions {
	/** Defaults to Pi's real agent directory (getAgentDir; honors PI_CODING_AGENT_DIR). */
	agentDir?: string;
	/** Canonical workspace; defaults to realpath(process.cwd()). */
	workspace?: string;
	/**
	 * This package's root directory (protected as a whole: bin/, manifest,
	 * startup, sources and dist/). Defaults to the package root containing
	 * this module (src/ in source form, dist/ in built form — both sit one
	 * level below the root).
	 */
	extensionDir?: string;
	/** Host/launcher-owned health receipt. Never agent-facing. */
	onHealth?: (health: AutomodeHealth) => void;
}

const GUARDED_TOOL_NAMES = ["read", "edit", "write", "bash"] as const;

/** Platforms this beta is supported on. Anything else fails closed while On. */
function platformError(): string | null {
	return process.platform === "darwin" || process.platform === "linux"
		? null
		: `unsupported platform "${process.platform}": pi-automode is supported on macOS and Linux only`;
}

export function createAutomodeExtension(options: AutomodeOptions = {}): ExtensionFactory {
	return async (pi: ExtensionAPI) => {
		const health = (h: AutomodeHealth) => reportHealth(options.onHealth, h);
		const agentDir = options.agentDir ?? getAgentDir();
		const workspace = options.workspace ?? canonicalize(process.cwd());
		const extensionDir = options.extensionDir ?? fileURLToPath(new URL("..", import.meta.url));
		const envError = platformError();

		let settings: SettingsStore;
		let logs: LogStore;
		try {
			settings = new SettingsStore(join(agentDir, "automode.json"));
			await settings.load();
			// Operational decision log store, not a settings store; the whole
			// agent directory is protected on native routes.
			logs = new LogStore(join(agentDir, "automode-logs.json"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			health({ initialized: false, guardedTools: [], enabled: false, error: message });
			// Surface the failure to the loader (and the launcher's errors check)
			// rather than loading an unguarded extension.
			throw error;
		}

		// Shadow reviewer wiring failure is visible, never silently swallowed;
		// local policy still enforces/asks without it and never consumes a
		// shadow result as permission.
		let nativeReviewer: NativeReviewer | null = null;
		let reviewerError: string | undefined;
		try {
			nativeReviewer = new NativeReviewer();
		} catch (error) {
			reviewerError = `shadow reviewer unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
		const reviewer: GateReviewer | null = nativeReviewer;

		const epochs = new EpochController();
		const approval = new ApprovalManager({ settings, epochs });
		const host = (): HostShellOptions => {
			const out: HostShellOptions = {};
			let effective: ReturnType<ExtensionAPI["getSettings"]> | undefined;
			try {
				effective = pi.getSettings();
			} catch {
				effective = undefined;
			}
			if (typeof effective?.shellPath === "string") out.shellPath = effective.shellPath;
			if (typeof effective?.shellCommandPrefix === "string") out.shellCommandPrefix = effective.shellCommandPrefix;
			if (typeof effective?.images?.autoResize === "boolean") out.imageAutoResize = effective.images.autoResize;
			return out;
		};
		const dirs = { workspace, agentDir, extensionDir };
		const gate = new Gate({
			settings,
			logs,
			buildEvidence,
			evaluatePolicy,
			reviewer,
			approval,
			epochs,
			dirs,
			host,
			environmentError: () => envError,
		});

		// Enforcement rides Pi's tool_call hook: the host awaits this handler
		// before executing, so the gate reviews the final arguments, blocks or
		// asks locally, and writes the reviewed target back into the event input.
		// No tool is registered, so the gate never conflicts with tool-providing
		// extensions such as a custom read/edit/write implementation. While Off
		// this hook has no opinion and logs nothing.
		pi.on("tool_call", (event, ctx) =>
			gate.reviewToolCall(
				{
					toolName: event.toolName,
					input: event.input as Record<string, unknown>,
					toolCallId: event.toolCallId,
					...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
				},
				{
					mode: ctx.mode,
					hasUI: ctx.hasUI,
					ui: ctx.ui as GateUiContext["ui"],
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
				},
			),
		);

		const invalidate = (reason: string) => gate.invalidate(reason);
		pi.on("session_before_switch", () => invalidate("session switch"));
		pi.on("session_before_tree", () => invalidate("tree navigation"));
		pi.on("session_before_fork", () => invalidate("session fork"));
		pi.on("session_shutdown", (event) => invalidate(`shutdown:${event.reason}`));

		const uiDeps = {
			settings,
			logs,
			gate,
			approval,
			dirs,
			host,
			guardedTools: GUARDED_TOOL_NAMES,
			...(options.onHealth ? { onHealth: (h: AutomodeHealth) => health(h) } : {}),
		};
		pi.registerCommand("automode", {
			description: "Automode permission review: panel, on/off, rules, logs",
			handler: createCommandHandler(uiDeps),
		});

		// The persistent status line follows gate/approval transitions, not only
		// session_start and panel actions: managed/approval counts move as tool
		// executions begin and end and as turns settle. Best-effort display only
		// — never authority.
		const refreshOnTransition = (_event: unknown, ctx: unknown): void => {
			refreshStatus(uiDeps, ctx as CommandCtx);
		};
		pi.on("tool_execution_start", refreshOnTransition);
		pi.on("tool_execution_end", refreshOnTransition);
		pi.on("turn_end", refreshOnTransition);

		// Session identity binds per-session state: the reviewer budget/breaker
		// and the decline-replay suppression reset only when session_start
		// reports a genuinely different session id — never on tree navigation
		// or ordinary policy edits (a same-session identical retry stays
		// suppressed), and /reload re-creates this whole closure anyway.
		let lastSessionId: string | undefined;
		pi.on("session_start", (_event, ctx) => {
			const sessionId = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
			if (sessionId !== undefined && sessionId !== lastSessionId) {
				lastSessionId = sessionId;
				try {
					nativeReviewer?.reset();
				} catch {
					// A reset failure must not break session start; the reviewer's
					// own breaker/budget simply stays in force.
				}
				approval.resetSession();
			}
			refreshStatus(uiDeps, ctx as unknown as CommandCtx);
		});

		const initialError = reviewerError ?? envError ?? (settings.error ? String(settings.error) : undefined);
		health({
			initialized: true,
			guardedTools: [...GUARDED_TOOL_NAMES],
			enabled: settings.current?.enabled === true,
			...(initialError ? { error: initialError } : {}),
		});
	};
}

function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Standard entrypoint: the default export is the extension factory. */
export default createAutomodeExtension();
