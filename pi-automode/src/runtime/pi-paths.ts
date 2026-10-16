import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Exact replica of Pi 1.1.0 path resolution for native file tools
 * (dist/utils/paths.js normalizePath/resolvePath as used by
 * dist/core/tools/path-utils.js resolveToCwd): unicode-space normalization,
 * single leading "@" strip, "~" expansion (on by default, also for the base
 * directory), file:// URL decoding, then cwd resolution.
 *
 * Core deliberately does not import Pi, so this adapter lives in the runtime
 * layer: while On, the gate translates the raw model-issued path to the exact
 * absolute path Pi's helper would resolve, feeds THAT path to evidence and to
 * the stock execute, and blocks rather than allowing any post-review fallback
 * (read's AM/PM, NFD and curly-quote variants) to redirect to a file that was
 * never reviewed. Off is untouched: wrappers delegate the raw args.
 */

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Mirror of Pi's normalizeWindowsShellPath (inert off win32). */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const drive = match[1];
	if (drive === undefined) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${drive.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Mirror of Pi's normalizePath. Tilde expansion defaults to ON in Pi. */
function normalizePathPi(input: string, home: string, unicodeSpaces: boolean, stripAt: boolean): string {
	let normalized = input;
	if (unicodeSpaces) normalized = normalized.replace(UNICODE_SPACES, " ");
	if (stripAt && normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(home, normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
	return normalized;
}

/**
 * Resolve `input` exactly as Pi's resolveToCwd would. Throws when the
 * file:// form is undecodable — callers fail closed.
 */
export function resolveToCwdEquivalent(input: string, cwd: string, homeDir?: string): string {
	const home = homeDir ?? homedir();
	const normalized = normalizePathPi(input, home, true, true);
	const normalizedBase = normalizePathPi(cwd, home, false, false);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizedBase, normalized);
}

export type EffectiveArgs =
	| { ok: true; args: Record<string, unknown>; translated: boolean; resolvedPath?: string }
	| { ok: false; reason: string };

/**
 * Translate a path-bearing tool's frozen args to the exact absolute target
 * Pi's helper would resolve, so review and execution see the same bytes.
 * bash and non-path tools pass through untouched.
 *
 * The helper re-normalizes whatever path it receives (unicode-space
 * normalization applies to the input; the cwd/home base can expand too), so
 * the reviewed target must be STABLE under a second normalization pass. The
 * translation iterates to a fixpoint (bounded); a path that never stabilizes
 * fails closed instead of letting the helper retarget it after review.
 */
export function effectiveToolArgs(
	tool: string,
	frozenArgs: Record<string, unknown>,
	cwd: string,
	homeDir?: string,
): EffectiveArgs {
	if (tool !== "read" && tool !== "edit" && tool !== "write") {
		return { ok: true, args: frozenArgs, translated: false };
	}
	const raw = frozenArgs.path;
	if (typeof raw !== "string") {
		// validateToolArgs already rejects this; stay defensive.
		return { ok: false, reason: `${tool}: "path" must be a string` };
	}
	let resolvedPath: string;
	try {
		resolvedPath = resolveToCwdEquivalent(raw, cwd, homeDir);
		// Fixpoint: the helper will run the SAME normalization again on our
		// resolved path. If that changes the target, the not-yet-normalized
		// form is what the helper would actually use — review THAT, and keep
		// iterating until the bytes are stable (or fail closed).
		for (let pass = 0; pass < 3; pass += 1) {
			const again = resolveToCwdEquivalent(resolvedPath, cwd, homeDir);
			if (again === resolvedPath) break;
			resolvedPath = again;
			if (pass === 2) {
				return {
					ok: false,
					reason: `${tool}: path does not stabilize under Pi's normalization; refusing to review a moving target`,
				};
			}
		}
	} catch (error) {
		return {
			ok: false,
			reason: `${tool}: path cannot be resolved with Pi semantics (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	if (resolvedPath === raw) {
		return { ok: true, args: frozenArgs, translated: false, resolvedPath };
	}
	return {
		ok: true,
		args: Object.freeze({ ...frozenArgs, path: resolvedPath }),
		translated: true,
		resolvedPath,
	};
}
