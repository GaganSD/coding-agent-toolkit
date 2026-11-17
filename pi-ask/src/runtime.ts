import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AskJournal, createSessionAskJournal } from "./journal/journal.ts";

/** State shared by the tool and the lifecycle handlers of one extension load. */
export interface AskRuntime {
	journal: AskJournal;
	/**
	 * Request ids whose form is on screen in this process. Recovery skips
	 * them: an open form is not an interrupted one.
	 */
	live: Set<string>;
}

export function createAskRuntime(
	pi: Pick<ExtensionAPI, "appendEntry">
): AskRuntime {
	return { journal: createSessionAskJournal(pi), live: new Set() };
}
