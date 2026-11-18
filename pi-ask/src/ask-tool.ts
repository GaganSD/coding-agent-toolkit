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
import { getAskConfigStore } from "./config/store.ts";
import { type AskFeatures, NO_ASK_FEATURES } from "./features.ts";
import { buildAskParamsSchema, stripSchemaDescriptions } from "./schema.ts";
import { AskJournalWriteError, describeExpiryStopFailure, toFormSnapshot } from "./journal/journal.ts";
import { type AskRuntime, createAskRuntime } from "./runtime.ts";
import {
	createExpiryTimer,
	effectiveTimeoutSeconds,
} from "./state/expiry.ts";
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
	{ background, clock, flushers, journal, live, returning, unsaved }: AskRuntime,
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
	// A limit counts only where there is a screen to count down on, and only
	// while expiry is on both at registration and in the live config. A stale
	// call that still carries one after expiry was switched off just waits.
	const expirySeconds =
		ctx.mode === "tui" && features.expiry
			? await resolveExpirySeconds(params.timeoutSeconds)
			: undefined;
	const form = toFormSnapshot(validation.state, expirySeconds);

	if (ctx.mode !== "tui") {
		// No persistent panel here, so `background` blocks like any other call.
		// The same goes for `timeoutSeconds`: there is no countdown, the call waits.
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
		const pending = background.enqueue(ctx, requestId, "background", {
			timeoutSeconds: expirySeconds,
		});
		return successfulResponse({
			...receipt(validation.state, "queued", requestId),
			pending,
		});
	}

	// Journalled before any waiting, so a form that never returns can be
	// recovered; the outcome is journalled before the tool returns.
	const requestId = journal.recordForm({ mode: "foreground", form, toolCallId });
	const timer =
		expirySeconds === undefined
			? undefined
			: createExpiryTimer(expirySeconds, clock);
	// A stopped countdown is journalled, so no rebuild can bring it back.
	timer?.subscribe({
		stop: (reason) => journal.recordExpiryStop(requestId, reason),
		failed: (error) => {
			if (error instanceof AskJournalWriteError) {
				ctx.ui.notify(describeExpiryStopFailure(error), "error");
				return true;
			}
			return false;
		},
	});
	const openForm = () =>
		runAskFlow(ctx, params, {
			allowDefer: !!background,
			expiry: timer && { owned: true, timer },
			onStateChange: journal.draftRecorder(requestId),
			registerFlush: (flush) => {
				flushers.add(flush);
				return () => flushers.delete(flush);
			},
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
		timer?.dispose();
		live.delete(requestId);
		ctx.ui.setWorkingVisible(true);
	}
	if (background && result.status === "deferred") {
		// "Answer later": the form keeps its request-order place in the queue
		// and its draft; the answer follows as a message.
		saved(ctx, background, unsaved, requestId, "deferred", () =>
			journal.recordDefer(requestId)
		);
		background.enqueue(ctx, requestId, "deferred");
		return successfulResponse(receipt(validation.state, "deferred", requestId));
	}
	const outcome = saved(ctx, background, unsaved, requestId, result.status, () =>
		journal.recordOutcome(requestId, result, "tool")
	);
	// The tool result follows this return; until it lands on the branch the
	// answer must not also be adopted as an orphan.
	returning.add(requestId);
	if (result.status === "expired") {
		// It can now be reopened for a late correction.
		background?.formEnded(ctx);
	}
	return successfulResponse(outcome.result);
}

const UNSAVED: Record<string, string> = {
	cancelled: "cancellation",
	deferred: "deferral",
	expired: "expiry",
};

/**
 * The user's reply is gone from the screen but not in the journal. Put the
 * form back in the panel at once, tell the user, and tell the agent not to
 * ask again.
 */
function saved<T>(
	ctx: ExtensionContext,
	background: AskRuntime["background"],
	unsaved: Set<string>,
	requestId: string,
	status: string,
	write: () => T
): T {
	try {
		return write();
	} catch (error) {
		if (error instanceof AskJournalWriteError) {
			const what = UNSAVED[status] ?? "answer";
			unsaved.add(requestId);
			try {
				background?.formEnded(ctx);
				ctx.ui.notify(`${error.message} The form is back in your panel.`, "error");
			} catch {
				// The screen is gone; the journal still holds the form.
			}
			error.message += ` The user's ${what} was not saved; the form will reappear in their panel. Do not re-ask.`;
		}
		throw error;
	}
}

/** A receipt names the form and carries no answers, not even drafted ones. */
function receipt(
	state: AskState,
	status: "queued" | "deferred",
	requestId: string
): AskResult {
	return { ...toAskResult(state, status), requestId };
}

/** The call's limit after the floor, or undefined when expiry is off. */
async function resolveExpirySeconds(
	requested: number | undefined
): Promise<number | undefined> {
	if (requested === undefined) {
		return;
	}
	const { config } = await getAskConfigStore().ensureLoaded();
	return config.expiry.enabled
		? effectiveTimeoutSeconds(requested, config.expiry.minSeconds)
		: undefined;
}
