import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Provenance = "draft" | "final";

export function checkPath(path: string): string {
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error("Benchmark artifact must not be a symlink: " + path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return path;
}

export function claimOutput(path: string, provenance: Provenance): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const root = realpathSync(path);
	const marker = checkPath(join(root, ".benchmark-provenance"));
	const entries = readdirSync(root);
	if (!entries.includes(".benchmark-provenance")) {
		if (entries.length) throw new Error("Benchmark output has no provenance. Use a fresh output directory.");
		writeFileSync(marker, provenance + "\n", { flag: "wx", mode: 0o600 });
	}
	if (readFileSync(marker, "utf8").trim() !== provenance) {
		throw new Error("Benchmark output provenance differs. Use separate draft and final directories.");
	}
	return root;
}

export function cassettePath(path: string): string {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return checkPath(join(realpathSync(directory), basename(path)));
}

export function approvedInput(path: string, provenance: Provenance): string {
	if (provenance === "draft") return path;
	if (/(?:^|[\\/])[^\\/]*draft[^\\/]*(?:[\\/]|$)/iu.test(path) ||
		/(?:^|[\\/])[^\\/]*draft[^\\/]*(?:[\\/]|$)/iu.test(realpathSync(path))) {
		throw new Error("Use --draft with draft inputs");
	}
	return path;
}
