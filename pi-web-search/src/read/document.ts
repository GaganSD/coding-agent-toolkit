import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { sliceText } from "../evidence.ts";
import { providerError } from "../providers/types.ts";
import type { Page } from "./http.ts";

export const MAX_DOCUMENT_CHARS = 64_000;
const MIN_HTML_CHARS = 120;
const adjacentWorker = new URL("./worker.mjs", import.meta.url);
const workerFile = existsSync(adjacentWorker) ? adjacentWorker : new URL("../src/read/worker.mjs", import.meta.url);

export interface DocumentText {
	text: string;
	title?: string;
	truncated?: boolean;
	source?: "local" | "github" | "pdf";
}

export type ExtractionJob = { format: "html"; text: string } | { format: "pdf"; bytes: Uint8Array };

export function textOf(page: Page): string {
	const charset = /(?:^|;)\s*charset=["']?([\w-]+)/iu.exec(page.contentType)?.[1] ?? "utf-8";
	let decoder: TextDecoder;
	try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder("utf-8"); }
	return decoder.decode(page.bytes, { stream: page.truncated });
}

export async function documentFromPage(page: Page, url: URL, signal: AbortSignal, rawFile = false): Promise<DocumentText> {
	const mime = page.contentType.split(";")[0].trim().toLowerCase();
	if (mime === "application/pdf" || page.bytes.subarray(0, 1024).includes("%PDF-")) {
		const pdf = await extract({ format: "pdf", bytes: page.bytes }, signal).catch((error: unknown) => {
			if (signal.aborted || !page.truncated) throw error;
			throw providerError("parse_error", "PDF exceeded the 5 MiB download cap and could not be read.");
		});
		return { ...pdf, source: "pdf", truncated: pdf.truncated || page.truncated };
	}
	const text = textOf(page);
	if (mime === "text/html" || mime === "application/xhtml+xml" || (!mime && /^\s*<(?:!doctype\s+html|html|head|body)\b/iu.test(text))) {
		const html = await extract({ format: "html", text }, signal);
		if (!page.truncated && html.text.replace(/\s/gu, "").length < MIN_HTML_CHARS) {
			throw providerError("parse_error", "The HTML page has too little readable text and may require JavaScript.", { retryable: true });
		}
		return { ...html, source: "local", truncated: html.truncated || page.truncated };
	}
	const textMime = !mime || mime.startsWith("text/") || /^(?:application\/(?:[\w.+-]*\+)?(?:json|xml|yaml|javascript))$/u.test(mime);
	if ((!textMime && !rawFile) || text.includes("\0")) {
		throw providerError("parse_error", "The URL returned a file format the local reader cannot extract.");
	}
	return {
		text: mime === "text/markdown" || /\.(?:md|markdown)$/iu.test(url.pathname) ? stripMarkdownLinks(text) : text,
		source: "local",
		truncated: page.truncated,
	};
}

/** Remove markdown resource links while keeping their labels and leaving fenced code intact. */
export function stripMarkdownLinks(text: string): string {
	if (!text.includes("[") && !text.includes("<")) return text;
	const definitions = new Set<string>();
	const chunks: { line: string; code: boolean }[] = [];
	let fence: string | undefined;
	for (const line of text.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
		const fenced = fence !== undefined;
		if (marker && !fence) fence = marker;
		else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
		if (!marker && !fenced) {
			const definition = /^ {0,3}\[([^\]\n]{1,256})\]:\s*\S/u.exec(line)?.[1];
			if (definition) {
				definitions.add(labelKey(definition));
				continue;
			}
		}
		chunks.push({ line, code: fenced || !!marker || /^(?: {4}|\t)/u.test(line) });
	}
	return chunks.map(({ line, code }) => code ? line : stripLineLinks(line, definitions)).join("\n");
}

function labelKey(label: string) {
	return label.trim().replace(/\s+/gu, " ").toLowerCase();
}

function stripLineLinks(line: string, definitions: Set<string>): string {
	// Bound matches on oversized lines. Retain bracketed labels, including nested images linked to another page.
	return line.replace(/(`{1,24})[^`]{0,2048}\1|(!?)\[((?:[^[\]\n]|\[[^[\]\n]{0,512}\]){0,512})\](?:\((?:[^()\n]|\([^()\n]{0,512}\)){0,2048}\)|\[([^\]\n]{0,256})\])?|<(?:https?:\/\/|mailto:)[^<>\s]+>|<\/?(?:a|img|picture|source)\b[^<>]{0,2048}>/giu,
		(full, code: string | undefined, image: string | undefined, label: string | undefined, reference: string | undefined) => {
			if (code) return full;
			if (label === undefined || image) return "";
			if (!full.endsWith(")") && !definitions.has(labelKey(reference || label))) return full;
			return label.includes("[") ? stripLineLinks(label, definitions) : label;
		});
}

function extract(job: ExtractionJob, signal: AbortSignal): Promise<DocumentText> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		// Parsing stays off the event loop, so a complex page cannot delay cancellation.
		const worker = new Worker(workerFile, {
			workerData: { ...job, maxChars: MAX_DOCUMENT_CHARS },
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 192 },
			env: {},
			stdout: true,
			stderr: true,
		});
		worker.stdout.resume();
		worker.stderr.resume();
		const fail = () => reject(providerError("parse_error", `Local ${job.format.toUpperCase()} extraction failed.`));
		const abort = () => {
			reject(signal.reason);
			void worker.terminate();
		};
		worker.once("message", (message: DocumentText | null) => {
			signal.removeEventListener("abort", abort);
			if (message) resolve(message); else fail();
		});
		worker.once("error", fail);
		worker.once("exit", () => {
			signal.removeEventListener("abort", abort);
			fail();
		});
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

export function capDocument(text: string): DocumentText {
	const clipped = sliceText(text, MAX_DOCUMENT_CHARS);
	return { text: clipped, truncated: clipped.length < text.length };
}
