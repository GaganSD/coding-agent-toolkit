/**
 * A fake Pi host for lifecycle tests: a real in-memory SessionManager (so
 * branches behave as they do in Pi), a TUI reduced to keyboard focus, widgets
 * and modal forms, and `sendMessage` with Pi's delivery rules.
 *
 * What is modelled on Pi 1.4.0, because the tests depend on it:
 * - `sendMessage` with `triggerTurn` while idle starts a run at once, but the
 *   message is written to the session only when that run records it
 *   (`recordWake`). Without `triggerTurn` it is appended now when idle, and
 *   at the end of the turn when busy.
 * - `turn_end` and `agent_before_settle` handlers return entries that are
 *   appended as soon as the dispatch ends.
 * - A widget is a component above or below the editor; it gets keys only
 *   while it has TUI focus. A modal form takes focus and gives it back.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ASK_CONFIG } from "../../src/config/defaults.ts";
import { getAskConfigStore } from "../../src/config/store.ts";
import { ASK_JOURNAL_ENTRY_TYPE } from "../../src/journal/entries.ts";
import type { AskResult } from "../../src/types.ts";

export const KEY = {
	enter: "\r",
	escape: "\u001b",
	ctrlC: "\u0003",
	/** Default `global.later`. */
	later: "\u000c",
	/** Default `global.panelFocus` (alt+a). */
	focus: "\u001ba",
	down: "\u001b[B",
};

export interface OpenForm {
	done: (result: AskResult) => void;
	press: (...keys: string[]) => void;
	render: () => string;
}

export interface SentMessage {
	message: {
		content: string;
		customType: string;
		details?: any;
		display: boolean;
	};
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

interface FakeComponent {
	dispose?: () => void;
	focused?: boolean;
	handleInput?: (data: string) => void;
	render?: (width: number) => string[];
}

export function quietConfig() {
	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
	});
}

/** One extension runtime ("process") attached to a session. */
export function fakePi(
	session: SessionManager = SessionManager.inMemory(),
	options: { mode?: string; persistSentMessages?: boolean } = {}
) {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const renderers = new Map<string, (...args: any[]) => any>();
	const sent: SentMessage[] = [];
	const forms: OpenForm[] = [];
	const notices: string[] = [];
	const widgets = new Map<
		string,
		{ component?: FakeComponent; lines?: string[]; placement: string }
	>();
	const inputListeners = new Set<(data: string) => any>();
	// Messages the host has accepted but not yet written to the session.
	const wakes: SentMessage["message"][] = [];
	const heldCustom: SentMessage["message"][] = [];
	let idle = true;
	let aborts = 0;

	const editor: FakeComponent & { text: string } = {
		text: "",
		focused: true,
		handleInput(data) {
			editor.text += data;
		},
	};
	let focus: FakeComponent | null = editor;
	const tui = {
		requestRender() {},
		getFocusedComponent: () => focus,
		setFocus(component: FakeComponent | null) {
			if (focus && "focused" in focus) {
				focus.focused = false;
			}
			focus = component;
			if (component && "focused" in component) {
				component.focused = true;
			}
		},
	};
	const theme = {
		bg: (_color: string, text: string) => text,
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	function persist(message: SentMessage["message"]) {
		if (options.persistSentMessages === false) {
			return;
		}
		session.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			structuredClone(message.details)
		);
	}

	const pi = {
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		registerMessageRenderer(type: string, renderer: (...args: any[]) => any) {
			renderers.set(type, renderer);
		},
		appendEntry(customType: string, data: unknown) {
			session.appendCustomEntry(customType, structuredClone(data));
		},
		sendMessage(message: SentMessage["message"], sendOptions: any) {
			sent.push({ message, options: sendOptions });
			if (sendOptions?.triggerTurn) {
				if (idle) {
					idle = false;
					wakes.push(message);
				} else {
					heldCustom.push(message);
				}
			} else if (idle) {
				persist(message);
			} else {
				heldCustom.push(message);
			}
		},
	};

	const ui = {
		theme,
		notify(text: string) {
			notices.push(text);
		},
		setWorkingVisible() {},
		getEditorText: () => editor.text,
		onTerminalInput(listener: (data: string) => any) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		setWidget(key: string, content: any, widgetOptions?: any) {
			widgets.get(key)?.component?.dispose?.();
			widgets.delete(key);
			if (content === undefined) {
				return;
			}
			const placement = widgetOptions?.placement ?? "aboveEditor";
			widgets.set(
				key,
				typeof content === "function"
					? { placement, component: content(tui, theme) }
					: { placement, lines: content }
			);
		},
		custom(factory: (...args: any[]) => any) {
			return new Promise<AskResult>((resolve) => {
				const done = (result: AskResult) => {
					if (focus === component) {
						tui.setFocus(editor);
					}
					resolve(result);
				};
				const component = factory(tui, theme, {}, done);
				tui.setFocus(component);
				forms.push({
					done,
					press: (...keys) => {
						for (const key of keys) {
							component.handleInput(key);
						}
					},
					render: () => component.render(80).join("\n"),
				});
			});
		},
	};

	const ctx = {
		cwd: process.cwd(),
		mode: options.mode ?? "tui",
		hasUI: true,
		sessionManager: session,
		isIdle: () => idle,
		abort() {
			aborts++;
		},
		ui,
	};

	function emit(event: string, payload: Record<string, unknown> = {}) {
		return (handlers.get(event) ?? []).map((handler) =>
			handler({ type: event, ...payload }, ctx)
		);
	}

	/** An actionable boundary: handlers chain entries, Pi appends them. */
	function boundary(event: string, payload: Record<string, unknown> = {}) {
		let entries: any[] = [];
		let proceed = false;
		for (const handler of handlers.get(event) ?? []) {
			const result = handler(
				{ type: event, ...payload, entries, continue: proceed },
				ctx
			) as { entries?: any[]; continue?: boolean } | undefined;
			entries = result?.entries ?? entries;
			proceed = result?.continue ?? proceed;
		}
		for (const entry of entries) {
			if (entry.type === "custom_message") {
				persist(entry);
			}
		}
		for (const message of heldCustom.splice(0)) {
			persist(message);
		}
		return { entries, continue: proceed };
	}

	return {
		pi: pi as never,
		ctx: ctx as never,
		session,
		sent,
		forms,
		notices,
		tools,
		commands,
		renderers,
		widgets,
		editor,
		get aborts() {
			return aborts;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		isIdle: () => idle,
		/** Dispatch a lifecycle event; returns what the handlers returned. */
		emit,
		/** The run started by an idle wake writes its starting message. */
		recordWake() {
			for (const message of wakes.splice(0)) {
				persist(message);
			}
		},
		turnEnd: (message: Record<string, unknown> = { stopReason: "toolUse" }) =>
			boundary("turn_end", { message }),
		beforeSettle: () => boundary("agent_before_settle"),
		/** The run is over: Pi is idle and tells the extensions. */
		settle(aborted = false) {
			idle = true;
			return emit("agent_settled", { aborted });
		},
		/** A key from the terminal: listeners first, then the focused component. */
		type(...keys: string[]) {
			for (const key of keys) {
				let consumed = false;
				for (const listener of inputListeners) {
					if (listener(key)?.consume) {
						consumed = true;
						break;
					}
				}
				if (!consumed) {
					focus?.handleInput?.(key);
				}
			}
		},
		focusIs(target: "editor" | "panel" | "form"): boolean {
			const panel = widgets.get("pi-ask:panel")?.component;
			if (target === "editor") {
				return focus === editor;
			}
			if (target === "panel") {
				return !!panel && focus === panel;
			}
			return !!focus && focus !== editor && focus !== panel;
		},
		panelText() {
			return (
				widgets.get("pi-ask:panel")?.component?.render?.(80).join("\n") ?? ""
			);
		},
		indicator() {
			return widgets.get("pi-ask:pending")?.lines?.join("\n");
		},
		command(name: string, args = "") {
			return commands.get(name)?.handler(args, ctx);
		},
		journal() {
			return session
				.getBranch()
				.filter(
					(entry: any) =>
						entry.type === "custom" &&
						entry.customType === ASK_JOURNAL_ENTRY_TYPE
				)
				.map((entry: any) => entry.data);
		},
		/** `pi-ask:answer` messages written to the active branch. */
		answers(): any[] {
			return session
				.getBranch()
				.filter((entry: any) => entry.type === "custom_message");
		},
	};
}

/** Let deferred work and awaited promises run. */
export async function tick(times = 3) {
	for (let index = 0; index < times; index++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
