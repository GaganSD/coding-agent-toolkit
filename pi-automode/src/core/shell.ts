import { promises as fs } from "node:fs";
import path from "node:path";

import { isWithinOrEqual, realpathNearest } from "./paths.js";
import { classifyPath } from "./protected.js";
import type { ProtectionContext } from "./protected.js";
import type { ShellResolution } from "../types.js";

/**
 * Conservative shell analysis for the shadow beta.
 *
 * Approved Bash internals are NOT sandboxed; protected-path enforcement is a
 * native file-route property, not a shield against an approved opaque shell.
 * A command is only eligible for a deterministic exact-rule allow when every
 * decisive fact is established:
 *   - no composition / substitution / redirection / escapes / comments,
 *   - no glob or tilde tokens (the real shell would expand them after our
 *     byte-exact analysis),
 *   - no shell startup environment (BASH_ENV/ENV) and no exported shell
 *     functions (BASH_FUNC_*), which can shadow any resolved binary,
 *   - the executable resolves, through the SAME PATH Pi's bash will use
 *     (Pi prepends <agentDir>/bin only when absent), to a realpath under a trusted system
 *     prefix with the execute bit set — never by basename alone,
 *   - the program is in a tiny set of read-only tools, every flag is from a
 *     per-program allowlist that excludes any write/exec/output option, and
 *     every path operand canonically resolves inside the workspace to a
 *     non-protected, non-sensitive target (snapshotted into evidence).
 * Interpreters, package managers, git (pager/config/hooks), network and
 * file-mutation tools are always opaque. Opaque means Ask — even with an
 * exact allow rule — rather than a fake allow.
 */

interface SimpleSpec {
  /** Allowed flag tokens; null means no flags at all. */
  flags: RegExp | null;
  /** Operand semantics: none, filesystem paths to verify, or inert strings. */
  operands: "none" | "paths" | "strings";
}

/**
 * Tiny proven read-only subset. Anything with a write/exec/output option is
 * excluded entirely: no sort (-o/--compress-program), no date (clock set),
 * no diff/patch family, no grep (-r include/exclude semantics), no tr/cut.
 */
const PROVEN_SIMPLE: Readonly<Record<string, SimpleSpec>> = {
  cat: { flags: /^-[nbetv]+$/, operands: "paths" },
  ls: { flags: /^-[alh1Rrt]+$/, operands: "paths" },
  head: { flags: /^-([0-9]+|[ncqv][0-9]*)$/, operands: "paths" },
  tail: { flags: /^-([0-9]+|[ncqfv][0-9]*)$/, operands: "paths" },
  wc: { flags: /^-[lwcm]+$/, operands: "paths" },
  file: { flags: /^-[bh]+$/, operands: "paths" },
  pwd: { flags: /^-[LP]$/, operands: "none" },
  echo: { flags: /^-[neE]+$/, operands: "strings" },
  printf: { flags: null, operands: "strings" },
  whoami: { flags: null, operands: "none" },
  hostname: { flags: null, operands: "none" },
  uname: { flags: /^-[amnrsv]+$/, operands: "none" },
  true: { flags: null, operands: "none" },
  false: { flags: null, operands: "none" },
  basename: { flags: null, operands: "strings" },
  dirname: { flags: null, operands: "strings" },
};

/**
 * Executable realpaths must live under a trusted system prefix. A binary
 * named `cat` in /tmp, ~/bin or any other PATH entry is NOT `cat` — name
 * alone is never proof. (Resolved after realpath, so the usual /bin ->
 * /usr/bin merges are fine.)
 */
const TRUSTED_EXECUTABLE_PREFIXES = [
  "/bin", "/usr/bin", "/sbin", "/usr/sbin",
  // Ubuntu 26's distribution-owned uutils coreutils, not a user's ~/.cargo/bin.
  "/usr/lib/cargo/bin/coreutils",
];

/** Package-manager family: snapshot the manifest as relevant executable input. */
const MANIFEST_PROGRAMS = new Set(["npm", "npx", "pnpm", "yarn", "bun"]);
/** Interpreter family: snapshot a directly referenced script file when identifiable. */
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "python", "python3", "python2", "node",
  "ruby", "perl", "php", "lua",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Tokens the real shell would expand after our byte-exact lex: globs and tilde. */
const GLOB_CHARS = /[*?[]/;

export interface ShellAnalysis {
  resolution: ShellResolution;
  /** Absolute paths of relevant executable inputs worth snapshotting. */
  referencedFiles: string[];
}

export interface ShellAnalysisContext {
  /** Environment the shell will actually run with; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Host-configured agent directory, preserving its lexical spelling. Pi
   * prepends its bin directory only if that exact PATH entry is absent.
   */
  agentDir?: string;
  /** Protection context for classifying path operands of proven programs. */
  protection?: ProtectionContext;
}

interface LexResult {
  tokens: string[];
  composed: boolean;
  error?: string;
}

/**
 * Minimal lexical scan. Not a shell parser: any construct whose effect we
 * cannot establish byte-exactly marks the command composed (opaque).
 */
function lex(command: string): LexResult {
  const tokens: string[] = [];
  let current = "";
  let has = false;
  let composed = false;
  let i = 0;
  const n = command.length;
  const push = () => {
    if (has) tokens.push(current);
    current = "";
    has = false;
  };
  while (i < n) {
    const c = command[i] as string;
    if (c === "'") {
      // A quoted section is a real argument even when EMPTY: `hostname ''`
      // passes an empty-string operand (a hostname setter), so quote open
      // marks the current token present — never silently drop it.
      has = true;
      i += 1;
      let closed = false;
      while (i < n) {
        const q = command[i] as string;
        if (q === "'") {
          closed = true;
          i += 1;
          break;
        }
        current += q;
        i += 1;
      }
      if (!closed) return { tokens, composed: true, error: "unterminated single quote" };
      continue;
    }
    if (c === '"') {
      has = true; // see single-quote branch: empty double quotes are an operand
      i += 1;
      let closed = false;
      while (i < n) {
        const q = command[i] as string;
        if (q === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (q === "$" || q === "`" || q === "\\") composed = true;
        current += q;
        i += 1;
      }
      if (!closed) return { tokens, composed: true, error: "unterminated double quote" };
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      i += 1;
      continue;
    }
    if ("|;&<>`$(){}\\\n\r".includes(c)) {
      composed = true;
      i += 1;
      continue;
    }
    if (c === "#" && !has) {
      // Comment start: parsing stops being byte-exact.
      composed = true;
      break;
    }
    current += c;
    has = true;
    i += 1;
  }
  push();
  const out: LexResult = { tokens, composed };
  return out;
}

async function resolveExecutable(
  token: string,
  cwd: string,
  envPath: string | undefined,
): Promise<{ resolved?: string; candidate?: string; shadowed: boolean; found: boolean }> {
  if (token.includes("/")) {
    const candidate = path.resolve(cwd, token);
    try {
      const st = await fs.stat(candidate);
      if (!st.isFile()) return { found: false, shadowed: false };
      const real = await realpathNearest(candidate);
      return { resolved: real, candidate, found: true, shadowed: false };
    } catch {
      return { found: false, shadowed: false };
    }
  }
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    const dirAbs = dir === "" ? cwd : path.resolve(cwd, dir);
    const candidate = path.join(dirAbs, token);
    try {
      const st = await fs.stat(candidate);
      if (!st.isFile()) continue;
      const real = await realpathNearest(candidate);
      return { resolved: real, candidate, found: true, shadowed: dir === "" };
    } catch {
      continue;
    }
  }
  return { found: false, shadowed: false };
}

export async function analyzeShell(
  command: string,
  cwdCanonical: string,
  workspaceCanonical: string,
  context: ShellAnalysisContext = {},
): Promise<ShellAnalysis> {
  const env = context.env ?? process.env;
  const resolution: ShellResolution = { command };
  const referencedFiles: string[] = [];
  const opaque = (why: string): ShellAnalysis => {
    resolution.opaqueReason = why;
    return { resolution, referencedFiles };
  };

  if (command.length === 0 || command.trim().length === 0) {
    return opaque("empty command");
  }
  if ((env.BASH_ENV ?? "") !== "" || (env.ENV ?? "") !== "") {
    return opaque("shell startup environment (BASH_ENV/ENV) is set; startup commands are unverifiable");
  }
  // Exported shell functions (BASH_FUNC_name%%=() {...}) shadow any binary we
  // could resolve; their bodies are unverifiable.
  if (Object.keys(env).some((k) => k.startsWith("BASH_FUNC_"))) {
    return opaque("exported shell functions (BASH_FUNC_*) can shadow any resolved executable");
  }

  const lexed = lex(command);
  if (lexed.error !== undefined) return opaque(`cannot lex command exactly: ${lexed.error}`);
  if (lexed.composed) {
    return opaque("shell composition, substitution, redirection or escaping is not verifiable in this beta");
  }
  const tokens = lexed.tokens;
  const first = tokens[0];
  if (first === undefined) return opaque("empty command");
  if (ENV_ASSIGNMENT.test(first)) {
    return opaque("leading environment assignment makes the invocation unverifiable");
  }
  // Glob/tilde tokens are expanded by the real shell AFTER our byte-exact
  // lex; the arguments that would actually run are unprovable.
  for (const token of tokens) {
    if (token.startsWith("~")) {
      return opaque("tilde token would be expanded by the shell after analysis; the real argument is unprovable");
    }
    if (GLOB_CHARS.test(token)) {
      return opaque("glob token would be expanded by the shell after analysis; the real arguments are unprovable");
    }
  }

  const base = path.basename(first);
  if (MANIFEST_PROGRAMS.has(base)) {
    referencedFiles.push(path.resolve(cwdCanonical, "package.json"));
  }
  if (INTERPRETERS.has(base)) {
    // Snapshot a directly referenced script file when one is identifiable;
    // inline (-c/-e) or missing scripts stay opaque regardless.
    for (const arg of tokens.slice(1)) {
      if (arg.startsWith("-")) continue;
      referencedFiles.push(path.resolve(cwdCanonical, arg));
      break;
    }
    return opaque(`interpreter '${base}' execution is opaque in this beta`);
  }

  // Match Pi's getShellEnv: an existing bin entry keeps its position.
  const envPath = env.PATH ?? "";
  const binDir = context.agentDir === undefined ? undefined : path.join(context.agentDir, "bin");
  const effectivePath = binDir !== undefined && !envPath.split(path.delimiter).includes(binDir)
    ? [binDir, envPath].filter(Boolean).join(path.delimiter)
    : envPath;

  const resolved = await resolveExecutable(first, cwdCanonical, effectivePath);
  if (!resolved.found || resolved.resolved === undefined) {
    return opaque(`executable '${first}' could not be resolved`);
  }
  resolution.resolvedExecutable = resolved.resolved;
  if (resolved.shadowed || isWithinOrEqual(workspaceCanonical, resolved.resolved)) {
    return opaque(`executable '${first}' resolves inside the workspace (PATH shadowing risk)`);
  }
  // A workspace-controlled LEXICAL executable (./cat, or a PATH entry inside
  // the workspace) stays opaque even when its canonical target is a trusted
  // system binary: a workspace symlink can be retargeted after evidence, so
  // the outside canonical target must not be silently trusted.
  if (resolved.candidate !== undefined && isWithinOrEqual(workspaceCanonical, resolved.candidate)) {
    return opaque(`executable '${first}' is lexically inside the workspace; its identity is operator-controlled, not provable`);
  }
  const resolvedBase = path.basename(resolved.resolved);
  const spec = PROVEN_SIMPLE[base];
  if (spec === undefined || PROVEN_SIMPLE[resolvedBase] === undefined) {
    return opaque(`program '${base}' is not in the narrowly verified set; its effects are unproven`);
  }
  // Both-in-the-whitelist is NOT enough: the resolved realpath must be the
  // SAME program that was pinned. `./cat` symlinked to /bin/hostname would
  // otherwise be reviewed against cat's operand profile while actually
  // running hostname (a hostname setter with an operand).
  if (resolvedBase !== base) {
    return opaque(`executable '${base}' resolves to a different program ('${resolvedBase}'); its actual semantics are unproven`);
  }
  // Name is never proof: the realpath must live under a trusted system prefix
  // and actually be executable. The executable itself is snapshotted by the
  // caller so the fingerprint binds its content.
  if (!TRUSTED_EXECUTABLE_PREFIXES.some((prefix) => isWithinOrEqual(prefix, resolved.resolved as string))) {
    return opaque(`executable '${first}' resolves outside trusted system prefixes (${resolved.resolved}); name alone is not proof`);
  }
  try {
    const st = await fs.stat(resolved.resolved);
    if (!st.isFile() || (st.mode & 0o111) === 0) {
      return opaque(`executable '${first}' is not an executable regular file`);
    }
  } catch (err) {
    return opaque(`executable '${first}' could not be stat'ed: ${(err as Error).message}`);
  }
  referencedFiles.push(resolved.resolved);

  // Strict argument constraints: only allowlisted read-only flags, and every
  // path operand must canonically resolve inside the workspace to a
  // non-protected, non-sensitive target.
  const operands: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-") && token !== "-") {
      if (spec.flags === null || !spec.flags.test(token)) {
        return opaque(`flag '${token}' is not in the verified read-only set for '${base}'`);
      }
      continue;
    }
    operands.push(token);
  }
  if (spec.operands === "none" && operands.length > 0) {
    return opaque(`'${base}' takes no operands in the verified subset`);
  }
  if (spec.operands === "paths") {
    if (context.protection === undefined) {
      return opaque("no protection context available to verify path operands");
    }
    for (const operand of operands) {
      const lexAbs = path.resolve(cwdCanonical, operand);
      let canonical: string;
      try {
        canonical = await realpathNearest(lexAbs);
      } catch (err) {
        return opaque(`operand '${operand}' could not be canonicalized: ${(err as Error).message}`);
      }
      const classification = classifyPath(lexAbs, canonical, context.protection);
      if (classification.protectedReason !== undefined || classification.sensitive) {
        return opaque(`operand '${operand}' resolves to a protected/sensitive target (${classification.protectedReason ?? "secret-bearing"})`);
      }
      if (!isWithinOrEqual(workspaceCanonical, canonical)) {
        return opaque(`operand '${operand}' canonically resolves outside the workspace; its identity is unprovable`);
      }
      referencedFiles.push(lexAbs);
    }
  }
  return { resolution, referencedFiles };
}
