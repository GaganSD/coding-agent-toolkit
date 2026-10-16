/**
 * Test gate: a stand-in for the real `createAutomodeExtension` that follows
 * the confirmed contract — options { agentDir, workspace, extensionDir,
 * onHealth }, wrapper tools for read/bash/edit/write, fail-closed tool_call
 * hook for every other route, health reported at session_start.
 *
 * It wraps the REAL Pi tool definitions, so delegation executes genuine
 * filesystem/shell operations inside the temp workspace.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import {
	GUARDED_TOOLS,
	type AutomodeExtensionFactoryProvider,
	type AutomodeExtensionOptions,
	type AutomodeHealth,
} from "../../src/launcher.js";

export interface ExecutedCall {
	tool: string;
	/** Frozen final post-hook arguments exactly as the wrapper received them. */
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
	/** Policy hook: block selected calls at the wrapper's execute boundary. */
	decide?: (tool: string, args: Record<string, unknown>) => { block: boolean; reason?: string };
	/** Observation hook for every call that reaches a wrapper. */
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
			const wrap = <TParams extends TSchema, TDetails>(
				definition: ToolDefinition<TParams, TDetails>,
			): ToolDefinition<TParams, TDetails> => ({
				...definition,
				execute: async (toolCallId, args, signal, onUpdate, ctx) => {
					// Freeze the final post-hook arguments before any decision.
					const frozen = structuredClone(args);
					const record = frozen as Record<string, unknown>;
					behavior.onExecute?.({ tool: definition.name, args: record });
					const decision = behavior.decide?.(definition.name, record);
					if (decision?.block) {
						throw new Error(`blocked by test gate: ${decision.reason ?? "policy"}`);
					}
					return definition.execute(toolCallId, frozen as Static<TParams>, signal, onUpdate, ctx);
				},
			});
			pi.registerTool(wrap(createReadToolDefinition(options.workspace)));
			pi.registerTool(wrap(createBashToolDefinition(options.workspace)));
			pi.registerTool(wrap(createEditToolDefinition(options.workspace)));
			pi.registerTool(wrap(createWriteToolDefinition(options.workspace)));
			// Fail closed on every route the gate does not wrap.
			pi.on("tool_call", (event) => {
				if (!guarded.has(event.toolName)) {
					return { block: true, reason: `unsupported tool route: ${event.toolName}` };
				}
				return undefined;
			});
			pi.on("session_start", () => {
				if (behavior.skipHealthOnGenerations?.includes(current)) return;
				options.onHealth({
					initialized: true,
					wrappedTools: [...GUARDED_TOOLS],
					enabled: behavior.enabled ?? true,
					...behavior.healthOverrides,
				});
			});
		};
	};
}

/**
 * Inline extension that mutates `bash` arguments in a tool_call hook, to
 * prove wrapper execute() observes final post-hook arguments.
 */
export function createArgsMutatorExtension(mutate: (input: Record<string, unknown>) => void): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			mutate(event.input as Record<string, unknown>);
			return undefined;
		});
	};
}
