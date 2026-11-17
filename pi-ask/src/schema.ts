import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const QUESTIONS_DESCRIPTION =
	"Questions to ask in the interactive clarification flow";

export const AskOptionSchema = Type.Object({
	value: Type.String({
		description:
			"Required machine-readable value returned for this option in the result",
	}),
	label: Type.String({
		description: "Required short visible option label shown in the list",
	}),
	description: Type.Optional(
		Type.String({
			description: "Optional one-line explanation to help the user choose",
		})
	),
	recommended: Type.Optional(
		Type.Boolean({
			description:
				"Optional presentation marker for a grounded preference; use the description to explain the reason",
		})
	),
});

export const AskQuestionSchema = Type.Object({
	id: Type.String({
		description:
			"Required stable question identifier used as the key in returned answers",
	}),
	label: Type.Optional(
		Type.String({
			description: "Short tab label, e.g. Goal, Audience, Tone, Scope",
		})
	),
	prompt: Type.String({
		description:
			"Required direct question shown to the user; ask about one decision at a time",
	}),
	type: Type.Optional(
		StringEnum(["single", "multi", "text"] as const, {
			description:
				"Question type: `single` means one answer is expected, `multi` means multiple answers could reasonably be selected, and `text` means the user should type an unconstrained answer. `text` questions have no options.",
		})
	),
	options: Type.Optional(
		Type.Array(AskOptionSchema, {
			description:
				"Answer options for single/multi questions; provide clear, distinct choices and do not add filler options. Omit for text questions.",
		})
	),
});

export const AskParamsSchema = Type.Object({
	title: Type.Optional(
		Type.String({
			description:
				"Optional short title shown above the clarification flow, e.g. README direction",
		})
	),
	questions: Type.Array(AskQuestionSchema, {
		description: QUESTIONS_DESCRIPTION,
	}),
});

/** Which optional model-facing fields the registered schema carries. */
export interface AskSchemaFeatures {
	/** `background` on the call. */
	background: boolean;
	/** `timeoutSeconds` on the call and `fallback` on each question. */
	expiry: boolean;
}

const AskQuestionWithFallbackSchema = Type.Object({
	...AskQuestionSchema.properties,
	fallback: Type.Optional(
		Type.String({
			description:
				"Option value applied if timeoutSeconds lapses; omit to leave the question unanswered",
		})
	),
});

/** Every optional field present; `buildAskParamsSchema` narrows it. */
export const AskParamsFullSchema = Type.Object({
	title: AskParamsSchema.properties.title,
	questions: Type.Array(AskQuestionWithFallbackSchema, {
		description: QUESTIONS_DESCRIPTION,
	}),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Queue the form and return a receipt at once; the answer arrives later",
		})
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"Time limit in seconds, counted from when the form is on screen",
		})
	),
});

/**
 * Parameter schema for the given features. A disabled feature's fields are
 * absent, not merely ignored, so they cost no recurring context. Statically
 * it is the full shape, since every gated field is optional.
 */
export function buildAskParamsSchema(
	features: AskSchemaFeatures
): typeof AskParamsFullSchema {
	const { title, questions, background, timeoutSeconds } =
		AskParamsFullSchema.properties;
	const properties = {
		title,
		questions: features.expiry ? questions : AskParamsSchema.properties.questions,
		...(features.background ? { background } : {}),
		...(features.expiry ? { timeoutSeconds } : {}),
	};
	return Type.Object(properties) as unknown as typeof AskParamsFullSchema;
}

const AnswerExtractionQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable snake_case question identifier" }),
	label: AskQuestionSchema.properties.label,
	prompt: Type.String({ description: "Direct question shown to the user" }),
	type: AskQuestionSchema.properties.type,
	options: Type.Optional(
		Type.Array(AskOptionSchema, {
			description:
				"Choices explicitly offered by the assistant. Omit for text questions.",
		})
	),
});

export const AnswerExtractionParamsSchema = Type.Object({
	...AskParamsSchema.properties,
	questions: Type.Array(AnswerExtractionQuestionSchema, {
		description: "Questions extracted from the assistant message",
	}),
});

/**
 * Model-facing copy of a schema with per-field `description` prose removed.
 * Field rules already live in the tool description and prompt guidelines, so
 * the duplicates only cost recurring context. The exported schemas keep their
 * descriptions for validation, docs, and tests.
 */
export function stripSchemaDescriptions<T>(schema: T): T {
	// Annotations are string-valued; a property *named* description holds an
	// object schema and survives the string check.
	return JSON.parse(
		JSON.stringify(schema),
		(key, value) =>
			key === "description" && typeof value === "string" ? undefined : value
	) as T;
}
