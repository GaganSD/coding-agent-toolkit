import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskBackground } from "./background.ts";
import { type AskJournal, createSessionAskJournal } from "./journal/journal.ts";

/** State shared by the tool and the lifecycle handlers of one extension load. */
export interface AskRuntime {
	/**
	 * Queue, panel and delivery for forms no tool call waits for. Absent when
	 * only the tool is registered: every call then blocks.
	 */
	background?: AskBackground;
	journal: AskJournal;
	/**
	 * Request ids whose blocking form is on screen in this process. The queue
	 * skips them: an open form is not an interrupted one.
	 */
	live: Set<string>;
}

export function createAskRuntime(
	pi: Pick<ExtensionAPI, "appendEntry">
): AskRuntime {
	return { journal: createSessionAskJournal(pi), live: new Set() };
}
