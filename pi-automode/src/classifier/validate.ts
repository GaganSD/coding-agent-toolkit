/**
 * Exact validation of native classifier results.
 *
 * Pi's System One wrapper guarantees presence and numeric type of answers but
 * deliberately echoes the *requested* `model.id` — so identity fields prove an
 * echo, not a provider-side resolved version, and this adapter never claims
 * model pinning. Everything else is validated here and malformed data is
 * rejected, never clamped into something that looks authoritative:
 *
 * - provider/model identity must echo the requested pair exactly;
 * - `stopReason` must be `"stop"` for a completed review (handled by caller);
 * - every question sent must have exactly one answer, with no extra answer ids;
 * - the choice label must be one of the criteria labels and the top label
 *   (an argmax of the probability distribution, ties allowed);
 * - probabilities must cover exactly the criteria labels, each finite in
 *   [0, 1], summing to 1 within a defined tolerance;
 * - confidence must be finite in [0, 1];
 * - usage, when present, must have finite non-negative core fields or it is
 *   dropped as unknown (never reported as zero cost).
 */
import type {
	ClassifierChoiceQuestionLike,
	ClassifierModelLike,
	ClassifierResultLike,
	ClassifierUsage,
	ValidatedChoiceAnswer,
} from "./contract.js";

/** Defined numerical tolerance for the probability-sum check. */
export const PROBABILITY_SUM_TOLERANCE = 1e-4;

/** Tolerance for the top-label (argmax) consistency check. */
export const TOP_LABEL_TOLERANCE = 1e-9;

const MAX_REASON_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Strip terminal control characters and bound length of provider-supplied text. */
export function sanitizeReason(text: unknown, maxLength = MAX_REASON_LENGTH): string {
	if (typeof text !== "string" || text.length === 0) return "";
	const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
	return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** Result identity must echo the requested pair exactly; never a pinning claim. */
export function validateIdentity(result: ClassifierResultLike, model: ClassifierModelLike): string | undefined {
	if (result.provider !== model.provider) {
		return `classifier identity mismatch: result provider ${sanitizeReason(result.provider) || "?"} != requested ${model.provider}`;
	}
	if (result.model !== model.id) {
		return `classifier identity mismatch: result model ${sanitizeReason(result.model) || "?"} != requested ${model.id}`;
	}
	return undefined;
}

function validateChoiceAnswer(
	id: string,
	question: ClassifierChoiceQuestionLike,
	raw: unknown,
): { ok: true; answer: ValidatedChoiceAnswer } | { ok: false; reason: string } {
	const fail = (reason: string) => ({ ok: false as const, reason: `answer ${id}: ${reason}` });
	if (!isRecord(raw)) return fail("missing or not an object");
	if (raw.type !== "choice") return fail("wrong answer type");
	if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) {
		return fail("choice label is not one of the criteria labels");
	}
	const choice = raw.choice;
	if (!isRecord(raw.probabilities)) return fail("probabilities missing or not an object");
	const probabilities: Record<string, number> = {};
	const criteriaLabels = Object.keys(question.criteria);
	const probabilityLabels = Object.keys(raw.probabilities);
	if (probabilityLabels.length !== criteriaLabels.length) {
		return fail("probabilities do not cover exactly the criteria labels");
	}
	let sum = 0;
	let max = Number.NEGATIVE_INFINITY;
	let choiceProbability: number | undefined;
	for (const label of criteriaLabels) {
		if (!Object.hasOwn(raw.probabilities, label)) {
			return fail("probabilities do not cover exactly the criteria labels");
		}
		const probability = raw.probabilities[label];
		if (!isProbability(probability)) return fail(`probability for ${label} is not finite in [0, 1]`);
		probabilities[label] = probability;
		sum += probability;
		if (probability > max) max = probability;
		if (label === choice) choiceProbability = probability;
	}
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
		return fail(`probabilities sum to ${sum}, outside tolerance of 1`);
	}
	if (!isProbability(raw.confidence)) return fail("confidence is not finite in [0, 1]");
	// choice is a criteria label, so its probability was recorded in the loop;
	// a tie at the top is accepted (within tolerance), never clamped.
	if (choiceProbability === undefined || choiceProbability < max - TOP_LABEL_TOLERANCE) {
		return fail("choice label is not the top-probability label");
	}
	return { ok: true, answer: { type: "choice", choice, probabilities, confidence: raw.confidence } };
}

/** Every question sent needs exactly one valid answer; extra ids are rejected. */
export function validateAnswers(
	questions: Record<string, ClassifierChoiceQuestionLike>,
	answers: unknown,
): { ok: true; answers: Record<string, ValidatedChoiceAnswer> } | { ok: false; reason: string } {
	if (!isRecord(answers)) return { ok: false, reason: "answers missing or not an object" };
	const questionIds = Object.keys(questions);
	const answerIds = Object.keys(answers);
	for (const id of answerIds) {
		if (!Object.hasOwn(questions, id)) return { ok: false, reason: `unexpected answer id ${sanitizeReason(id) || "?"}` };
	}
	if (answerIds.length !== questionIds.length) {
		return { ok: false, reason: "answer count does not match the questions sent" };
	}
	const validated: Record<string, ValidatedChoiceAnswer> = {};
	for (const id of questionIds) {
		if (!Object.hasOwn(answers, id)) return { ok: false, reason: `missing answer for ${id}` };
		const question = questions[id];
		if (question === undefined) return { ok: false, reason: `missing question for ${id}` };
		const result = validateChoiceAnswer(id, question, answers[id]);
		if (!result.ok) return result;
		validated[id] = result.answer;
	}
	return { ok: true, answers: validated };
}

function nonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Clean, validated usage or `undefined` (unknown). A catalog's absent price is
 * unknown cost, not free; malformed usage is dropped, never clamped to zero.
 */
export function validateUsage(raw: unknown): ClassifierUsage | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecord(raw) || !isRecord(raw.cost)) return undefined;
	if (!nonNegativeFinite(raw.input) || !nonNegativeFinite(raw.output)) return undefined;
	if (!nonNegativeFinite(raw.totalTokens) || !nonNegativeFinite(raw.cost.total)) return undefined;
	const usage: ClassifierUsage = {
		input: raw.input,
		output: raw.output,
		totalTokens: raw.totalTokens,
		cost: { total: raw.cost.total },
	};
	for (const key of ["cacheRead", "cacheWrite", "reasoning"] as const) {
		if (raw[key] !== undefined) {
			if (!nonNegativeFinite(raw[key])) return undefined;
			usage[key] = raw[key] as number;
		}
	}
	return usage;
}
