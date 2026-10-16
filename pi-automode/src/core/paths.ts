import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Pi's `resolveToCwd` (dist/core/tools/path-utils.js) rewrites model-supplied
 * paths before touching the filesystem: unicode spaces become plain spaces,
 * one leading `@` is stripped, `~`/`~/` expand to the home directory, and
 * `file://` URLs are decoded. The runtime owns replicating that translation
 * and feeding the *normalized* absolute path to the core. When a raw path
 * that still carries any of these spellings reaches the core unnormalized,
 * the core must fail closed (evidence incomplete -> Ask), never silently
 * floor-Allow the literal path.
 *
 * These patterns replicate Pi's `normalizePath` (dist/utils/paths.js) exactly:
 * same unicode-space class, same single-`@` strip, same tilde and `file://`
 * handling (case-sensitive `file://`, matching Pi).
 */
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

/**
 * Return why `raw` would be rewritten by Pi's path normalization, or null
 * when Pi would treat the bytes literally. Any non-null result means the
 * runtime skipped its translation step; callers must not classify the raw
 * spelling as the real target.
 */
export function piPathExpansionRisk(raw: string): string | null {
  if (PI_UNICODE_SPACES.test(raw)) {
    return "unicode space characters that Pi normalizes to plain spaces";
  }
  if (raw.startsWith("@")) {
    return "a leading '@' that Pi strips before resolving";
  }
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    return "a leading '~' that Pi expands to the home directory";
  }
  if (/^file:\/\//.test(raw)) {
    return "a file:// URL that Pi decodes to an absolute path";
  }
  return null;
}

/** True when `child` is `parent` itself or contained inside it. Both absolute. */
export function isWithinOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Canonicalize an absolute path even when it (or some ancestors) does not
 * exist yet: realpath the nearest existing ancestor and re-append the missing
 * remainder lexically. This keeps symlink targets decisive for not-yet-created
 * descendants. Throws on errors other than ENOENT (e.g. EACCES), and on
 * ENOTDIR/ELOOP-style failures, so callers can mark evidence incomplete.
 */
export async function realpathNearest(absPath: string): Promise<string> {
  let current = path.resolve(absPath);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      let result = real;
      for (let i = missing.length - 1; i >= 0; i -= 1) {
        result = path.join(result, missing[i] as string);
      }
      return result;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) throw err;
        missing.push(path.basename(current));
        current = parent;
        continue;
      }
      throw err;
    }
  }
}
