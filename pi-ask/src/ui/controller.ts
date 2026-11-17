import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme } from "@earendil-works/pi-tui";
import type { AskConfig } from "../config/schema.ts";
import { getAskConfigStore } from "../config/store.ts";
import {
	createQuestionWaitingNotification,
	notifyQuestionWaiting,
} from "../notifications.ts";
import type { AskDraftSnapshot } from "../journal/entries.ts";
import { createInitialState } from "../state/create.ts";
import { type ExpiryTimer, toExpiredResult } from "../state/expiry.ts";
import { applyDraftSnapshot } from "../state/draft.ts";
import {
	getEditorDraft,
	saveEditorDraft,
	submitEditorDraft,
	syncStateToSelection,
} from "../state/editor.ts";
import {
	cancelFlow,
	dismissFlow,
	moveOption,
	moveTab,
} from "../state/navigation.ts";
import { cycleCurrentQuestionType } from "../state/question-type.ts";
import { toAskResult } from "../state/result.ts";
import {
	getCurrentOption,
	getCurrentQuestion,
	isSubmitTab,
} from "../state/selectors.ts";
import {
	applyNumberShortcut,
	confirmCurrentSelection,
	enterOptionNoteMode,
	enterQuestionNoteMode,
	toggleCurrentMultiOption,
} from "../state/transitions.ts";
import { isEditingView } from "../state/view.ts";
import type { AskParams, AskResult, AskState } from "../types.ts";
import { maybeAutoSubmitState } from "./auto-submit.ts";
import { createAskAutocompleteProvider } from "./autocomplete.ts";
import {
	DIRTY_DISMISS_NOTICE,
	shouldConfirmDirtyDismiss,
} from "./dismiss-guard.ts";
import type { AskInputCommand } from "./input.ts";
import { getInputCommand } from "./input.ts";
import { renderAskScreen } from "./render.ts";
import {
	getReviewShortcutHint,
	resolveReviewShortcutDoublePress,
} from "./review-shortcuts.ts";
import { showAskSettings } from "./show-settings.ts";

type CustomCallback = Parameters<ExtensionContext["ui"]["custom"]>[0];
type CustomCallbackArgs = CustomCallback extends (...args: infer T) => unknown
	? T
	: never;
type Tui = CustomCallbackArgs[0];
type Theme = CustomCallbackArgs[1];
type Keybindings = CustomCallbackArgs[2];
type Done = (result: AskResult) => void;
type AskFlowParams = AskParams &
	Pick<ExtensionContext, "cwd"> &
	AskFlowOptions & {
		config: AskConfig;
		configNotice?: string;
		ctx: ExtensionContext;
	};

export interface AskFlowOptions {
	/**
	 * Offer "answer later" on a blocking form: the flow then resolves with a
	 * `deferred` result and the caller moves the form to the queue.
	 */
	allowDefer?: boolean;
	/** Shown under the tabs, e.g. that this form timed out earlier. */
	banner?: string;
	/** Answers to restore, e.g. from the journal of an interrupted form. */
	draft?: AskDraftSnapshot;
	/**
	 * The form's time limit. The flow shows the countdown and stops it on
	 * the first key. With `owned` it also starts the clock when the form
	 * opens and finishes with the `expired` result; otherwise the host that
	 * owns the form's visibility does both.
	 */
	expiry?: { owned?: boolean; timer: ExpiryTimer };
	/** Called for every key the form receives, before it is handled. */
	onInput?: (data: string) => void;
	/** Called after every state change while the form is open. */
	onStateChange?: (state: AskState) => void;
	/**
	 * Set when the form is drawn in the background panel. There the cancel
	 * and "answer later" keys only put the panel away (`onHide`); the form is
	 * cancelled with the dismiss key or from the review tab.
	 */
	panel?: { onHide: () => void };
}

/** The form as a TUI component, for hosts other than `ctx.ui.custom`. */
export interface AskFlowComponent {
	dispose(): void;
	focused: boolean;
	/** The live form state, including unsaved editor text. */
	getState(): AskState;
	handleInput(data: string): void;
	invalidate(): void;
	render(width: number): string[];
}

interface AskFlowController {
	allowDefer: boolean;
	banner?: string;
	config: AskConfig;
	configNotice?: string;
	ctx: ExtensionContext;
	done: Done;
	editor: Editor;
	expiry?: ExpiryTimer;
	focused: boolean;
	onInput?: (data: string) => void;
	onStateChange?: (state: AskState) => void;
	panel?: { onHide: () => void };
	pendingDiscardConfirm: boolean;
	pendingQuestionTypeChangeQuestionId?: string;
	pendingReviewShortcutActionIndex?: number;
	settingsOpen: boolean;
	state: AskState;
	statusNotice?: string;
	suppressAutoInputForSelection: boolean;
	theme: Theme;
	tui: Tui;
	unsubscribeConfig: () => void;
}

export async function runAskFlow(
	ctx: ExtensionContext,
	params: AskParams,
	options: AskFlowOptions = {}
): Promise<AskResult> {
	const store = getAskConfigStore();
	const { config, notice } = await store.ensureLoaded();
	if (ctx.mode !== "tui") {
		return toAskResult(createInitialState(params), "unavailable");
	}
	return ctx.ui.custom<AskResult>((...args) =>
		createAskFlowController(args, {
			...params,
			...options,
			config,
			configNotice: notice?.text,
			cwd: ctx.cwd,
			ctx,
		})
	);
}

export function createAskFlowController(
	[tui, theme, _keybindings, done]: [
		Tui,
		Theme,
		Keybindings | undefined,
		(result: AskResult) => void,
	],
	params: AskFlowParams
): AskFlowComponent {
	const controller: AskFlowController = {
		allowDefer: params.allowDefer === true,
		banner: params.banner,
		config: params.config,
		configNotice: params.configNotice,
		ctx: params.ctx,
		done,
		editor: createEditor(tui, theme, params.cwd),
		expiry: params.expiry?.timer,
		focused: false,
		onInput: params.onInput,
		onStateChange: params.onStateChange,
		panel: params.panel,
		settingsOpen: false,
		state: applyDraftSnapshot(createInitialState(params), params.draft),
		suppressAutoInputForSelection: false,
		pendingDiscardConfirm: false,
		pendingQuestionTypeChangeQuestionId: undefined,
		pendingReviewShortcutActionIndex: undefined,
		statusNotice: undefined,
		theme,
		tui,
		unsubscribeConfig: () => {
			// replaced immediately after controller creation
		},
	};

	controller.unsubscribeConfig = getAskConfigStore().subscribe((config) => {
		controller.config = config;
		controller.configNotice = undefined;
		controller.state = maybeAutoSubmitState(
			controller.state,
			controller.config
		);
		refresh(controller);
		maybeFinish(controller);
	});

	controller.editor.onSubmit = (value) => submitEditor(controller, value);
	syncSelection(controller);
	const unsubscribeExpiry = bindExpiry(controller, params.expiry?.owned === true);
	notifyCurrentQuestion(controller)
		.catch(() => {
			// Notification failures are best-effort and must not affect the ask flow.
		})
		// The clock starts only after the user has been told a question waits.
		.then(() => controller.expiry?.arm());

	return {
		get focused() {
			return controller.focused;
		},
		set focused(value: boolean) {
			controller.focused = value;
			controller.editor.focused = value;
		},
		getState: () =>
			isEditingView(controller.state)
				? saveEditorDraft(controller.state, controller.editor.getText())
				: controller.state,
		render: (width: number) => renderController(controller, width),
		invalidate() {
			controller.editor.invalidate();
		},
		handleInput(data: string) {
			// One key means the user is here: the countdown ends for good.
			controller.expiry?.interact();
			controller.onInput?.(data);
			handleControllerInput(controller, data);
		},
		dispose() {
			unsubscribeExpiry();
			controller.unsubscribeConfig();
		},
	};
}

/** Redraws on each tick; a form that owns its clock also finishes on expiry. */
function bindExpiry(controller: AskFlowController, owned: boolean) {
	const timer = controller.expiry;
	if (!timer) {
		return () => {
			// nothing to release
		};
	}
	const unsubscribe = timer.subscribe({
		change: () => controller.tui.requestRender(),
		expire: () => {
			if (owned && !controller.state.completed) {
				controller.done(toExpiredResult(controller.state));
			}
		},
	});
	if (owned) {
		timer.show();
	}
	return unsubscribe;
}

function renderController(
	controller: AskFlowController,
	width: number
): string[] {
	return renderAskScreen({
		banner: controller.banner,
		countdown: controller.expiry?.view(),
		config: controller.config,
		editor: controller.editor,
		footerNotice: getFooterNotice(controller),
		reviewShortcutHint: getActiveReviewShortcutHint(controller),
		state: controller.state,
		surface: controller.panel
			? { panel: { focused: controller.focused } }
			: { defer: controller.allowDefer },
		theme: controller.theme,
		width,
	});
}

function handleControllerInput(controller: AskFlowController, data: string) {
	controller.editor.disableSubmit = !isNativeEditorSubmitEnabled(controller);
	const command = getInputCommand(
		controller.state,
		controller.config,
		data,
		isEditingView(controller.state) ? controller.editor.getText() : ""
	);
	if (isEditingView(controller.state)) {
		handleEditingCommand(controller, command, data);
		return;
	}
	handleNavigationCommand(controller, command);
}

function isNativeEditorSubmitEnabled(controller: AskFlowController): boolean {
	if (controller.state.view.kind === "input") {
		return controller.config.keymaps.editor.submit.includes("enter");
	}
	if (controller.state.view.kind === "note") {
		return controller.config.keymaps.noteEditor.save.includes("enter");
	}
	return true;
}

function handleEditingCommand(
	controller: AskFlowController,
	command: AskInputCommand,
	data: string
) {
	if (command.kind === "dismiss") {
		handleExitFlow(controller, dismissFlow(controller.state));
		return;
	}
	if (command.kind === "later") {
		answerLater(controller);
		return;
	}
	if (command.kind === "showSettings") {
		showSettingsModal(controller);
		return;
	}
	if (command.kind === "editMoveTab") {
		commitSavedEditorNavigation(controller, moveTab, command.delta);
		return;
	}
	if (command.kind === "editMoveOption") {
		commitSavedEditorNavigation(controller, moveOption, command.delta);
		return;
	}
	if (command.kind === "editClose") {
		closeEditor(controller);
		return;
	}
	if (command.kind === "editSubmit") {
		submitEditor(controller, controller.editor.getText());
		return;
	}
	if (command.kind === "delegateToEditor") {
		controller.editor.handleInput(data);
		refresh(controller);
	}
}

function handleNavigationCommand(
	controller: AskFlowController,
	command: AskInputCommand
) {
	switch (command.kind) {
		case "moveTab":
			clearPendingConfirms(controller);
			commitState(controller, moveTab(controller.state, command.delta));
			return;
		case "moveOption":
			clearPendingConfirms(controller);
			commitState(controller, moveOption(controller.state, command.delta));
			return;
		case "toggleMulti":
			clearPendingConfirms(controller);
			handleToggleCurrentOption(controller);
			return;
		case "changeQuestionType":
			clearPendingConfirms(controller, { keepTypeChange: true });
			handleChangeQuestionType(controller);
			return;
		case "openQuestionNote":
			clearPendingConfirms(controller);
			openQuestionNote(controller);
			return;
		case "openOptionNote":
			clearPendingConfirms(controller);
			openOptionNote(controller);
			return;
		case "confirm":
			clearPendingConfirms(controller);
			commitState(controller, confirmCurrentSelection(controller.state), {
				finish: true,
			});
			return;
		case "cancel":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			if (controller.panel) {
				// Hiding cancels nothing; the form waits in the queue.
				answerLater(controller);
				return;
			}
			handleExitFlow(controller, cancelFlow(controller.state));
			return;
		case "later":
			clearPendingConfirms(controller);
			answerLater(controller);
			return;
		case "numberShortcut":
			if (handleReviewShortcutNumber(controller, command.digit)) {
				return;
			}
			clearPendingConfirms(controller);
			commitState(
				controller,
				applyNumberShortcut(controller.state, command.digit)
			);
			return;
		case "dismiss":
			clearReviewShortcutPending(controller);
			clearQuestionTypeChangePending(controller);
			handleExitFlow(controller, dismissFlow(controller.state));
			return;
		case "showSettings":
			showSettingsModal(controller);
			return;
		case "ignore":
		case "editMoveTab":
		case "editMoveOption":
		case "editClose":
		case "editSubmit":
		case "delegateToEditor":
			return;
		default:
			return;
	}
}

function handleToggleCurrentOption(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question) {
		return;
	}
	commitState(controller, toggleCurrentMultiOption(controller.state));
}

function handleChangeQuestionType(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question || isSubmitTab(controller.state)) {
		return;
	}
	const confirmed =
		controller.pendingQuestionTypeChangeQuestionId === question.id;
	const result = cycleCurrentQuestionType(controller.state, { confirmed });
	controller.statusNotice = result.notice;
	if (result.needsConfirmation) {
		controller.pendingQuestionTypeChangeQuestionId = question.id;
		refresh(controller);
		return;
	}
	clearQuestionTypeChangePending(controller);
	commitState(controller, result.state, { finish: true });
}

function openQuestionNote(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question || isSubmitTab(controller.state)) {
		return;
	}
	commitState(
		controller,
		enterQuestionNoteMode(controller.state, question.id),
		{
			syncSelection: false,
		}
	);
}

function openOptionNote(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	const option = getCurrentOption(controller.state);
	if (
		!(question && option) ||
		option.isCustomOption ||
		isSubmitTab(controller.state)
	) {
		return;
	}
	commitState(
		controller,
		enterOptionNoteMode(controller.state, question.id, option.value),
		{ syncSelection: false }
	);
}

function commitState(
	controller: AskFlowController,
	nextState: AskState,
	options: { finish?: boolean; syncSelection?: boolean } = {}
) {
	if (nextState.activeTabIndex !== controller.state.activeTabIndex) {
		clearFooterNotices(controller);
	}
	controller.suppressAutoInputForSelection = false;
	controller.state = nextState;
	if (options.syncSelection !== false) {
		syncSelection(controller);
	}
	controller.state = maybeAutoSubmitState(controller.state, controller.config);
	hydrateEditor(controller);
	refresh(controller);
	if (options.finish) {
		maybeFinish(controller);
	}
}

function submitEditor(controller: AskFlowController, value: string) {
	commitState(controller, submitEditorDraft(controller.state, value), {
		finish: true,
	});
}

function commitSavedEditorNavigation(
	controller: AskFlowController,
	navigate: (state: AskState, delta: 1 | -1) => AskState,
	delta: 1 | -1
) {
	commitState(controller, navigate(saveEditorState(controller), delta));
}

function closeEditor(controller: AskFlowController) {
	const nextState = saveEditorState(controller);
	controller.suppressAutoInputForSelection = nextState.view.kind !== "input";
	controller.state = nextState;
	refresh(controller);
}

/**
 * "Answer later". Typed text is saved into the draft first. In the panel
 * the form stays open and only the panel goes away; a blocking form ends
 * with a `deferred` receipt.
 */
function answerLater(controller: AskFlowController) {
	if (!(controller.panel || controller.allowDefer)) {
		return;
	}
	// The draft keeps typed text; the open editor itself is left as it is.
	const saved = isEditingView(controller.state)
		? saveEditorDraft(controller.state, controller.editor.getText())
		: controller.state;
	controller.pendingDiscardConfirm = false;
	controller.onStateChange?.(saved);
	if (controller.panel) {
		controller.tui.requestRender();
		controller.panel.onHide();
		return;
	}
	controller.done(toAskResult(saved, "deferred"));
}

function handleExitFlow(controller: AskFlowController, nextState: AskState) {
	if (!shouldRequestDismissConfirmation(controller)) {
		commitState(controller, nextState, { finish: true });
		return;
	}
	if (controller.pendingDiscardConfirm) {
		commitState(controller, nextState, { finish: true });
		return;
	}
	controller.pendingDiscardConfirm = true;
	refresh(controller);
}

function shouldRequestDismissConfirmation(
	controller: AskFlowController
): boolean {
	return shouldConfirmDirtyDismiss({
		config: controller.config,
		state: controller.state,
		editingText: isEditingView(controller.state)
			? controller.editor.getText()
			: "",
	});
}

function clearFooterNotices(controller: AskFlowController) {
	controller.configNotice = undefined;
	controller.statusNotice = undefined;
	controller.pendingDiscardConfirm = false;
}

function clearPendingConfirms(
	controller: AskFlowController,
	options: { keepTypeChange?: boolean } = {}
) {
	controller.pendingDiscardConfirm = false;
	clearReviewShortcutPending(controller);
	if (!options.keepTypeChange) {
		clearQuestionTypeChangePending(controller);
	}
}

function clearReviewShortcutPending(controller: AskFlowController) {
	controller.pendingReviewShortcutActionIndex = undefined;
}

function clearQuestionTypeChangePending(controller: AskFlowController) {
	controller.pendingQuestionTypeChangeQuestionId = undefined;
}

function getActiveReviewShortcutHint(
	controller: AskFlowController
): string | undefined {
	if (
		!(
			isSubmitTab(controller.state) &&
			controller.config.behaviour.doublePressReviewShortcuts
		)
	) {
		return;
	}
	return getReviewShortcutHint(controller.pendingReviewShortcutActionIndex);
}

function handleReviewShortcutNumber(
	controller: AskFlowController,
	digit: number
): boolean {
	if (
		!(
			isSubmitTab(controller.state) &&
			controller.config.behaviour.doublePressReviewShortcuts
		)
	) {
		return false;
	}

	const resolution = resolveReviewShortcutDoublePress(
		digit,
		controller.pendingReviewShortcutActionIndex
	);
	if (resolution.actionIndex === undefined) {
		return false;
	}

	controller.pendingReviewShortcutActionIndex = resolution.pendingActionIndex;
	const nextState = resolution.confirmed
		? applyNumberShortcut(controller.state, digit)
		: {
				...controller.state,
				activeSubmitActionIndex: resolution.actionIndex,
			};
	commitState(controller, nextState, { finish: resolution.confirmed });
	return true;
}

function getFooterNotice(controller: AskFlowController): string | undefined {
	if (controller.pendingDiscardConfirm) {
		return DIRTY_DISMISS_NOTICE;
	}
	return controller.statusNotice ?? controller.configNotice;
}

function showSettingsModal(controller: AskFlowController) {
	if (controller.settingsOpen) {
		return;
	}
	controller.settingsOpen = true;
	showAskSettings(controller.ctx).finally(() => {
		controller.settingsOpen = false;
		refresh(controller);
	});
}

function refresh(controller: AskFlowController) {
	// Every state change ends in a refresh, so this is the one observation point.
	controller.onStateChange?.(controller.state);
	controller.tui.requestRender();
}

async function notifyCurrentQuestion(
	controller: AskFlowController
): Promise<void> {
	const question = getCurrentQuestion(controller.state);
	if (!question) {
		return;
	}
	await notifyQuestionWaiting(
		controller.config,
		createQuestionWaitingNotification(question)
	);
}

function maybeFinish(controller: AskFlowController) {
	if (controller.state.completed) {
		controller.done(toAskResult(controller.state));
	}
}

function hydrateEditor(controller: AskFlowController) {
	controller.editor.setText(getEditorDraft(controller.state));
}

function syncSelection(controller: AskFlowController) {
	if (controller.suppressAutoInputForSelection) {
		return;
	}
	controller.state = syncStateToSelection(controller.state);
}

function saveEditorState(controller: AskFlowController): AskState {
	const text = controller.editor.getText();
	controller.editor.setText("");
	return saveEditorDraft(controller.state, text);
}

function createEditor(tui: Tui, theme: Theme, cwd: string) {
	const editor = new Editor(tui, createEditorTheme(theme));
	editor.setAutocompleteProvider(createAskAutocompleteProvider(cwd));
	return editor;
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			description: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("warning", text),
			scrollInfo: (text) => theme.fg("dim", text),
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
		},
	};
}
