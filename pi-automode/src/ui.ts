import type { ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { showModelPicker } from "./model-picker.js";
import { DISCLOSURE_VERSION } from "./core/disclosure.js";
import { editTuningSettings, TUNING_FIELDS } from "./settings-editor.js";
import type { AutomodeSettings, DecisionLog, Rule } from "./types.js";
import { escapeOneLine, escapeTerminal } from "./runtime/escape.js";
import { ambientShellCustomizations, type HostShellOptions } from "./runtime/host.js";
import { normalizeDisclosureEndpoint } from "./core/disclosure.js";
import type { AutomodeHealth } from "./runtime/health.js";

/**
 * Pi-native dialogs: a compact panel, rules, logs and optional active safety review.
 *
 * Authority rules (IMPLEMENTATION.md invariant 6 + B1):
 * - Pi dispatches slash commands BEFORE input hooks and provides no command
 *   origin authentication. Authority is the live local TUI dispatch itself
 *   (ctx.mode === "tui" && ctx.hasUI): the on/off toggle and decision model
 *   selection are single-step by operator decision, so any TUI-context
 *   command dispatch can apply them with no dialog. Rule save/delete, log
 *   clear and re-verify additionally require an explicit host-owned
 *   confirmation whose default is Cancel. RPC (hasUI=true) and print/json
 *   never authorize.
 * - No message content, tool result or pi-ask answer is parsed as authority;
 *   only the host dispatch path reaches settings.update.
 */

const USAGE = "Usage: /automode [on|off|rules|logs]";

/** Minimal UI surface used by the command layer (subset of ExtensionUIContext). */
export interface CommandUi {
	custom?: ExtensionUIContext["custom"];
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
	/** Host theme for status/header colors; absent in headless and tests. */
	readonly theme?: Theme;
}

export interface DecisionModelInfo {
	provider: string;
	id: string;
	baseUrl?: unknown;
}

export interface CommandModelRegistry {
	/** Every registered decision model when the host exposes the catalogue. */
	getModelsOfType?(type: "classifier", provider?: string): readonly DecisionModelInfo[];
	/** Auth-ready decision models; a rejection means availability unknown, not missing. */
	getAvailableOfType(type: "classifier", provider?: string): Promise<readonly DecisionModelInfo[]>;
}

export interface CommandCtx {
	mode: string;
	hasUI: boolean;
	ui: CommandUi;
	modelRegistry?: CommandModelRegistry;
}

export interface UiSettingsStore {
	readonly current: AutomodeSettings;
	readonly epoch: number;
	readonly error: string | null;
	update(next: AutomodeSettings): Promise<void>;
	reload(): Promise<boolean>;
}

export interface UiLogStore {
	read(settings: AutomodeSettings): Promise<DecisionLog[]>;
	clear(): Promise<void>;
}

export interface UiGate {
	readonly state: "off" | "on" | "halted";
	readonly haltReason: string | null;
	/** Managed calls in flight or queued on the execution mutex. */
	readonly pendingManaged: number;
	operatorUpdated(): void;
	reverify(): Promise<{ ok: boolean; error?: string }>;
}

export interface UiApproval {
	readonly pendingCount: number;
}

export interface UiDeps {
	settings: UiSettingsStore;
	logs: UiLogStore;
	gate: UiGate;
	approval: UiApproval;
	dirs: { agentDir: string; workspace: string; extensionDir: string };
	host(): HostShellOptions;
	guardedTools: readonly string[];
	onHealth?: (health: AutomodeHealth) => void;
}

const CANCEL = "Cancel";

/** Theme-colored text; plain when the host provides no theme (headless, tests). */
function paint(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme ? theme.fg(color, text) : text;
}

/** Color only the real terminal: RPC clients may render status text verbatim. */
function themeFor(ctx: CommandCtx): Theme | undefined {
	return ctx.mode === "tui" ? ctx.ui.theme : undefined;
}

export function createCommandHandler(deps: UiDeps): (args: string, ctx: CommandCtx) => Promise<void> {
	return async (args: string, ctx: CommandCtx) => {
		const sub = args.trim();
		switch (sub) {
			case "":
				return showPanel(deps, ctx);
			case "on":
				return setEnabled(deps, ctx, true);
			case "off":
				return setEnabled(deps, ctx, false);
			case "rules":
				return rulesEditor(deps, ctx);
			case "logs":
				return logsViewer(deps, ctx);
			default:
				ctx.ui.notify(`${USAGE} — unknown subcommand "${escapeOneLine(sub)}"`, "error");
		}
	};
}

/** Keep the footer quiet; diagnostics live in Settings. */
export function statusText(deps: UiDeps, theme?: Theme): string {
	const settings = deps.settings.current;
	const state = deps.gate.state;
	if (state === "halted") return paint(theme, "error", "Automode: Halted");
	if (state === "off" || !settings?.enabled) return paint(theme, "warning", "Automode: Off");
	return paint(theme, "success", "Automode: On");
}

export function refreshStatus(deps: UiDeps, ctx: CommandCtx): void {
	try {
		ctx.ui.setStatus?.("automode", statusText(deps, themeFor(ctx)));
	} catch {
		// Status display is best-effort and never authority.
	}
}

/** Live local TUI only. RPC-forwarded dialogs are not authority. */
function requireOperator(ctx: CommandCtx): boolean {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Automode changes require the interactive terminal; this mode cannot authorize them.", "error");
		return false;
	}
	return true;
}

/**
 * Host-owned terminal confirmation with Cancel as the default/first option.
 * Only the exact confirm label authorizes; Escape/undefined/errors do not.
 */
async function confirmAuthority(ctx: CommandCtx, title: string, detail: string, confirmLabel: string): Promise<boolean> {
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select(detail ? `${title}\n\n${detail}` : title, [CANCEL, confirmLabel]);
	} catch {
		return false;
	}
	return choice === confirmLabel;
}

/**
 * Commit a settings mutation. `expectedEpoch` must have been captured BEFORE
 * the workflow's async dialogs: a confirmation shown for state S can never
 * apply to a newer state — if the settings epoch moved (another verified
 * change, a reload) the stale confirmation is discarded, not applied.
 */
async function saveSettings(
	deps: UiDeps,
	ctx: CommandCtx,
	next: AutomodeSettings,
	expectedEpoch: number,
	healthEnabled?: boolean,
): Promise<boolean> {
	if (deps.settings.epoch !== expectedEpoch) {
		ctx.ui.notify("Automode: settings changed while you were deciding; nothing was saved — review and retry.", "warning");
		return false;
	}
	try {
		await deps.settings.update(next);
	} catch (error) {
		ctx.ui.notify(`Automode: could not save settings (${error instanceof Error ? error.message : String(error)})`, "error");
		return false;
	}
	deps.onHealth?.({
		initialized: true,
		guardedTools: [...deps.guardedTools],
		enabled: healthEnabled ?? next.enabled,
		...(deps.settings.error ? { error: String(deps.settings.error) } : {}),
	});
	return true;
}

async function setEnabled(deps: UiDeps, ctx: CommandCtx, on: boolean): Promise<void> {
	if (!requireOperator(ctx)) return;
	const epoch0 = deps.settings.epoch;
	const current = deps.settings.current;
	if (!current) {
		ctx.ui.notify("Automode: no valid configuration; fix automode.json first.", "error");
		return;
	}
	if (current.enabled === on && deps.gate.state !== "halted") {
		ctx.ui.notify(on ? "Already on." : "Already off.", "info");
		return;
	}
	// Single-step: the live local TUI invocation is the decision; no dialog.
	if (!(await saveSettings(deps, ctx, { ...current, enabled: on }, epoch0, on))) return;
	// Clears any halt and invalidates pending asks/reviews; Off never releases
	// held calls into execution, On never retroactively re-holds work.
	deps.gate.operatorUpdated();
	refreshStatus(deps, ctx);
	ctx.ui.notify(on ? "Automode is on." : "Automode is off.", "info");
}

async function showPanel(deps: UiDeps, ctx: CommandCtx): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Automode panel requires UI.", "error");
		return;
	}
	for (;;) {
		const settings = deps.settings.current;
		const state = deps.gate.state;
		const halted = state === "halted";
		const theme = themeFor(ctx);
		const label = halted
			? paint(theme, "error", "Automode: Halted")
			: settings?.enabled
				? paint(theme, "success", "Automode: On")
				: paint(theme, "warning", "Automode: Off");
		const lines: string[] = [];
		if (halted) {
			lines.push(`Halted: ${escapeOneLine(deps.gate.haltReason ?? "configuration needs verification", 160)}`);
		} else if (deps.settings.error) {
			lines.push(`Config error: ${escapeOneLine(String(deps.settings.error), 160)}`);
		}
		if (ambientShellCustomizations(deps.host()).length) lines.push("Shell customization detected: bash is blocked while on.");
		if (ctx.mode !== "tui") lines.push("Changes and approvals require the interactive terminal.");
		if (deps.approval.pendingCount) lines.push(`${deps.approval.pendingCount} awaiting approval`);
		const toggle = settings?.enabled ? "Toggle OFF" : "Toggle ON";
		const options = [toggle, "Rules", "Logs", "Decision Models", "Settings"];
		if (state === "halted") options.unshift("Re-verify configuration");
		options.push("Close");

		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(lines.length ? `${label}\n${lines.join("\n")}` : label, options);
		} catch {
			return;
		}
		if (choice === toggle) await setEnabled(deps, ctx, !settings?.enabled);
		else if (choice === "Rules") await rulesEditor(deps, ctx);
		else if (choice === "Logs") await logsViewer(deps, ctx);
		else if (choice === "Decision Models") await decisionModelPicker(deps, ctx);
		else if (choice === "Settings") await showSettings(deps, ctx);
		else if (choice === "Re-verify configuration") await reverify(deps, ctx);
		else return;
		refreshStatus(deps, ctx);
	}
}

async function showSettings(deps: UiDeps, ctx: CommandCtx): Promise<void> {
	if (!requireOperator(ctx)) return;
	const epoch0 = deps.settings.epoch;
	const current = deps.settings.current;
	if (!current) {
		ctx.ui.notify("Automode: no valid configuration; fix automode.json first.", "error");
		return;
	}
	let next: AutomodeSettings | undefined;
	try {
		next = await editTuningSettings(ctx.ui, current,
			`Pending: ${deps.gate.pendingManaged} managed, ${deps.approval.pendingCount} awaiting approval`);
	} catch {
		return; // UI failure never persists a partially edited draft.
	}
	if (!next) return;
	if (TUNING_FIELDS.every((field) => next[field.key] === current[field.key])) {
		ctx.ui.notify("No settings changed.", "info");
		return;
	}
	if (await saveSettings(deps, ctx, next, epoch0)) ctx.ui.notify("Automode settings saved.", "info");
}

async function reverify(deps: UiDeps, ctx: CommandCtx): Promise<void> {
	if (!requireOperator(ctx)) return;
	const confirmed = await confirmAuthority(
		ctx,
		"Re-verify configuration?",
		"The current automode.json on disk becomes the reviewed configuration. Only confirm if you expected its contents.",
		"Re-verify",
	);
	if (!confirmed) return;
	const result = await deps.gate.reverify();
	ctx.ui.notify(
		result.ok ? "Configuration re-verified; guard state restored." : `Still halted: ${result.error ?? "unknown error"}`,
		result.ok ? "info" : "error",
	);
	refreshStatus(deps, ctx);
}

// ---------------------------------------------------------------- rules

function ruleLine(list: "allowlist" | "blocklist", rule: Rule): string {
	const flags = rule.enabled === false ? " · disabled" : "";
	return `[${list}${flags}] ${rule.tool ?? "bash"}/${rule.mode ?? "glob"} ${escapeOneLine(rule.text, 120)}`;
}

interface RuleRef {
	list: "allowlist" | "blocklist";
	index: number;
	rule: Rule;
}

const RULE_ADD = "Add rule";
const RULE_DONE = "Done";

async function rulesEditor(deps: UiDeps, ctx: CommandCtx): Promise<void> {
	if (!requireOperator(ctx)) return;
	for (;;) {
		const current = deps.settings.current;
		if (!current) {
			ctx.ui.notify("Automode: no valid configuration; fix automode.json first.", "error");
			return;
		}
		const epoch0 = deps.settings.epoch;
		const refs: (RuleRef | typeof RULE_ADD | typeof RULE_DONE)[] = [];
		const options: string[] = [];

		for (const [list, rules] of [
			["blocklist", current.blocklist],
			["allowlist", current.allowlist],
		] as const) {
			rules.forEach((rule, index) => {
				// Positional prefix: duplicate rule texts produce identical labels,
				// so selection keys on the unique position, never the label bytes.
				options.push(`${options.length + 1}. ${ruleLine(list, rule)}`);
				refs.push({ list, index, rule });
			});
		}
		options.push(RULE_ADD, RULE_DONE);
		refs.push(RULE_ADD, RULE_DONE);

		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(current.allowlist.length + current.blocklist.length === 0
				? "Automode rules — no rules yet. Workspace file checks still apply."
				: "Automode rules — block rules take priority", options);
		} catch {
			return;
		}
		const ref = choice === undefined ? RULE_DONE : refs[options.indexOf(choice)];
		if (ref === undefined || ref === RULE_DONE) return;
		if (ref === RULE_ADD) {
			await addRule(deps, ctx, current, epoch0);
			continue;
		}
		await editRule(deps, ctx, current, ref, epoch0);
	}
}

async function addRule(deps: UiDeps, ctx: CommandCtx, current: AutomodeSettings, epoch0: number): Promise<void> {
	const definitions = (["Allowlist", "Blocklist"] as const).flatMap((effect) =>
		(["bash", "read", "edit", "write"] as const).flatMap((tool) =>
			(["glob", "exact", "regex"] as const).map((mode) => ({
				label: `${effect} ${mode === "glob" ? "" : `${mode} `}${tool === "bash" ? "command" : tool}`,
				tool, mode, list: effect === "Allowlist" ? "allowlist" as const : "blocklist" as const,
			}))));
	const choice = await ctx.ui.select("Add rule — command/path patterns, not messages", [...definitions.map((d) => d.label), CANCEL]);
	const definition = definitions.find((d) => d.label === choice);
	if (!definition) return;
	const { tool, mode, list } = definition;
	const text = await ctx.ui.editor(`${list} ${tool}/${mode} — full ${tool === "bash" ? "command" : "canonical absolute path"}; regex: literals, classes, . * + ? only`);
	if (text === undefined || text.length === 0) return;
	const rule: Rule = { text, ...(tool !== "bash" ? { tool } : {}), ...(mode !== "glob" ? { mode } : {}) };
	const confirmed = await confirmAuthority(
		ctx,
		"Save rule?",
		`${list} rule:\n${escapeTerminal(text, { multiline: true })}`,
		"Save rule",
	);
	if (!confirmed) return;
	const next: AutomodeSettings = { ...current, [list]: [...current[list], rule] };
	if (await saveSettings(deps, ctx, next, epoch0)) ctx.ui.notify("Rule saved.", "info");
}

async function editRule(deps: UiDeps, ctx: CommandCtx, current: AutomodeSettings, ref: RuleRef, epoch0: number): Promise<void> {
	const toggleLabel = ref.rule.enabled === false ? "Enable" : "Disable";
	const moveLabel = ref.list === "allowlist" ? "Move to blocklist" : "Move to allowlist";
	const choice = await ctx.ui.select(`${ruleLine(ref.list, ref.rule)}`, [
		"Back",
		"Edit text",
		toggleLabel,
		moveLabel,
		"Delete",
	]);
	if (choice === undefined || choice === "Back") return;

	const lists = () => ({ allowlist: [...current.allowlist], blocklist: [...current.blocklist] });

	if (choice === "Edit text") {
		const text = await ctx.ui.editor("Edit rule — saved verbatim", ref.rule.text);
		if (text === undefined || text.length === 0) return;
		const confirmed = await confirmAuthority(
			ctx,
			"Save rule edit?",
			escapeTerminal(text, { multiline: true }),
			"Save rule",
		);
		if (!confirmed) return;
		const next = lists();
		next[ref.list][ref.index] = { ...ref.rule, text };
		if (await saveSettings(deps, ctx, { ...current, ...next }, epoch0)) ctx.ui.notify("Rule saved.", "info");
		return;
	}
	if (choice === toggleLabel) {
		const confirmed = await confirmAuthority(
			ctx,
			ref.rule.enabled === false ? "Enable rule?" : "Disable rule?",
			ruleLine(ref.list, ref.rule),
			ref.rule.enabled === false ? "Enable rule" : "Disable rule",
		);
		if (!confirmed) return;
		const next = lists();
		next[ref.list][ref.index] = { ...ref.rule, enabled: ref.rule.enabled === false };
		if (await saveSettings(deps, ctx, { ...current, ...next }, epoch0)) {
			ctx.ui.notify(ref.rule.enabled === false ? "Rule enabled." : "Rule disabled.", "info");
		}
		return;
	}
	if (choice === moveLabel) {
		const confirmed = await confirmAuthority(ctx, "Move rule?", ruleLine(ref.list, ref.rule), "Move rule");
		if (!confirmed) return;
		const next = lists();
		next[ref.list].splice(ref.index, 1);
		const target = ref.list === "allowlist" ? "blocklist" : "allowlist";
		next[target].push(ref.rule);
		if (await saveSettings(deps, ctx, { ...current, ...next }, epoch0)) ctx.ui.notify("Rule moved.", "info");
		return;
	}
	if (choice === "Delete") {
		const confirmed = await confirmAuthority(
			ctx,
			"Delete rule?",
			ruleLine(ref.list, ref.rule),
			"Delete rule",
		);
		if (!confirmed) return;
		const next = lists();
		next[ref.list].splice(ref.index, 1);
		if (await saveSettings(deps, ctx, { ...current, ...next }, epoch0)) ctx.ui.notify("Rule deleted.", "info");
	}
}

// ---------------------------------------------------------------- logs

const LOGS_CLEAR = "Clear logs";
const LOGS_CLOSE = "Close";

function logLine(entry: DecisionLog): string {
	const summary =
		entry.action.tool === "bash"
			? `$ ${String(entry.action.args.command ?? "")}`
			: `${escapeOneLine(entry.action.tool, 40)} ${String(entry.action.args.path ?? "")}`;
	return `${escapeOneLine(entry.time, 40)} ${entry.outcome.toUpperCase()} · ${escapeOneLine(entry.source, 80)} — ${escapeOneLine(summary, 120)}`;
}

function logDetail(entry: DecisionLog): string {
	const lines = [
		`id: ${escapeTerminal(entry.id)}`,
		`time: ${escapeTerminal(entry.time)}`,
		`outcome: ${entry.outcome}`,
		`source: ${escapeTerminal(entry.source)}`,
		`reason: ${escapeTerminal(entry.reason, { multiline: true })}`,
		`action: ${escapeTerminal(entry.action.tool)} ${escapeTerminal(JSON.stringify(entry.action.args, null, 2) ?? "", { multiline: true })}`,
		`cwd: ${escapeTerminal(entry.action.cwd)}`,
	];
	if (entry.matchedRule) {
		lines.push(`matched rule: ${escapeTerminal(entry.matchedRule.text, { multiline: true })}`);
	}
	lines.push(
		entry.decisionModel !== undefined
			? `decision model: ${escapeTerminal(JSON.stringify(entry.decisionModel), { multiline: true })}`
			: "decision model: not captured",
		entry.input !== undefined
			? `input: ${escapeTerminal(JSON.stringify(entry.input), { multiline: true })}`
			: "input: not captured",
		entry.output !== undefined
			? `output: ${escapeTerminal(JSON.stringify(entry.output), { multiline: true })}`
			: "output: not captured",
	);
	return lines.join("\n");
}

async function logsViewer(deps: UiDeps, ctx: CommandCtx): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Automode logs require UI.", "error");
		return;
	}
	for (;;) {
		const settings = deps.settings.current;
		if (!settings) {
			ctx.ui.notify("Automode: no valid configuration; fix automode.json first.", "error");
			return;
		}
		let entries: DecisionLog[];
		try {
			entries = await deps.logs.read(settings);
		} catch (error) {
			ctx.ui.notify(
				`Automode: decision log unavailable (${error instanceof Error ? error.message : String(error)})`,
				"error",
			);
			return;
		}
		const options: string[] = [];
		const byLine = new Map<string, DecisionLog>();
		for (const entry of [...entries].reverse()) {
			const line = `${options.length + 1}. ${logLine(entry)}`;
			options.push(line);
			byLine.set(line, entry);
		}
		if (entries.length && ctx.mode === "tui") options.push(LOGS_CLEAR);
		options.push(LOGS_CLOSE);
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				entries.length ? "Automode logs — newest first" : "Automode logs — no decisions recorded yet",
				options,
			);
		} catch {
			return;
		}
		if (choice === undefined || choice === LOGS_CLOSE) return;
		if (choice === LOGS_CLEAR) {
			if (!requireOperator(ctx)) return;
			const confirmed = await confirmAuthority(ctx, "Clear decision logs?", "All recorded decisions are deleted locally.", "Clear logs");
			if (confirmed) {
				try {
					await deps.logs.clear();
					ctx.ui.notify("Decision logs cleared.", "info");
				} catch (error) {
					ctx.ui.notify(`Could not clear logs: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			continue;
		}
		const entry = byLine.get(choice);
		if (!entry) continue;
		try {
			await ctx.ui.select(`Decision detail\n\n${logDetail(entry)}`, [LOGS_CLOSE]);
		} catch {
			return;
		}
	}
}

// ---------------------------------------------------------------- review / decision models

const PICKER_RULES_ONLY = "Rules only (no decision model)";
const CURRENT_PREFIX = "[current] ";

/** Registered decision model plus tri-state availability (undefined = unknown). */
interface ListedDecisionModel extends DecisionModelInfo {
	available?: boolean;
}

/**
 * Every registered decision model with availability when it can be resolved.
 * A failed availability lookup (abort, auth error, network) means unknown,
 * never "missing credentials". Without getModelsOfType the availability
 * results themselves are the catalogue.
 */
async function listDecisionModels(registry: CommandModelRegistry): Promise<ListedDecisionModel[]> {
	const known: DecisionModelInfo[] = (registry.getModelsOfType?.("classifier") ?? []).map((model) => ({
		provider: model.provider,
		id: model.id,
		...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
	}));
	let available: readonly DecisionModelInfo[] | undefined;
	try {
		available = await registry.getAvailableOfType("classifier");
	} catch {
		available = undefined;
	}
	const ready = new Set((available ?? []).map((model) => `${model.provider}/${model.id}`));
	const listed = known.map((model) => {
		const entry: ListedDecisionModel = { ...model };
		if (available !== undefined) entry.available = ready.has(`${model.provider}/${model.id}`);
		return entry;
	});
	if (listed.length > 0) return listed;
	return (available ?? []).map((model) => ({ ...model, available: true }));
}

/** Display key for a decision model; escaped so registry ids cannot inject controls. */
function decisionModelPin(model: DecisionModelInfo): string {
	return `${escapeTerminal(model.provider)}/${escapeTerminal(model.id)}`;
}

/** Strip the SGR sequences Pi's Theme.fg emits; also used to map rows back. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

interface DecisionModelRow {
	plain: string;
	painted: string;
	model: ListedDecisionModel;
}

/**
 * pi-web-search parity: bare available pin, `· login required` / `· untested`
 * otherwise, current pin accented. Plain text is the mapping key; duplicate
 * plain labels get a positional suffix so a row never maps to another model.
 */
function decisionModelRow(
	model: ListedDecisionModel,
	current: string | undefined,
	theme: Theme | undefined,
	used: Set<string>,
): DecisionModelRow {
	const pin = decisionModelPin(model);
	const isCurrent = current === `${model.provider}/${model.id}`;
	const stateText = model.available === true ? "" : model.available === false ? " · login required" : " · untested";
	const statePainted = stateText === ""
		? ""
		: ` · ${paint(theme, model.available === false ? "warning" : "muted", stateText.slice(3))}`;
	let suffix = "";
	while (used.has(`${isCurrent ? CURRENT_PREFIX : ""}${pin}${stateText}${suffix}`)) {
		suffix = suffix === "" ? " (2)" : ` (${Number(suffix.slice(2, -1)) + 1})`;
	}
	const plain = `${isCurrent ? CURRENT_PREFIX : ""}${pin}${stateText}${suffix}`;
	used.add(plain);
	const painted = `${isCurrent ? `${paint(theme, "accent", "[current]")} ` : ""}${pin}${statePainted}${suffix}`;
	return { plain, painted, model };
}

async function decisionModelPicker(deps: UiDeps, ctx: CommandCtx): Promise<void> {
	if (!requireOperator(ctx)) return;
	// Bind the settings epoch before any async work: a model choice shown for
	// one configuration must never be applied to a newer one.
	const epoch0 = deps.settings.epoch;
	const registry = ctx.modelRegistry;
	if (!registry || typeof registry.getAvailableOfType !== "function") {
		ctx.ui.notify("Automode: model registry unavailable.", "error");
		return;
	}
	const models = await listDecisionModels(registry);
	const current = deps.settings.current;
	const currentPin = current?.decisionModel
		? `${current.decisionModel.provider}/${current.decisionModel.model}`
		: undefined;
	// Available decision models first, current pin at the very top; stable otherwise.
	models.sort((a, b) => Number(b.available === true) - Number(a.available === true));
	const currentIndex = models.findIndex((model) => `${model.provider}/${model.id}` === currentPin);
	if (currentIndex > 0) models.unshift(...models.splice(currentIndex, 1));

	// Positional keys: every row's plain text is unique, so mapping is exact.
	const used = new Set<string>([PICKER_RULES_ONLY]);
	const rows = models.map((model) => decisionModelRow(model, currentPin, themeFor(ctx), used));
	const byLabel = new Map(rows.map((row) => [row.plain, row.model]));
	const options = [PICKER_RULES_ONLY, ...rows.map((row) => row.painted)];
	// Selection grants consent, so show the exact normalized destination before
	// the decision. Never render rejected URLs: they may contain credentials.
	const disclosure = "Selecting a model approves current disclosure: exact bounded bash commands, tool/path metadata and proposed permission patterns may go to this endpoint. File bodies and other argument values never leave. Safe judgments above the configured thresholds may approve unmatched actions. Hard blocks remain final.";
	const items = [
		{ value: PICKER_RULES_ONLY, label: PICKER_RULES_ONLY, description: "Nothing is uploaded." },
		...rows.map((row) => {
			const endpoint = normalizeDisclosureEndpoint(typeof row.model.baseUrl === "string" ? row.model.baseUrl : "");
			return { value: row.plain, label: row.painted, description: `Endpoint: ${endpoint === null ? "invalid endpoint (selection unavailable)" : escapeTerminal(endpoint)}` };
		}),
	];
	let choice: string | undefined;
	try {
		if (ctx.ui.custom) {
			choice = await showModelPicker({ custom: ctx.ui.custom.bind(ctx.ui) }, disclosure, items);
		} else {
			const title = ["Decision Models — active safety review", disclosure,
				...items.slice(1).map((item) => `${item.value} → ${item.description.slice("Endpoint: ".length)}`),
			].join("\n");
			choice = await ctx.ui.select(title, options);
		}
	} catch {
		return;
	}
	if (choice === undefined) return;

	if (!current) {
		ctx.ui.notify("Automode: no valid configuration; fix automode.json first.", "error");
		return;
	}

	// Selecting Rules only is a complete, single-step decision.
	if (choice === PICKER_RULES_ONLY) {
		const next: AutomodeSettings = {
			...current,
			decisionModel: null,
			disclosureConsent: "none",
			disclosureVersion: null,
			disclosureProvider: null,
			disclosureModel: null,
			disclosureEndpoint: null,
			disclosureWorkspace: null,
		};
		if (await saveSettings(deps, ctx, next, epoch0)) ctx.ui.notify("Rules only: nothing is uploaded.", "info");
		return;
	}

	const model = byLabel.get(stripAnsi(choice));
	if (!model) return;

	// Selecting a model IS the disclosure consent; there is no second dialog.
	const endpoint = normalizeDisclosureEndpoint(typeof model.baseUrl === "string" ? model.baseUrl : "");
	if (endpoint === null) {
		ctx.ui.notify("Invalid decision model endpoint (missing or contains credentials/query/fragment). Selection unchanged; nothing saved.", "warning");
		return;
	}
	const next: AutomodeSettings = {
		...current,
		decisionModel: { provider: model.provider, model: model.id },
		disclosureConsent: "approved",
		disclosureVersion: DISCLOSURE_VERSION,
		disclosureProvider: model.provider,
		disclosureModel: model.id,
		disclosureEndpoint: endpoint,
		disclosureWorkspace: deps.dirs.workspace,
	};
	if (!(await saveSettings(deps, ctx, next, epoch0))) return;
	ctx.ui.notify(`Active safety review: ${escapeOneLine(model.provider)}/${escapeOneLine(model.id)}.`, "info");
}
