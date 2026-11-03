import {
	arr,
	bool,
	obj,
	opt,
	str,
	type Schema,
} from "@earendil-works/pi-schema";

/** `{ type: "string", enum }`: Google-compatible string enum, identical JSON to pi-ai's StringEnum. */
function stringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string },
): Schema<T[number]> {
	return {
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
	};
}

const AskQuestionLabelSchema = str({
	description: "Short tab label, e.g. Goal, Audience, Tone, Scope",
});

const AskQuestionTypeSchema = stringEnum(["single", "multi", "text"] as const, {
	description:
		"Question type: `single` means one answer is expected, `multi` means multiple answers could reasonably be selected, and `text` means the user should type an unconstrained answer. `text` questions have no options.",
});

export const AskOptionSchema = obj(
	{
		value: str({
			description:
				"Required machine-readable value returned for this option in the result",
		}),
		label: str({
			description: "Required short visible option label shown in the list",
		}),
		description: opt(
			str({
				description: "Optional one-line explanation to help the user choose",
			})
		),
		recommended: opt(
			bool({
				description:
					"Optional presentation marker for a grounded preference; use the description to explain the reason",
			})
		),
	},
	{ open: true }
);

export const AskQuestionSchema = obj(
	{
		id: str({
			description:
				"Required stable question identifier used as the key in returned answers",
		}),
		label: opt(AskQuestionLabelSchema),
		prompt: str({
			description:
				"Required direct question shown to the user; ask about one decision at a time",
		}),
		type: opt(AskQuestionTypeSchema),
		options: opt(
			arr(AskOptionSchema, {
				description:
					"Answer options for single/multi questions; provide clear, distinct choices and do not add filler options. Omit for text questions.",
			})
		),
	},
	{ open: true }
);

const AskParamsProperties = {
	title: opt(
		str({
			description:
				"Optional short title shown above the clarification flow, e.g. README direction",
		})
	),
};

export const AskParamsSchema = obj(
	{
		...AskParamsProperties,
		questions: arr(AskQuestionSchema, {
			description: "Questions to ask in the interactive clarification flow",
		}),
	},
	{ open: true }
);

const AnswerExtractionQuestionSchema = obj(
	{
		id: str({ description: "Stable snake_case question identifier" }),
		label: opt(AskQuestionLabelSchema),
		prompt: str({ description: "Direct question shown to the user" }),
		type: opt(AskQuestionTypeSchema),
		options: opt(
			arr(AskOptionSchema, {
				description:
					"Choices explicitly offered by the assistant. Omit for text questions.",
			})
		),
	},
	{ open: true }
);

export const AnswerExtractionParamsSchema = obj(
	{
		...AskParamsProperties,
		questions: arr(AnswerExtractionQuestionSchema, {
			description: "Questions extracted from the assistant message",
		}),
	},
	{ open: true }
);

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
