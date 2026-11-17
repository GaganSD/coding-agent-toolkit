import type { AskConfig } from "../config/schema.ts";
import { askStrings } from "../i18n.ts";
import {
	type ExpiryView,
	formatRemaining,
	hasDeclaredFallback,
} from "../state/expiry.ts";
import type { FooterSurface } from "../constants/keymaps.ts";
import {
	getCurrentQuestion,
	getRenderableOptions,
	isSubmitTab,
} from "../state/selectors.ts";
import type { AskState } from "../types.ts";
import { renderFrameFooter, renderFrameHeader } from "./render-frame.ts";
import { renderQuestionScreen } from "./render-question.ts";
import { renderSubmitScreen } from "./render-submit.ts";
import type { QuestionRenderContext, Theme } from "./render-types.ts";

export function renderAskScreen(args: {
	/** A line under the tabs, e.g. the timed-out notice of a reopened form. */
	banner?: string;
	config: AskConfig;
	/** Present when the form has a time limit. */
	countdown?: ExpiryView;
	footerNotice?: string;
	reviewShortcutHint?: string;
	state: AskState;
	surface?: FooterSurface;
	theme: Theme;
	width: number;
	editor: QuestionRenderContext["editor"];
}): string[] {
	const {
		banner,
		config,
		countdown,
		footerNotice,
		reviewShortcutHint,
		state,
		surface,
		theme,
		width,
		editor,
	} = args;
	const lines: string[] = [];
	const question = getCurrentQuestion(state);
	const options = getRenderableOptions(question);

	renderFrameHeader({
		lines,
		state,
		theme,
		width,
		status: headerStatus(banner, countdown, state),
	});

	if (isSubmitTab(state)) {
		renderSubmitScreen(lines, state, theme, width, reviewShortcutHint);
	} else if (question) {
		renderQuestionScreen({
			lines,
			state,
			question,
			options,
			theme,
			width,
			editor,
			fallbackMarked: countdown?.phase === "running",
		});
	}

	renderFrameFooter({
		config,
		footerNotice,
		lines,
		state,
		surface,
		theme,
		width,
	});
	return lines;
}

/** The one line under the tabs: the countdown, or why the form is special. */
function headerStatus(
	banner: string | undefined,
	countdown: ExpiryView | undefined,
	state: AskState
): string | undefined {
	if (banner) {
		return banner;
	}
	if (countdown?.phase === "running") {
		return askStrings().countdownRunning(
			formatRemaining(countdown.remainingSeconds),
			state.questions.some(hasDeclaredFallback)
		);
	}
	return countdown?.phase === "stopped"
		? askStrings().countdownStopped
		: undefined;
}
