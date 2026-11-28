import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { readOptionalText, resolveWriteTarget, withFileLock, writeAtomicText } from "./file-write.ts";
import { basename, dirname, join } from "node:path";

/** Retrieval credentials only. Pi owns all classifier authentication. */
export type CredentialProviderId = "exa" | "parallel" | "github" | "brave" | "context7";

/**
 * Environment aliases per credential, highest precedence first. Every nonblank
 * alias beats the current auth.json value, so rotating or removing a stored key
 * is observed by the next operation without reloading the extension.
 */
export const CREDENTIAL_ENV_ALIASES: Record<
	CredentialProviderId,
	readonly string[]
> = {
	exa: ["EXA_API_KEY"],
	parallel: ["PARALLEL_API_KEY"],
	github: ["GITHUB_TOKEN", "GH_TOKEN"],
	brave: ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"],
	context7: ["CONTEXT7_API_KEY"],
};

export const CREDENTIAL_PROVIDER_IDS = Object.keys(
	CREDENTIAL_ENV_ALIASES,
) as CredentialProviderId[];

export type CredentialSource = "env" | "auth" | "gh";

export interface ResolvedCredential {
	key: string;
	source: CredentialSource;
	name: string;
}

export type CredentialReader = (providerId: CredentialProviderId) => unknown;

type StoredCredential = { kind: "missing" | "managed" | "broken" } | { kind: "literal"; key: string };

/** Pi interprets command prefixes and dollar templates, including escape sequences. */
function isPiExpression(value: string) {
	return value.startsWith("!") || /\$(?:[$!]|[A-Za-z_]|\{[A-Za-z_][A-Za-z0-9_]*\})/u.test(value);
}

export function isLiteralApiKey(value: string) {
	return /^[\x21-\x7e]{1,4096}$/u.test(value) && !isPiExpression(value);
}

function classifyStored(entry: unknown): StoredCredential {
	if (entry === undefined) return { kind: "missing" };
	if (!isPlainObject(entry)) return { kind: "broken" };
	if (entry.type === "oauth") return { kind: "managed" };
	if (entry.type === "api_key" && !Object.hasOwn(entry, "key")) return { kind: "missing" };
	const key = trim(entry.key);
	if (entry.type !== "api_key" || key === undefined) return { kind: "broken" };
	if (isPiExpression(key)) return { kind: "managed" };
	return isLiteralApiKey(key) ? { kind: "literal", key } : { kind: "broken" };
}

export interface CredentialResolverOptions {
	/** Env source; defaults to `process.env`. Injected by tests. */
	env?: NodeJS.ProcessEnv;
	/** Fully replaces the stored-credential source. Injected by tests. */
	readCredential?: CredentialReader;
	/** auth.json path; read fresh on each call. Injected by tests. */
	authPath?: string;
	/** Last-resort GitHub CLI token. Injected by tests; never logged. */
	readGhToken?: () => string | undefined;
}

let storedReader: CredentialReader | undefined;
let resolvePiAgentDir: (() => string) | undefined;

export function enablePiAgentDirectory(getAgentDir: () => string): void {
	resolvePiAgentDir = getAgentDir;
}

export function agentDirectory(): string {
	if (resolvePiAgentDir) return resolvePiAgentDir();
	const directory = process.env.PI_CODING_AGENT_DIR;
	if (!directory) return join(homedir(), ".pi", "agent");
	if (directory === "~") return homedir();
	return directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory;
}

/**
 * Read stored credentials from Pi's auth.json. Called once by the extension
 * entrypoint. Until it is called, stored credentials are absent, so a bare
 * import of the tools (or the test suite) never touches the operator's secrets.
 * The reader reads the file on every call: no immortal secret cache.
 */
export function enableStoredCredentials(authPath?: string): void {
	storedReader = readerForPath(authPath ?? join(agentDirectory(), "auth.json"));
}

/** Restores the default "no stored credentials" state. */
export function disableStoredCredentials(): void {
	storedReader = undefined;
}

/**
 * The single credential resolver. It evaluates every nonblank env alias first,
 * then reads the current stored value. Nothing is cached across calls, so a
 * rotated or removed auth.json key takes effect on the next operation.
 */
export function resolveCredential(
	providerId: CredentialProviderId,
	options?: CredentialResolverOptions,
): ResolvedCredential | undefined {
	return credentialState(providerId, options).resolved;
}

/** Retrieval source and stored-entry ownership are independent facts. */
export function credentialState(providerId: CredentialProviderId, options?: CredentialResolverOptions) {
	const env = options?.env ?? process.env;
	const reader = options?.readCredential ??
		(options?.authPath !== undefined ? readerForPath(options.authPath) : storedReader);
	const stored = classifyStored(reader?.(providerId));
	const resolved = (() : ResolvedCredential | undefined => {
		for (const name of CREDENTIAL_ENV_ALIASES[providerId]) {
			const key = trim(env[name]);
			if (key !== undefined) return { key, source: "env", name };
		}
		if (stored.kind === "literal") return { key: stored.key, source: "auth", name: providerId };
		if (providerId === "github") {
			// Explicit test resolvers never spawn gh on the operator's machine.
			const key = trim(options ? options.readGhToken?.() : readGhCliToken());
			if (key !== undefined) return { key, source: "gh", name: "gh auth" };
		}
	})();
	return { resolved, stored: stored.kind, editable: resolved?.source !== "env" && (stored.kind === "literal" || stored.kind === "missing") };
}

export function exaApiKey(
	options?: CredentialResolverOptions,
): string | undefined {
	return resolveCredential("exa", options)?.key;
}

export function braveApiKey(options?: CredentialResolverOptions): string | undefined {
	return resolveCredential("brave", options)?.key;
}

export function context7ApiKey(options?: CredentialResolverOptions): string | undefined {
	return resolveCredential("context7", options)?.key;
}

export function parallelApiKey(
	options?: CredentialResolverOptions,
): string | undefined {
	return resolveCredential("parallel", options)?.key;
}

export function githubToken(
	options?: CredentialResolverOptions,
): string | undefined {
	return resolveCredential("github", options)?.key;
}

/** Always github.com — never the CLI default host, which may be Enterprise. */
export const GH_CLI_TOKEN_ARGS = ["auth", "token", "--hostname", "github.com"] as const;

let ghCliCache: { value: string | undefined; at: number } | undefined;
const GH_CLI_CACHE_MS = 30_000;

/**
 * Uses an already-authenticated github.com CLI login. Disabled under `node:test`
 * so suite machines with `gh auth` do not silently change availability.
 */
export function readGhCliToken(
	spawn: typeof spawnSync = spawnSync,
): string | undefined {
	if (process.env.NODE_TEST_CONTEXT) {
		return undefined;
	}
	const now = Date.now();
	if (ghCliCache && now - ghCliCache.at < GH_CLI_CACHE_MS) {
		return ghCliCache.value;
	}
	try {
		const result = spawn("gh", [...GH_CLI_TOKEN_ARGS], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const value = result.status === 0 && typeof result.stdout === "string"
			? result.stdout
			: undefined;
		ghCliCache = { value, at: now };
		return value;
	} catch {
		ghCliCache = { value: undefined, at: now };
		return undefined;
	}
}

function readerForPath(authPath: string): CredentialReader {
	return (providerId) => {
		try {
			const entries = parseAuthObject(readFileSync(authPath, "utf8"));
			return Object.hasOwn(entries, providerId) ? entries[providerId] : undefined;
		} catch {
			// auth.json is optional and may be malformed; a missing key is absent.
			return undefined;
		}
	};
}

export function defaultAuthPath(): string {
	return join(agentDirectory(), "auth.json");
}

export class CredentialChangedError extends Error {
	constructor() { super("The stored credential changed. Reopen the key editor and try again."); }
}

function entryRevision(entry: unknown): string | null {
	return entry === undefined ? null : createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** Null means no entry; keyless entries with sibling fields still have a revision. */
export function credentialRevision(providerId: CredentialProviderId, authPath = defaultAuthPath()): string | null {
	return entryRevision(readerForPath(authPath)(providerId));
}

/** Merge a literal API key into auth.json. Never logs the key. */
export async function storeApiKey(
	providerId: CredentialProviderId,
	key: string,
	authPath?: string,
	guard?: { expected: string | null; signal: AbortSignal },
): Promise<void> {
	const trimmed = trim(key);
	if (trimmed === undefined || !isLiteralApiKey(trimmed)) {
		throw new Error("Enter a literal API key, not a command or environment reference.");
	}
	await mutateAuth(authPath, (current) => {
		const existing = current[providerId];
		if (guard && entryRevision(existing) !== guard.expected) throw new CredentialChangedError();
		const kind = classifyStored(existing).kind;
		if (kind !== "literal" && kind !== "missing") throw new Error("This credential is broken or managed by Pi.");
		current[providerId] = { ...(isPlainObject(existing) ? existing : {}), type: "api_key", key: trimmed };
		return true;
	}, guard?.signal);
}

function literalRevision(entry: unknown): string | undefined {
	if (classifyStored(entry).kind === "literal") return entryRevision(entry) ?? undefined;
}

/** An opaque revision binds removal confirmation to the saved entry, not the current environment. */
export function apiKeyRevision(providerId: CredentialProviderId, authPath = defaultAuthPath()): string | undefined {
	return literalRevision(readerForPath(authPath)(providerId));
}

/** Remove only the saved key, optionally requiring an exact observed entry revision. */
export async function removeApiKey(providerId: CredentialProviderId, authPath?: string, expected?: string, signal?: AbortSignal): Promise<boolean> {
	return mutateAuth(authPath, (current) => {
		const existing = current[providerId];
		const revision = literalRevision(existing);
		if (!isPlainObject(existing) || !revision || (expected !== undefined && revision !== expected)) return false;
		delete existing.key;
		if (Object.keys(existing).length === 1) delete current[providerId];
		return true;
	}, signal);
}

async function mutateAuth(
	authPath: string | undefined,
	mutate: (current: Record<string, unknown>) => boolean,
	signal?: AbortSignal,
): Promise<boolean> {
	signal?.throwIfAborted();
	const path = authPath ?? defaultAuthPath();
	// Canonicalize the parent but not the basename: Pi locks auth.json.lock next to the supplied path.
	const logical = join(await resolveWriteTarget(dirname(path)), basename(path));
	const target = await resolveWriteTarget(path);
	const [first, second] = [...new Set([logical, target])].sort();
	const assertTarget = async () => {
		if (await resolveWriteTarget(path) !== target) throw new Error("The auth.json link changed. Reopen /web-search before retrying.");
	};
	const save = async (assertHeld: () => Promise<void>) => {
		signal?.throwIfAborted();
		await assertTarget();
		const revision = await readOptionalText(target);
		const current = parseAuthObject(revision);
		const write = mutate(current);
		if (write) {
			await writeAtomicText(target, `${JSON.stringify(current, null, 2)}\n`, async () => {
				await assertHeld();
				await assertTarget();
				if (await readOptionalText(target) !== revision) throw new Error("auth.json changed during the save. Reopen /web-search before retrying.");
				signal?.throwIfAborted();
			});
		}
		return write;
	};
	const stale = 30_000; // Match Pi's async auth backend.
	return withFileLock(first, (assertFirst) => second
		? withFileLock(second, (assertSecond) => save(async () => { await assertFirst(); await assertSecond(); }), stale)
		: save(assertFirst), stale);
}

function parseAuthObject(raw: string | undefined): Record<string, unknown> {
	if (raw === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
		if (!isPlainObject(parsed)) {
			throw new Error("auth.json is not a JSON object. It was not changed.");
		}
		return parsed;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("auth.json is malformed. It was not changed.", { cause: error });
		}
		throw error;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trim(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
