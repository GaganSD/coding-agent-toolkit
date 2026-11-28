import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { canonical, digest, scrub } from "./replay.ts";

export interface Task { id: string; prompt: string; multiPart: boolean | undefined }
type Turn = { messages: number; tools: number; reply: AssistantMessage };
type Observation = { handles: Record<string, string>; failed: boolean };
interface Cassette { fingerprint: string; model: Model<Api>; turns: Turn[]; observations?: Observation[] }
interface Call {
	id: string;
	name: string;
	array: boolean;
	executed?: boolean;
	failed?: boolean;
	failure?: { category: "validation" | "replay" | "provider"; text: string };
}

export async function trial(session: AgentSession, model: Model<Api>, task: Task, file: string,
	live: boolean, fingerprint: string, diagnostics: { misses: string[]; errors: string[] }) {
	const stored: Cassette | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
	if (!stored && !live) throw new Error("Model replay missing for task " + task.id);
	if (stored && stored.fingerprint !== fingerprint) throw new Error("Model cassette settings changed for task " + task.id);
	const recording: Cassette = { model: clean(model), turns: [], observations: [], fingerprint };
	const aliases = new Map<string, string>();
	const liveStream = session.agent.streamFunction;
	let turn = 0;
	let failure: string | undefined;
	const calls: Call[] = [];
	let ended = 0;
	const callBudget = 8;
	let deadline = false;
	let reachedBudget = false;
	const timer = setTimeout(() => { deadline = true; void session.abort(); }, 90_000);
	session.agent.streamFunction = async (requested, context, options) => {
		const shape = { messages: context.messages.length, tools: session.agent.state.tools.length };
		const next = turn++;
		if (stored) {
			const entry = stored.turns[next];
			if (!entry || entry.messages !== shape.messages || entry.tools !== shape.tools) {
				failure = "Model replay diverged at turn " + (next + 1);
				throw new Error(failure);
			}
			const stream = createAssistantMessageEventStream();
			const message = structuredClone(entry.reply);
			for (const part of message.content) {
				if (part.type === "toolCall") for (const key of ["ref", "cursor", "responseId"]) {
					const value = part.arguments[key];
					if (typeof value === "string") part.arguments[key] = aliases.get(value) ?? value;
				}
			}
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else if (message.stopReason === "pending") stream.end(message);
			else stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		}
		const stream = await liveStream(requested, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? 1200, 1200) });
		void stream.result().then((reply) => {
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				if (!reachedBudget && !deadline) {
					failure = /\b(?:401|402|403|404|429|500|502|503|504)\b/u.exec(reply.errorMessage ?? "")?.[0] ?? "model provider error";
				}
				return;
			}
			const saved = clean(reply);
			if (saved.content.some((part, i) => part.type === "toolCall" &&
				JSON.stringify(part.arguments) !== JSON.stringify((reply.content[i] as { arguments?: unknown }).arguments))) {
				failure = "Recorded model arguments require credential redaction";
				return;
			}
			recording.turns[next] = { ...shape, reply: saved };
		});
		return stream;
	};

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			calls.push({ id: event.toolCallId, name: event.toolName,
				array: Array.isArray(event.args?.query) || Array.isArray(event.args?.queries) });
		}
		if (event.type === "tool_execution_end") {
			let call = calls.find(({ id }) => id === event.toolCallId);
			if (!call) {
				call = { id: event.toolCallId, name: event.toolName, array: false };
				calls.push(call);
			}
			call.executed = event.durationMs !== undefined;
			call.failed = event.isError || diagnostics.misses.length > 0;
			const output = textContent(event.result);
			const reasons = diagnostics.errors.splice(0);
			if (diagnostics.misses.length) {
				call.failure = { category: "replay", text: diagnostics.misses.join("; ") };
			} else if (event.isError || reasons.length) {
				const category = event.isError && (reasons.length === 0 && /argument|validat|supply|exactly|must be|required|schema|invalid|unexpected/iu.test(output))
					? "validation" : "provider";
				call.failure = { category, text: scrub([output, ...reasons].filter(Boolean).join("\n")).slice(0, 2500) };
			}
			const handles = resultHandles(event.result);
			const expected = stored?.observations?.[ended];
			recording.observations!.push({ handles, failed: event.isError });
			if (expected) {
				for (const [label, previous] of Object.entries(expected.handles)) if (handles[label]) aliases.set(previous, handles[label]);
				if (expected.failed !== event.isError || Object.keys(expected.handles).sort().join(",") !== Object.keys(handles).sort().join(",")) {
					failure = "Tool replay diverged at call " + (ended + 1);
				}
			}
			if (++ended >= callBudget) {
				reachedBudget = true;
				session.agent.abort();
			}
		}
	});
	try {
		await session.bindExtensions({});
		try { await session.prompt(task.prompt); }
		catch { if (!failure && !deadline && !reachedBudget) failure = "Model run failed"; }
		if (diagnostics.misses.length) failure = "Retrieval replay miss";
		if (deadline) failure = "Model trial deadline";
		if (stored && turn !== stored.turns.length && !failure) failure = "Model replay ended at a different turn";
		const messages = session.agent.state.messages;
		const totalTokens = messages.reduce((sum, message) => message.role === "assistant" ? sum + (message.usage?.totalTokens ?? 0) : sum, 0);
		const assistantCalls = messages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []);
		for (const tool of assistantCalls) {
			if (!calls.some(({ id }) => id === tool.id)) calls.push({ id: tool.id, name: tool.name, array: Array.isArray(tool.arguments.query) || Array.isArray(tool.arguments.queries), executed: false, failed: true,
				...(reachedBudget ? {} : { failure: { category: "validation" as const, text: scrub(tool.argumentsError ?? "Tool call did not execute") } }) });
		}
		if (!stored && !failure) writeFileSync(file, JSON.stringify(recording) + "\n", { mode: 0o600 });
		return { task: task.id, firstValid: calls[0] ? calls[0].failed === false : undefined, attemptedToolCalls: calls.length, toolCalls: calls.filter(({ executed }) => executed).length, totalTokens,
			multiPart: task.multiPart, arrayCalls: calls.filter(({ array }) => array).length, reachedBudget,
			failure, calls, messages: clean(messages) };
	} finally {
		clearTimeout(timer);
		unsubscribe();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}

function resultHandles(result: unknown): Record<string, string> {
	const details = (result as { details?: { cursor?: unknown; ref?: unknown; resultId?: unknown; responseId?: unknown;
		searchResults?: { ref?: unknown }[] } } | undefined)?.details;
	if (!details) return {};
	const entries: [string, unknown][] = [["cursor", details.cursor], ["ref", details.ref],
		["resultId", details.resultId], ["responseId", details.responseId]];
	for (const [index, hit] of (details.searchResults ?? []).entries()) entries.push(["hit-" + index, hit.ref]);
	return Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function clean<T>(value: T): T {
	return JSON.parse(JSON.stringify(value), (key, item: unknown) => {
		if (/^(?:apiKey|authorization|credential|secret|token|cookie)$/iu.test(key)) return undefined;
		return typeof item === "string" ? scrub(item, false) : item;
	});
}

export function textContent(result: unknown): string {
	return (result as { content?: { type: string; text?: string }[] } | undefined)?.content?.flatMap((part) =>
		part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") ?? "";
}

export function trialFingerprint(data: unknown): string {
	return digest(JSON.stringify(canonical(data)));
}
