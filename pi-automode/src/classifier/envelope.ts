/**
 * Bounded review envelope: the only data this adapter may transmit.
 *
 * Privacy rules (fail closed, stay local):
 * - Sensitive, incomplete, or protected-target evidence is never transmitted.
 * - Action argument VALUES are never transmitted. A scanner cannot prove an
 *   arbitrary payload (write content, edit old/new text, opaque command,
 *   raw command string) is free of secrets whose keys look ordinary, so the
 *   envelope is a metadata-only whitelist: tool name, cwd, and the argument
 *   key names — never the payloads.
 * - Shell opaque-reason text is never transmitted: core embeds raw command
 *   tokens (flags, operands, executable names) in it. Only the boolean fact
 *   and the canonical resolved executable path leave the machine.
 * - Snapshot/file bodies, environment values, conversation text, and
 *   credentials are never part of the envelope; snapshots contribute only
 *   whitelisted scalar metadata, exactly the core FileSnapshot metadata
 *   fields (no drift, no bodies).
 * - Operator-saved message rule texts are the policy under evaluation and
 *   are sent byte-exact as written; command rules never leave the machine.
 * - The serialized state is byte-bounded in UTF-8 (not UTF-16 code units),
 *   with a pre-serialization estimate so oversized evidence is refused
 *   before a large serialization is ever allocated. Oversized or
 *   irreducibly opaque evidence skips remote review entirely: there is no
 *   decisive truncation, and nothing pretends a reduced payload is
 *   equivalent to the real one.
 *
 * Everything placed in `state` is built field-by-field from whitelisted
 * sources; unknown objects are never spread into the envelope.
 */
import type {
	ClassifierChoiceQuestionLike,
	JsonValueLike,
	ReviewInput,
	ReviewerEvidence,
	ReviewerSettings,
} from "./contract.js";
import { buildQuestions, enabledMessageRules, QUESTION_VERSION } from "./questions.js";

/** Bump on any shape change; recorded in every envelope. */
export const ENVELOPE_VERSION = 2;

/** Serialized-state UTF-8 byte budget; far under any per-request budget. */
export const DEFAULT_MAX_STATE_BYTES = 16_000;

/**
 * Whitelisted scalar FileSnapshot metadata keys — exactly the core
 * `FileSnapshot` metadata fields (`src/types.ts`). Bodies never; if core
 * grows metadata fields they must be added here deliberately, and scalar
 * body-like fields must never be added.
 */
const SNAPSHOT_METADATA_KEYS = [
	"path",
	"canonicalPath",
	"kind",
	"sha256",
	"hashTruncated",
	"size",
	"mtimeMs",
	"nlink",
	"dev",
	"ino",
	"error",
] as const;

export type EnvelopeResult = { ok: true; input: ReviewInput } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Argument metadata: sorted top-level key names only. Values — including
 * nested ones — never leave the machine, so no key scan, depth walk, or
 * serialization of payloads happens here at all.
 */
function argumentKeys(args: Record<string, unknown>): string[] {
	return Object.keys(args).sort();
}

/** Whitelisted scalar snapshot metadata. Bodies and unknown shapes stay out. */
function snapshotMetadata(raw: unknown): Record<string, JsonValueLike> {
	if (!isRecord(raw)) return { opaque: true };
	const meta: Record<string, JsonValueLike> = {};
	for (const key of SNAPSHOT_METADATA_KEYS) {
		if (!Object.hasOwn(raw, key)) continue;
		const value = raw[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			meta[key] = value;
		}
	}
	return meta;
}

/**
 * Lower-bound UTF-8 byte estimate of the JSON serialization, computed over
 * the whitelisted tree before any full serialization is allocated. String
 * content dominates; JSON punctuation and escaping only add bytes, so this
 * is a safe early-refusal bound, never the acceptance check.
 */
function estimateSerializedBytes(value: JsonValueLike): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return 8;
	if (Array.isArray(value)) {
		let total = 2;
		for (const item of value) total += estimateSerializedBytes(item) + 1;
		return total;
	}
	let total = 2;
	for (const key of Object.keys(value)) {
		total += Buffer.byteLength(key, "utf8") + 4 + estimateSerializedBytes(value[key] as JsonValueLike) + 1;
	}
	return total;
}

/**
 * Build the bounded review input, or explain why remote review is refused.
 * Pure and local: this function never performs I/O.
 */
export function buildReviewInput(
	evidence: ReviewerEvidence,
	settings: ReviewerSettings,
	options?: { maxStateBytes?: number },
): EnvelopeResult {
	if (evidence.sensitive) {
		return { ok: false, reason: "sensitive evidence is never transmitted; review stays local" };
	}
	if (!evidence.complete) {
		return { ok: false, reason: "incomplete evidence is never transmitted; review stays local" };
	}
	if (typeof evidence.protectedReason === "string" && evidence.protectedReason.length > 0) {
		return { ok: false, reason: "protected-target evidence is never transmitted; review stays local" };
	}

	const blockRules = enabledMessageRules(settings.blocklist);
	const allowRules = enabledMessageRules(settings.allowlist);
	if (blockRules.length === 0 && allowRules.length === 0) {
		return { ok: false, reason: "no message rules to evaluate; no classifier request is needed" };
	}
	const questions: Record<string, ClassifierChoiceQuestionLike> = buildQuestions(settings);

	if (!isRecord(evidence.action) || typeof evidence.action.tool !== "string" || typeof evidence.action.cwd !== "string") {
		return { ok: false, reason: "action identity is malformed; review stays local" };
	}
	const args = isRecord(evidence.action.args) ? evidence.action.args : {};
	if (!Array.isArray(evidence.snapshots)) {
		return { ok: false, reason: "evidence snapshots are malformed; review stays local" };
	}
	const shell = evidence.shell;
	const shellFacts: Record<string, JsonValueLike> = {};
	if (shell !== undefined) {
		if (!isRecord(shell)) {
			return { ok: false, reason: "shell resolution evidence is malformed; review stays local" };
		}
		if (typeof shell.resolvedExecutable === "string") shellFacts.resolved_executable = shell.resolvedExecutable;
		// opaqueReason embeds raw command tokens; only the boolean fact leaves.
		if (typeof shell.opaqueReason === "string" && shell.opaqueReason.length > 0) shellFacts.opaque = true;
	}

	const state: Record<string, JsonValueLike> = {
		envelope_version: ENVELOPE_VERSION,
		question_version: QUESTION_VERSION,
		action: {
			tool: evidence.action.tool,
			argument_keys: argumentKeys(args),
			cwd: evidence.action.cwd,
		},
		target: {
			workspace: evidence.workspace,
			...(typeof evidence.canonicalPath === "string" ? { canonical_path: evidence.canonicalPath } : {}),
		},
		evidence: {
			// evidence.reason embeds raw command tokens and path spellings from
			// local analysis; like the shell opaque-reason text it never leaves
			// the machine.
			...(Object.keys(shellFacts).length > 0 ? { shell: shellFacts } : {}),
			snapshots: evidence.snapshots.map(snapshotMetadata),
		},
	};
	if (blockRules.length > 0) state.block_rules = blockRules.map((rule) => ({ rule: rule.text }));
	if (allowRules.length > 0) state.allow_rules = allowRules.map((rule) => ({ rule: rule.text }));

	const maxStateBytes = options?.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
	// Refuse before allocating a large serialization (estimate is a lower bound).
	if (estimateSerializedBytes(state) > maxStateBytes) {
		return {
			ok: false,
			reason: `evidence exceeds the bounded state budget (>${maxStateBytes} UTF-8 bytes by estimate); no decisive truncation, review stays local`,
		};
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(state);
	} catch {
		return { ok: false, reason: "evidence is not safely serializable; review stays local" };
	}
	// Authoritative check in UTF-8 bytes, not UTF-16 code units.
	const byteLength = Buffer.byteLength(serialized, "utf8");
	if (byteLength > maxStateBytes) {
		return {
			ok: false,
			reason: `evidence exceeds the bounded state budget (${byteLength} > ${maxStateBytes} UTF-8 bytes); no decisive truncation, review stays local`,
		};
	}
	return { ok: true, input: { state, questions } };
}
