import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configureJudgment, parseJudgmentArgs, resolveSettings, type JudgmentAction } from "./providers/config.ts";
import { PROVIDER_KINDS, type ProviderKind } from "./providers/types.ts";
import { accountsSummary, providerHelp } from "./ui/accounts.ts";
import { availableClassifiers, ClassifierDiscoveryError } from "./ui/classifiers.ts";
import { CREDENTIAL_PROVIDER_IDS, type CredentialProviderId } from "./env.ts";
import type { PanelRow } from "./ui/panel.ts";
import { providerName } from "./ui/provider-names.ts";

export { availableClassifiers, ClassifierDiscoveryError, listSupportedClassifiers } from "./ui/classifiers.ts";

export const WEB_SEARCH_USAGE =
	"Usage: /web-search [status|provider [name]|classifier [none|provider/model]]. Keys are never accepted as arguments.";


export const WEB_SEARCH_COMMAND = "web-search";

export type WebSearchAction =
	| { kind: "menu" }
	| { kind: "status" }
	| { kind: "provider"; id?: ProviderKind }
	| { kind: "classifier"; action: JudgmentAction | "pick" }
	| { kind: "usage" };

const PROVIDER_KIND_SET = new Set<string>(PROVIDER_KINDS);

export function parseWebSearchArgs(args: string): WebSearchAction {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { kind: "menu" };
	}
	const parts = trimmed.split(/\s+/);
	const [head, ...rest] = parts;
	if (head === "status") {
		return { kind: "status" };
	}
	if (head === "provider") {
		if (rest.length === 0) {
			return { kind: "provider" };
		}
		const id = rest[0];
		if (!id || !PROVIDER_KIND_SET.has(id)) {
			return { kind: "usage" };
		}
		if (rest.length === 1) {
			return { kind: "provider", id: id as ProviderKind };
		}
		return { kind: "usage" };
	}
	if (head === "classifier") {
		if (rest.length === 0) {
			return { kind: "classifier", action: "pick" };
		}
		if (rest.length === 1 && rest[0] === "none") {
			return { kind: "classifier", action: "off" };
		}
		const pin = parseJudgmentArgs(rest.join(" "));
		if (pin && pin !== "status" && pin !== "on" && pin !== "off") {
			return { kind: "classifier", action: pin };
		}
		return { kind: "usage" };
	}
	if (trimmed === "on" || trimmed === "off") {
		return { kind: "classifier", action: trimmed };
	}
	return { kind: "usage" };
}

export function webSearchCompletions(prefix: string): { value: string; label: string }[] {
	const trimmed = prefix.trimStart();
	const parts = trimmed.length === 0 ? [""] : trimmed.split(/\s+/);
	const completing = prefix.endsWith(" ") ? "" : (parts.at(-1) ?? "");
	const head = prefix.endsWith(" ") ? (parts[0] ?? "") : (parts.length > 1 ? parts[0] : "");
	if (head === "provider") {
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		return tokens.length === 1 || (tokens.length === 2 && !prefix.endsWith(" "))
			? filterCompletions([...PROVIDER_KINDS], completing)
			: [];
	}
	if (head === "classifier") {
		return filterCompletions(["none"], completing);
	}
	if (parts.length <= 1 && !prefix.endsWith(" ")) {
		return filterCompletions(
			["status", "provider", "classifier", "on", "off"],
			completing,
		);
	}
	return [];
}

function filterCompletions(values: readonly string[], prefix: string) {
	return values
		.filter((value) => value.startsWith(prefix))
		.map((value) => ({ value, label: value }));
}

type CommandContext = Pick<ExtensionCommandContext, "mode" | "hasUI" | "ui" | "modelRegistry" | "signal">;

export async function handleWebSearchCommand(
	args: string,
	ctx: CommandContext,
	pi: Pick<ExtensionAPI, "sendMessage">,
	panel = { first: true },
): Promise<void> {
	const parsed = parseWebSearchArgs(args);
	const interactive = ctx.mode === "tui" && ctx.hasUI;
	let report: string;
	let tone: "info" | "error" | "warning" = "info";
	try {
		if (parsed.kind === "usage") report = WEB_SEARCH_USAGE;
		else if (parsed.kind === "status") report = await buildSettingsReport();
		else if (parsed.kind === "classifier" && parsed.action !== "pick") {
			await configureJudgment(parsed.action, () => availableClassifiers(ctx.modelRegistry, ctx.signal));
			const saved = await resolveSettings();
			const classifier = "error" in saved ? undefined : saved.classifier;
			const pin = classifier?.enabled && classifier.provider && classifier.model ? classifier : undefined;
			const needsLogin = pin && ctx.modelRegistry?.getProviderAuthStatus?.(pin.provider)?.configured === false;
			const off = pin && !("error" in saved) && !saved.researchEnabled;
			report = "✓ Saved — applies to the next search"
				+ (off ? "\n▲ Turn on Multi-source to use it" : "")
				+ (needsLogin ? `\n▲ Run /login ${pin.provider} to use this` : "");
			if (off || needsLogin) tone = "warning";
		} else if (interactive) {
			let focus: PanelRow = "web";
			if (parsed.kind === "provider") focus = parsed.id ? CREDENTIAL_PROVIDER_IDS.includes(parsed.id as CredentialProviderId) ? parsed.id as CredentialProviderId : "code" : "exa";
			else if (parsed.kind === "classifier") focus = "classifier";
			else if (panel.first) { panel.first = false; focus = "exa"; }
			const { openWebSearchPanel } = await import("./ui/panel.ts");
			await openWebSearchPanel(ctx, focus);
			return;
		} else if (parsed.kind === "provider" && parsed.id && !providerHelp[parsed.id].keyUrl) {
			report = `${providerName[parsed.id]} works without a key.`;
		} else report = await buildSettingsReport();
	} catch (error) {
		tone = "error";
		const config = await resolveSettings();
		report = error instanceof ClassifierDiscoveryError ? `✕ ${error.message}`
			: "error" in config ? configError(config.error)
			: "✕ Couldn't update search settings. Check web-search.json and permissions.";
	}
	if (interactive) ctx.ui.notify(report, tone);
	else pi.sendMessage({ customType: WEB_SEARCH_COMMAND, content: report, display: true });
}

function configError(error: { configPath: string; issue?: { summary: string } }) {
	return `✕ ${error.configPath}: ${error.issue?.summary ?? "couldn't read settings"}. Open /web-search in the terminal UI to fix it.`;
}

export async function buildSettingsReport(): Promise<string> {
	const config = await resolveSettings();
	if ("error" in config) return `Web search\n${configError(config.error)}`;
	const route = ({ provider, fallback }: { provider: ProviderKind; fallback: ProviderKind[] }) =>
		[...new Set([provider, ...fallback])].map((kind) => providerName[kind]).join(" → ");
	const { enabled, provider, model } = config.classifier;
	return [
		"Web search",
		`Web     ${providerName[config.web.provider]}`,
		`Backup  ${config.web.fallback.filter((id) => id !== config.web.provider).map((id) => providerName[id]).join(" → ") || "None"}`,
		`Code    ${route(config.code)}`,
		`Multi-source  ${config.researchEnabled ? "On" : "Off"}     Classifier  ${enabled && provider && model ? `${provider}/${model}` : "None"}`,
		"",
		accountsSummary(),
		"Open /web-search in the terminal UI to change these.",
	].join("\n");
}
