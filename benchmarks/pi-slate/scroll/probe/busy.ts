import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 12 characters / 30 ms ≈ 100 estimated tokens/s, using Slate's chars/4 estimator.
const DELTA_MS = 30;

export function installBusyProvider(pi: ExtensionAPI) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stage = 0, requests = 0;
  const state = { thinkingDeltas: 0, textDeltas: 0, toolsFinished: 0, settled: false,
    thinkingEndedAt: null as number | null, toolStartedAt: null as number | null, error: undefined as string | undefined };
  pi.on("message_update", (event) => {
    if (event.message.role === "assistant" && event.message.provider === "scroll-bench" &&
        event.assistantMessageEvent.type === "thinking_end") state.thinkingEndedAt = Date.now();
  });
  pi.on("tool_execution_start", (event) => {
    if (event.toolCallId === "scroll-bench-read") state.toolStartedAt = Date.now();
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolCallId === "scroll-bench-read" && !event.isError) state.toolsFinished++;
  });
  pi.on("agent_settled", () => { state.settled = true; });
  pi.registerProvider("scroll-bench", {
    baseUrl: "http://127.0.0.1:1", // Required metadata; the stream never makes a request.
    apiKey: "offline",
    api: "scroll-bench-offline",
    models: [{ id: "offline", name: "Synthetic stream", reasoning: true, input: ["text"], cost,
      contextWindow: 2_000_000, maxTokens: 8192 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const first = ++requests === 1;
      const output: AssistantMessage = {
        role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
        stopReason: "pending", timestamp: Date.now(),
        usage: { input: 2400, output: 0, cacheRead: 7200, cacheWrite: 0, totalTokens: 9600, cost: { ...cost, total: 0 } },
      };
      const pause = () => delay(DELTA_MS, undefined, { signal: options?.signal });
      const text = async (more: () => boolean) => {
        const block = { type: "text" as const, text: "" };
        const contentIndex = output.content.push(block) - 1;
        stream.push({ type: "text_start", contentIndex, partial: output });
        const chunks = ["\n\n- Review ", "the fixture ", "and compare ", "the expected", " with actual", " line counts", ".\n\n`result", "` is stable."];
        for (let i = 0; more(); i++) {
          await pause();
          const delta = chunks[i % chunks.length]!;
          block.text += delta;
          stream.push({ type: "text_delta", contentIndex, delta, partial: output });
          state.textDeltas++;
        }
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      };
      void (async () => {
        try {
          if (requests > 2) throw new Error("Unexpected third synthetic model request");
          stream.push({ type: "start", partial: output });
          if (first) {
            const block = { type: "thinking" as const, thinking: "" };
            output.content.push(block);
            stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
            while (stage < 2) {
              await pause();
              const delta = "Check rows. ";
              block.thinking += delta;
              stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output });
              state.thinkingDeltas++;
            }
            stream.push({ type: "thinking_end", contentIndex: 0, content: block.thinking, partial: output });
            const end = state.textDeltas + 4;
            await text(() => state.textDeltas < end);
            const call: ToolCall = { type: "toolCall", id: "scroll-bench-read", name: "read", arguments: {} };
            const contentIndex = output.content.push(call) - 1;
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            await pause();
            call.arguments = { path: "fixture.txt" };
            stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
          } else {
            await text(() => stage < 3);
          }
          output.usage.output = (first ? state.thinkingDeltas + state.textDeltas : state.textDeltas - 4) * 3;
          output.usage.totalTokens += output.usage.output;
          output.stopReason = first ? "toolUse" : "stop";
          stream.push({ type: "done", reason: output.stopReason, message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          state.error = output.errorMessage = String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  });
  return {
    state,
    advance(next: number) {
      if (next <= stage) return;
      stage = next;
      if (stage === 1) pi.sendUserMessage("Stream the offline scroll benchmark response.");
    },
  };
}
