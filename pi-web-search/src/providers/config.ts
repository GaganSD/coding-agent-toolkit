import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { errorCode, readOptionalText, resolveWriteTarget, withFileLock, writeAtomicText } from "../file-write.ts";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	PROVIDER_KINDS,
	type ProviderError,
	type ProviderFamily,
	providerError,
	type ProviderKind,
	providerFamily,
} from "./types.ts";

export const DEFAULT_PROVIDER: ProviderKind = "exa";
export const DEFAULT_FALLBACK: ProviderKind[] = ["parallel"];
export const DEFAULT_CODE_PROVIDER: ProviderKind = "grep";
export const DEFAULT_CODE_FALLBACK: ProviderKind[] = ["sourcegraph", "github"];
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_RESULTS = 8;

export interface FamilyChain {
	provider: ProviderKind;
	fallback: ProviderKind[];
}
export const MIN_MAX_RESULTS = 1;
export const MAX_MAX_RESULTS = 20;
/**
 * Hard cap on the model-facing query. The keyless Exa MCP `objective` embeds the
 * query behind a short prefix and the server rejects objectives above 4096
 * characters, so the query itself must stay comfortably below that.
 */
export const MAX_QUERY_CHARS = 4000;

export const CONFIG_FILE_NAME = "web-search.json";
export const CONFIG_PATH_ENV_VAR = "PI_WEB_SEARCH_CONFIG";

export interface ClassifierSettings {
	enabled: boolean;
	/** Exact Pi classifier provider. Empty when unpinned. */
	provider: string;
	/** Exact Pi classifier model id. Empty when unpinned. */
	model: string;
	/** Weights for the ranking bools. Policy stays in code, tunable here. */
	weights: { answers: number; offtopic: number; selfcontained: number };
	/** Suppress unsafe categories at or above this probability; uncertainty is retained. */
	safetyThreshold: number;
	/** Skip augmentation when the judged set would exceed this many characters. */
	maxStateChars: number;
}

export interface ResolvedSettings {
	timeoutMs: number;
	maxResults: number;
	configPath: string;
	web: FamilyChain;
	code: FamilyChain;
	researchEnabled: boolean;
	classifier: ClassifierSettings;
	/** Non-fatal config problems, surfaced to the model as warnings. */
	notices: string[];
}

/** `invalid_config` never throws raw; it is surfaced through tool details. */
export interface InvalidConfigError extends ProviderError {
	code: "invalid_config";
	configPath: string;
	issue?: ConfigIssue;
}

export interface ConfigIssue {
	summary: string;
	line?: number;
	field?: string;
	propertyPath?: string[];
	fix?: { from: string; to: string; preview: string; revision: string };
}

export interface WebSearchConfig {
	timeoutMs?: number;
	maxResults?: number;
	web?: Partial<FamilyChain>;
	code?: Partial<FamilyChain>;
	research?: { enabled?: boolean };
	classifier?: Partial<Omit<ClassifierSettings, "weights">> & {
		weights?: Partial<ClassifierSettings["weights"]>;
	};
}

export interface AvailableClassifier {
	provider: string;
	id: string;
}

export type JudgmentAction = "on" | "off" | AvailableClassifier;

export type WebSearchConfigResult =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: InvalidConfigError }
	| { status: "ok"; path: string; config: WebSearchConfig };

const PROVIDER_KIND_SET = new Set<string>(PROVIDER_KINDS);
const CONFIG_KEYS = new Set(["web", "code", "research", "classifier", "timeoutMs", "maxResults"]);

export const DEFAULT_CLASSIFIER_SETTINGS: ClassifierSettings = {
	enabled: false,
	provider: "vercel-ai-gateway",
	model: "typesafe-ai/jev",
	weights: { answers: 0.45, offtopic: -0.3, selfcontained: 0.25 },
	safetyThreshold: 0.75,
	maxStateChars: 24000,
};

const CLASSIFIER_CONFIG_KEYS = new Set([
	"enabled", "provider", "model", "weights", "safetyThreshold", "maxStateChars",
]);

export function defaultWebSearchConfigPath(): string {
	const override = process.env[CONFIG_PATH_ENV_VAR];
	if (override && override.length > 0) {
		return override;
	}
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

export async function readWebSearchConfig(
	path?: string,
): Promise<WebSearchConfigResult> {
	const configPath = path ?? defaultWebSearchConfigPath();
	try {
		const raw = await readOptionalText(configPath);
		return raw === undefined ? { status: "missing", path: configPath } : parseWebSearchConfigRaw(raw, configPath);
	} catch (error) {
		return { status: "invalid", path: configPath,
			error: invalidConfig(configPath, `Could not read ${configPath}: ${errorMessage(error)}`) };
	}
}

export function readWebSearchConfigSync(path?: string): WebSearchConfigResult {
	const configPath = path ?? defaultWebSearchConfigPath();
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (error) {
		return readFailure(configPath, error);
	}
	return parseWebSearchConfigRaw(raw, configPath);
}

function readFailure(
	configPath: string,
	error: unknown,
): WebSearchConfigResult {
	if (errorCode(error) === "ENOENT") {
		return { status: "missing", path: configPath };
	}
	return {
		status: "invalid",
		path: configPath,
		error: invalidConfig(
			configPath,
			`Could not read ${configPath}: ${errorMessage(error)}`,
		),
	};
}

function parseWebSearchConfigRaw(
	raw: string,
	configPath: string,
): WebSearchConfigResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = errorMessage(error);
		const location = /\bat position (\d+)(?: \(line (\d+) column \d+\))?$/u.exec(message);
		const line = location ? Number(location[2]) || lineAt(raw, Number(location[1])) : undefined;
		const failure = invalidConfig(configPath, `${configPath} is not valid JSON: ${message}`);
		failure.issue = { line, summary: line === undefined ? "invalid JSON" : `invalid JSON (line ${line})` };
		return { status: "invalid", path: configPath, error: failure };
	}
	return parseWebSearchConfig(parsed, configPath, raw);
}

/**
 * The single parser: parsed JSON in, a validated config out. The readers and
 * writers agree on which settings are valid.
 */
export function parseWebSearchConfig(parsed: unknown, configPath: string, raw?: string): WebSearchConfigResult {
	const fail = (message: string, path: string[] = [], unknown?: { allowed: ReadonlySet<string>; object: Record<string, unknown> }): WebSearchConfigResult => {
		const error = invalidConfig(configPath, message);
		if (raw !== undefined) error.issue = describeIssue(raw, configPath, path, unknown);
		return { status: "invalid", path: configPath, error };
	};
	if (!isPlainObject(parsed)) return fail(`${configPath} must contain a JSON object.`);

	const config: WebSearchConfig = {};
	const unknown = unknownKeys(parsed, CONFIG_KEYS);
	if (unknown.length) return fail(`Unsupported configuration keys: ${unknown.join(", ")}. Use web/code provider chains and research.enabled.`,
		[unknown[0]], { allowed: CONFIG_KEYS, object: parsed });

	for (const key of ["timeoutMs", "maxResults"] as const) {
		if (!(key in parsed)) continue;
		const value = parsed[key];
		if (typeof value !== "number" || !Number.isFinite(value)) return fail(`"${key}" must be a finite number.`, [key]);
		config[key] = value;
	}

	for (const key of ["web", "code"] as const) {
		if (!(key in parsed)) continue;
		const block = parsed[key];
		const message = `"${key}" must contain only a valid provider and/or fallback array: ${quotedList(PROVIDER_KINDS)}.`;
		if (!isPlainObject(block)) return fail(message, [key]);
		const allowed = new Set(["provider", "fallback"]);
		const [extra] = unknownKeys(block, allowed);
		if (extra !== undefined) return fail(message, [key, extra], { allowed, object: block });
		if ("provider" in block && (typeof block.provider !== "string" || !PROVIDER_KIND_SET.has(block.provider))) return fail(message, [key, "provider"]);
		if ("fallback" in block && (!Array.isArray(block.fallback) || !isProviderKindList(block.fallback))) return fail(message, [key, "fallback"]);
		config[key] = block as Partial<FamilyChain>;
	}

	if ("research" in parsed) {
		const research = parsed.research;
		const message = '"research" must be an object with an optional boolean "enabled".';
		if (!isPlainObject(research)) return fail(message, ["research"]);
		const allowed = new Set(["enabled"]);
		const [extra] = unknownKeys(research, allowed);
		if (extra !== undefined) return fail(message, ["research", extra], { allowed, object: research });
		if ("enabled" in research && typeof research.enabled !== "boolean") return fail(message, ["research", "enabled"]);
		config.research = research;
	}

	if ("classifier" in parsed) {
		const classifier = parsed.classifier;
		if (!isPlainObject(classifier)) return fail('"classifier" must be an object.', ["classifier"]);
		const extras = unknownKeys(classifier, CLASSIFIER_CONFIG_KEYS);
		if (extras.length) return fail(`Unsupported classifier keys: ${extras.join(", ")}.`, ["classifier", extras[0]], { allowed: CLASSIFIER_CONFIG_KEYS, object: classifier });
		if ("weights" in classifier) {
			const weights = classifier.weights;
			const message = '"classifier.weights" must contain only answers, offtopic, and selfcontained.';
			if (!isPlainObject(weights)) return fail(message, ["classifier", "weights"]);
			const allowed = new Set(Object.keys(DEFAULT_CLASSIFIER_SETTINGS.weights));
			const [extra] = unknownKeys(weights, allowed);
			if (extra !== undefined) return fail(message, ["classifier", "weights", extra], { allowed, object: weights });
		}
		config.classifier = classifier as WebSearchConfig["classifier"];
	}
	return { status: "ok", path: configPath, config };
}

function unknownKeys(object: Record<string, unknown>, allowed: ReadonlySet<string>) {
	return Object.keys(object).filter((key) => !allowed.has(key));
}

/** Explicit setup command: preserve settings, write no keys, refuse malformed config. */
export async function configureJudgment(
	action: JudgmentAction,
	available: readonly AvailableClassifier[] | (() => Promise<readonly AvailableClassifier[]>) = [],
): Promise<{ path: string; note?: string }> {
	const path = defaultWebSearchConfigPath();
	let note: string | undefined;
	let candidates: readonly AvailableClassifier[] = typeof available === "function" ? [] : available;
	if (action === "on" && typeof available === "function") {
		const current = await readWebSearchConfig(path);
		if (current.status === "invalid") throw current.error;
		if (current.status !== "ok" || !pinnedClassifier(current.config.classifier)) candidates = await available();
	}

	await updateConfig((config) => {
		if (action === "off") {
			config.classifier = { ...config.classifier, enabled: false };
		} else if (action === "on") {
			config.research = { ...config.research, enabled: true };
			if (pinnedClassifier(config.classifier)) {
				config.classifier = { ...config.classifier, enabled: true };
			} else {
				const preferred = candidates.find((entry) => entry.provider === DEFAULT_CLASSIFIER_SETTINGS.provider && entry.id === DEFAULT_CLASSIFIER_SETTINGS.model)
					?? candidates.find((entry) => /(?:^|\/)~?(?:typesafe(?:-ai)?\/)?jev(?:-|$)/.test(entry.id));
				const selected = preferred ?? (candidates.length === 1 ? candidates[0] : undefined)
					?? { provider: DEFAULT_CLASSIFIER_SETTINGS.provider, id: DEFAULT_CLASSIFIER_SETTINGS.model };
				config.classifier = { ...config.classifier, enabled: true, provider: selected.provider, model: selected.id };
				if (!candidates.some((entry) => entry.provider === selected.provider && entry.id === selected.id)) {
					note = `Default Jev selected; authenticate with /login ${selected.provider} before using judgment.`;
				}
			}
		} else {
			config.research = { ...config.research, enabled: true };
			config.classifier = { ...config.classifier, enabled: true, provider: action.provider, model: action.id };
		}
	}, path);
	return { path, note };
}

export type SearchSettingEdit =
	| { kind: "set"; field: "research"; value: boolean }
	| { kind: "set"; field: "maxResults"; value: number }
	| { kind: "promote" | "include" | "remove"; family: ProviderFamily; provider: ProviderKind }
	| { kind: "reorder"; family: ProviderFamily; provider: ProviderKind; delta: -1 | 1 };

/** Apply only the requested edit to the latest configuration under the lock. */
export async function saveSearchSetting(edit: SearchSettingEdit): Promise<boolean> {
	return updateConfig((config) => {
		if (edit.kind === "set") {
			if (edit.field === "research") config.research = { ...config.research, enabled: edit.value };
			else config.maxResults = clampMaxResults(edit.value);
			return;
		}
		const { family, provider } = edit;
		if (providerFamily(provider) !== family) throw new Error("Provider is not in this search family.");
		const chain = resolveFamilyChain(family, config, []);
		if (provider === chain.provider) return false;
		const fallback = [...new Set(chain.fallback.filter((id) => id !== chain.provider))];
		const index = fallback.indexOf(provider);
		if (edit.kind === "promote") {
			if (index >= 0) fallback[index] = chain.provider;
			config[family] = { provider, fallback };
			return;
		}
		if (edit.kind === "include" && index < 0) fallback.push(provider);
		else if (edit.kind === "remove" && index >= 0) fallback.splice(index, 1);
		else if (edit.kind === "reorder" && index >= 0 && fallback[index + edit.delta]) {
			[fallback[index], fallback[index + edit.delta]] = [fallback[index + edit.delta], fallback[index]];
		} else return false;
		config[family] = { ...config[family], fallback };
	});
}

function updateConfig(mutate: (config: WebSearchConfig) => void | false, path = defaultWebSearchConfigPath()) {
	return transactConfig(path, (raw) => {
		const current = raw === undefined ? undefined : parseWebSearchConfigRaw(raw, path);
		if (current?.status === "invalid") throw current.error;
		const config = current?.status === "ok" ? current.config : {};
		if (mutate(config) === false) return;
		const validated = parseWebSearchConfig(config, path);
		if (validated.status === "invalid") throw validated.error;
		return `${JSON.stringify(config, null, 2)}\n`;
	});
}

async function transactConfig(path: string, next: (raw: string | undefined) => string | undefined) {
	const target = await resolveWriteTarget(path);
	return withFileLock(target, async (assertHeld) => {
		const raw = await readOptionalText(target);
		const updated = next(raw);
		if (updated === undefined || updated === raw) return false;
		await writeAtomicText(target, updated, async () => {
			if (await resolveWriteTarget(path) !== target || await readOptionalText(target) !== raw) {
				throw new Error("Search settings changed. Reopen /web-search before retrying.");
			}
			await assertHeld();
		});
		return true;
	});
}

const lineAt = (raw: string, position: number) => raw.slice(0, position).split(/\r\n|\r|\n/u).length;

/** Locate the property token at an exact object path in valid JSON. */
function propertyTokens(raw: string, target: readonly string[]) {
	const matches: RegExpMatchArray[] = [];
	const stack: string[][] = [];
	let pending: string[] | undefined;
	for (const token of raw.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?|[{}[\]]/gu)) {
		const text = token[0];
		if (text === "{" || text === "[") {
			stack.push(pending ?? (stack.length ? [...stack.at(-1)!, ""] : []));
			pending = undefined;
		} else if (text === "}" || text === "]") {
			stack.pop();
			pending = undefined;
		} else if (token[1]) {
			pending = [...stack.at(-1)!, JSON.parse(text.slice(0, -token[1].length)) as string];
			if (pending.length === target.length && pending.every((key, i) => key === target[i])) matches.push(token);
		} else pending = undefined;
	}
	return matches;
}

function replaceKey(raw: string, token: RegExpMatchArray, key: string) {
	return raw.slice(0, token.index) + JSON.stringify(key) + token[1] + raw.slice(token.index! + token[0].length);
}

function nearMatch(from: string, to: string) {
	if (from.toLowerCase() === to.toLowerCase()) return true;
	if (Math.abs(from.length - to.length) > 1) return false;
	const i = [...from].findIndex((char, index) => char !== to[index]);
	const diff = i < 0 ? Math.min(from.length, to.length) : i;
	if (from.length !== to.length) {
		const bigger = from.length > to.length ? from : to;
		return bigger.slice(0, diff) + bigger.slice(diff + 1) === (bigger === from ? to : from);
	}
	return from.slice(diff + 1) === to.slice(diff + 1) ||
		from[diff] === to[diff + 1] && from[diff + 1] === to[diff] && from.slice(diff + 2) === to.slice(diff + 2);
}

function describeIssue(raw: string, file: string, path: string[], unknown?: { allowed: ReadonlySet<string>; object: Record<string, unknown> }): ConfigIssue {
	const field = path.length ? path.join(".") : undefined;
	const tokens = field ? propertyTokens(raw, path) : [];
	const line = tokens[0] ? lineAt(raw, tokens[0].index!) : undefined;
	const summary = field ? `${unknown ? "unknown" : "invalid"} setting ${JSON.stringify(field)}` : "could not read settings";
	const issue: ConfigIssue = { field, propertyPath: path, line, summary: summary + (line ? ` (line ${line})` : "") };
	if (unknown && tokens.length === 1) {
		const from = path.at(-1)!;
		const candidates = [...unknown.allowed].filter((key) => !Object.hasOwn(unknown.object, key) && nearMatch(from, key));
		const [to] = candidates;
		if (candidates.length === 1 && parseWebSearchConfig(JSON.parse(replaceKey(raw, tokens[0], to)), file).status === "ok") {
			const value = unknown.object[from];
			const safeEnum = (path[0] === "web" || path[0] === "code") && to === "provider" && typeof value === "string" && PROVIDER_KIND_SET.has(value);
			const safeFlag = to === "enabled" && ["research", "classifier"].includes(path[0]) && typeof value === "boolean";
			const safeLimit = path.length === 1 && (to === "maxResults" || to === "timeoutMs") && typeof value === "number";
			const preview = safeFlag || safeLimit || safeEnum ? JSON.stringify(value) : "<hidden>";
			issue.fix = { from, to, preview, revision: createHash("sha256").update(raw).digest("hex") };
		}
	}
	return issue;
}

/** Confirmed repair changes the one property token, not the rest of the file. */
export async function applyConfigFix(path: string, expected: NonNullable<ConfigIssue["fix"]>): Promise<void> {
	await transactConfig(path, (raw) => {
		const current = raw === undefined ? undefined : parseWebSearchConfigRaw(raw, path);
		const issue = current?.status === "invalid" ? current.error.issue : undefined;
		const fix = issue?.fix;
		if (raw === undefined || !fix || !issue?.propertyPath || fix.revision !== expected.revision || fix.from !== expected.from || fix.to !== expected.to) {
			throw new Error("Search settings changed. Reopen /web-search before applying a fix.");
		}
		const [token] = propertyTokens(raw, issue.propertyPath);
		return replaceKey(raw, token, fix.to);
	});
}

export function parseJudgmentArgs(args: string): JudgmentAction | "status" | undefined {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return "status";
	}
	if (trimmed === "on" || trimmed === "off") {
		return trimmed;
	}
	const parts = trimmed.split(/\s+/);
	if (parts.length === 2 && parts[0] && parts[1]) {
		return { provider: parts[0], id: parts[1] };
	}
	const slash = trimmed.indexOf("/");
	if (slash > 0 && slash < trimmed.length - 1) {
		return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
	}
	return undefined;
}

function pinnedClassifier(
	classifier: WebSearchConfig["classifier"],
): { provider: string; model: string } | undefined {
	const provider = typeof classifier?.provider === "string" ? classifier.provider.trim() : "";
	const model = typeof classifier?.model === "string" ? classifier.model.trim() : "";
	return provider.length > 0 && model.length > 0 ? { provider, model } : undefined;
}

export async function resolveSettings(
	path?: string,
): Promise<ResolvedSettings | { error: InvalidConfigError }> {
	const result = await readWebSearchConfig(path);
	if (result.status === "invalid") {
		return { error: result.error };
	}
	return applyConfig(result.path, result.status === "ok" ? result.config : {});
}

export function resolveSettingsSync(
	path?: string,
): ResolvedSettings | { error: InvalidConfigError } {
	const result = readWebSearchConfigSync(path);
	if (result.status === "invalid") {
		return { error: result.error };
	}
	return applyConfig(result.path, result.status === "ok" ? result.config : {});
}

export function applyConfig(
	configPath: string,
	config: WebSearchConfig,
): ResolvedSettings {
	const notices: string[] = [];
	const web = resolveFamilyChain("web", config, notices);
	const code = resolveFamilyChain("code", config, notices);

	return {
		timeoutMs: normalizeTimeoutMs(config.timeoutMs),
		maxResults: clampMaxResults(config.maxResults ?? DEFAULT_MAX_RESULTS),
		configPath,
		web,
		code,
		researchEnabled: config.research?.enabled === true,
		classifier: applyClassifierConfig(config.classifier, notices),
		notices,
	};
}

function resolveFamilyChain(
	family: ProviderFamily,
	config: WebSearchConfig,
	notices: string[],
): FamilyChain {
	const defaults: FamilyChain = family === "web"
		? { provider: DEFAULT_PROVIDER, fallback: [...DEFAULT_FALLBACK] }
		: { provider: DEFAULT_CODE_PROVIDER, fallback: [...DEFAULT_CODE_FALLBACK] };
	const scoped = family === "web" ? config.web : config.code;
	let provider = scoped?.provider ?? defaults.provider;
	let fallback = scoped?.fallback ?? defaults.fallback;

	if (providerFamily(provider) !== family) {
		notices.push(`Ignored ${family}.provider "${provider}": wrong family.`);
		provider = defaults.provider;
	}
	fallback = fallback.filter((kind) => {
		if (providerFamily(kind) === family) {
			return true;
		}
		notices.push(`Ignored ${family} fallback "${kind}": it answers ${providerFamily(kind)} questions.`);
		return false;
	});
	return { provider, fallback };
}

function applyClassifierConfig(
	classifier: WebSearchConfig["classifier"],
	notices: string[],
): ClassifierSettings {
	if (!isPlainObject(classifier)) {
		return { ...DEFAULT_CLASSIFIER_SETTINGS };
	}
	const numeric = (key: keyof ClassifierSettings, fallback: number): number => {
		const value = classifier[key];
		if (value === undefined) {
			return fallback;
		}
		if (typeof value !== "number" || !Number.isFinite(value)) {
			notices.push(`Ignored classifier.${key}: not a finite number.`);
			return fallback;
		}
		return value;
	};
	const model = classifier.model;
	if (model !== undefined && typeof model !== "string") {
		notices.push("Ignored classifier.model: expected a string.");
	}
	const provider = classifier.provider;
	if (provider !== undefined && typeof provider !== "string") {
		notices.push("Ignored classifier.provider: expected a string.");
	}
	// A missing pair uses Jev; a partial/invalid explicit pin never substitutes.
	const useDefault = provider === undefined && model === undefined;
	const pinnedProvider = useDefault ? DEFAULT_CLASSIFIER_SETTINGS.provider : typeof provider === "string" ? provider.trim() : "";
	const pinnedModel = useDefault ? DEFAULT_CLASSIFIER_SETTINGS.model : typeof model === "string" ? model.trim() : "";
	if (classifier.enabled === true && (pinnedProvider.length === 0 || pinnedModel.length === 0)) {
		notices.push("classifier.enabled without provider/model: judgment stays unpinned until set.");
	}
	return {
		enabled: classifier.enabled === true,
		provider: pinnedProvider,
		model: pinnedModel,
		weights: {
			answers: numericWeight(classifier, "answers", notices),
			offtopic: numericWeight(classifier, "offtopic", notices),
			selfcontained: numericWeight(classifier, "selfcontained", notices),
		},
		safetyThreshold: numeric("safetyThreshold", DEFAULT_CLASSIFIER_SETTINGS.safetyThreshold),
		maxStateChars: numeric("maxStateChars", DEFAULT_CLASSIFIER_SETTINGS.maxStateChars),
	};
}

function numericWeight(
	classifier: NonNullable<WebSearchConfig["classifier"]>,
	key: keyof ClassifierSettings["weights"],
	notices: string[],
): number {
	const value = classifier.weights?.[key];
	if (value === undefined) {
		return DEFAULT_CLASSIFIER_SETTINGS.weights[key];
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		notices.push(`Ignored classifier.weights.${key}: not a finite number.`);
		return DEFAULT_CLASSIFIER_SETTINGS.weights[key];
	}
	return value;
}

function quotedList(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(" | ");
}

export const MIN_TIMEOUT_MS = 1000;

export function normalizeTimeoutMs(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.max(MIN_TIMEOUT_MS, Math.trunc(value));
}

export function clampMaxResults(value: number): number {
	return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.trunc(value)));
}

function invalidConfig(
	configPath: string,
	message: string,
): InvalidConfigError {
	const error = providerError("invalid_config", message) as InvalidConfigError;
	error.configPath = configPath;
	return error;
}

function isProviderKindList(value: unknown[]): boolean {
	return value.every(
		(entry) => typeof entry === "string" && PROVIDER_KIND_SET.has(entry),
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
