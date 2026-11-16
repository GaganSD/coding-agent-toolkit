import { highlightCode, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** A read-only viewer, never an approval surface. */
export async function showInspect(
	ui: Pick<ExtensionUIContext, "custom">,
	detail: string,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) return;
	await ui.custom<void>((tui, theme, _keys, done) => {
		let offset = 0;
		let height = 1;
		let total = 0;
		const close = () => done();
		signal.addEventListener("abort", close, { once: true });
		const body = new Text("", 0, 0);
		const rebuild = () => {
			// Keep values in the normal foreground; only labels and JSON tokens
			// receive color. Never render tool-controlled text as Markdown.
			const argsStart = detail.indexOf("args: ");
			const argsEnd = detail.indexOf("\ncwd: ", argsStart);
			const label = (line: string) => line.replace(/^([^:]+:)(.*)$/, (_match, key: string, value: string) => `${theme.fg("muted", key)}${value}`);
			const lines = detail.split("\n").map(label);
			if (argsStart >= 0 && argsEnd > argsStart) {
				body.setText([
					...detail.slice(0, argsStart).trimEnd().split("\n").map(label),
					"",
					theme.fg("muted", "Arguments"),
					...highlightCode(detail.slice(argsStart + 6, argsEnd), "json"),
					"",
					...detail.slice(argsEnd + 1).split("\n").map(label),
				].join("\n"));
			} else body.setText(lines.join("\n"));
		};
		rebuild();
		return {
			render(width: number) {
				height = Math.max(1, tui.terminal.rows - 6);
				const lines = body.render(width);
				total = lines.length;
				offset = Math.max(0, Math.min(offset, total - height));
				return [
					truncateToWidth(theme.fg("accent", "Inspect — exact action (control characters escaped)"), width),
					"",
					...lines.slice(offset, offset + height),
					"",
					truncateToWidth(theme.fg("dim", "Esc close · ↑↓ scroll · PgUp/PgDn page"), width),
				];
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return close();
				if (matchesKey(data, Key.up)) offset--;
				else if (matchesKey(data, Key.down)) offset++;
				else if (matchesKey(data, Key.pageUp)) offset -= height;
				else if (matchesKey(data, Key.pageDown)) offset += height;
				else if (matchesKey(data, Key.home)) offset = 0;
				else if (matchesKey(data, Key.end)) offset = total;
				tui.requestRender();
			},
			invalidate() { rebuild(); body.invalidate(); },
			dispose() { signal.removeEventListener("abort", close); },
		};
	});
}
