import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskBackground } from "./background.ts";
import { type AskJournal, createSessionAskJournal } from "./journal/journal.ts";
import type { ExpiryClock } from "./state/expiry.ts";

/** State shared by the tool and the lifecycle handlers of one extension load. */
export interface AskRuntime {
	/** Time and timers for countdowns; the system clock when absent. */
	clock?: ExpiryClock;
	/**
	 * Queue, panel and delivery for forms no tool call waits for. Absent when
	 * only the tool is registered: every call then blocks.
	 */
	background?: AskBackground;
	/**
	 * Reports the pending draft of each blocking form on screen. Run when
	 * the extension shuts down: a form's typing timer must not decide whether
	 * the last keystrokes are kept.
	 */
	flushers: Set<() => void>;
	journal: AskJournal;
	/**
	 * Request ids whose blocking form is on screen in this process. The queue
	 * skips them: an open form is not an interrupted one.
	 */
	live: Set<string>;
	/**
	 * Blocking calls whose outcome is journalled but whose tool result may
	 * not be on the branch yet, identified by request id. The result is
	 * about to arrive, so the answer must not also be sent as a message.
	 */
	returning: Set<string>;
	/**
	 * Blocking forms whose outcome or deferral could not be journalled. The
	 * agent was told they will reappear, so the panel keeps them even after
	 * the conversation moves on, until a `defer` entry makes that durable.
	 */
	unsaved: Set<string>;
}

export function createAskRuntime(
	pi: Pick<ExtensionAPI, "appendEntry">,
	clock?: ExpiryClock
): AskRuntime {
	return {
		clock,
		flushers: new Set(),
		journal: createSessionAskJournal(pi, clock && { now: clock.now }),
		live: new Set(),
		returning: new Set(),
		unsaved: new Set(),
	};
}
