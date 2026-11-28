import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { WebSearchPanel } from "../../src/ui/panel.ts";

export const plainTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text } as unknown as Theme;
export const terminal = { terminal: { rows: 28 } as ConstructorParameters<typeof WebSearchPanel>[2]["terminal"], requestRender() {}, start() {}, stop() {} };
export const bindings = (map: Record<string, KeyId> = {}) => {
	const fallback: Record<string, KeyId> = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "tui.select.cancel": "escape" };
	return {
		matches: (data: string, name: string) => matchesKey(data, map[name] ?? fallback[name]),
		getKeys: (name: string) => [map[name] ?? fallback[name]],
	};
};
