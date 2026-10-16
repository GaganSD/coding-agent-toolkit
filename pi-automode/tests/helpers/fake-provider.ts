/**
 * Offline fake chat provider for host-smoke tests.
 *
 * Registers one provider with one model whose `streamSimple` replays a
 * scripted list of turns (text or tool calls). No network, no credentials,
 * no cost. The api key is a literal dummy so Pi's availability checks pass.
 */
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const FAKE_PROVIDER = "automode-fake";
export const FAKE_MODEL_ID = "fake-1";
export const FAKE_API = "automode-fake-scripted";

export interface FakeToolCall {
	name: string;
	args: Record<string, unknown>;
}

export type FakeTurn = { kind: "text"; text: string } | { kind: "toolCalls"; calls: FakeToolCall[] };

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function baseMessage(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emitTurn(stream: AssistantMessageEventStream, model: Model<string>, turn: FakeTurn): void {
	const message = baseMessage(model);
	stream.push({ type: "start", partial: message });
	if (turn.kind === "text") {
		message.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		message.content[0] = { type: "text", text: turn.text };
		stream.push({ type: "text_delta", contentIndex: 0, delta: turn.text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: turn.text, partial: message });
		message.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message });
		return;
	}
	turn.calls.forEach((call, index) => {
		const toolCall = {
			type: "toolCall" as const,
			id: `fake-call-${message.timestamp}-${index}`,
			name: call.name,
			arguments: call.args as JsonObject,
		};
		message.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
	});
	message.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message });
}

/**
 * Returns an inline extension factory registering the fake provider.
 * Turns are consumed in order; when the script runs out, a final empty text
 * turn is produced so the agent settles instead of hanging.
 */
export function createFakeProviderExtension(turns: FakeTurn[]): ExtensionFactory {
	let cursor = 0;
	return (pi) => {
		pi.registerProvider(FAKE_PROVIDER, {
			name: "Automode fake provider",
			baseUrl: "http://127.0.0.1:9/",
			apiKey: "fake-offline-key",
			api: FAKE_API,
			models: [
				{
					id: FAKE_MODEL_ID,
					name: "Automode Fake",
					api: FAKE_API,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					reasoning: false,
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
			streamSimple: (model) => {
				const turn = cursor < turns.length ? turns[cursor++]! : { kind: "text" as const, text: "fake: script exhausted" };
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => emitTurn(stream, model as Model<string>, turn));
				return stream;
			},
		});
	};
}
