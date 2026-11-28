import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { resolve, win32 } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, isKeyRepeat, matchesKey, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { apiKeyRevision, CREDENTIAL_PROVIDER_IDS, CredentialChangedError, credentialRevision, isLiteralApiKey, resolveCredential, removeApiKey, storeApiKey, type CredentialProviderId } from "../env.ts";
import { applyConfig, applyConfigFix, configureJudgment, resolveSettings, saveSearchSetting } from "../providers/config.ts";
import { FileLockBusyError } from "../file-write.ts";
import { PROVIDER_KINDS, providerFamily, type ProviderFamily, type ProviderKind } from "../providers/types.ts";
import { accountState, checkApiKey, PROVIDER_AUTH, providerReady } from "./accounts.ts";
import { listSupportedClassifiers, type ListedClassifier } from "./classifiers.ts";
import { selectPinnedClassifier } from "../classifier/api.ts";
import { awaitWithSignal, withTimeout } from "../providers/http.ts";
import { PICKER_OVERLAY } from "./frame.ts";
import { providerName } from "./provider-names.ts";
import { renderPanel, type Message } from "./panel-view.ts";

export const SEARCH_ROWS = ["web", "fallback", "code", "thorough", "results"] as const;
export const PANEL_ROWS = [...SEARCH_ROWS, ...CREDENTIAL_PROVIDER_IDS, "classifier"] as const;
export type PanelRow = (typeof PANEL_ROWS)[number];
export type PanelContext = Pick<ExtensionContext, "ui" | "modelRegistry" | "signal"> & { signal?: AbortSignal };
type PanelKeys = Pick<KeybindingsManager, "matches" | "getKeys">;
const providersFor = (family: ProviderFamily) => PROVIDER_KINDS.filter((id) => providerFamily(id) === family);
const choices = { web: providersFor("web"), code: providersFor("code") };
export const isAccount = (row: string): row is CredentialProviderId => CREDENTIAL_PROVIDER_IDS.some((id) => id === row);
const SAVED: Message = { tone: "success", text: "✓ Saved — applies to the next search" };

type Editor = { kind: "key"; value: string; revision: string | null; controller: AbortController; pending?: boolean }
	| { kind: "check"; controller: AbortController };

export type PanelOption = {
	id: string;
	label: string;
	provider?: ProviderKind;
	current?: boolean;
	hint?: Message;
	run: () => void | Promise<void>;
};

type Action = { key: string; label: string; matches: (data: string) => boolean; run: (data: string) => void | Promise<void> };

export class WebSearchPanel implements Component, Focusable {
	focused = false;
	selected: PanelRow;
	right = false;
	editor?: Editor;
	private choice?: string;
	private codeBackups = false;
	private removal?: { provider: CredentialProviderId; revision: string };
	private restoreEditor?: (cancel?: boolean) => void;
	private classifier?: { controller: AbortController; models?: ListedClassifier[]; load?: Promise<void> };
	private classifierCheck?: AbortController;
	private readonly lifetime = new AbortController();
	private checkedPin?: string;
	classifierAvailable?: boolean;
	message?: Message;
	busy = false;
	private closed = false;

	private current: Awaited<ReturnType<typeof resolveSettings>>;
	private tui: Pick<TUI, "terminal" | "requestRender" | "stop" | "start">;
	private theme: () => Theme;
	readonly keys: PanelKeys;
	private ctx: PanelContext;
	private done: () => void;
	private check: typeof checkApiKey;

	constructor(
		current: Awaited<ReturnType<typeof resolveSettings>>,
		focus: PanelRow,
		tui: WebSearchPanel["tui"],
		theme: () => Theme,
		keys: PanelKeys,
		ctx: PanelContext,
		done: () => void,
		check = checkApiKey,
	) {
		this.current = current; this.tui = tui; this.theme = theme; this.keys = keys;
		this.ctx = ctx; this.done = done; this.check = check;
		this.selected = focus;
		this.focusIssue();
		this.syncClassifierOptions();
		this.refreshClassifier();
	}

	get error() { return "error" in this.current ? this.current.error : undefined; }
	get settings() { return "error" in this.current ? applyConfig(this.current.error.configPath, {}) : this.current; }
	get pin() {
		const { enabled, provider, model } = this.settings.classifier;
		return enabled && provider && model ? `${provider}/${model}` : undefined;
	}
	get login() {
		if (!this.pin) return;
		const provider = this.settings.classifier.provider;
		if (this.ctx.modelRegistry?.getProviderAuthStatus?.(provider)?.configured === false) return provider;
	}
	get classifierLoading() { return this.classifier !== undefined && this.classifier.models === undefined; }
	get editorCommand() { return process.env.VISUAL?.trim() || process.env.EDITOR?.trim(); }
	get removing() { return this.removal?.provider === this.selected; }
	get checkingKey() { return this.editor?.kind === "check" || this.editor?.kind === "key" && this.editor.pending; }
	get backupFamily() { return this.selected === "fallback" ? "web" : this.selected === "code" && this.codeBackups ? "code" : undefined; }

	private fallbackChoices(family: ProviderFamily) {
		const chain = this.settings[family];
		return [...new Set<ProviderKind>([...chain.fallback, ...choices[family]])].filter((id) => id !== chain.provider);
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort();
		this.classifier?.controller.abort();
		this.restoreEditor?.(true);
		this.classifierCheck?.abort();
		this.closeEditor();
		this.done();
	}

	private closeEditor() {
		this.editor?.controller.abort();
		this.editor = undefined;
		this.removal = undefined;
		this.message = undefined;
	}

	private focusIssue() {
		const issue = this.error?.issue;
		const path = issue?.propertyPath;
		const field = path?.length === 1 ? issue?.fix?.to ?? path[0] : path?.[0];
		if (field === "maxResults") this.selected = "results";
		else if (field === "research") this.selected = "thorough";
		else if (field === "classifier") this.selected = "classifier";
		else if (field === "web" && (issue?.fix?.to ?? path?.[1]) === "fallback") this.selected = "fallback";
		else if (field === "web" || field === "code") this.selected = field;
	}

	private async save(write: () => Promise<unknown>, failure: string, message = SAVED) {
		this.busy = true;
		this.message = undefined;
		try {
			if (await write() !== false && !this.closed) this.message = message;
		} catch (error) {
			if (!this.closed) this.message = { tone: "error", text: `✕ ${error instanceof FileLockBusyError || error instanceof CredentialChangedError ? error.message : failure}` };
		} finally {
			if (!this.closed) {
				this.current = await resolveSettings();
				this.syncClassifierOptions();
				this.refreshClassifier();
			}
			this.busy = false;
		}
	}

	private keyInput(data: string, editor: Extract<Editor, { kind: "key" }>) {
		if (editor.pending) return;
		if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
			editor.value = (editor.value + data.slice(6, -6).trim()).slice(0, 4097);
		} else if (matchesKey(data, "backspace")) editor.value = editor.value.slice(0, -1);
		else if (matchesKey(data, "ctrl+u")) editor.value = "";
		else {
			const xterm = /^\x1b\[27;[12];(\d{2,3})~$/u.exec(data);
			const input = decodeKittyPrintable(data) ?? (xterm ? String.fromCharCode(Number(xterm[1])) : data);
			if (/^[\x20-\x7e]+$/u.test(input)) editor.value = (editor.value + input).slice(0, 4097);
		}
	}

	private async submitKey(id: CredentialProviderId, editor: Extract<Editor, { kind: "key" }>) {
		const key = editor.value.trim();
		if (!isLiteralApiKey(key)) {
			this.message = { tone: "error", text: "✕ Paste a literal API key, not a command or environment reference." };
			return;
		}
		editor.value = "";
		editor.pending = true;
		this.message = undefined;
		this.tui.requestRender();
		const status = await this.check(id, key, editor.controller.signal).catch(() => "offline" as const);
		if (this.editor !== editor || editor.controller.signal.aborted) return;
		editor.pending = false;
		if (status === "rejected") {
			this.message = { tone: "error", text: `✕ ${providerName[id]} rejected this key` };
			return;
		}
		this.editor = undefined;
		const state = accountState(id);
		if (!state.editable && state.source !== "env") {
			this.message = { tone: "warning", text: "▲ This credential is broken or managed by Pi." };
			return;
		}
		if (state.source === "env") {
			this.message = { tone: "warning", text: "▲ A shell key is set. Unset it to save a key." };
			return;
		}
		await this.save(() => storeApiKey(id, key, undefined, { expected: editor.revision, signal: this.lifetime.signal }), "Couldn't save the key. Check auth.json and permissions.",
			status === "offline" ? { tone: "warning", text: "▲ Saved, couldn't check — offline?" }
				: id === "parallel" ? { tone: "success", text: "✓ Parallel connected — higher limits on" } : { tone: "success", text: "✓ Saved and verified" });
	}

	/** The same selectable options drive the right pane and its input. */
	options(): PanelOption[] {
		const { selected: row, settings, editor } = this;
		const writeFailed = "Couldn't save. Check web-search.json and permissions.";
		if (editor?.kind === "key" || editor?.kind === "check") return [];
		const backup = this.backupFamily;
		if (backup || row === "web" || row === "code") {
			const family = backup ?? (row === "code" ? "code" : "web");
			const chain = settings[family];
			const ids = (backup ? this.fallbackChoices(family) : choices[family]).filter((id) => id !== "searxng" || settings.searxng);
			const options: PanelOption[] = (["keyless", "required"] as const).flatMap((auth) => ids.filter((id) => PROVIDER_AUTH[id] === auth).map((id) => {
				const index = chain.fallback.indexOf(id);
				return { id, provider: id, label: backup ? `${index < 0 ? "–" : index + 1}  ${providerName[id]}` : providerName[id],
					current: !backup && chain.provider === id,
					run: () => backup ? this.changeFallback(backup, id, 0)
						: chain.provider !== id ? this.save(() => saveSearchSetting({ kind: "promote", family, provider: id }), writeFailed) : undefined };
			}));
			if (row === "code") options.push({ id: "backups", label: backup ? "Choose primary" : "Edit backups", run: () => {
				this.codeBackups = !backup;
				this.choice = undefined;
				this.message = undefined;
			} });
			return options;
		}
		if (row === "thorough") return [true, false].map((value) => ({
			id: String(value), label: value ? "On" : "Off", current: settings.researchEnabled === value,
			run: () => settings.researchEnabled !== value ? this.save(() => saveSearchSetting({ kind: "set", field: "research", value }), writeFailed) : undefined,
		}));
		if (row === "results") return Array.from({ length: 20 }, (_, i) => ({
			id: String(i + 1), label: String(i + 1), current: settings.maxResults === i + 1,
			run: () => settings.maxResults !== i + 1 ? this.save(() => saveSearchSetting({ kind: "set", field: "maxResults", value: i + 1 }), writeFailed) : undefined,
		}));
		if (isAccount(row)) {
			const state = accountState(row);
			if (!state.editable) return [];
			return [{ id: "key", label: state.stored === "literal" ? "Replace key" : "Add key", run: () => {
				this.editor = { kind: "key", value: "", revision: credentialRevision(row), controller: new AbortController() };
				this.message = undefined;
			} }, ...(state.stored === "literal" || this.removing ? [{ id: "remove", label: this.removing ? "Confirm removal" : "Remove key", run: () => this.removeKey(row) }] : []),
			...(state.source === "auth" ? [{ id: "check", label: "Check key", run: () => this.checkSavedKey(row) }] : [])];
		}
		const models = this.classifier?.models;
		if (!models) return [];
		const options: PanelOption[] = [{ id: "none", label: "None", current: !this.pin, run: () => this.save(() => configureJudgment("off"), writeFailed) },
			...models.map((model) => {
				const id = `${model.provider}/${model.id}`;
				const hint: Message | undefined = model.available === false ? { tone: "warning", text: "▲ unavailable" }
					: model.available === undefined ? { tone: "dim", text: "untested" } : undefined;
				return { id, label: id, current: this.pin === id, hint, run: () => this.save(() => configureJudgment(model), writeFailed) };
			})];
		if (!settings.researchEnabled && this.pin) options.push({
			id: "multi-source", label: "▲ Turn on Multi-source to use it", run: () => {
				this.leaveRight();
				this.selectRow("thorough");
				this.right = true;
				this.choice = "true";
			},
		});
		return options;
	}

	selectedOption(options: PanelOption[]) {
		return options.find((option) => option.id === this.choice) ?? options.find((option) => option.current) ?? options[0];
	}

	private leaveRight() {
		this.closeEditor();
		this.right = false;
	}

	private selectRow(row: PanelRow) {
		this.closeEditor();
		this.selected = row;
		this.choice = undefined;
		this.codeBackups = false;
		this.syncClassifierOptions();
	}

	private async removeKey(row: CredentialProviderId) {
		const pending = this.removal;
		this.removal = undefined;
		if (pending?.provider === row) {
			await this.save(async () => {
				if (!await removeApiKey(row, undefined, pending.revision, this.lifetime.signal)) throw new Error("The saved key changed.");
			}, "Couldn't remove the key. Check whether it changed or auth.json is writable.", { tone: "success", text: "✓ Removed" });
			return;
		}
		const revision = apiKeyRevision(row);
		if (revision) this.removal = { provider: row, revision };
		this.message = undefined;
	}

	private async checkSavedKey(id: CredentialProviderId) {
		const revision = apiKeyRevision(id);
		const credential = resolveCredential(id);
		if (!revision || credential?.source !== "auth") return;
		const editor: Editor = { kind: "check", controller: new AbortController() };
		this.editor = editor;
		this.message = undefined;
		this.tui.requestRender();
		const result = await this.check(id, credential.key, editor.controller.signal).catch(() => "offline" as const);
		if (this.editor !== editor || editor.controller.signal.aborted) return;
		this.editor = undefined;
		this.message = apiKeyRevision(id) !== revision || accountState(id).source !== "auth" ? { tone: "warning", text: "▲ The saved key changed. Check again." }
			: result === "accepted" ? { tone: "success", text: "✓ Key verified" }
			: result === "rejected" ? { tone: "error", text: `✕ ${providerName[id]} rejected this key` }
				: { tone: "warning", text: "▲ Couldn't check — offline?" };
	}

	/** One action table drives both input dispatch and the footer. */
	actions(): Action[] {
		const row = this.selected;
		const editor = this.editor;
		const make = (key: string, label: string, matches: Action["matches"], run: Action["run"]): Action => ({ key, label, matches, run });
		const bound = (data: string, action: "up" | "down" | "confirm" | "cancel") => this.keys.matches(data, `tui.select.${action}`);
		const keyLabel = (action: "up" | "down" | "confirm" | "cancel", fallback: string) => this.keys.getKeys(`tui.select.${action}`)
			.filter((key) => key !== "ctrl+c").map((key) => ({ escape: "Esc", enter: "Enter", up: "↑", down: "↓" })[key as string] ?? key).join("/") || fallback;
		const cancel = (data: string) => matchesKey(data, "escape") || bound(data, "cancel");
		const confirm = (data: string) => matchesKey(data, "enter") || bound(data, "confirm");
		const move = (run: (step: number) => void) => make(keyLabel("up", "↑") + keyLabel("down", "↓"), "Move",
			(data) => bound(data, "up") || bound(data, "down"), (data) => run(bound(data, "up") ? -1 : 1));
		const close = make(keyLabel("cancel", "Esc"), "Close", cancel, () => this.finish());
		const back = make("←", "Back", (data) => matchesKey(data, "left") || cancel(data), () => this.leaveRight());
		if ((editor?.kind === "key" || editor?.kind === "check") && isAccount(row)) {
			const cancelEdit = make("Esc", "Back", (data) => matchesKey(data, "escape"), () => this.closeEditor());
			return editor.kind === "check" || editor.pending ? [cancelEdit]
				: [make("Enter", "Check & save", (data) => matchesKey(data, "enter"), () => this.submitKey(row, editor)), cancelEdit];
		}
		const error = this.error;
		if (error) {
			const fix = error.issue?.fix;
			return [...(fix ? [make(keyLabel("confirm", "Enter"), "Apply fix", confirm, () => this.save(() => applyConfigFix(error.configPath, fix), "Couldn't apply the fix. Check the file and permissions."))] : []),
				make("O", "Open file", (data) => letter(data, "o"), () => this.openFile(error.configPath, error.issue?.line)), close];
		}
		if (!this.right) return [move((step) => {
			this.selectRow(PANEL_ROWS[cycle(PANEL_ROWS.indexOf(row), step, PANEL_ROWS.length)]);
		}), make("→", "Open", (data) => matchesKey(data, "right") || confirm(data), () => {
			this.right = true;
			this.message = undefined;
			if (row === "classifier") return this.classifier?.load;
		}), close];

		const options = this.options();
		const active = this.selectedOption(options);
		if (!active) return [back];
		const backup = this.backupFamily;
		const provider = active.provider;
		const fallback = backup ? [...new Set(this.settings[backup].fallback.filter((id) => id !== this.settings[backup].provider))] : [];
		const index = provider ? fallback.indexOf(provider) : -1;
		const reorderUp = index > 0, reorderDown = index >= 0 && index < fallback.length - 1;
		return [
			...(options.length > 1 ? [move((step) => {
				this.removal = undefined;
				this.message = undefined;
				this.choice = options[cycle(options.indexOf(active), step, options.length)].id;
			})] : []),
			make(backup ? "Space" : keyLabel("confirm", "Enter"), this.removing ? "Confirm" : backup && provider
				? this.settings[backup].fallback.includes(provider) ? "Remove" : "Include" : "Choose", (data) => confirm(data) || matchesKey(data, "space"), () => {
				this.choice = active.id;
				return active.run();
			}),
			...(backup && provider && (reorderUp || reorderDown) ? [make(`Shift ${reorderUp ? "↑" : ""}${reorderDown ? "↓" : ""}`, "Reorder",
				(data) => reorderUp && matchesKey(data, "shift+up") || reorderDown && matchesKey(data, "shift+down"),
				(data) => this.changeFallback(backup, provider, matchesKey(data, "shift+up") ? -1 : 1))] : []),
			...(provider && isAccount(provider) && !providerReady(provider) ? [make("A", "Accounts", (data) => letter(data, "a"), () => {
				this.leaveRight();
				this.selectRow(provider);
				this.right = true;
			})] : []),
			back,
		];
	}

	async handleInput(data: string): Promise<void> {
		if (this.closed || isKeyRelease(data)) return;
		// Held keys repeat only inside the key editor; repeated commands stay blocked.
		const repeat = isKeyRepeat(data);
		if (repeat && this.editor?.kind !== "key") return;
		if (!repeat && matchesKey(data, "ctrl+c")) { this.finish(); return; }
		if (this.busy) return;
		const editor = this.editor;
		try {
			const action = this.actions().find((candidate) => candidate.matches(data));
			if (action) { if (!repeat) await action.run(data); }
			else if (editor?.kind === "key") this.keyInput(data, editor);
			else if (this.removing) this.removal = undefined;
		} catch {
			if (!editor || this.editor === editor) this.message = { tone: "error", text: "✕ Couldn't update search settings. Reopen /web-search and try again." };
		} finally { if (!this.closed) this.tui.requestRender(); }
	}

	private refreshClassifier() {
		const pin = this.pin;
		if (this.closed || pin === this.checkedPin) return;
		this.checkedPin = pin;
		this.classifierAvailable = undefined;
		this.classifierCheck?.abort();
		const registry = this.ctx.modelRegistry;
		if (!pin || !registry) return;
		const { provider, model } = this.settings.classifier;
		const controller = new AbortController();
		this.classifierCheck = controller;
		const deadline = withTimeout(controller.signal, 3_000);
		void awaitWithSignal(selectPinnedClassifier(registry, provider, model, deadline.signal), deadline.signal)
			.then((found) => {
				if (controller.signal.aborted) return;
				this.classifierAvailable = !!found;
				this.tui.requestRender();
			}, () => {}).finally(deadline.dispose);
	}

	private syncClassifierOptions() {
		if (this.selected !== "classifier" || this.error) {
			this.classifier?.controller.abort();
			this.classifier = undefined;
			return;
		}
		if (this.classifier) return;
		const classifier: NonNullable<WebSearchPanel["classifier"]> = { controller: new AbortController() };
		this.classifier = classifier;
		classifier.load = listSupportedClassifiers(this.ctx.modelRegistry, classifier.controller.signal).catch((): ListedClassifier[] => []).then((models) => {
			if (classifier.controller.signal.aborted) return;
			if (this.pin && !models.some((model) => `${model.provider}/${model.id}` === this.pin)) {
				models.unshift({ provider: this.settings.classifier.provider, id: this.settings.classifier.model });
			}
			classifier.models = models.sort((a, b) => Number(b.available === true) - Number(a.available === true));
			this.tui.requestRender();
		});
	}

	private changeFallback(family: ProviderFamily, provider: ProviderKind, delta: -1 | 0 | 1) {
		const kind = this.settings[family].fallback.includes(provider) ? "remove" : "include";
		return this.save(() => saveSearchSetting(delta ? { kind: "reorder", family, provider, delta } : { kind, family, provider }),
			"Couldn't save. Check web-search.json and permissions.");
	}

	private async openFile(path: string, line?: number) {
		const invocation = editorInvocation(this.editorCommand, path, line);
		if (!invocation) {
			this.message = { tone: "error", text: "✕ Couldn't read EDITOR. Check the command and its quotes." };
			return;
		}
		this.busy = true;
		try {
			this.tui.stop();
			let child: ChildProcess | undefined;
			this.restoreEditor = (cancel) => {
				this.restoreEditor = undefined;
				try { if (cancel) child?.kill("SIGKILL"); }
				finally { this.tui.start(); this.tui.requestRender(true); }
			};
			try {
				const [command, ...args] = invocation;
				child = spawn(command, args, { stdio: "inherit" });
				const [code] = await once(child, "exit");
				if (code !== 0) throw new Error("Editor exited unsuccessfully.");
			} catch {
				if (!this.closed) this.message = { tone: "error", text: `✕ Couldn't open ${path}. Set EDITOR, then try again.` };
			} finally { this.restoreEditor?.(); }
			if (this.closed) return;
			this.current = await resolveSettings();
			this.focusIssue();
			this.syncClassifierOptions();
			this.refreshClassifier();
		} finally { this.busy = false; }
	}

	render(width: number): string[] { return renderPanel(this, this.theme(), width, this.tui.terminal.rows); }
	invalidate() {}
}

/** Split a quoted editor command into arguments without invoking a shell. */
export function editorInvocation(configured: string | undefined, path: string, line?: number, platform = process.platform) {
	const windows = platform === "win32";
	const command = configured?.trim() || (windows ? "notepad.exe" : "vi");
	const pattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/gu;
	// Unmatched quotes are not silently accepted as separators.
	if (command.replace(pattern, "").trim()) return;
	const [executable, ...args] = [...command.matchAll(pattern)].map(([word]) =>
		word.replace(/"([^"]*)"|'([^']*)'/gu, (_, double, single) => double ?? single));
	if (!executable) return;
	const name = win32.basename(executable).replace(/\.exe$/iu, "");
	if (line && /^(?:vi|vim|nvim|nano|emacs|micro)$/iu.test(name)) args.push(`+${line}`);
	return [executable, ...args, windows ? win32.resolve(path) : resolve(path)];
}

const letter = (data: string, key: "o" | "a") => matchesKey(data, key) || matchesKey(data, `shift+${key}`);
const cycle = (index: number, step: number, total: number) => (index + step + total) % total;

export async function openWebSearchPanel(ctx: PanelContext, focus: PanelRow) {
	const resolved = await resolveSettings();
	if (ctx.signal?.aborted) return;
	let panel: WebSearchPanel | undefined;
	const close = () => panel?.finish();
	ctx.signal?.addEventListener("abort", close, { once: true });
	try {
		await ctx.ui.custom<void>((tui, _theme, keys, done) => {
			panel = new WebSearchPanel(resolved, focus, tui, () => ctx.ui.theme, keys, ctx, done);
			if (ctx.signal?.aborted) panel.finish();
			return panel;
		}, PICKER_OVERLAY);
	} finally { ctx.signal?.removeEventListener("abort", close); }
}
