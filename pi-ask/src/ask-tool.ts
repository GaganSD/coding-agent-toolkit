import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_PROMPT_GUIDELINES,
	invalidPayloadResponse,
	nonInteractiveResponse,
	renderAskToolCall,
	renderAskToolResult,
	successfulResponse,
	validateParams,
} from "./ask-tool-helpers.ts";
import { type AskFeatures, NO_ASK_FEATURES } from "./features.ts";
import { buildAskParamsSchema, stripSchemaDescriptions } from "./schema.ts";
import { toFormSnapshot } from "./journal/journal.ts";
import { type AskRuntime, createAskRuntime } from "./runtime.ts";
import { prepareAskParams } from "./state/normalize.ts";
import { toAskResult } from "./state/result.ts";
import type { AskParams, AskResult } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";
import { runRpcAskFlow } from "./ui/rpc-flow.ts";

export interface AskToolOptions {
	/** Optional schema fields to register; see `resolveAskFeatures`. */
	features?: AskFeatures;
	/** Journal and live-form registry; shared with recovery when given. */
	runtime?: AskRuntime;
}

export function registerAskTool(pi: ExtensionAPI, options: AskToolOptions = {}) {
	const features = options.features ?? NO_ASK_FEATURES;
	const runtime = options.runtime ?? createAskRuntime(pi);
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Interview the user to clarify gaps in context or requirements, get missing authorization, or brainstorm",
		promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
		// Field prose lives in the guidelines; the registered schema stays lean.
		parameters: stripSchemaDescriptions(buildAskParamsSchema(features)),
		prepareArguments: (args) => prepareAskParams(args) as AskParams,
		execute: (toolCallId, params, signal, _onUpdate, ctx) =>
			executeAskTool(runtime, toolCallId, params as AskParams, ctx, signal),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

async function executeAskTool(
	{ journal, live }: AskRuntime,
	toolCallId: string,
	params: AskParams,
	ctx: ExtensionContext,
	signal?: AbortSignal
) {
	const validation = validateParams(params);
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	// Journalled before any waiting, so a form that never returns can be
	// recovered; the outcome is journalled before the tool returns.
	const requestId = journal.recordForm({
		mode: "foreground",
		form: toFormSnapshot(validation.state, params.timeoutSeconds),
		toolCallId,
	});
	const settle = (result: AskResult) =>
		journal.recordOutcome(requestId, result, "tool").result;

	if (ctx.mode !== "tui") {
		// Hosts with dialog UI but no custom TUI (RPC subagents, ACP clients)
		// get the card-based fallback; print/json keeps the pending summary.
		if (ctx.hasUI) {
			const result = await runRpcAskFlow(ctx.ui, validation.state, signal);
			return successfulResponse(settle(result));
		}
		return nonInteractiveResponse(
			validation.state,
			settle(toAskResult(validation.state, "unavailable"))
		);
	}
	ctx.ui.setWorkingVisible(false);
	live.add(requestId);
	try {
		const result = await runAskFlow(ctx, params, {
			onStateChange: journal.draftRecorder(requestId),
		});
		return successfulResponse(settle(result));
	} finally {
		live.delete(requestId);
		ctx.ui.setWorkingVisible(true);
	}
}
