/**
 * A fake Pi host for lifecycle tests: a real in-memory SessionManager (so
 * branches behave as they do in Pi), recorded sendMessage calls, and a
 * `ui.custom` that exposes the open form for scripted key presses.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ASK_CONFIG } from "../../src/config/defaults.ts";
import { getAskConfigStore } from "../../src/config/store.ts";
import { ASK_JOURNAL_ENTRY_TYPE } from "../../src/journal/entries.ts";
import type { AskResult } from "../../src/types.ts";

export const KEY = { enter: "\r", escape: "\u001b" };

export interface OpenForm {
	done: (result: AskResult) => void;
	press: (...keys: string[]) => void;
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
	const sent: SentMessage[] = [];
	const forms: OpenForm[] = [];
	const notices: string[] = [];
	let idle = true;

	const pi = {
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		appendEntry(customType: string, data: unknown) {
			session.appendCustomEntry(customType, structuredClone(data));
		},
		sendMessage(message: SentMessage["message"], sendOptions: any) {
			sent.push({ message, options: sendOptions });
			if (options.persistSentMessages !== false) {
				session.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					structuredClone(message.details)
				);
			}
		},
	};

	const ctx = {
		cwd: process.cwd(),
		mode: options.mode ?? "tui",
		hasUI: true,
		sessionManager: session,
		isIdle: () => idle,
		ui: {
			notify(text: string) {
				notices.push(text);
			},
			setWorkingVisible() {},
			custom(factory: (...args: any[]) => any) {
				return new Promise<AskResult>((resolve) => {
					const tui = { requestRender() {} };
					const theme = {
						bg: (_color: string, text: string) => text,
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					};
					const component = factory(tui, theme, {}, resolve);
					forms.push({
						done: resolve,
						press: (...keys) => {
							for (const key of keys) {
								component.handleInput(key);
							}
						},
					});
				});
			},
		},
	};

	return {
		pi: pi as never,
		ctx: ctx as never,
		session,
		sent,
		forms,
		notices,
		tools,
		setIdle(value: boolean) {
			idle = value;
		},
		/** Dispatch a lifecycle event; returns what the handlers returned. */
		emit(event: string, payload: Record<string, unknown> = {}) {
			return (handlers.get(event) ?? []).map((handler) =>
				handler({ type: event, ...payload }, ctx)
			);
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
	};
}

/** Let deferred work and awaited promises run. */
export async function tick(times = 3) {
	for (let index = 0; index < times; index++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
