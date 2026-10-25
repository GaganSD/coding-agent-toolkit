import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EvidenceProvider, SearchResultDetail, StreamResult } from "./providers/types.ts";

/** Idle expiry: successful reads slide it forward, never past the maximum lifetime. */
export const EVIDENCE_TTL_MS = 10 * 60_000;
export const EVIDENCE_MAX_LIFETIME_MS = 60 * 60_000;
const MAX_ENTRIES = 32;
const MAX_BYTES = 8 * 1024 * 1024;
const ENTRY_CHARS = 256_000;
const PASSAGE_CHARS = 64_000;
/** 9 bytes -> 12 base64url chars: short, opaque, and safe inside a `resultId:index` ref. */
const ID_BYTES = 9;
/** Global bound on live continuation cursors; minting past this evicts the oldest. */
const MAX_CURSORS = 256;
/** 8 bytes -> 11 base64url chars: unguessable enough for a memory-only, session-owned table. */
const CURSOR_BYTES = 8;
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{11}$/;

interface Entry { owner: string; created: number; expires: number; result: StreamResult; bytes: number; clipped: boolean }

/** One stored hit in a listing: metadata only, never the excerpt. */
export interface StoredHitSummary {
	/** One-based position; the hit ref is `${resultId}:${index}`. */
	index: number;
	title?: string;
	url?: string;
	/** Stored excerpt length in UTF-16 code units. */
	chars: number;
}

export interface StoredListing { total: number; hits: StoredHitSummary[]; clipped: boolean }

export type HitRead =
	| { status: "ok"; hit: SearchResultDetail; clipped: boolean; provider: EvidenceProvider; total: number }
	| { status: "unavailable" }
	| { status: "no-hit"; total: number };

/** Memory only: no documents in session JSONL, no cross-session handles. */
export class EvidenceStore {
	private entries = new Map<string, Entry>();
	private bytes = 0;
	private now: () => number;
	/** Opaque token -> target; dies with the store, pruned with its evidence entry. */
	private cursors = new Map<string, { id: string; ref: string; offset: number }>();
	/** `${ref}\n${offset}` -> token, so re-deriving a cursor is deterministic. */
	private cursorKeys = new Map<string, string>();
	constructor(now = Date.now) { this.now = now; }

	put(owner: string, result: StreamResult): { resultId: string; storedCount: number; storedClipped: boolean } | undefined {
		this.prune();
		if (!result.searchResults?.length) return undefined;
		let remaining = ENTRY_CHARS;
		let clipped = false;
		const searchResults = result.searchResults.slice(0, 256).map((hit) => {
			const text = hit.citedText ?? "";
			const citedText = sliceText(text, Math.min(PASSAGE_CHARS, remaining));
			remaining -= citedText.length;
			clipped ||= citedText.length < text.length;
			const stored = { ...hit, citedText };
			for (const field of ["title", "query", "source", "pageAge", "status", "type"] as const) {
				const value = stored[field];
				if (typeof value === "string") {
					stored[field] = sliceText(value, 1000);
					clipped ||= value.length > 1000;
				}
			}
			return stored;
		});
		clipped ||= searchResults.length < result.searchResults.length;
		const stored = structuredClone({ ...result, text: "", searchResults, sources: [], warnings: [] });
		const bytes = Buffer.byteLength(JSON.stringify(stored));
		if (bytes > MAX_BYTES) return undefined;
		while (this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) this.remove(this.entries.keys().next().value!);
		let resultId = randomBytes(ID_BYTES).toString("base64url");
		while (this.entries.has(resultId)) resultId = randomBytes(ID_BYTES).toString("base64url");
		const created = this.now();
		this.entries.set(resultId, { owner, created, expires: created + EVIDENCE_TTL_MS, result: stored, bytes, clipped });
		this.bytes += bytes;
		return { resultId, storedCount: searchResults.length, storedClipped: clipped };
	}

	get(owner: string, id: string): { result: StreamResult; clipped: boolean } | undefined {
		const entry = this.owned(owner, id);
		if (!entry) return undefined;
		this.touch(id, entry);
		return { result: structuredClone(entry.result), clipped: entry.clipped };
	}

	/** Existence + ownership without refreshing idle expiry or recency. */
	has(owner: string, id: string): boolean {
		return this.owned(owner, id) !== undefined;
	}

	/** A successful access: slides idle expiry (capped by lifetime) and recency. */
	refresh(owner: string, id: string): void {
		const entry = this.owned(owner, id);
		if (entry) this.touch(id, entry);
	}

	/** Bounded metadata page: no excerpt clones, and strings are immutable so callers cannot mutate stored state. Never refreshes; the caller refreshes only after a successful read. */
	list(owner: string, id: string, offset: number, limit: number): StoredListing | undefined {
		const entry = this.owned(owner, id);
		if (!entry) return undefined;
		const hits = entry.result.searchResults ?? [];
		const start = Math.max(0, Math.min(Math.floor(offset), hits.length));
		const page = hits.slice(start, start + Math.max(0, limit)).map((hit, i) => ({
			index: start + i + 1,
			...(hit.title === undefined ? {} : { title: hit.title }),
			...(hit.url === undefined ? {} : { url: hit.url }),
			chars: hit.citedText?.length ?? 0,
		}));
		return { total: hits.length, hits: page, clipped: entry.clipped };
	}

	/** Targeted read: clones the one requested hit, never the whole result. Never refreshes; the caller refreshes only after a successful read. */
	readHit(owner: string, id: string, index: number): HitRead {
		const entry = this.owned(owner, id);
		if (!entry) return { status: "unavailable" };
		const hits = entry.result.searchResults ?? [];
		const hit = hits[index];
		if (!hit) return { status: "no-hit", total: hits.length };
		return { status: "ok", hit: structuredClone(hit), clipped: entry.clipped, provider: entry.result.providerKind, total: hits.length };
	}

	/** Opaque random cursor bound to one exact ref; the same ref+offset always reuses its token. */
	sealCursor(ref: string, offset: number): string {
		const key = `${ref}\n${offset}`;
		const existing = this.cursorKeys.get(key);
		if (existing !== undefined && this.cursors.has(existing)) return existing;
		if (this.cursors.size >= MAX_CURSORS) this.dropCursor(this.cursors.keys().next().value!);
		let token = randomBytes(CURSOR_BYTES).toString("base64url");
		while (this.cursors.has(token)) token = randomBytes(CURSOR_BYTES).toString("base64url");
		const colon = ref.indexOf(":");
		this.cursors.set(token, { id: colon === -1 ? ref : ref.slice(0, colon), ref, offset });
		this.cursorKeys.set(key, token);
		return token;
	}

	/** Offset for a live cursor bound to this exact ref; undefined for unknown, malformed, or wrong-ref tokens. */
	openCursor(ref: string, cursor: string): number | undefined {
		if (!CURSOR_SHAPE.test(cursor)) return undefined;
		const target = this.cursors.get(cursor);
		return target?.ref === ref ? target.offset : undefined;
	}

	clear(owner?: string): void {
		for (const [id, entry] of this.entries) if (owner === undefined || entry.owner === owner) this.remove(id);
	}
	private owned(owner: string, id: string): Entry | undefined {
		this.prune();
		const entry = this.entries.get(id);
		return entry?.owner === owner ? entry : undefined;
	}
	/** Slides idle expiry and re-inserts so eviction follows recency, not insertion order. */
	private touch(id: string, entry: Entry): void {
		entry.expires = Math.min(this.now() + EVIDENCE_TTL_MS, entry.created + EVIDENCE_MAX_LIFETIME_MS);
		this.entries.delete(id);
		this.entries.set(id, entry);
	}
	private remove(id: string): void {
		const entry = this.entries.get(id);
		if (entry) this.bytes -= entry.bytes;
		this.entries.delete(id);
		for (const [token, target] of this.cursors) if (target.id === id) this.dropCursor(token);
	}
	private dropCursor(token: string): void {
		const target = this.cursors.get(token);
		if (target) this.cursorKeys.delete(`${target.ref}\n${target.offset}`);
		this.cursors.delete(token);
	}
	private prune(): void { for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id); }
}

export function sliceText(text: string, limit: number): string {
	let end = Math.max(0, Math.min(text.length, limit));
	if (end < text.length && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
	return text.slice(0, end);
}

export function evidenceOwner(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager?.getSessionId?.();
}

export const evidenceStore = new EvidenceStore();
