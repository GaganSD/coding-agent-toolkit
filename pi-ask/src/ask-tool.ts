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
import type { AskParams, AskResult, AskState } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";
import { runRpcAskFlow } from "./ui/rpc-flow.ts";

export interface AskToolOptions {
	/** Optional schema fields to register; see `resolveAskFeatures`. */
	features?: AskFeatures;
	/** Journal, live-form registry and queue; shared with the lifecycle. */
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
			executeAskTool(
				runtime,
				features,
				toolCallId,
				params as AskParams,
				ctx,
				signal
			),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

async function executeAskTool(
	{ background, journal, live }: AskRuntime,
	features: AskFeatures,
	toolCallId: string,
	params: AskParams,
	ctx: ExtensionContext,
	signal?: AbortSignal
) {
	const validation = validateParams(params);
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	const form = toFormSnapshot(validation.state, params.timeoutSeconds);

	if (ctx.mode !== "tui") {
		// No persistent panel here, so `background` blocks like any other call.
		// Hosts with dialog UI but no custom TUI (RPC subagents, ACP clients)
		// get the card-based fallback; print/json keeps the pending summary.
		const requestId = journal.recordForm({ mode: "foreground", form, toolCallId });
		const settle = (result: AskResult) =>
			journal.recordOutcome(requestId, result, "tool").result;
		if (ctx.hasUI) {
			const result = await runRpcAskFlow(ctx.ui, validation.state, signal);
			return successfulResponse(settle(result));
		}
		return nonInteractiveResponse(
			validation.state,
			settle(toAskResult(validation.state, "unavailable"))
		);
	}

	// A stale call that still carries `background` after the feature was
	// switched off blocks like any other call.
	if (background && features.background && params.background === true) {
		// Journalled first: the receipt promises an answer that survives a
		// restart. No outcome is written; a receipt is not one.
		const requestId = journal.recordForm({ mode: "background", form, toolCallId });
		const pending = background.enqueue(ctx, requestId, "background");
		return successfulResponse({
			...receipt(validation.state, "queued", requestId),
			pending,
		});
	}

	// Journalled before any waiting, so a form that never returns can be
	// recovered; the outcome is journalled before the tool returns.
	const requestId = journal.recordForm({ mode: "foreground", form, toolCallId });
	const openForm = () =>
		runAskFlow(ctx, params, {
			allowDefer: !!background,
			onStateChange: journal.draftRecorder(requestId),
		});
	let result: AskResult;
	ctx.ui.setWorkingVisible(false);
	live.add(requestId);
	try {
		// A blocking form owns the keyboard: the panel steps aside for it.
		result = await (background
			? background.foreground(ctx, openForm)
			: openForm());
	} finally {
		live.delete(requestId);
		ctx.ui.setWorkingVisible(true);
	}
	if (background && result.status === "deferred") {
		// "Answer later": the form keeps its request-order place in the queue
		// and its draft; the answer follows as a message.
		journal.recordDefer(requestId);
		background.enqueue(ctx, requestId, "deferred");
		return successfulResponse(receipt(validation.state, "deferred", requestId));
	}
	return successfulResponse(
		journal.recordOutcome(requestId, result, "tool").result
	);
}

/** A receipt names the form and carries no answers, not even drafted ones. */
function receipt(
	state: AskState,
	status: "queued" | "deferred",
	requestId: string
): AskResult {
	return { ...toAskResult(state, status), requestId };
}
