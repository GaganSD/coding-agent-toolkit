import path from "node:path";

/** All paths in this context must already be canonicalized (realpathNearest). */
export interface ProtectionContext {
  workspace: string;
  agentDir: string;
  extensionDir: string;
  homeDir: string;
}

export interface PathClassification {
  protectedReason?: string;
  sensitive: boolean;
}

/** `.env`, `.env.local`, `.env.production`, ... (name floor, not a complete secret detector). */
const ENV_FILE = /^\.env(\..+)?$/;
/** Common private-key file names. */
const KEY_FILE = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|id_xmss)$/;
const KEY_MATERIAL_EXT = /\.(pem|key|p12|pfx)$/;
const CI_FILES = new Set([".gitlab-ci.yml", "jenkinsfile"]);

function segments(p: string): string[] {
  return p.split(path.sep).filter((s) => s.length > 0);
}

/**
 * Conservative fold for protected-name comparisons: Unicode NFD (so NFC and
 * NFD spellings of the same name compare equal) plus lowercasing. This exists
 * for case-insensitive/normalizing filesystems (default APFS, SMB), where a
 * *new* file written as `.ENV` or `.GIT/hooks/x` IS `.env` / `.git/hooks/x`
 * on disk and there is no existing realpath to recover the true case.
 *
 * Folding is applied ONLY to protected-name and protected-ancestor
 * comparisons. Generic workspace containment (the allow floor) stays
 * byte-exact and case-sensitive: on a case-sensitive Linux filesystem,
 * folding containment would treat `WS/secret` as inside `ws/` and allow a
 * path that is actually outside — an escape. Over-matching here only ever
 * makes a target more protected (Ask/Block), never less.
 */
function foldName(s: string): string {
  return s.normalize("NFD").toLowerCase();
}

function foldSegments(p: string): string[] {
  return segments(p).map(foldName);
}

/** Case/NFD-insensitive containment used ONLY for protected roots. */
function isWithinOrEqualFolded(parent: string, child: string): boolean {
  const p = foldSegments(parent);
  const c = foldSegments(child);
  if (c.length < p.length) return false;
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] !== c[i]) return false;
  }
  return true;
}

/**
 * Classify one absolute path. Lexical protected names and canonical/symlink
 * targets are both checked by the caller; this inspects a single path.
 */
function classifyOne(absPath: string, ctx: ProtectionContext): PathClassification {
  const folded = foldSegments(absPath);
  const base = folded[folded.length - 1] ?? "";

  // Control plane: agent directory (contains credentials) and Automode's own code.
  if (isWithinOrEqualFolded(ctx.agentDir, absPath)) {
    return { protectedReason: "pi-agent-directory", sensitive: true };
  }
  if (isWithinOrEqualFolded(ctx.extensionDir, absPath)) {
    return { protectedReason: "automode-extension-code", sensitive: false };
  }
  // Project control plane: <workspace>/.pi/ (lexical; also covers not-yet-created descendants).
  if (isWithinOrEqualFolded(path.join(ctx.workspace, ".pi"), absPath)) {
    return { protectedReason: "project-pi-directory", sensitive: true };
  }
  // Key stores.
  if (isWithinOrEqualFolded(path.join(ctx.homeDir, ".ssh"), absPath)) {
    return { protectedReason: "ssh-key-store", sensitive: true };
  }
  if (isWithinOrEqualFolded(path.join(ctx.homeDir, ".gnupg"), absPath)) {
    return { protectedReason: "gnupg-key-store", sensitive: true };
  }
  // Execution/security configuration, matched by path segment so nested
  // repositories and worktrees are covered, not only the workspace root.
  for (let i = 0; i < folded.length; i += 1) {
    if (folded[i] === ".git") {
      const next = folded[i + 1];
      if (next === "hooks") return { protectedReason: "git-hooks", sensitive: false };
      if ((next === "config" || next === "config.worktree") && i + 2 === folded.length) {
        return { protectedReason: "git-config", sensitive: false };
      }
      // Everything else under `.git` (index, refs, objects, info/exclude, ...)
      // and the `.git` entry itself — which in worktrees/submodules is a
      // gitdir POINTER FILE whose overwrite retargets the whole repository.
      return { protectedReason: "git-metadata", sensitive: false };
    }
    if (folded[i] === ".github" && folded[i + 1] === "workflows") {
      return { protectedReason: "ci-workflow", sensitive: false };
    }
    if (folded[i] === ".circleci") {
      return { protectedReason: "ci-configuration", sensitive: false };
    }
    // `.env` used as a directory: descendants of a secret-bearing name stay
    // secret-bearing (`.env/production`, `.env.d/local`, ...).
    if (ENV_FILE.test(folded[i] as string)) {
      return { protectedReason: "secret-file", sensitive: true };
    }
  }
  if (CI_FILES.has(base)) {
    return { protectedReason: "ci-configuration", sensitive: false };
  }
  // Secrets by name (a floor, not a complete secret detector). `.envrc`
  // (direnv) executes on shell entry and typically carries secrets.
  if (ENV_FILE.test(base) || base === ".envrc" || KEY_FILE.test(base) || KEY_MATERIAL_EXT.test(base)) {
    return { protectedReason: "secret-file", sensitive: true };
  }
  return { sensitive: false };
}

/**
 * Protected/sensitive classification for a file-tool target. Both the lexical
 * path (as written, normalized) and the canonical resolved path are checked;
 * a hit on either is decisive. This catches symlink escapes into protected
 * territory and protected names reached through non-canonical spellings.
 * Name and protected-ancestor comparisons are case/NFD-folded so new files
 * on case-insensitive filesystems cannot bypass the floor by spelling.
 */
export function classifyPath(
  lexicalAbs: string,
  canonicalAbs: string,
  ctx: ProtectionContext,
): PathClassification {
  const variants = new Set([path.resolve(lexicalAbs), canonicalAbs]);
  let protectedReason: string | undefined;
  let sensitive = false;
  for (const variant of variants) {
    const hit = classifyOne(variant, ctx);
    if (hit.protectedReason !== undefined && protectedReason === undefined) {
      protectedReason = hit.protectedReason;
    }
    if (hit.sensitive) sensitive = true;
  }
  const out: PathClassification = { sensitive };
  if (protectedReason !== undefined) out.protectedReason = protectedReason;
  return out;
}
