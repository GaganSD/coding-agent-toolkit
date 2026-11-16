import { getSelectListTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Only the heading and selected action are accented, not the tool call. */
export async function showPermissionDialog(
	ui: Pick<ExtensionUIContext, "custom">,
	summary: string,
	options: string[],
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	return ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const end = Date.now() + timeoutMs;
		const body = new Text(summary, 0, 0);
		const list = new SelectList(options.map((value) => ({ value, label: value })), options.length, getSelectListTheme());
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		const close = () => done(undefined);
		signal.addEventListener("abort", close, { once: true });
		const timer = setInterval(() => tui.requestRender(), 1000);
		timer.unref?.();
		return {
			render(width: number) {
				return [
					truncateToWidth(theme.fg("accent", "Needs your permission"), width),
					"",
					...body.render(width),
					"",
					...list.render(width),
					"",
					...new Text(theme.fg("muted", `${Math.max(0, Math.ceil((end - Date.now()) / 1000))}s remaining · On timeout: safe > 50% + confidence guard, otherwise decline`), 0, 0).render(width),
					truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter select · Esc decline"), width),
				];
			},
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
			invalidate() { body.invalidate(); list.invalidate(); },
			dispose() { clearInterval(timer); signal.removeEventListener("abort", close); },
		};
	});
}
