import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultWebSearchConfigPath } from "./providers/config.ts";

export function welcomeStatePath(configPath = defaultWebSearchConfigPath()): string {
	// An override can name the config itself after the usual sidecar.
	return basename(configPath).toLowerCase() === "web-search-welcome.json"
		? `${configPath}.welcome.json`
		: join(dirname(configPath), "web-search-welcome.json");
}

export async function hasSeenWelcome(path = welcomeStatePath()): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
		return typeof parsed === "object" && parsed !== null && (parsed as { seen?: unknown }).seen === true;
	} catch {
		return false;
	}
}

export async function markWelcomeSeen(path = welcomeStatePath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	try {
		// Advisory state must never truncate an existing file or follow a symlink.
		await writeFile(path, `${JSON.stringify({ seen: true }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export async function maybeShowWelcome(ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI || await hasSeenWelcome()) return;
	// Pi renders info notifications as a dim status line above the editor.
	ctx.ui.notify("web search ready · no keys needed · /web-search to customise", "info");
	await markWelcomeSeen().catch(() => {});
}
