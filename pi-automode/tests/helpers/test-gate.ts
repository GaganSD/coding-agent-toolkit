/**
 * Test gate: a stand-in for the real `createAutomodeExtension` that follows
 * the confirmed contract — options { agentDir, workspace, extensionDir,
 * onHealth }, a `tool_call` enforcement hook for the four guarded tools and a
 * fail-closed block for every other route, health reported at session_start.
 *
 * It reviews the host's real tool-call input, so the executions that follow
 * perform genuine filesystem/shell operations inside the temp workspace.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	GUARDED_TOOLS,
	type AutomodeExtensionFactoryProvider,
	type AutomodeExtensionOptions,
	type AutomodeHealth,
} from "../../src/launcher.js";

export interface ExecutedCall {
	tool: string;
	/** Frozen final arguments exactly as the gate's tool_call hook reviewed them. */
	args: Record<string, unknown>;
}

export interface TestGateBehavior {
	/** Reported `enabled` in the health receipt. Default true. */
	enabled?: boolean;
	/** Factory invocation numbers (1-based) that should throw during load. */
	failOnGenerations?: number[];
	/** Generations that report no health receipt at all. */
	skipHealthOnGenerations?: number[];
	/** Extra fields merged into every health receipt. */
	healthOverrides?: Partial<AutomodeHealth>;
	/** Policy hook: block selected calls at the tool_call boundary. */
	decide?: (tool: string, args: Record<string, unknown>) => { block: boolean; reason?: string };
	/** Observation hook for every call the gate reviews. */
	onExecute?: (call: ExecutedCall) => void;
}

export function createTestGateProvider(behavior: TestGateBehavior = {}): AutomodeExtensionFactoryProvider {
	let generation = 0;
	return (options: AutomodeExtensionOptions): ExtensionFactory => {
		generation += 1;
		const current = generation;
		return (pi) => {
			if (behavior.failOnGenerations?.includes(current)) {
				throw new Error(`test gate: deliberate load failure on generation ${current}`);
			}
			const guarded = new Set<string>(GUARDED_TOOLS);
			pi.on("tool_call", (event) => {
				if (!guarded.has(event.toolName)) {
					return { block: true, reason: `unsupported tool route: ${event.toolName}` };
				}
				// Freeze the reviewed arguments before any decision.
				const frozen = structuredClone(event.input) as Record<string, unknown>;
				behavior.onExecute?.({ tool: event.toolName, args: frozen });
				const decision = behavior.decide?.(event.toolName, frozen);
				if (decision?.block) {
					return { block: true, reason: decision.reason ?? "policy" };
				}
				return undefined;
			});
			pi.on("session_start", () => {
				if (behavior.skipHealthOnGenerations?.includes(current)) return;
				options.onHealth({
					initialized: true,
					guardedTools: [...GUARDED_TOOLS],
					enabled: behavior.enabled ?? true,
					...behavior.healthOverrides,
				});
			});
		};
	};
}
