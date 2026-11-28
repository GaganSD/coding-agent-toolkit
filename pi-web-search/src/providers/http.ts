import { setImmediate } from "node:timers/promises";
import { type ProviderError, providerError } from "./types.ts";

export type FetchLike = (
	input: string,
	init: RequestInitLike,
) => Promise<ResponseLike>;

export interface ResponseLike {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	/** Present on real `Response` objects; read with a byte cap when available. */
	body?: ReadableStream<Uint8Array> | null;
}

export interface RequestInitLike {
	method?: string;
	redirect?: "error";
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface JsonRequestOptions {
	httpError?: typeof normalizeHttpError;
	headers?: Record<string, string>;
	body: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: FetchLike;
	/** Receives the raw response before the body is read (captures the MCP session id). */
	onResponse?: (response: ResponseLike, redact?: Redact) => void;
	/** Resolve with `undefined` instead of throwing when the body is empty. */
	allowEmptyBody?: boolean;
	/** Hard cap on the decoded response body; oversized bodies fail as parse_error. */
	maxResponseBytes?: number;
	/** Selects which SSE JSON-RPC message to resolve with (correlates by id). */
	selectMessage?: (message: unknown) => boolean;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

/** Bounds the network/memory cost of one response before it is decoded. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Bound ready-reader microtask bursts so abort/deadline timers can run. */
const BODY_READ_YIELD_CHUNKS = 256;
const BODY_READ_YIELD_BYTES = 64 * 1024;

/** POST JSON, parse a JSON body, throw `ProviderError` on any failure. */
export async function postJson<T>(
	url: string,
	options: JsonRequestOptions,
): Promise<T> {
	return send(url, options, (bodyText, redact) => parseJsonBody<T>(url, bodyText, redact));
}

/** GET JSON with the same bounds, cancellation and error handling as POST. */
export async function getJson<T>(
	url: string,
	options: Omit<JsonRequestOptions, "body">,
): Promise<T> {
	return send(url, { ...options, body: undefined }, (text, redact) => parseJsonBody<T>(url, text, redact), "GET");
}

/** GET a raw body (used for Sourcegraph's search stream). */
export async function getText(
	url: string,
	options: Omit<JsonRequestOptions, "body">,
): Promise<string> {
	return send(url, { ...options, body: undefined }, (text) => text, "GET");
}

/**
 * POST JSON to an endpoint answering with the MCP streamable-HTTP envelope
 * (`text/event-stream` framed as `event: message` / `data: {...}`) or with a
 * plain JSON body. Returns the decoded JSON-RPC message.
 */
export async function postSseJson<T>(
	url: string,
	options: JsonRequestOptions,
): Promise<T> {
	return send(url, options, (bodyText, redact) =>
		parseEnvelope<T>(
			url,
			bodyText,
			options.allowEmptyBody === true,
			options.selectMessage,
			redact,
		),
		"POST",
		options.selectMessage,
	);
}

/**
 * Returns the concatenated payloads of an SSE stream, in order.
 *
 * `data:` is the normal framing, but GitHub's MCP server is inconsistent within
 * a single session: `initialize` and `tools/call` use `data:`, while
 * `tools/list` sends a bare JSON line after `event: message`. Ignoring bare
 * lines is fine until it silently is not, so a bare `{`/`[` line is treated as
 * payload too.
 */
export function extractSseData(bodyText: string): string[] {
	const payloads: string[] = [];
	let current: string[] = [];

	const flush = () => {
		if (current.length > 0) {
			payloads.push(current.join("\n"));
		}
		current = [];
	};

	for (const rawLine of bodyText.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			flush();
			continue;
		}
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("data:")) {
			current.push(line.slice("data:".length).trimStart());
			continue;
		}
		if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
			continue;
		}
		if (line.startsWith("{") || line.startsWith("[")) {
			current.push(line);
		}
	}
	flush();
	return payloads;
}

export function normalizeHttpError(
	response: ResponseLike,
	bodyText: string,
): ProviderError {
	const status = response.status;
	const detail = summarizeBody(bodyText);
	const suffix = detail ? `: ${detail}` : "";
	if (status === 429) {
		return providerError("rate_limited", `HTTP 429 too many requests${suffix}`, {
			status,
			retryable: true,
			retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
		});
	}
	return providerError("http_error", `HTTP ${status}${suffix}`, { status });
}

/** Only the provider HTTP header, never arbitrary prose, can specify cooldown. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
	if (!value?.trim()) return undefined;
	const seconds = Number(value);
	const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
	return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60_000) : undefined;
}

export interface ComposedSignal {
	signal: AbortSignal;
	/** Clears the timer and detaches the caller's abort listener. */
	dispose(): void;
}

/**
 * Keeps pending work alive until its deadline, even if the transport has no
 * event-loop handles. Callers must dispose on completion to release the timer
 * and detach the caller's abort listener.
 */
export function withTimeout(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): ComposedSignal {
	const controller = new AbortController();
	const abort = (reason: ProviderError) => {
		if (!controller.signal.aborted) {
			controller.abort(reason);
		}
	};

	if (signal) {
		if (signal.aborted) {
			abort(reasonFrom(signal));
		} else {
			signal.addEventListener("abort", onCallerAbort, { once: true });
		}
	}

	const timer =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? setTimeout(() => {
					abort(timeoutError(timeoutMs));
				}, timeoutMs)
			: undefined;

	return {
		signal: controller.signal,
		dispose() {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			signal?.removeEventListener("abort", onCallerAbort);
		},
	};

	function onCallerAbort() {
		abort(reasonFrom(signal));
	}
}

/**
 * A caller's abort reason may itself be a `ProviderError` — e.g. a parent
 * operation deadline composed with `withTimeout` aborts with `code: "timeout"`.
 * Preserve that code so an operation timeout is never reported as a user abort.
 */
function reasonFrom(signal: AbortSignal | undefined): ProviderError {
	const reason = signal?.reason;
	return asProviderError(reason) ?? abortedError();
}

export function timeoutError(timeoutMs: number): ProviderError {
	return providerError("timeout", `Request timed out after ${timeoutMs}ms.`, {
		retryable: true,
	});
}

export function abortedError(): ProviderError {
	return providerError("aborted", "Request aborted.", { retryable: false });
}

async function send<T>(
	url: string,
	options: JsonRequestOptions,
	decode: (bodyText: string, redact?: Redact) => T,
	method: "POST" | "GET" = "POST",
	selectSseMessage?: (message: unknown) => boolean,
): Promise<T> {
	const doFetch = options.fetchImpl ??
		(globalThis.fetch as FetchLike | undefined);
	if (!doFetch) {
		throw providerError(
			"network_error",
			"No fetch implementation is available; pass options.fetchImpl.",
			{ retryable: true },
		);
	}

	const redact = credentialRedactor(options.headers);
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const composed = withTimeout(options.signal, timeoutMs);

	try {
		if (composed.signal.aborted) throw reasonFrom(composed.signal);
		const response = await awaitWithSignal(doFetch(url, {
			method,
			// Fixed provider endpoints must not forward keys or queries elsewhere.
			redirect: "error",
			headers: {
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				Accept: "application/json, text/event-stream",
				...options.headers,
			},
			...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
			signal: composed.signal,
		}), composed.signal).catch((error: unknown) => {
			throw error instanceof Error && isProviderErrorLike(error) ? redactError(error, redact) : error;
		});
		options.onResponse?.(response, redact);

		let bodyText: string;
		try {
			bodyText = await awaitWithSignal(readBody(
				response,
				options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
				url,
				composed.signal,
				response.ok && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream"
					? selectSseMessage : undefined,
			), composed.signal);
		} catch (error) {
			if (error instanceof Error && isProviderErrorLike(error)) {
				throw redactError(error, redact);
			}
			throw composed.signal.aborted
				? abortReason(composed.signal, timeoutMs)
				: providerError(
						"network_error",
						`Failed to read response body from ${url}: ${
							safeMessage(error, redact)
						}`,
						{ retryable: true, cause: redact ? undefined : error },
					);
		}

		if (composed.signal.aborted) throw reasonFrom(composed.signal);
		if (!response.ok) {
			throw (options.httpError ?? normalizeHttpError)(response, redact?.(bodyText) ?? bodyText);
		}
		const value = decode(bodyText, redact);
		return redact ? redactValues(value, redact) as T : value;
	} catch (error) {
		throw toProviderError(error, composed.signal, timeoutMs, redact);
	} finally {
		composed.dispose();
	}
}

function toProviderError(
	error: unknown,
	signal: AbortSignal,
	timeoutMs: number,
	redact?: Redact,
): ProviderError {
	if (error instanceof Error && isProviderErrorLike(error)) {
		return error;
	}
	if (signal.aborted) {
		return abortReason(signal, timeoutMs);
	}
	if (isAbortLikeError(error)) {
		return abortedError();
	}
	const message = safeMessage(error, redact);
	return providerError("network_error", `Request failed: ${message}`, {
		retryable: true,
		cause: redact ? undefined : error,
	});
}

type Redact = (text: string) => string;

export function credentialRedactor(headers?: Record<string, string>): Redact | undefined {
	const values = Object.entries(headers ?? {}).flatMap(([name, value]) => {
		switch (name.toLowerCase()) {
			case "authorization": return [value.replace(/^Bearer\s+/iu, "")];
			case "x-api-key": case "x-subscription-token": return [value];
			default: return [];
		}
	}).filter(Boolean);
	if (!values.length) return;
	const variants = new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]));
	for (const value of values) {
		try { variants.add(encodeURIComponent(value)); } catch { /* Malformed input. */ }
	}
	const pattern = [...variants].sort((a, b) => b.length - a.length)
		.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
	const expression = new RegExp(pattern, "gu");
	return (text) => text.replace(expression, "[redacted]");
}

export function safeMessage(error: unknown, redact?: Redact) {
	const message = error instanceof Error ? error.message : String(error);
	return redact?.(message) ?? message;
}

function redactError(error: ProviderError, redact?: Redact): ProviderError {
	const message = redact?.(error.message) ?? error.message;
	return message === error.message ? error : providerError(error.code, message, {
		status: error.status, rpcCode: error.rpcCode, retryable: error.retryable, retryAfterMs: error.retryAfterMs,
	});
}

/** JSON responses can echo credentials in tool errors, warnings or metadata. */
function redactValues(value: unknown, redact: Redact): unknown {
	if (typeof value === "string") return redact(value);
	if (value && typeof value === "object") {
		const pending = [value as Record<string, unknown>];
		while (pending.length) {
			const object = pending.pop()!;
			for (const key of Object.keys(object)) {
				const child = object[key];
				if (typeof child === "string" && !(object === value && key === "jsonrpc" && child === "2.0")) object[key] = redact(child);
				else if (child && typeof child === "object") pending.push(child as Record<string, unknown>);
			}
		}
	}
	return value;
}

function abortReason(signal: AbortSignal, timeoutMs: number): ProviderError {
	const reason = signal.reason;
	if (asProviderError(reason)) {
		return reason as ProviderError;
	}
	return isProviderErrorWithCode(reason, "timeout")
		? timeoutError(timeoutMs)
		: abortedError();
}

/**
 * Reads the response body, capping decoded bytes so a hostile or oversized
 * upstream response cannot buffer without bound before JSON.parse. The
 * composed request signal stays live here, so the body is also deadline-bound.
 * A fully framed, correlated SSE reply can complete before EOF; cancel its
 * unused tail rather than letting an idle server delay the result until timeout.
 */
async function readBody(
	response: ResponseLike,
	maxBytes: number,
	url: string,
	signal: AbortSignal,
	selectMessage?: (message: unknown) => boolean,
): Promise<string> {
	const stream = response.body;
	if (!stream) {
		const text = await response.text();
		assertBodySize(Buffer.byteLength(text, "utf8"), maxBytes, url);
		return text;
	}

	const reader = stream.getReader();
	const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const decoder = new TextDecoder();
	let total = 0;
	const bodyParts: string[] = [];
	const frameParts: string[] = [];
	const boundary = /\r?\n\r?\n/g;
	let overlap = "";
	let chunksSinceYield = 0;
	let bytesSinceYield = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				total += value.byteLength;
				assertBodySize(total, maxBytes, url);
				bytesSinceYield += value.byteLength;
				const chunk = decoder.decode(value, { stream: true });
				if (chunk.length > 0) bodyParts.push(chunk);
				if (selectMessage) {
					// Only this chunk plus at most three delimiter characters is
					// flattened/scanned. Join frame segments once, at its boundary.
					const scan = overlap + chunk;
					boundary.lastIndex = 0;
					let segmentStart = 0;
					let match: RegExpExecArray | null;
					while ((match = boundary.exec(scan)) !== null) {
						frameParts.push(scan.slice(segmentStart, match.index));
						const frame = frameParts.join("");
						frameParts.length = 0;
						segmentStart = boundary.lastIndex;
						for (const payload of extractSseData(frame)) {
							let message: unknown;
							try { message = JSON.parse(payload); } catch { continue; }
							if (selectMessage(message)) {
								cancel();
								return payload;
							}
						}
					}
					const committedEnd = Math.max(segmentStart, scan.length - 3);
					if (committedEnd > segmentStart) frameParts.push(scan.slice(segmentStart, committedEnd));
					overlap = scan.slice(committedEnd);
				}
			}
			if (++chunksSinceYield >= BODY_READ_YIELD_CHUNKS || bytesSinceYield >= BODY_READ_YIELD_BYTES) {
				await setImmediate();
				chunksSinceYield = 0;
				bytesSinceYield = 0;
				if (signal.aborted) throw reasonFrom(signal);
			}
		}
		bodyParts.push(decoder.decode());
		return bodyParts.join("");
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** Also bound injected transports/body readers that do not honor fetch's signal. */
export function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void pending.catch(() => {});
		return Promise.reject(reasonFrom(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(reasonFrom(signal)); };
		signal.addEventListener("abort", abort, { once: true });
		pending.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}

function assertBodySize(size: number, maxBytes: number, url: string): void {
	if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) {
		throw providerError(
			"parse_error",
			`Response from ${url} exceeded the ${maxBytes}-byte response cap.`,
		);
	}
}

function parseEnvelope<T>(
	url: string,
	bodyText: string,
	allowEmptyBody: boolean,
	selectMessage?: (message: unknown) => boolean,
	redact?: (text: string) => string,
): T {
	if (bodyText.trim().length === 0) {
		if (allowEmptyBody) {
			return undefined as T;
		}
		throw providerError("parse_error", `Empty response body from ${url}.`);
	}
	const trimmed = bodyText.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const message = parseJsonBody<T>(url, bodyText, redact);
		if (!selectMessage) return message;
		const reply = (Array.isArray(message) ? message : [message]).find(selectMessage);
		if (reply === undefined) {
			throw providerError("parse_error", `No JSON-RPC response matching the request id in the response from ${url}.`);
		}
		return reply as T;
	}
	const frames = extractSseData(bodyText);
	if (frames.length === 0) {
		throw providerError(
			"parse_error",
			`No SSE data frames in the response from ${url}.`,
		);
	}
	if (!selectMessage) {
		return parseJsonBody<T>(url, frames[frames.length - 1], redact);
	}
	// JSON-RPC: pick the message whose id matches the outstanding request and
	// tolerate unrelated notifications (progress/log events carry no id).
	for (const frame of frames) {
		let message: unknown;
		try {
			message = JSON.parse(frame);
		} catch {
			continue;
		}
		if (selectMessage(message)) {
			return message as T;
		}
	}
	throw providerError(
		"parse_error",
		`No JSON-RPC response matching the request id in the response from ${url}.`,
	);
}

function parseJsonBody<T>(url: string, bodyText: string, redact?: (text: string) => string): T {
	try {
		return JSON.parse(bodyText) as T;
	} catch (error) {
		// V8 may quote only part of a token. Generate the diagnostic from the scrubbed body.
		const safeBody = redact?.(bodyText) ?? bodyText;
		let cause: unknown = error;
		if (safeBody !== bodyText) {
			cause = undefined;
			try { JSON.parse(safeBody); } catch (safeError) { cause = safeError; }
		}
		const diagnostic = cause === undefined ? "Invalid JSON (credential redacted)." : safeMessage(cause);
		throw providerError("parse_error", `Response from ${url} was not valid JSON: ${diagnostic}`, { cause });
	}
}

function isProviderErrorLike(error: Error): error is ProviderError {
	return typeof (error as { code?: unknown }).code === "string";
}

/** Narrows any value to a `ProviderError` when it carries a stable code. */
function asProviderError(value: unknown): ProviderError | undefined {
	if (
		value instanceof Error &&
		typeof (value as { code?: unknown }).code === "string"
	) {
		return value as ProviderError;
	}
	return undefined;
}

function isProviderErrorWithCode(value: unknown, code: string): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		"code" in value &&
		(value as { code?: unknown }).code === code
	);
}

function isAbortLikeError(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

function summarizeBody(bodyText: string): string {
	const collapsed = bodyText.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) {
		return "";
	}
	if (/<!doctype|<html|<title>/i.test(collapsed)) {
		return "upstream returned an HTML error page";
	}
	return collapsed.length > 300
		? `${collapsed.slice(0, 300)}…`
		: collapsed;
}
