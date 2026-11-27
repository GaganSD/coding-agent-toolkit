// Rollout-local evidence for relating the response counter to the independently
// advancing history counter. Only the response record is authoritative spend.
export const CODEX_PARSER_VERSION = 11;

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const ZERO = FIELDS.map(() => 0);

function vector(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || !Number.isSafeInteger(raw.input_tokens) || !Number.isSafeInteger(raw.output_tokens)) return null;
  const values = FIELDS.map((key) => raw[key] === undefined ? 0 : raw[key]);
  return values.every((n) => Number.isSafeInteger(n) && n >= 0) ? values : null;
}

const pair = (total, usage) => `${total}/${usage}`;
const same = (a, b) => Boolean(a && b && a.every((n, i) => n === b[i]));
const minus = (a, b) => a.map((n, i) => n - b[i]);
const plus = (a, b) => a.map((n, i) => n + b[i]);
const nonnegative = (a) => a.every((n) => n >= 0);
const byId = (id) => `:${id}`;

export function codexSpendScope(state, session) {
  if (state.forkReplay) return state.codexReplaySpend ??= {};
  const scopes = state.codexSpend ??= {};
  return scopes[session] ??= {};
}

function compatible(candidate, { responseId, turnId }) {
  return candidate && (!responseId || !candidate.responseId || responseId === candidate.responseId)
    && (!turnId || !candidate.turnId || turnId === candidate.turnId);
}

function indexPair(index, signature, candidate, key) {
  const previous = index[signature];
  index[signature] = previous === undefined || previous?.[key] === candidate[key] ? candidate : false;
}

export function rememberCodexSnapshot(scope, rawTotal, rawLast, observation, previousTotals) {
  const total = vector(rawTotal);
  const usage = vector(rawLast);
  const snapshot = { ...observation, total, usage };
  if (!rawLast) {
    if (observation.responseId && total && !scope.ids?.[byId(observation.responseId)]) {
      (scope.checkpoints ??= {})[byId(observation.responseId)] = snapshot;
    }
    return;
  }
  if (observation.responseId) (scope.snapshotIds ??= {})[byId(observation.responseId)] = snapshot;
  if (!total || !usage) return;
  indexPair(scope.snapshotPairs ??= {}, pair(total, usage), snapshot, "key");
  if (!observation.responseId && scope.latest) {
    scope.provisional = { snapshot, before: vector(previousTotals) ?? ZERO, after: scope.latest.seq };
  }
}

function chainStep(candidate, total, usage, accepted, anchor) {
  return candidate?.total && same(usage, candidate.usage)
    && same(minus(total, usage), accepted)
    && candidate.seq > (anchor?.seq ?? 0)
    && nonnegative(minus(minus(candidate.total, usage), anchor?.modern ?? ZERO));
}

export function observeCodexResponse(scope, rawTotal, rawUsage, identity) {
  const usage = vector(rawUsage);
  if (!identity.responseId || !usage) return {};
  const total = vector(rawTotal);
  const id = byId(identity.responseId);
  const previous = scope.ids?.[id];
  const exactRecord = total && scope.pairs?.[pair(total, usage)];
  if (exactRecord?.responseId === identity.responseId
    || (previous && same(previous.usage, usage) && (!total || same(previous.total, total)))) return {};
  const candidate = { ...identity, usage, total, seq: (scope.seq ?? 0) + 1 };
  scope.seq = candidate.seq;
  (scope.ids ??= {})[id] = candidate;
  let snapshot = scope.snapshotIds?.[id];
  const checkpoint = scope.checkpoints?.[id];
  // One checkpoint can only cover usage at the observed cumulative total.
  const covered = !snapshot && same(checkpoint?.total, total) ? checkpoint : null;
  if (!total) return { candidate, snapshot };

  const fingerprint = pair(total, usage);
  if (!snapshot) {
    const exact = scope.snapshotPairs?.[fingerprint];
    if (compatible(exact, candidate)) snapshot = exact;
  }
  const provisional = scope.provisional;
  let inferred = false;
  if (!snapshot && !covered && provisional && provisional.after === scope.latest?.seq
    && compatible(provisional.snapshot, candidate)
    && same(provisional.snapshot.total, vector(scope.legacyTotals))
    && same(minus(total, usage), scope.latest.total)
    && chainStep(candidate, provisional.snapshot.total, provisional.snapshot.usage, provisional.before, scope.anchor)) {
    snapshot = provisional.snapshot;
    inferred = true;
  }
  delete scope.provisional;
  scope.latest = candidate;
  indexPair(scope.pairs ??= {}, fingerprint, candidate, "responseId");
  indexPair(scope.totals ??= {}, String(total), candidate, "responseId");
  ((scope.byUsage ??= {})[String(usage)] ??= []).push(candidate);
  return { candidate, snapshot, checkpoint: covered, inferred };
}

export function advanceCodexEcho(scope, candidate, rawTotal, rawLast) {
  const last = vector(rawLast);
  const snapshot = vector(rawTotal);
  const previous = vector(scope.legacyTotals);
  if (!candidate?.total || !snapshot || !last || candidate.seq < (scope.anchor?.seq ?? 0)
    || (previous && !nonnegative(minus(snapshot, previous)))) return false;
  scope.anchor = { seq: candidate.seq, modern: candidate.total, snapshot, last };
  return true;
}

function firstAfter(candidates, seq) {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid].seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function matchCodexSnapshot(scope, rawTotal, rawLast, identity) {
  const total = vector(rawTotal);
  const usage = vector(rawLast);
  if (identity.responseId) {
    const candidate = scope.ids?.[byId(identity.responseId)];
    return candidate ? { candidate } : null;
  }
  if (!total || !usage || !scope.latest) return null;
  const exact = scope.pairs?.[pair(total, usage)];
  if (compatible(exact, identity)) return { candidate: exact };

  const anchor = scope.anchor;
  const accepted = vector(scope.legacyTotals) ?? ZERO;
  const candidates = scope.byUsage?.[String(usage)] ?? [];
  if (same(minus(total, usage), accepted)) {
    // Prefer the already anchored shift over guessing which equal-sized
    // response advanced a lagging chain. Otherwise require unique evidence.
    const expected = anchor && same(anchor.snapshot, accepted)
      ? scope.pairs?.[pair(plus(anchor.modern, usage), usage)] : null;
    if (compatible(expected, identity) && chainStep(expected, total, usage, accepted, anchor)) {
      return { candidate: expected, inferred: true };
    }
    let match;
    for (let i = firstAfter(candidates, anchor?.seq ?? 0); i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (!compatible(candidate, identity) || !chainStep(candidate, total, usage, accepted, anchor)) continue;
      if (match && match.responseId !== candidate.responseId) return null;
      match = candidate;
    }
    if (match) return { candidate: match, inferred: true };
  }

  // Spending-only responses advance both counters but preserve history-last.
  const step = anchor && same(anchor.snapshot, accepted) && same(anchor.last, usage)
    ? minus(total, anchor.snapshot) : null;
  const advanced = step && nonnegative(step) && step.some(Boolean)
    ? scope.totals?.[String(plus(anchor.modern, step))] : null;
  if (compatible(advanced, identity) && advanced.seq > anchor.seq) {
    return { candidate: advanced, inferred: true, staleLast: true };
  }
  return null;
}
