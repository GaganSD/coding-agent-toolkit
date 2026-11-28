import { lookup } from "node:dns/promises";
import { get as httpGet, type IncomingHttpHeaders } from "node:http";
import { get as httpsGet, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { compose, Readable } from "node:stream";
import { constants, createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { awaitWithSignal } from "../providers/http.ts";
import { isProviderError, providerError } from "../providers/types.ts";

export const PAGE_ACCEPT = "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1";
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const blocked = new BlockList();
for (const [ip, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
	["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(ip, prefix, "ipv4");
blocked.addAddress("168.63.129.16", "ipv4"); // Azure platform virtual IP
for (const [ip, prefix] of [
	["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(ip, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

interface Address { address: string; family: number }
interface Response { status: number; headers: IncomingHttpHeaders; body: Readable }
export interface PageTransport {
	resolve?: (host: string) => Promise<Address[]>;
	connect?: (url: URL, address: Address, headers: Record<string, string>, signal: AbortSignal) => Promise<Response>;
}

export interface Page {
	bytes: Buffer;
	contentType: string;
	truncated: boolean;
}

export type FetchPage = (url: URL, headers?: Record<string, string>) => Promise<Page>;

export function publicHttpUrl(raw: string | URL): URL {
	let url: URL;
	try { url = new URL(raw); } catch { throw providerError("parse_error", "Invalid URL."); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw providerError("parse_error", "URL reading requires HTTP(S) URLs without credentials.");
	}
	const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
	if (!isIP(hostname) && (!hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/iu.test(hostname))) {
		throw blockedAddress();
	}
	url.hash = "";
	return url;
}

function blockedAddress() {
	return providerError("parse_error", "URL reading blocked a non-public network address.");
}

async function publicAddress(url: URL, signal: AbortSignal, resolve: NonNullable<PageTransport["resolve"]>): Promise<Address> {
	const hostname = url.hostname.replace(/^\[|\]$/gu, "");
	const family = isIP(hostname);
	const addresses = family ? [{ address: hostname, family }] : await awaitWithSignal(resolve(hostname), signal);
	if (!addresses.length) throw providerError("network_error", "URL hostname resolved to no addresses.", { retryable: false });
	for (const candidate of addresses) {
		if (candidate.family !== isIP(candidate.address) || candidate.address.includes("%")) throw blockedAddress();
		if (candidate.family === 4 && !blocked.check(candidate.address, "ipv4")) continue;
		if (candidate.family === 6 && globalV6.check(candidate.address, "ipv6") && !blocked.check(candidate.address, "ipv6")) continue;
		throw blockedAddress();
	}
	return addresses[0];
}

/** Keep the URL hostname for Host and TLS certificate verification. Only the socket lookup is pinned. */
export function pinnedRequestOptions(address: Address, headers: Record<string, string>, signal: AbortSignal): RequestOptions & { autoSelectFamily: false } {
	return {
		agent: false,
		autoSelectFamily: false,
		family: address.family,
		headers,
		signal,
		rejectUnauthorized: true,
		lookup: (_host, _options, callback) => callback(null, address.address, address.family),
	};
}

function connectPinned(url: URL, address: Address, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
	return new Promise((resolve, reject) => {
		const get = url.protocol === "https:" ? httpsGet : httpGet;
		const request = get(url, pinnedRequestOptions(address, headers, signal), (message) => {
			resolve({ status: message.statusCode ?? 0, headers: message.headers, body: message });
		});
		request.on("error", reject);
	});
}

export async function fetchPinnedPage(
	input: URL,
	signal: AbortSignal,
	transport: PageTransport = {},
	headers: Record<string, string> = {},
	onValidation?: (validated: boolean) => void,
): Promise<Page> {
	let next = input;
	let requestHeaders = { Accept: PAGE_ACCEPT, "Accept-Encoding": "identity", "User-Agent": "pi-web-search", ...headers };
	for (let redirects = 0; ; redirects++) {
		signal.throwIfAborted();
		onValidation?.(false);
		const url = publicHttpUrl(next);
		try {
			const address = await publicAddress(url, signal, transport.resolve ?? ((host) => lookup(host, { all: true })));
			signal.throwIfAborted();
			onValidation?.(true);
			const response = await (transport.connect ?? connectPinned)(url, address, requestHeaders, signal);
			try {
				const location = response.headers.location;
				if (REDIRECTS.has(response.status) && location) {
					onValidation?.(false);
					if (redirects === MAX_REDIRECTS) throw providerError("http_error", "URL reading stopped after 5 redirects.", { retryable: false });
					try { next = new URL(location, url); } catch { throw providerError("parse_error", "URL returned an invalid redirect."); }
					if (next.origin !== url.origin) {
						requestHeaders = Object.fromEntries(Object.entries(requestHeaders)
							.filter(([name]) => name.toLowerCase() !== "authorization")) as typeof requestHeaders;
					}
					continue;
				}
				if (response.status < 200 || response.status >= 300) {
					const retryable = response.status === 403 || response.status === 429 || (response.status >= 500 && response.status < 600);
					throw providerError(response.status === 429 ? "rate_limited" : "http_error",
						`URL returned HTTP ${response.status}.`, { status: response.status, retryable });
				}
				const contentType = response.headers["content-type"] ?? "";
				const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
				return { ...await readBody(response.body, encoding, signal), contentType };
			} finally {
				response.body.destroy();
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (isProviderError(error)) throw error;
			if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT") {
				throw providerError("timeout", "Direct URL request timed out.");
			}
			throw providerError("network_error", "Direct URL request failed.", { retryable: false });
		}
	}
}

async function readBody(body: Readable, encoding: string, signal: AbortSignal) {
	// Request identity encoding. Decode common encodings for servers that ignore it.
	// A clipped input may end inside a compressed frame. Keep the decoded prefix.
	const zlibOptions = { finishFlush: constants.Z_SYNC_FLUSH };
	const decoder = encoding === "gzip" ? createGunzip(zlibOptions)
		: encoding === "br" ? createBrotliDecompress({ finishFlush: constants.BROTLI_OPERATION_FLUSH })
		: encoding === "deflate" ? createInflate(zlibOptions) : undefined;
	if (!decoder && encoding && encoding !== "identity") {
		throw providerError("parse_error", "URL returned an unsupported content encoding.");
	}
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	// Bound both the compressed wire body and its decoded expansion.
	async function* wireChunks() {
		let remaining = MAX_BODY_BYTES;
		for await (const chunk of body as AsyncIterable<Buffer>) {
			if (chunk.length > remaining) {
				truncated = true;
				yield chunk.subarray(0, remaining);
				return;
			}
			remaining -= chunk.length;
			yield chunk;
		}
	}
	const stream = decoder ? compose(Readable.from(wireChunks()), decoder) : body;
	const stop = () => {
		stream.destroy();
		if (decoder) body.destroy();
	};
	signal.addEventListener("abort", stop, { once: true });
	try {
		signal.throwIfAborted();
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			const available = MAX_BODY_BYTES - total;
			const kept = chunk.subarray(0, available);
			chunks.push(kept);
			total += kept.length;
			if (chunk.length > available) {
				truncated = true;
				break;
			}
		}
		signal.throwIfAborted();
	} catch (error) {
		// A decoder can reject an intentionally clipped compressed stream.
		if (!truncated || signal.aborted) throw error;
	} finally {
		signal.removeEventListener("abort", stop);
		stream.destroy();
	}
	return { bytes: Buffer.concat(chunks, total), truncated };
}
