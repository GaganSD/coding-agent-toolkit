import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Editor } from "@earendil-works/pi-tui";
import type {
	getCurrentQuestion,
	getRenderableOptions,
} from "../state/selectors.ts";
import type { AskState } from "../types.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export interface QuestionRenderContext {
	editor: Editor;
	/** The countdown is running: the declared fallback option is marked. */
	fallbackMarked?: boolean;
	lines: string[];
	options: ReturnType<typeof getRenderableOptions>;
	question: NonNullable<ReturnType<typeof getCurrentQuestion>>;
	state: AskState;
	theme: Theme;
	width: number;
}
