/**
 * Shared data contracts for pi-automode core.
 *
 * Pure module: no Pi imports, no runtime side effects.
 * All modules use ESM `.js` import specifiers (Node >= 22.19).
 */

/** Full-string command/path rule. No message/natural-language interpretation.
 * Default tool is bash; native file tools match the canonical absolute path.
 * Default mode is glob (* wildcard); exact permits literal *, regex is bounded
 * non-backtracking syntax implemented in core/rules.ts.
 */
export interface Rule {
  text: string;
  enabled?: boolean;
  tool?: "bash" | "read" | "edit" | "write";
  mode?: "glob" | "exact" | "regex";
}

export interface DecisionModelSelection {
  provider: string;
  model: string;
}

export type DisclosureConsent = "none" | "approved" | "declined";

export interface AutomodeSettings {
  version: 1;
  enabled: boolean;
  decisionModel: DecisionModelSelection | null;
  disclosureConsent: DisclosureConsent;
  /** Explicit consent for command-bearing active safety review. Null = old consent. */
  disclosureVersion: number | null;
  reviewSafeThreshold: number;
  reviewConfidenceThreshold: number;
  /** Consent binding: provider id of the decision model at consent time. Null = unbound. */
  disclosureProvider: string | null;
  /** Consent binding: model id of the decision model at consent time. Null = unbound. */
  disclosureModel: string | null;
  /**
   * Consent binding: normalized (origin+pathname, no userinfo/query/fragment)
   * base URL of the selected decision model at consent time. Null = unbound;
   * an unbound "approved" cannot upload.
   */
  disclosureEndpoint: string | null;
  /** Consent binding: canonical (realpath) workspace at consent time. Null = unbound. */
  disclosureWorkspace: string | null;
  allowlist: Rule[];
  blocklist: Rule[];
  logRetentionDays: number;
  logMaxEntries: number;
  reviewTimeoutMs: number;
  reviewMaxRequests: number;
  approvalTimeoutMs: number;
}

/** Contract defaults: Off, no consent, empty rules, 7d/500 logs, 2s review, 100 req/session, 10min approval. */
export const DEFAULT_SETTINGS: AutomodeSettings = Object.freeze({
  version: 1,
  enabled: false,
  decisionModel: null,
  disclosureConsent: "none",
  disclosureVersion: null,
  reviewSafeThreshold: 0.99,
  reviewConfidenceThreshold: 0.67,
  disclosureProvider: null,
  disclosureModel: null,
  disclosureEndpoint: null,
  disclosureWorkspace: null,
  allowlist: Object.freeze([]) as unknown as Rule[],
  blocklist: Object.freeze([]) as unknown as Rule[],
  logRetentionDays: 7,
  logMaxEntries: 500,
  reviewTimeoutMs: 2000,
  reviewMaxRequests: 100,
  approvalTimeoutMs: 60_000,
});

export interface Action {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
}

export type SnapshotKind = "file" | "directory" | "symlink" | "missing" | "other";

/**
 * Snapshot of a decision-relevant filesystem target. `path` is the path as
 * referenced; `canonicalPath` is the resolved canonical target. For regular
 * files, `sha256`/`size`/`mtimeMs`/`nlink`/`dev`/`ino` describe the content
 * and identity at evidence time; `error` is set when any of that could not be
 * established. Protected/sensitive targets are NEVER content-hashed (metadata
 * only — secret bytes are not pulled into memory); oversized files are hashed
 * over a bounded prefix and marked `hashTruncated`.
 */
export interface FileSnapshot {
  path: string;
  canonicalPath: string;
  kind: SnapshotKind;
  sha256?: string;
  /** True when `sha256` covers only a bounded prefix of an oversized file. */
  hashTruncated?: boolean;
  size?: number;
  mtimeMs?: number;
  nlink?: number;
  dev?: number;
  ino?: number;
  error?: string;
}

/**
 * How a bash command's executable was resolved, or why it is treated as
 * opaque. Opaque effects are not proven by executable evidence. Eligible
 * simple invocations may still receive explicit operator/model permission.
 */
export interface ShellResolution {
  command: string;
  resolvedExecutable?: string;
  opaqueReason?: string;
}

export interface ActionEvidence {
  action: Action;
  /** Canonical workspace root used for containment checks. */
  workspace: string;
  /** Canonical target path for native file tools; absent for bash/unknown tools. */
  canonicalPath?: string;
  /** Why the target is protected (writes Block, reads local Ask), when it is. */
  protectedReason?: string;
  /** Secret-bearing target: local Ask only, never hosted review. */
  sensitive: boolean;
  /** False when any decisive evidence could not be established; unprovable cases Ask/Block. */
  complete: boolean;
  /** Only opacity (not filesystem/integrity failure) prevents deterministic proof.
   * Eligible simple, non-sensitive commands may receive explicit/model permission. */
  reviewableShell?: boolean;
  /**
   * Binds tool, exact argument bytes, canonical cwd, canonical targets and
   * snapshot content. Request IDs are deliberately excluded: they are not
   * authority.
   */
  fingerprint: string;
  /** Human-readable explanation of incomplete evidence, when incomplete. */
  reason?: string;
  snapshots: FileSnapshot[];
  shell?: ShellResolution;
}

export type DecisionOutcome = "allow" | "ask" | "block";

export interface Decision {
  outcome: DecisionOutcome;
  source: string;
  reason: string;
  matchedRule?: Rule;
}

export interface DecisionLog {
  id: string;
  time: string;
  action: Action;
  outcome: DecisionOutcome;
  source: string;
  reason: string;
  matchedRule?: Rule;
  decisionModel?: unknown;
  input?: unknown;
  output?: unknown;
}
