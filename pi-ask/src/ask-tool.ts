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
import { AskParamsSchema, stripSchemaDescriptions } from "./schema.ts";
import { prepareAskParams } from "./state/normalize.ts";
import type { AskParams } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";
import { runRpcAskFlow } from "./ui/rpc-flow.ts";

export function registerAskTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Interview the user to clarify gaps in context or requirements, get missing authorization, or brainstorm",
		promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
		// Field prose lives in the guidelines; the registered schema stays lean.
		parameters: stripSchemaDescriptions(AskParamsSchema),
		prepareArguments: (args) => prepareAskParams(args) as AskParams,
		execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
			executeAskTool(params as AskParams, ctx, signal),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

async function executeAskTool(
	params: AskParams,
	ctx: ExtensionContext,
	signal?: AbortSignal
) {
	const validation = validateParams(params);
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	if (ctx.mode !== "tui") {
		// Hosts with dialog UI but no custom TUI (RPC subagents, ACP clients)
		// get the card-based fallback; print/json keeps the pending summary.
		if (ctx.hasUI) {
			const result = await runRpcAskFlow(ctx.ui, validation.state, signal);
			return successfulResponse(result);
		}
		return nonInteractiveResponse(validation.state);
	}
	ctx.ui.setWorkingVisible(false);
	try {
		const result = await runAskFlow(ctx, params);
		return successfulResponse(result);
	} finally {
		ctx.ui.setWorkingVisible(true);
	}
}
