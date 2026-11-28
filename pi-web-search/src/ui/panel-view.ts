import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { accountState, accountValue, PROVIDER_AUTH, providerHelp, providerReady } from "./accounts.ts";
import { compactPicker, fit, framedPicker, pickerBody, pickerGeometry, sectionRow, viewport } from "./frame.ts";
import { CREDENTIAL_PROVIDER_IDS, type CredentialProviderId } from "../env.ts";
import { isAccount, PANEL_ROWS, type PanelRow, type WebSearchPanel } from "./panel.ts";
import { providerName } from "./provider-names.ts";
import { plainLine } from "./transcript.ts";

export type Message = { tone: "success" | "warning" | "error" | "dim" | "muted"; text: string };

const labels: Record<PanelRow, string> = {
	web: "Web search", fallback: "Backup", code: "Code search", thorough: "Multi-source", results: "Results",
	...providerName, classifier: "Classifier",
};
const descriptions: Partial<Record<PanelRow, string>> = {
	web: "First choice for web search.", fallback: "Tried in numbered order when web search errors or is rate limited.",
	code: "Searches public repositories. Use Edit backups to change the code backup order.",
	thorough: "Lets the model ask up to two sources at once for harder questions. Slower, more complete.",
	results: "Maximum number of results returned per search.",
	classifier: "Ranks multi-source results and hides unsafe ones. Billed to that provider’s account.",
};
const sections: Partial<Record<PanelRow, string>> = { web: "Search", exa: "Accounts", classifier: "Ranking" };
const CURSOR_MARKER = "\x1b_pi:c\x07";
const gutter = "  ";
const ready = "● Ready";
const skipped = "▲ Skipped until you add a key";

function optionPage(lines: string[], active: number, slots: number) {
	const start = Math.max(0, Math.min(active - Math.floor(slots / 2), lines.length - slots));
	return lines.slice(start, start + slots);
}

export function renderPanel(panel: WebSearchPanel, th: Theme, width: number, rows: number) {
	const { height, tiny, inner, bodyHeight } = pickerGeometry(width, rows);
	const { selected: row, settings, editor, error, right } = panel;
	const chip = (text: string) => th.style(` ${text} `, { fg: "accent", bg: "userMessageBg" });
	const field = (name: string, value: string) => `${th.fg("text", name)}  ${chip(`[ ${value} ]`)}`;
	const status = (tone: Message["tone"], text: string) => th.fg(tone, text);
	const accountValues = new Map<CredentialProviderId, string>(CREDENTIAL_PROVIDER_IDS.map((id) => [id, accountValue(id)]));
	const accountWidth = Math.max(...Array.from(accountValues.values(), visibleWidth));
	const value = (id: PanelRow): string => {
		if (isAccount(id)) return accountValues.get(id)!;
		if (id === "web" || id === "code") return providerName[settings[id].provider];
		if (id === "fallback") return settings.web.fallback.filter((kind) => kind !== settings.web.provider).map((kind) => providerName[kind]).join(" → ") || "None";
		if (id === "thorough") return settings.researchEnabled ? "On" : "Off";
		if (id === "results") return String(settings.maxResults);
		return panel.pin ?? "None";
	};
	const hints = (columns: number) => {
		const actions = panel.actions();
		const compact = actions.map(({ key, label }) => `${th.fg("accent", key)} ${th.fg("muted", label)}`).join(" · ");
		return visibleWidth(compact) <= columns ? compact : actions.map(({ key }) => th.fg("accent", key)).join(" ");
	};
	const pending = panel.removing && isAccount(row) ? status("warning", `Press Enter or Space again to remove the ${providerName[row]} key`) : "";
	const message = panel.message ? status(panel.message.tone, plainLine(panel.message.text)) : "";
	const title = panel.backupFamily === "code" ? "Code backup" : labels[row];
	const name = th.style(title, { fg: "accent", bold: true });
	const issue = error?.issue, fix = issue?.fix;
	const banner = error ? status("error", plainLine(`✕ ${basename(error.configPath)}${issue?.line ? ` line ${issue.line}` : ""}: ${issue?.field && issue.summary.startsWith("unknown setting")
		? `unknown setting ${JSON.stringify(issue.field)}${fix ? ` — did you mean ${JSON.stringify(fix.to)}?` : ""}`
		: issue?.summary.replace(/ \(line \d+\)$/u, "") ?? "couldn't read settings"}`)) : "";
	const rowLine = (label: string, selected: boolean, focused: boolean, columns: number) => {
		const cursor = selected && focused ? th.fg("accent", "›") : " ";
		const line = fit(`${cursor} ${label}`, columns);
		return selected ? th.style(line, { fg: focused ? "text" : "dim", bg: "selectedBg", bold: focused }) : line;
	};
	const options = error ? [] : panel.options();
	const active = panel.selectedOption(options);
	const providerWidth = Math.max(0, ...options.filter((opt) => opt.provider).map((opt) => visibleWidth(opt.label)));
	const optionWidth = providerWidth || Math.max(0, ...options.filter((opt) => opt.id !== "multi-source").map((opt) => visibleWidth(opt.label)));
	const entries = options.map((opt) => {
		const auth = opt.provider && PROVIDER_AUTH[opt.provider];
		const connection = auth === "required" && opt.provider && isAccount(opt.provider) ? accountValues.get(opt.provider) : undefined;
		const hint = connection ? status(connection.startsWith("●") ? "success" : "muted", connection)
			: opt.hint ? status(opt.hint.tone, opt.hint.text) : "";
		const current = opt.current ? th.fg("accent", "current") : "";
		return { opt, auth, hint, current };
	});
	const hintGap = "  ";
	const hintWidth = Math.max(0, ...entries.map(({ hint, current }) => visibleWidth([hint, current].filter(Boolean).join(hintGap))));
	const optionLines = (columns: number, slots: number) => {
		let group: string | undefined;
		let activeIndex = 0;
		const lines: string[] = [];
		const nameWidth = Math.min(optionWidth, Math.max(1, columns - gutter.length - hintGap.length - hintWidth));
		const tailWidth = columns - gutter.length - nameWidth - hintGap.length;
		for (const { opt, auth, hint, current } of entries) {
			if (auth && auth !== group) lines.push(sectionRow(th, auth === "keyless" ? "Keyless" : "Needs a key"));
			else if (!auth && group) lines.push(sectionRow(th, "Actions"));
			group = auth;
			if (opt === active) activeIndex = lines.length;
			const label = plainLine(opt.label);
			let tail = hint || current;
			if (hint && current && tailWidth >= visibleWidth(current) + hintGap.length + 1) {
				tail = fit(hint, tailWidth - visibleWidth(current) - hintGap.length).trimEnd() + hintGap + current;
			}
			const text = tail ? fit(label, nameWidth) + hintGap + tail : label;
			lines.push(rowLine(text, opt === active, right, columns));
		}
		return optionPage(lines, activeIndex, slots);
	};
	const accountLines = (columns: number) => {
		if (!isAccount(row)) return [];
		const acct = accountState(row);
		if (panel.checkingKey) return [status("dim", "◌ Checking…")];
		if (editor?.kind === "key") {
			const bullets = "•".repeat(Math.min(editor.value.length, Math.max(0, columns - 9)));
			return [`Key  ${chip(bullets + (panel.focused ? CURSOR_MARKER : "") + th.fg("accent", "▏"))}`, status("dim", "Paste a key. Enter checks it and saves.")];
		}
		const readOnly = (text: string, tone: Message["tone"] = "dim") => rowLine(status(tone, text), true, right, columns);
		if (acct.source === "env") return [readOnly("Read-only · set in your shell."), field("Key", acct.variable ?? "Environment"),
			...(acct.stored === "managed" ? [status("dim", "Stored credential: Managed by Pi")] : [])];
		if (acct.source === "auth") return [field("Key", "saved · auth.json")];
		if (acct.stored === "managed") return [readOnly("Read-only · Managed by Pi")];
		if (acct.stored === "broken") return [readOnly("Broken credential — edit it in Pi’s auth settings.", "warning")];
		return [field("Key", acct.source === "gh" ? "gh auth" : "No key")];
	};
	const ranking = () => [
		...(settings.offTopicFallback ? [status("dim", "Fast web off-topic fallback is on.")] : []),
		...(panel.login ? [status("warning", `▲ Run /login ${panel.login} to use this`)] : []),
		...(panel.pin && !panel.login ? panel.classifierAvailable === undefined ? [status("dim", "○ Classifier untested")]
			: panel.classifierAvailable === false ? [status("warning", "▲ Pinned classifier unavailable")]
				: settings.researchEnabled || settings.offTopicFallback ? [gutter + status("success", ready)] : [] : []),
	];
	const notes = (columns: number) => {
		if (isAccount(row)) return accountLines(columns);
		if (row === "classifier") return panel.classifierLoading ? [rowLine(status("dim", "◌ Checking…"), true, right, columns)] : ranking();
		const provider = active?.provider;
		return provider ? [gutter + (providerReady(provider, settings) ? status("success", ready) : status("warning", skipped))] : [];
	};
	const detailContent = (columns: number, slots: number) => {
		const statusLines = notes(columns);
		const info = descriptions[row] ?? (isAccount(row) ? providerHelp[row].description : undefined);
		const link = isAccount(row) ? providerHelp[row].keyUrl : undefined;
		const description = [...(info && columns > 0 ? wrapTextWithAnsi(th.fg("text", info), columns) : []), ...(link ? [th.fg("dim", link)] : [])];
		const minOptions = options.length ? Math.min(3, options.length) : 0;
		const intro = !editor && description.length + 1 + minOptions + statusLines.length <= slots ? [...description, ""] : [];
		const available = slots - intro.length;
		const keepNotes = statusLines.slice(0, Math.max(0, available - (options.length ? 1 : 0)));
		return [...intro, ...optionLines(columns, available - keepNotes.length), ...keepNotes];
	};
	const details = (columns: number, slots: number) => {
		if (error) return compactPicker([name, ...(fix ? [field("File has", `${JSON.stringify(fix.from)}: ${fix.preview}`), field("Fix", `${JSON.stringify(fix.to)}: ${fix.preview}`)] : []),
			...wrapTextWithAnsi(th.fg("dim", plainLine(error.configPath)), columns)], columns, slots);
		return compactPicker(slots > 1 ? [name, ...detailContent(columns, slots - 1)] : detailContent(columns, slots), columns, slots);
	};
	if (tiny) {
		const priority = banner || pending || message;
		const identity = `${!right && !error ? th.fg("accent", "›") + " " : gutter}${name} · ${chip(`[ ${plainLine(value(row))} ]`)}`;
		if (!error && right && height === 1) return compactPicker(detailContent(width, 1), width, height);
		if (height === 1) return compactPicker([priority || identity], width, height);
		if (!error && !editor && height === 2 && !priority) return compactPicker([identity, ...detailContent(width, 1)], width, height);
		const header = editor ? [] : [identity];
		const slots = Math.max(0, height - header.length - 1 - Number(!!priority));
		return compactPicker([...header, ...(!error ? detailContent(width, slots) : []), ...(priority ? [priority] : []), hints(width)], width, height);
	}
	const items = PANEL_ROWS.flatMap<{ section: string } | { id: PanelRow }>((id) => sections[id] ? [{ section: sections[id]! }, { id }] : [{ id }]);
	const list = (columns: number, slots: number) => viewport(th, "Settings", PANEL_ROWS.indexOf(row), PANEL_ROWS.length,
		items.findIndex((item) => "id" in item && item.id === row), items.length, columns, slots, (index) => {
			const item = items[index];
			if ("section" in item) return sectionRow(th, item.section);
			const selected = row === item.id;
			const text = selected && error ? "✕" : plainLine(value(item.id));
			const valueWidth = Math.min(isAccount(item.id) ? accountWidth : visibleWidth(text), Math.max(2, Math.floor(columns * 0.46)));
			const label = fit(labels[item.id], columns - 3 - valueWidth);
			const val = fit(text, valueWidth);
			return rowLine(`${label} ${selected ? val : th.fg("muted", val)}`, selected, !right || !!error, columns);
		});
	const body = pickerBody(th, width, inner, bodyHeight - Number(!!banner), list, details);
	return framedPicker(th, width, "Web search", [...(banner ? [banner] : []), ...body], ["", hints(inner), pending || message], right ? "borderAccent" : "border");
}
