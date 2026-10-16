import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalJson } from "./core/canonical-json.js";
import { isWithinOrEqual, piPathExpansionRisk, realpathNearest } from "./core/paths.js";
import { classifyPath } from "./core/protected.js";
import { analyzeShell } from "./core/shell.js";
import type { Action, ActionEvidence, FileSnapshot, SnapshotKind } from "./types.js";

/**
 * Content hashing is bounded: at most this many bytes are read. Larger files
 * are hashed over this prefix and marked `hashTruncated`; size/mtime/dev/ino
 * still bind the rest. This keeps a huge read target from being slurped into
 * memory before an Ask.
 */
export const SNAPSHOT_HASH_MAX_BYTES = 16 * 1024 * 1024;

export interface EvidenceContext {
  workspace: string;
  agentDir: string;
  extensionDir: string;
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
}

async function hashFile(
  absPath: string,
  size: number,
): Promise<{ sha256: string; truncated: boolean }> {
  // O_NOFOLLOW: never hash through a symlink swapped in after our lstat.
  const handle = await fs.open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const toRead = Math.min(size, SNAPSHOT_HASH_MAX_BYTES);
    const buf = Buffer.alloc(toRead);
    let off = 0;
    while (off < toRead) {
      const { bytesRead } = await handle.read(buf, off, toRead - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return {
      sha256: createHash("sha256").update(buf.subarray(0, off)).digest("hex"),
      truncated: size > SNAPSHOT_HASH_MAX_BYTES,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Snapshot one filesystem target. Never throws for ordinary filesystem
 * failures; unresolvable facts are recorded as `error` so the caller can mark
 * evidence incomplete instead of guessing.
 */
async function snapshotPath(
  referencedPath: string,
  options: { skipContent?: boolean } = {},
): Promise<FileSnapshot> {
  const abs = path.resolve(referencedPath);
  let canonical = abs;
  try {
    canonical = await realpathNearest(abs);
  } catch {
    /* recorded below via lstat error path if truly broken */
  }
  const base: FileSnapshot = { path: abs, canonicalPath: canonical, kind: "missing" };
  let lst;
  try {
    lst = await fs.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return base;
    base.kind = "other";
    base.error = `lstat failed: ${(err as Error).message}`;
    return base;
  }
  let targetPath = abs;
  if (lst.isSymbolicLink()) {
    try {
      targetPath = await fs.realpath(abs);
      lst = await fs.lstat(targetPath);
    } catch (err) {
      return {
        path: abs,
        canonicalPath: targetPath,
        kind: "symlink",
        error: `broken or unreadable symlink: ${(err as Error).message}`,
      };
    }
  }
  const kind: SnapshotKind = lst.isFile() ? "file" : lst.isDirectory() ? "directory" : "other";
  const snap: FileSnapshot = {
    path: abs,
    canonicalPath: targetPath,
    kind,
    size: lst.size,
    mtimeMs: lst.mtimeMs,
    nlink: lst.nlink,
    dev: lst.dev,
    ino: lst.ino,
  };
  // Protected/sensitive/blocked targets are metadata-only: never pull secret
  // bytes into memory to decide what we already know is secret.
  if (kind === "file" && options.skipContent !== true) {
    try {
      const hashed = await hashFile(targetPath, lst.size);
      snap.sha256 = hashed.sha256;
      if (hashed.truncated) snap.hashTruncated = true;
    } catch (err) {
      snap.error = `content hash failed: ${(err as Error).message}`;
    }
  }
  return snap;
}

function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(canonicalJson(parts), "utf8").digest("hex");
}

/**
 * Build canonical evidence for one proposed action. Fingerprints bind the
 * tool, exact argument bytes, canonical cwd, canonical targets and snapshot
 * content; the request ID is deliberately excluded (it is not authority).
 *
 * This function never throws for expected filesystem/argument problems; it
 * returns incomplete evidence with an explanatory `reason` instead, so
 * unprovable cases resolve to Ask/Block rather than crash the gate.
 */
export async function buildEvidence(action: Action, ctx: EvidenceContext): Promise<ActionEvidence> {
  const problems: string[] = [];
  const snapshots: FileSnapshot[] = [];

  const workspace = await realpathNearest(path.resolve(ctx.workspace)).catch(() => {
    problems.push("workspace could not be canonicalized");
    return path.resolve(ctx.workspace);
  });
  const homeDirRaw = ctx.homeDir ?? os.homedir();
  const homeDir = await realpathNearest(path.resolve(homeDirRaw)).catch(() => path.resolve(homeDirRaw));
  const agentDir = await realpathNearest(path.resolve(ctx.agentDir)).catch(() => path.resolve(ctx.agentDir));
  const extensionDir = await realpathNearest(path.resolve(ctx.extensionDir)).catch(() => path.resolve(ctx.extensionDir));

  let canonicalCwd = workspace;
  if (typeof action.cwd === "string" && action.cwd.length > 0) {
    const cwdAbs = path.resolve(workspace, action.cwd);
    try {
      canonicalCwd = await realpathNearest(cwdAbs);
    } catch (err) {
      problems.push(`cwd could not be canonicalized: ${(err as Error).message}`);
      canonicalCwd = cwdAbs;
    }
  } else {
    problems.push("action cwd is missing");
  }

  let canonicalPath: string | undefined;
  let protectedReason: string | undefined;
  let sensitive = false;
  let shell: ActionEvidence["shell"];
  const tool = action.tool;

  if (tool === "read" || tool === "edit" || tool === "write") {
    const raw = action.args?.path;
    if (typeof raw !== "string" || raw.length === 0) {
      problems.push("file tool argument 'path' is missing or not a string");
    } else {
      // Fail closed on raw Pi-expanding path syntax. Pi's resolveToCwd
      // rewrites unicode spaces, a leading '@', '~' and file:// URLs before
      // touching the filesystem; the runtime must perform that translation
      // and hand the core the FINAL absolute path. A raw spelling reaching
      // the core unnormalized classifies the wrong target (e.g. the literal
      // `{ws}/@.env`), so evidence is incomplete — never a floor-Allow.
      const expansionRisk = piPathExpansionRisk(raw);
      if (expansionRisk !== null) {
        problems.push(
          `path carries Pi-expanding syntax (${expansionRisk}); the runtime must normalize it to the final absolute path before evidence`,
        );
      }
      const lexicalAbs = path.resolve(canonicalCwd, raw);
      let canonical = lexicalAbs;
      try {
        canonical = await realpathNearest(lexicalAbs);
      } catch (err) {
        problems.push(`target could not be canonicalized: ${(err as Error).message}`);
      }
      canonicalPath = canonical;
      const classification = classifyPath(lexicalAbs, canonical, {
        workspace,
        agentDir,
        extensionDir,
        homeDir,
      });
      protectedReason = classification.protectedReason;
      sensitive = classification.sensitive;

      const snap = await snapshotPath(lexicalAbs, {
        skipContent: classification.protectedReason !== undefined || classification.sensitive,
      });
      snapshots.push(snap);
      if (snap.error !== undefined) {
        problems.push(`target snapshot incomplete: ${snap.error}`);
      }
      if (snap.kind === "other") {
        problems.push("target is not a regular file or directory");
      }
      // Hard-link handling: an nlink>1 target may alias a sensitive or
      // out-of-workspace inode; the floor must not silently approve it.
      if (snap.kind === "file" && (snap.nlink ?? 1) > 1) {
        problems.push("target has multiple hard links; workspace-local identity is unprovable");
      }
      // A symlink whose canonical target escaped the workspace is still
      // handled by containment in policy; record it honestly.
      if (snap.kind === "symlink" && snap.error !== undefined) {
        problems.push(`symlink could not be resolved: ${snap.error}`);
      }
    }
  } else if (tool === "bash") {
    const command = action.args?.command;
    if (typeof command !== "string") {
      problems.push("bash argument 'command' is missing or not a string");
    } else {
      const analysis = await analyzeShell(command, canonicalCwd, workspace, {
        env: process.env,
        agentDir,
        protection: { workspace, agentDir, extensionDir, homeDir },
      });
      shell = analysis.resolution;
      if (analysis.resolution.opaqueReason !== undefined) {
        problems.push(`shell evidence incomplete: ${analysis.resolution.opaqueReason}`);
      }
      for (const ref of analysis.referencedFiles) {
        let refProtected: boolean;
        try {
          const refClassification = classifyPath(ref, await realpathNearest(ref), {
            workspace,
            agentDir,
            extensionDir,
            homeDir,
          });
          refProtected = refClassification.protectedReason !== undefined || refClassification.sensitive;
        } catch {
          refProtected = true; // uncanonicalizable reference: do not hash blindly
        }
        const snap = await snapshotPath(ref, { skipContent: refProtected });
        snapshots.push(snap);
        if (snap.error !== undefined) {
          problems.push(`referenced file snapshot incomplete: ${snap.error}`);
        }
        // Hard-link handling (mirrors the native-tool rule): an nlink>1
        // operand may alias a sensitive or out-of-workspace inode; the floor
        // must not silently approve it.
        if (snap.kind === "file" && (snap.nlink ?? 1) > 1) {
          problems.push("referenced file has multiple hard links; workspace-local identity is unprovable");
        }
      }
    }
  }
  // Unknown/custom tools: evidence stays minimal; policy blocks the route.

  const complete = problems.length === 0;
  const reason = complete ? null : problems.join("; ");
  // The fingerprint binds every decision-relevant fact: workspace identity,
  // completeness/reason, and per-target content AND metadata (nlink, dev,
  // ino, mtime) so an nlink/inode change always invalidates a prior allow.
  const fingerprint = fingerprintOf({
    tool: action.tool,
    args: action.args ?? null,
    cwd: canonicalCwd,
    workspace,
    canonicalPath: canonicalPath ?? null,
    protectedReason: protectedReason ?? null,
    sensitive,
    complete,
    reason,
    shell: shell ?? null,
    snapshots: snapshots.map((s) => ({
      canonicalPath: s.canonicalPath,
      kind: s.kind,
      sha256: s.sha256 ?? null,
      hashTruncated: s.hashTruncated ?? null,
      size: s.size ?? null,
      mtimeMs: s.mtimeMs ?? null,
      nlink: s.nlink ?? null,
      dev: s.dev ?? null,
      ino: s.ino ?? null,
    })),
  });

  const evidence: ActionEvidence = {
    action,
    workspace,
    sensitive,
    complete,
    fingerprint,
    snapshots,
  };
  if (canonicalPath !== undefined) evidence.canonicalPath = canonicalPath;
  if (protectedReason !== undefined) evidence.protectedReason = protectedReason;
  if (reason !== null) evidence.reason = reason;
  if (shell !== undefined) evidence.shell = shell;
  return evidence;
}

export { isWithinOrEqual };
