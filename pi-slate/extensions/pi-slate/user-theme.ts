import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allSlateThemes, slateTheme, USER_THEME_PREFIX, type SlateThemeJson } from "./themes.ts";

function themesDirectory(directory?: string): string {
  return directory ?? join(getAgentDir(), "themes");
}

function themeDocument(value: unknown): SlateThemeJson | undefined {
  if (!value || typeof value !== "object") return undefined;
  const doc = value as SlateThemeJson;
  if (typeof doc.name !== "string" || !doc.vars || !doc.colors || !doc.export) return undefined;
  return doc;
}

function writeFallback(directory: string, path: string, theme: SlateThemeJson): void {
  const fallback = { ...theme, name: `${USER_THEME_PREFIX}${theme.name}` };
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * Keep a fallback copy of a shipped theme at `themes/<name>.json`.
 * The file name stays the selected theme so it still loads after pi-slate is
 * removed. The internal name is `slate-<name>`, so Pi keeps the bundled theme
 * authoritative while both are installed.
 * Our own `slate-<name>` copy is refreshed when the bundle changes. A same-name
 * document (the earlier un-namespaced copy) is migrated in place. Any other
 * file is the user's and is left untouched. Returns false when the file cannot
 * be read or written, or when `name` is not a shipped theme.
 */
export function ensureUserTheme(name: string | undefined, directory = themesDirectory()): boolean {
  const theme = slateTheme(name);
  if (!theme) return false;
  const path = join(directory, `${theme.name}.json`);
  const fallback = { ...theme, name: `${USER_THEME_PREFIX}${theme.name}` };
  try {
    if (existsSync(path)) {
      const existing = themeDocument(JSON.parse(readFileSync(path, "utf8")));
      const ours = existing?.name === fallback.name;
      const stock = existing?.name === theme.name;
      if (ours && isDeepStrictEqual(existing, fallback)) return true;
      if (!ours && !stock) return true;
    }
    writeFallback(directory, path, theme);
    return true;
  } catch {
    return false;
  }
}

/** Migrate same-name copies already on disk, including themes that are not selected. */
export function migrateUserThemeCopies(directory = themesDirectory()): void {
  for (const theme of allSlateThemes()) {
    if (existsSync(join(directory, `${theme.name}.json`))) ensureUserTheme(theme.name, directory);
  }
}

/** Session start: migrate old copies, then make sure the active theme has a fallback. */
export function installUserThemes(name: string | undefined, directory = themesDirectory()): boolean {
  migrateUserThemeCopies(directory);
  return !slateTheme(name) || ensureUserTheme(name, directory);
}
