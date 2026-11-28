import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readlink, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;

export async function readOptionalText(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf-8"); }
	catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
}

export async function resolveWriteTarget(path: string): Promise<string> {
	let target = resolve(path);
	for (let links = 0; links < 40; links++) {
		try { return await realpath(target); }
		catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
		// realpath cannot resolve a dangling link; preserve it when creating its target.
		try { target = resolve(dirname(target), await readlink(target)); }
		catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "EINVAL") {
				const parent = dirname(target);
				return parent === target ? target : join(await resolveWriteTarget(parent), basename(target));
			}
			throw error;
		}
	}
	throw new Error("Too many symbolic links.");
}

export class FileLockBusyError extends Error {
	constructor(path: string) {
		super(`Settings file is locked: ${path}. Retry after the other writer finishes or its lock expires.`);
	}
}

export async function withFileLock<T>(path: string, run: (assertHeld: () => Promise<void>) => Promise<T>, stale = 5_000): Promise<T> {
	const target = resolve(path);
	const lock = `${target}.lock`;
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	let compromised: Error | undefined;
	const release = await lockfile.lock(target, {
		realpath: false, stale, update: 2_000,
		retries: { retries: 40, factor: 1, minTimeout: 150, maxTimeout: 150 },
		onCompromised: (error) => { compromised = error; },
	}).catch((error: unknown) => {
		if (errorCode(error) === "ELOCKED") throw new FileLockBusyError(lock);
		throw error;
	});
	const owner = await stat(lock);
	const held = async () => {
		const current = await stat(lock).catch(() => undefined);
		return !compromised && current?.ino === owner.ino && current.dev === owner.dev && current.birthtimeMs === owner.birthtimeMs;
	};
	try {
		return await run(async () => { if (!await held()) throw new FileLockBusyError(lock); });
	} finally {
		if (await held()) await release();
	}
}

export async function writeAtomicText(target: string, text: string, beforeRename?: () => Promise<void>): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		try { await file.writeFile(text); }
		finally { await file.close(); }
		await beforeRename?.();
		await rename(temporary, target);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
