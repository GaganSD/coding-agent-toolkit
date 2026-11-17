/**
 * Queue and keyboard ownership of the background panel, as pure state.
 *
 * The rules:
 * - One form is shown at a time: the head of the queue, which is in request
 *   order across background, deferred and recovered forms.
 * - A blocking (foreground) form owns the keyboard. While one is open the
 *   panel is off screen, so two forms never compete for input; it comes back
 *   with the focus it had.
 * - A panel the user hid stays hidden, and unfocused, whatever arrives.
 * - A new request takes focus only when it opens a panel that was not
 *   showing a form, and only if the caller allows it.
 */

export interface AskPanelState {
	/** Whether the keyboard should be in the panel when it is on screen. */
	focused: boolean;
	/** Blocking forms currently open. */
	foreground: number;
	/** The user put the panel away; only the user brings it back. */
	hidden: boolean;
	/** Request ids waiting for an answer, first asked first. */
	queue: readonly string[];
}

export interface AskPanelView {
	focused: boolean;
	/** The one form the panel shows; undefined when the panel is off screen. */
	formId?: string;
	visible: boolean;
}

export type AskPanelEvent =
	/** Rebuilt from the journal (start, reload, resume, fork, tree). */
	| { type: "sync"; queue: readonly string[]; hidden: boolean }
	/** A request joined the queue in this process. */
	| { type: "arrived"; queue: readonly string[]; focus: boolean }
	/** A form left the queue (answered, cancelled, or gone from the branch). */
	| { type: "removed"; queue: readonly string[] }
	| { type: "hide" }
	| { type: "reopen" }
	| { type: "toggleFocus" }
	/** The host moved the keyboard away from the panel. */
	| { type: "blurred" }
	/** The host gave the keyboard back, e.g. when a dialog over it closed. */
	| { type: "refocused" }
	| { type: "foregroundOpened" }
	| { type: "foregroundClosed" };

export const EMPTY_PANEL: AskPanelState = {
	queue: [],
	hidden: false,
	focused: false,
	foreground: 0,
};

export function panelView(state: AskPanelState): AskPanelView {
	const formId = state.queue[0];
	const visible =
		formId !== undefined && !state.hidden && state.foreground === 0;
	return visible
		? { visible, formId, focused: state.focused }
		: { visible: false, focused: false };
}

/** Whether a toggle-focus key belongs to the panel right now. */
export function panelTakesFocusKey(state: AskPanelState): boolean {
	return state.queue.length > 0 && state.foreground === 0;
}

export function reducePanel(
	state: AskPanelState,
	event: AskPanelEvent
): AskPanelState {
	switch (event.type) {
		case "sync":
			// A rebuild is not a new request: it never takes the keyboard.
			return {
				...state,
				queue: event.queue,
				hidden: event.hidden,
				focused: false,
			};
		case "arrived": {
			const wasShowing = state.queue.length > 0;
			return {
				...state,
				queue: event.queue,
				focused:
					state.hidden || wasShowing ? state.focused : event.focus,
			};
		}
		case "removed":
			return {
				...state,
				queue: event.queue,
				focused: event.queue.length > 0 && state.focused,
			};
		case "hide":
			return { ...state, hidden: true, focused: false };
		case "reopen":
			return state.queue.length > 0
				? { ...state, hidden: false, focused: true }
				: state;
		case "toggleFocus":
			if (!panelTakesFocusKey(state)) {
				return state;
			}
			return state.hidden
				? { ...state, hidden: false, focused: true }
				: { ...state, focused: !state.focused };
		case "blurred":
			return { ...state, focused: false };
		case "refocused":
			return panelView(state).visible ? { ...state, focused: true } : state;
		case "foregroundOpened":
			return { ...state, foreground: state.foreground + 1 };
		case "foregroundClosed":
			return { ...state, foreground: Math.max(0, state.foreground - 1) };
		default:
			return state;
	}
}
