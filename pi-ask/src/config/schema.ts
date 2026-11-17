import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const AskAnswerModelPreferenceSchema = Type.Object({
	id: Type.String(),
	provider: Type.String(),
});

const AskNotificationChannelSchema = Type.Union([
	Type.Literal("bell"),
	Type.Literal("osc9"),
	Type.Literal("osc777"),
	Type.Object({
		command: Type.String(),
		type: Type.Literal("command"),
	}),
]);

const AskKeyBindingSchema = Type.Union([
	Type.String(),
	Type.Array(Type.String()),
]);

const AskConfigKeymapsSchema = Type.Object({
	global: Type.Object({
		dismiss: Type.Optional(AskKeyBindingSchema),
		later: Type.Optional(AskKeyBindingSchema),
		panelFocus: Type.Optional(AskKeyBindingSchema),
		settings: Type.Optional(AskKeyBindingSchema),
	}),
	main: Type.Object({
		cancel: Type.Optional(AskKeyBindingSchema),
		changeQuestionType: Type.Optional(AskKeyBindingSchema),
		confirm: Type.Optional(AskKeyBindingSchema),
		nextOption: Type.Optional(AskKeyBindingSchema),
		nextTab: Type.Optional(AskKeyBindingSchema),
		optionNote: Type.Optional(AskKeyBindingSchema),
		previousOption: Type.Optional(AskKeyBindingSchema),
		previousTab: Type.Optional(AskKeyBindingSchema),
		questionNote: Type.Optional(AskKeyBindingSchema),
		toggle: Type.Optional(AskKeyBindingSchema),
	}),
	editor: Type.Object({
		close: Type.Optional(AskKeyBindingSchema),
		nextOptionWhenEmpty: Type.Optional(AskKeyBindingSchema),
		nextTabWhenEmpty: Type.Optional(AskKeyBindingSchema),
		previousOptionWhenEmpty: Type.Optional(AskKeyBindingSchema),
		previousTabWhenEmpty: Type.Optional(AskKeyBindingSchema),
		submit: Type.Optional(AskKeyBindingSchema),
	}),
	noteEditor: Type.Object({
		close: Type.Optional(AskKeyBindingSchema),
		nextOptionWhenEmpty: Type.Optional(AskKeyBindingSchema),
		nextTabWhenEmpty: Type.Optional(AskKeyBindingSchema),
		previousOptionWhenEmpty: Type.Optional(AskKeyBindingSchema),
		previousTabWhenEmpty: Type.Optional(AskKeyBindingSchema),
		save: Type.Optional(AskKeyBindingSchema),
	}),
	settingsModal: Type.Object({
		close: Type.Optional(AskKeyBindingSchema),
		nextOption: Type.Optional(AskKeyBindingSchema),
		previousOption: Type.Optional(AskKeyBindingSchema),
		toggle: Type.Optional(AskKeyBindingSchema),
	}),
});

export const AskConfigFileSchema = Type.Object({
	schemaVersion: Type.Optional(Type.Number()),
	answer: Type.Optional(
		Type.Object({
			extractionModels: Type.Optional(
				Type.Array(AskAnswerModelPreferenceSchema)
			),
			extractionRetries: Type.Optional(Type.Number()),
			extractionTimeoutMs: Type.Optional(Type.Number()),
		})
	),
	behaviour: Type.Optional(
		Type.Object({
			autoSubmitWhenAnsweredWithoutNotes: Type.Optional(Type.Boolean()),
			background: Type.Optional(Type.Boolean()),
			confirmDismissWhenDirty: Type.Optional(Type.Boolean()),
			doublePressReviewShortcuts: Type.Optional(Type.Boolean()),
			showFooterHints: Type.Optional(Type.Boolean()),
		})
	),
	expiry: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			minSeconds: Type.Optional(Type.Number()),
		})
	),
	keymaps: Type.Optional(AskConfigKeymapsSchema),
	notifications: Type.Optional(
		Type.Object({
			channels: Type.Optional(Type.Array(AskNotificationChannelSchema)),
			enabled: Type.Optional(Type.Boolean()),
		})
	),
});

export type AskConfigFile = Static<typeof AskConfigFileSchema>;
export type AskAnswerModelPreference = Static<
	typeof AskAnswerModelPreferenceSchema
>;
export type AskNotificationChannel = Static<typeof AskNotificationChannelSchema>;

export interface AskConfigKeymaps {
	editor: {
		close: string[];
		nextOptionWhenEmpty: string[];
		nextTabWhenEmpty: string[];
		previousOptionWhenEmpty: string[];
		previousTabWhenEmpty: string[];
		submit: string[];
	};
	global: {
		dismiss: string[];
		/** "Answer later": defer a blocking form, or hide the panel. */
		later: string[];
		/** Switch keyboard focus between the panel and the normal input. */
		panelFocus: string[];
		settings: string[];
	};
	main: {
		cancel: string[];
		changeQuestionType: string[];
		confirm: string[];
		nextOption: string[];
		nextTab: string[];
		optionNote: string[];
		previousOption: string[];
		previousTab: string[];
		questionNote: string[];
		toggle: string[];
	};
	noteEditor: {
		close: string[];
		nextOptionWhenEmpty: string[];
		nextTabWhenEmpty: string[];
		previousOptionWhenEmpty: string[];
		previousTabWhenEmpty: string[];
		save: string[];
	};
	settingsModal: {
		close: string[];
		nextOption: string[];
		previousOption: string[];
		toggle: string[];
	};
}

export interface AskConfig {
	answer: {
		extractionModels: AskAnswerModelPreference[];
		extractionRetries: number;
		extractionTimeoutMs: number;
	};
	behaviour: {
		autoSubmitWhenAnsweredWithoutNotes: boolean;
		/** `false` removes `background` from the schema; every call blocks. */
		background: boolean;
		confirmDismissWhenDirty: boolean;
		doublePressReviewShortcuts: boolean;
		showFooterHints: boolean;
	};
	expiry: {
		/** `false` removes `timeoutSeconds` and `fallback` from the schema. */
		enabled: boolean;
		/** Shorter requested limits are raised to this floor. */
		minSeconds: number;
	};
	keymaps: AskConfigKeymaps;
	notifications: {
		channels: AskNotificationChannel[];
		enabled: boolean;
	};
}

export const validateAskConfigFile = Compile(AskConfigFileSchema);
