import { getSelectListTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";

/** A compact catalogue: normal prose, scrollable choices, exact destination. */
export async function showModelPicker(
	ui: Pick<ExtensionUIContext, "custom">,
	disclosure: string,
	items: SelectItem[],
): Promise<string | undefined> {
	return ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const prose = new Text(disclosure, 0, 0);
		let selected = 0;
		let capacity = 0;
		let list: SelectList;
		const makeList = (visible: number) => {
			// Keep destinations in a separate wrapping block rather than clipping
			// the URL into the list's description column.
			list = new SelectList(items.map(({ value, label }) => ({ value, label })), visible, getSelectListTheme());
			list.setSelectedIndex(selected);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			list.onSelectionChange = (item) => { selected = items.findIndex((entry) => entry.value === item.value); };
		};
		makeList(1);
		return {
			render(width: number) {
				const header = prose.render(width);
				const destination = new Text(theme.fg("muted", items[selected]?.description ?? "Nothing is uploaded."), 0, 0).render(width);
				const visible = Math.max(1, tui.terminal.rows - header.length - destination.length - 8);
				if (capacity !== visible) { capacity = visible; makeList(visible); }
				return [
					truncateToWidth(theme.fg("accent", "Decision Models — active safety review"), width),
					"",
					...header,
					"",
					...list.render(width),
					"",
					...destination,
					"",
					truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel"), width),
				];
			},
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
			invalidate() { prose.invalidate(); list.invalidate(); },
		};
	});
}
