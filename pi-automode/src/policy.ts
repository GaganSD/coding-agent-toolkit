import { isWithinOrEqual } from "./core/paths.js";
import type { ActionEvidence, AutomodeSettings, Decision, Rule } from "./types.js";

/**
 * Pure policy: deterministic precedence over canonical evidence.
 *
 * Precedence (shadow beta — classifier output never creates Allow here):
 *   supported route/integrity → protected writes → exact block commands →
 *   unresolved message block (Ask) → workspace file floor and narrowly
 *   supported exact shell allows → Ask.
 *
 * No blanket shell prefixes: command rules match every byte exactly. Opaque
 * shell (composition, interpreters, git, unverifiable executables, PATH or
 * startup-env ambiguity) Asks even with an exact allow rule.
 */

export const SUPPORTED_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write", "bash"]);

function block(source: string, reason: string, matchedRule?: Rule): Decision {
  const d: Decision = { outcome: "block", source, reason };
  if (matchedRule !== undefined) d.matchedRule = matchedRule;
  return d;
}

function ask(source: string, reason: string): Decision {
  return { outcome: "ask", source, reason };
}

function allow(source: string, reason: string, matchedRule?: Rule): Decision {
  const d: Decision = { outcome: "allow", source, reason };
  if (matchedRule !== undefined) d.matchedRule = matchedRule;
  return d;
}

/** Byte-exact match against enabled command rules. Every byte is significant. */
export function matchCommandRule(rules: Rule[], command: string): Rule | undefined {
  return rules.find((r) => r.type === "command" && r.enabled !== false && r.text === command);
}

/** Enabled message rules cannot be resolved deterministically in this beta. */
export function hasEnabledMessageRule(rules: Rule[]): boolean {
  return rules.some((r) => r.type === "message" && r.enabled !== false);
}

export function evaluatePolicy(evidence: ActionEvidence, settings: AutomodeSettings): Decision {
  const tool = evidence.action.tool;

  // 1. Supported route / integrity. Unknown/custom/nested routes Block;
  //    one-shot approval cannot lift missing coverage.
  if (!SUPPORTED_TOOLS.has(tool)) {
    return block(
      "policy:unsupported-route",
      `tool '${tool}' has no verified execution route in this beta`,
    );
  }

  const isWrite = tool === "edit" || tool === "write";

  // 2. Protected writes are final Blocks; nothing later revives them.
  if (isWrite && evidence.protectedReason !== undefined) {
    return block(
      "policy:protected-write",
      `writes to protected target (${evidence.protectedReason}) are blocked while Automode is On`,
    );
  }

  // 3. Exact block commands (byte-exact, enabled rules only). Works even when
  //    shell evidence is incomplete: the match itself needs no filesystem proof.
  if (tool === "bash") {
    const command = evidence.action.args?.command;
    if (typeof command === "string") {
      const blockRule = matchCommandRule(settings.blocklist, command);
      if (blockRule !== undefined) {
        return block("rule:blocklist", "exact blocklist command rule match", blockRule);
      }
    }
  }

  // 4. Unresolved message block: an enabled message block rule cannot be
  //    settled deterministically, and classifier output is shadow-only in
  //    this beta, so it resolves to a local Ask before the file floor or any
  //    automatic allow. Message rules are never silently ignored.
  if (hasEnabledMessageRule(settings.blocklist)) {
    return ask(
      "policy:message-block-unresolved",
      "an enabled message block rule cannot be evaluated deterministically; asking instead of guessing",
    );
  }

  // 5a. Workspace file floor: native reads/edits/writes canonically inside the
  //     workspace, not protected, with complete evidence.
  if (tool === "read" || isWrite) {
    if (evidence.sensitive || evidence.protectedReason !== undefined) {
      // Protected/sensitive reads are a local Ask, never hosted review.
      return ask(
        "policy:sensitive-read",
        `target is protected (${evidence.protectedReason ?? "secret-bearing"}); requires a local operator decision`,
      );
    }
    if (!evidence.complete) {
      return ask(
        "policy:incomplete-evidence",
        `filesystem evidence is incomplete (${evidence.reason ?? "unknown cause"}); unprovable cases ask`,
      );
    }
    if (
      evidence.canonicalPath !== undefined
      && isWithinOrEqual(evidence.workspace, evidence.canonicalPath)
    ) {
      return allow(
        "policy:workspace-floor",
        `native ${tool} on a canonical non-protected path inside the workspace`,
      );
    }
    return ask(
      "policy:outside-workspace",
      "canonical target is outside the workspace; the deterministic floor does not cover it",
    );
  }

  // 5b. Narrowly supported exact shell allows. The exact allow rule alone is
  //     not proof of effects: approved Bash internals are not sandboxed, so
  //     opaque commands Ask even when the bytes match.
  const command = evidence.action.args?.command;
  if (typeof command === "string") {
    const allowRule = matchCommandRule(settings.allowlist, command);
    if (allowRule !== undefined) {
      if (!evidence.complete) {
        return ask(
          "policy:opaque-shell",
          `exact allow rule matched but shell evidence is incomplete (${evidence.reason ?? "unknown cause"}); this beta asks instead of trusting opaque programs`,
        );
      }
      return allow("rule:allowlist", "exact allowlist command rule match with complete evidence", allowRule);
    }
  }
  return ask(
    "policy:no-matching-rule",
    "no operator rule covers this exact invocation; no blanket shell prefixes exist",
  );
}
