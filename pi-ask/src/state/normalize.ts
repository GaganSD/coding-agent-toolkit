import type {
	AskOption,
	AskParams,
	AskQuestion,
	AskQuestionInput,
	AskValidationIssue,
} from "../types.ts";

interface IssueCollector {
	add: (path: string, message: string) => void;
	issues: AskValidationIssue[];
}

export function normalizeQuestions(params: AskParams): AskQuestion[] {
	const issues = collectValidationIssues(params);
	if (issues.length > 0) {
		throw new Error(issues[0]?.message ?? "Invalid ask_user payload");
	}
	return params.questions.map((question, index) =>
		normalizeQuestion(question, index)
	);
}

export function collectValidationIssues(
	params: AskParams
): AskValidationIssue[] {
	const collector = createIssueCollector();
	validateQuestions(params.questions, collector);
	return collector.issues;
}

const QUESTION_SHAPE_KEYS = ["id", "label", "prompt", "type", "options"];

export function prepareAskParams(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}
	const repaired = repairQuestionShape(input);
	if (!Array.isArray(repaired.questions)) {
		return repaired;
	}
	return {
		...repaired,
		questions: repaired.questions.map((question) => {
			if (!isRecord(question)) {
				return question;
			}
			if (!Array.isArray(question.options)) {
				return question;
			}
			return {
				...question,
				options: question.options.map(prepareOption),
			};
		}),
	};
}

/**
 * Repair common payload-shape mistakes before validation: a lone question
 * flattened to the top level, or question fields left beside a one-item
 * `questions` array. Only missing keys are moved; existing values and
 * multi-question payloads are left untouched.
 */
function repairQuestionShape(
	input: Record<string, unknown>
): Record<string, unknown> {
	const questions = input.questions;
	const one =
		questions === undefined && typeof input.prompt === "string"
			? ({} as Record<string, unknown>)
			: Array.isArray(questions) &&
				  questions.length === 1 &&
				  isRecord(questions[0])
				? questions[0]
				: undefined;
	if (one === undefined) return input;
	const rest = { ...input };
	const moved: Record<string, unknown> = {};
	for (const key of QUESTION_SHAPE_KEYS) {
		if (one[key] === undefined && rest[key] !== undefined) {
			moved[key] = rest[key];
			delete rest[key];
		}
	}
	if (Object.keys(moved).length === 0) return input;
	return { ...rest, questions: [{ ...one, ...moved }] };
}

function prepareOption(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}
	if (
		input.label !== undefined &&
		!(typeof input.label === "string" && !input.label.trim())
	) {
		return input;
	}
	if (typeof input.value !== "string") {
		return input;
	}
	const words = input.value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
	if (!words) {
		return input;
	}
	return {
		...input,
		label: words.charAt(0).toUpperCase() + words.slice(1),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuestion(
	question: AskQuestionInput,
	index: number
): AskQuestion {
	const type = normalizeQuestionType(question.type);
	return {
		id: question.id.trim(),
		label: question.label?.trim() || `Q${index + 1}`,
		prompt: question.prompt.trim(),
		type,
		options: type === "text" ? [] : (question.options ?? []).map(normalizeOption),
	};
}

function normalizeOption(option: AskOption): AskOption {
	return {
		value: option.value.trim(),
		label: option.label.trim(),
		description: option.description?.trim() || undefined,
		...(option.recommended === undefined
			? {}
			: { recommended: option.recommended }),
	};
}

function validateQuestions(
	questions: AskParams["questions"],
	collector: IssueCollector
) {
	if (questions.length === 0) {
		collector.add("questions", "At least one question is required");
		return;
	}

	const questionIds = new Set<string>();
	for (const [questionIndex, question] of questions.entries()) {
		validateQuestion(question, questionIndex, questionIds, collector);
	}
}

function validateQuestion(
	question: AskQuestionInput,
	questionIndex: number,
	questionIds: Set<string>,
	collector: IssueCollector
) {
	const questionNumber = questionIndex + 1;
	const questionPath = `questions[${questionIndex}]`;
	const questionId = question.id?.trim();
	const questionType = normalizeQuestionType(question.type);
	const options = question.options ?? [];

	validateQuestionType(
		question.type,
		questionNumber,
		collector,
		`${questionPath}.type`
	);
	assertRequired(
		questionId,
		collector,
		`${questionPath}.id`,
		`Question ${questionNumber}: id is required`
	);
	assertUnique(
		questionIds,
		questionId,
		collector,
		`${questionPath}.id`,
		`Question ${questionNumber}: duplicate question id "${questionId}"`
	);
	assertRequired(
		question.prompt?.trim(),
		collector,
		`${questionPath}.prompt`,
		`Question ${questionNumber}: prompt is required`
	);

	if (questionType === "text") {
		if (options.length > 0) {
			collector.add(
				`${questionPath}.options`,
				`Question ${questionNumber}: text questions have no options`
			);
		}
		return;
	}

	if (options.length === 0) {
		collector.add(
			`${questionPath}.options`,
			`Question ${questionNumber}: at least one option is required`
		);
		return;
	}

	const optionValues = new Set<string>();
	for (const [optionIndex, option] of options.entries()) {
		validateOption(
			option,
			optionIndex,
			optionValues,
			questionNumber,
			collector,
			`${questionPath}.options[${optionIndex}]`
		);
	}
}

function validateOption(
	option: AskOption,
	optionIndex: number,
	optionValues: Set<string>,
	questionNumber: number,
	collector: IssueCollector,
	optionPath: string
) {
	const optionNumber = optionIndex + 1;
	const prefix = `Question ${questionNumber}, option ${optionNumber}`;
	const optionValue = option.value?.trim();

	assertRequired(
		optionValue,
		collector,
		`${optionPath}.value`,
		`${prefix}: value is required`
	);
	assertUnique(
		optionValues,
		optionValue,
		collector,
		`${optionPath}.value`,
		`${prefix}: duplicate option value "${optionValue}"`
	);
	assertRequired(
		option.label?.trim(),
		collector,
		`${optionPath}.label`,
		`${prefix}: label is required`
	);
}

function normalizeQuestionType(
	value: AskQuestionInput["type"]
): AskQuestion["type"] {
	return value === "multi" || value === "text" ? value : "single";
}

function validateQuestionType(
	value: AskQuestionInput["type"],
	questionNumber: number,
	collector: IssueCollector,
	path: string
) {
	if (
		value !== undefined &&
		value !== "single" &&
		value !== "multi" &&
		value !== "text"
	) {
		collector.add(
			path,
			`Question ${questionNumber}: invalid type ${JSON.stringify(value)}; expected "single", "multi", or "text"`
		);
	}
}

function assertRequired(
	value: string | undefined,
	collector: IssueCollector,
	path: string,
	message: string
) {
	if (!value) {
		collector.add(path, message);
	}
}

function assertUnique(
	seen: Set<string>,
	value: string | undefined,
	collector: IssueCollector,
	path: string,
	message: string
) {
	if (!value) {
		return;
	}
	if (seen.has(value)) {
		collector.add(path, message);
		return;
	}
	seen.add(value);
}

function createIssueCollector(): IssueCollector {
	const issues: AskValidationIssue[] = [];
	return {
		issues,
		add(path, message) {
			issues.push({ path, message });
		},
	};
}
