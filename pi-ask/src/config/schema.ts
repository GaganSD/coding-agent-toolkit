import {
	arr,
	bool,
	compile,
	lit,
	num,
	obj,
	opt,
	str,
	union,
	type Static,
} from "@earendil-works/pi-schema";

const AskAnswerModelPreferenceSchema = obj(
	{
		id: str(),
		provider: str(),
	},
	{ open: true }
);

const AskNotificationChannelSchema = union([
	lit("bell"),
	lit("osc9"),
	lit("osc777"),
	obj(
		{
			command: str(),
			type: lit("command"),
		},
		{ open: true }
	),
]);

const AskKeyBindingSchema = union([str(), arr(str())]);

const AskConfigKeymapsSchema = obj(
	{
		global: obj(
			{
				dismiss: opt(AskKeyBindingSchema),
				settings: opt(AskKeyBindingSchema),
			},
			{ open: true }
		),
		main: obj(
			{
				cancel: opt(AskKeyBindingSchema),
				changeQuestionType: opt(AskKeyBindingSchema),
				confirm: opt(AskKeyBindingSchema),
				nextOption: opt(AskKeyBindingSchema),
				nextTab: opt(AskKeyBindingSchema),
				optionNote: opt(AskKeyBindingSchema),
				previousOption: opt(AskKeyBindingSchema),
				previousTab: opt(AskKeyBindingSchema),
				questionNote: opt(AskKeyBindingSchema),
				toggle: opt(AskKeyBindingSchema),
			},
			{ open: true }
		),
		editor: obj(
			{
				close: opt(AskKeyBindingSchema),
				nextOptionWhenEmpty: opt(AskKeyBindingSchema),
				nextTabWhenEmpty: opt(AskKeyBindingSchema),
				previousOptionWhenEmpty: opt(AskKeyBindingSchema),
				previousTabWhenEmpty: opt(AskKeyBindingSchema),
				submit: opt(AskKeyBindingSchema),
			},
			{ open: true }
		),
		noteEditor: obj(
			{
				close: opt(AskKeyBindingSchema),
				nextOptionWhenEmpty: opt(AskKeyBindingSchema),
				nextTabWhenEmpty: opt(AskKeyBindingSchema),
				previousOptionWhenEmpty: opt(AskKeyBindingSchema),
				previousTabWhenEmpty: opt(AskKeyBindingSchema),
				save: opt(AskKeyBindingSchema),
			},
			{ open: true }
		),
		settingsModal: obj(
			{
				close: opt(AskKeyBindingSchema),
				nextOption: opt(AskKeyBindingSchema),
				previousOption: opt(AskKeyBindingSchema),
				toggle: opt(AskKeyBindingSchema),
			},
			{ open: true }
		),
	},
	{ open: true }
);

export const AskConfigFileSchema = obj(
	{
		schemaVersion: opt(num()),
		answer: opt(
			obj(
				{
					extractionModels: opt(arr(AskAnswerModelPreferenceSchema)),
					extractionRetries: opt(num()),
					extractionTimeoutMs: opt(num()),
				},
				{ open: true }
			)
		),
		behaviour: opt(
			obj(
				{
					autoSubmitWhenAnsweredWithoutNotes: opt(bool()),
					confirmDismissWhenDirty: opt(bool()),
					doublePressReviewShortcuts: opt(bool()),
					showFooterHints: opt(bool()),
				},
				{ open: true }
			)
		),
		keymaps: opt(AskConfigKeymapsSchema),
		notifications: opt(
			obj(
				{
					channels: opt(arr(AskNotificationChannelSchema)),
					enabled: opt(bool()),
				},
				{ open: true }
			)
		),
	},
	{ open: true }
);

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
		confirmDismissWhenDirty: boolean;
		doublePressReviewShortcuts: boolean;
		showFooterHints: boolean;
	};
	keymaps: AskConfigKeymaps;
	notifications: {
		channels: AskNotificationChannel[];
		enabled: boolean;
	};
}

export const validateAskConfigFile = compile(AskConfigFileSchema);
