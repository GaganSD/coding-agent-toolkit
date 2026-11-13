import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, Text, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { SETTINGS_LIMITS } from "./settings.js";
import { DEFAULT_SETTINGS, type AutomodeSettings } from "./types.js";
import type { CommandUi } from "./ui.js";

interface Field {
	key: "approvalTimeoutMs" | "reviewSafeThreshold" | "reviewConfidenceThreshold" | "reviewTimeoutMs" | "reviewMaxRequests" | "logRetentionDays" | "logMaxEntries";
	label: string;
	unit: string;
	scale: number;
	min: number;
	max: number;
	help: string;
}

export const TUNING_FIELDS: readonly Field[] = [
	{ key: "approvalTimeoutMs", label: "Approval wait", unit: "s", scale: 1000, ...SETTINGS_LIMITS.approvalTimeoutMs,
		help: "Time allowed for approval, including queue wait. An unanswered eligible action may run once if safe probability > 50% and the confidence guard passes; otherwise it is declined." },
	{ key: "reviewSafeThreshold", label: "Immediate safe threshold", unit: "%", scale: 0.01, min: 0.5, max: 1,
		help: "Minimum safe probability for immediate model approval, without asking. Lower values permit more automatic actions. Hard blocks and privacy restrictions remain final." },
	{ key: "reviewConfidenceThreshold", label: "Model confidence guard", unit: "%", scale: 0.01, min: 0.5, max: 1,
		help: "Minimum model confidence for immediate approval, timeout fallback, and reusable pattern proposals. Confidence is not a safety guarantee." },
	{ key: "reviewTimeoutMs", label: "Model review timeout", unit: "s", scale: 1000, ...SETTINGS_LIMITS.reviewTimeoutMs,
		help: "Maximum time for one decision-model review. Failed or timed-out reviews never grant permission." },
	{ key: "reviewMaxRequests", label: "Model requests per session", unit: "", scale: 1, ...SETTINGS_LIMITS.reviewMaxRequests,
		help: "Decision-model request budget per session. Always Allow proposals also consume requests. Exhausting the budget falls back to local approval." },
	{ key: "logRetentionDays", label: "Keep logs", unit: " days", scale: 1, ...SETTINGS_LIMITS.logRetentionDays,
		help: "Local decision-log retention. Older entries are removed when logs are read or appended." },
	{ key: "logMaxEntries", label: "Maximum log entries", unit: "", scale: 1, ...SETTINGS_LIMITS.logMaxEntries,
		help: "Keep the newest entries up to this limit. The internal byte ceiling still applies." },
];

function display(value: number, scale: number): string {
	return String(Number((value / scale).toFixed(6)));
}

/** Exact decimal input, converted to persisted units and checked before saving. */
export function parseTuningValue(field: Field, input: string): number | undefined {
	const text = input.trim();
	if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
	const value = Number((Number(text) * field.scale).toFixed(6));
	if (!Number.isFinite(value) || value < field.min || value > field.max) return undefined;
	if (field.scale !== 0.01 && !Number.isInteger(value)) return undefined;
	return value;
}

export async function showSettingsMenu(ui: CommandUi, items: SelectItem[], note: string): Promise<string | undefined> {
	const choice = await ui.select(`Automode settings\n${note}\nChanges are saved only with Save changes.`, items.map((item) => item.label));
	return items.find((item) => item.label === choice)?.value;
}

/** One interaction, fixed geometry: editing never opens another dialog. */
async function showInlineSettings(ui: CommandUi, current: AutomodeSettings, pending: string): Promise<AutomodeSettings | undefined> {
	return ui.custom!<AutomodeSettings | undefined>((tui, theme, _keys, done) => {
		const draft = { ...current };
		const input = new Input();
		const border = new DynamicBorder((text) => theme.fg("border", text));
		const actions = ["Save changes", "Reset to defaults", "Cancel"];
		const count = TUNING_FIELDS.length + actions.length;
		let selected = 0;
		let editing = false;
		let focused = false;
		let error = "";
		const activeField = () => TUNING_FIELDS[selected];
		const changedCount = () => TUNING_FIELDS.filter((field) => draft[field.key] !== current[field.key]).length;
		const range = (field: Field) => `${display(field.min, field.scale)}–${display(field.max, field.scale)}${field.unit}`;
		const apply = (): boolean => {
			if (!editing) return true;
			const field = activeField()!;
			const value = parseTuningValue(field, input.getValue());
			if (value === undefined) {
				error = `Enter ${range(field)}${field.scale !== 0.01 ? "; whole persisted units only" : ""}.`;
				return false;
			}
			draft[field.key] = value;
			editing = false;
			input.focused = false;
			error = "";
			return true;
		};
		const beginEdit = (replace = false) => {
			const field = activeField();
			if (!field) return;
			input.setValue(replace ? "" : display(draft[field.key], field.scale));
			editing = true;
			input.focused = focused;
			error = "";
		};
		const move = (delta: number) => {
			if (!apply()) return;
			selected = (selected + delta + count) % count;
			error = "";
		};
		input.onSubmit = () => { apply(); };
		input.onEscape = () => { editing = false; input.focused = false; error = ""; };
		const activate = () => {
			if (activeField()) return beginEdit();
			switch (selected - TUNING_FIELDS.length) {
				case 0: done(draft); break;
				case 1:
					for (const field of TUNING_FIELDS) draft[field.key] = DEFAULT_SETTINGS[field.key];
					break;
				case 2: done(undefined); break;
			}
		};
		return {
			get focused() { return focused; },
			set focused(value: boolean) { focused = value; input.focused = value && editing; },
			render(width: number) {
				// Match Pi's native selectors: full-width horizontal rules, one
				// column of padding, no enclosing box. Reserve help space so
				// navigation and inline edits never change the panel height.
				width = Math.max(1, width);
				if (width < 8) return [truncateToWidth("Settings", width)];
				const inner = width - 2;
				const helpHeight = Math.min(width >= 100 ? 3 : 4, Math.max(1, tui.terminal.rows - 13));
				const visible = Math.min(count, Math.max(1, tui.terminal.rows - helpHeight - 10));
				const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible));
				const line = (text = "") => {
					const clipped = truncateToWidth(text, inner);
					return ` ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} `;
				};
				const rows: string[] = [];
				for (let i = start; i < start + visible; i++) {
					const field = TUNING_FIELDS[i];
					const cursor = i === selected ? "→ " : "  ";
					const paint = (text: string) => theme.fg(i === selected ? "accent" : "text", text);
					if (!field) { rows.push(line(paint(cursor + actions[i - TUNING_FIELDS.length]!))); continue; }
					const labelWidth = Math.min(29, Math.max(0, inner - 15));
					const label = truncateToWidth(field.label, labelWidth);
					const suffix = `${field.unit}${draft[field.key] !== current[field.key] ? " *" : ""}`;
					const valueWidth = Math.max(1, inner - labelWidth - 3 - visibleWidth(suffix));
					const value = i === selected && editing ? input.render(valueWidth)[0] ?? "" : display(draft[field.key], field.scale);
					rows.push(line(paint(`${cursor}${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))} ${value}${suffix}`)));
				}
				const field = activeField();
				const help = field
					? `${error ? `${error}\n` : ""}${range(field)} · Default ${display(DEFAULT_SETTINGS[field.key], field.scale)}${field.unit}\n${field.help}`
					: ["Apply this draft. Model, consent, rules, and on/off state stay unchanged.", "Restore tuning defaults in this draft. Choose Save changes to apply them.", "Discard unsaved changes and return to Automode."][selected - TUNING_FIELDS.length]!;
				const helpLines = new Text(theme.fg(error ? "warning" : "muted", help), 0, 0).render(inner);
				const helpBlock = Array.from({ length: helpHeight }, (_, i) => line(i === helpHeight - 1 && helpLines.length > helpHeight ? truncateToWidth(helpLines[i] ?? "", Math.max(1, inner - 1)) + "…" : helpLines[i] ?? ""));
				return [...border.render(width), line(),
					line(theme.fg("accent", theme.bold("Automode settings"))),
					line(theme.fg("muted", `${changedCount()} unsaved · ${pending}`)), line(),
					...rows, line(), ...helpBlock,
					line(theme.fg("dim", editing ? "enter apply  esc cancel edit  tab next  ctrl+s save" : "↑↓ navigate  enter edit  type to replace  esc cancel  ctrl+s save")),
					line(), ...border.render(width)];
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("c"))) return done(undefined);
				if (matchesKey(data, Key.ctrl("s"))) { if (apply()) done(draft); }
				else if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) move(-1);
				else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) move(1);
				else if (editing) input.handleInput(data);
				else if (matchesKey(data, Key.escape)) return done(undefined);
				else if (matchesKey(data, Key.enter)) activate();
				else if (activeField() && /^\d$/.test(data)) { beginEdit(true); input.handleInput(data); }
				tui.requestRender();
			},
			invalidate() { input.invalidate(); },
		};
	});
}

/** Edits a local draft only. The command layer owns epoch checks and persistence. */
export async function editTuningSettings(
	ui: CommandUi,
	current: AutomodeSettings,
	pending: string,
): Promise<AutomodeSettings | undefined> {
	if (ui.custom) return showInlineSettings(ui, current, pending);
	const draft = { ...current };
	for (;;) {
		const changed = TUNING_FIELDS.filter((field) => draft[field.key] !== current[field.key]).length;
		const items: SelectItem[] = [
			...TUNING_FIELDS.map((field) => ({ value: field.key,
				label: `${field.label.padEnd(29)} ${display(draft[field.key], field.scale)}${field.unit}${draft[field.key] !== current[field.key] ? " *" : ""}`,
				description: field.help })),
			{ value: "save", label: "Save changes", description: "Apply the displayed values. Model selection, disclosure consent, rules, and on/off state stay unchanged." },
			{ value: "reset", label: "Reset to defaults", description: "Reset these seven tuning values in the draft. Nothing is persisted until you choose Save changes." },
			{ value: "cancel", label: "Cancel", description: "Discard unsaved changes and return to Automode." },
		];
		const choice = await showSettingsMenu(ui, items, `${changed ? `${changed} unsaved change${changed === 1 ? "" : "s"}` : "No unsaved changes"} · ${pending}`);
		if (choice === undefined || choice === "cancel") return undefined;
		if (choice === "save") return draft;
		if (choice === "reset") {
			for (const field of TUNING_FIELDS) draft[field.key] = DEFAULT_SETTINGS[field.key];
			continue;
		}
		const field = TUNING_FIELDS.find((entry) => entry.key === choice);
		if (!field) continue;
		const range = `${display(field.min, field.scale)}–${display(field.max, field.scale)}${field.unit}`;
		const value = await ui.input(`${field.label}${field.unit ? ` (${field.unit.trim()})` : ""} · ${range}`,
			`Current: ${display(draft[field.key], field.scale)} · Default: ${display(DEFAULT_SETTINGS[field.key], field.scale)}`);
		if (value === undefined) continue;
		const parsed = parseTuningValue(field, value);
		if (parsed === undefined) {
			ui.notify(`Enter a number in ${range}${field.scale !== 0.01 ? " (whole persisted units)" : ""}. Nothing changed.`, "warning");
			continue;
		}
		draft[field.key] = parsed;
	}
}
