import { codexRawVector } from "./codex-spend.mjs";
import { isPlainObject, toNonNegInt } from "./util.mjs";

// A rejected reparse must not seed its suffix from the damaged prefix. The
// shipped v5–v9 formats persisted legacyTotals and (when present) pending
// response usage. Drafts stored the same facts in a scope instead.
export function codexTailContext(file, accept, acceptTask) {
  const prior = file?.state;
  if (!prior?.session || prior.forkReplay) return null;
  const session = `codex:${prior.session}`;
  const scope = prior.codexSpend?.[session];
  const raw = scope?.historyTotal ?? scope?.legacyTotals ?? prior.legacyTotals;
  // An indexed root can contain response records before its first history
  // snapshot. Its pending ledger covers that initial increase from zero.
  const rootBeforeHistory = prior.forkStartMs === undefined && !prior.codexHistoryBase &&
    (Array.isArray(scope?.recordDelta) || isPlainObject(scope?.pendingTotal) ||
      (prior.modern && isPlainObject(prior.modernPending)));
  if (!Array.isArray(raw) && !isPlainObject(raw) && !rootBeforeHistory) return null;
  const baseline = Array.isArray(raw) ? [...raw] : codexRawVector(raw);
  const delta = (key) => Math.max(0, toNonNegInt(scope?.pendingTotal?.[key] ?? prior.modernPending?.[key]) -
    toNonNegInt(scope?.pendingCovered?.[key]));
  const read = delta("cacheRead");
  const write = delta("cacheWrite");
  return {
    file,
    state: { session: prior.session, project: prior.project, provider: prior.provider, timestamp: prior.timestamp,
      codexSpend: { [session]: { historyTotal: baseline, model: scope?.model ?? prior.model,
        responses: { ...(!Array.isArray(scope?.responses) ? scope?.responses : {}) },
        recordDelta: scope?.recordDelta ?? [delta("input") + read + write, read, write, delta("output"), delta("reasoning")],
        pendingRecords: scope?.pendingRecords && { ...scope.pendingRecords },
      } } },
    warn() {},
    addCodexTask(usageKey, key, duration, taskSession) {
      if (taskSession === session) acceptTask(usageKey, key, duration, taskSession);
    },
    linkCodexSnapshot() {},
    addCodexUsage(meta, tokens, key) {
      if (this.history && meta.session === session) accept(meta, tokens, key);
    },
  };
}
