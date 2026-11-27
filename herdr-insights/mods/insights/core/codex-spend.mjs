// A modern response describes spend. A token_count describes the history
// snapshot at emission time, so neither its clock nor its cumulative counter
// uniquely identifies a response. This evidence is local to one rollout,
// owning thread and (after the caller excludes it) non-replay history.
export const CODEX_PARSER_VERSION = 10;

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];

function vector(raw) {
  if (!raw || !Number.isSafeInteger(raw.input_tokens) || !Number.isSafeInteger(raw.output_tokens)) return null;
  const values = FIELDS.map((key) => raw[key] === undefined ? 0 : raw[key]);
  return values.every((n) => Number.isSafeInteger(n) && n >= 0) ? values : null;
}

const pair = (total, usage) => `${total}/${usage}`;
const same = (a, b) => a.every((n, i) => n === b[i]);
const minus = (a, b) => a.map((n, i) => n - b[i]);
const nonnegative = (a) => a.every((n) => n >= 0);
const ZERO = FIELDS.map(() => 0);

function scopeFor(state, session) {
  const scopes = state.codexSpend ??= {};
  return scopes[session] ??= { ids: {}, pairs: {}, echoes: {}, usage: {}, legacy: {}, legacyIds: {} };
}

function compatible(candidate, { responseId, turnId }) {
  return candidate && (!responseId || !candidate.responseId || responseId === candidate.responseId)
    && (!turnId || !candidate.turnId || turnId === candidate.turnId);
}

export function observeCodexResponse(state, session, rawTotal, rawUsage, identity) {
  const usage = vector(rawUsage);
  if (!identity.responseId || !usage) return null;
  const scope = scopeFor(state, session);
  const total = vector(rawTotal);
  const candidate = { ...identity, usage, total, seq: (scope.latest?.seq ?? 0) + 1 };
  const id = `:${identity.responseId}`;
  scope.ids[id] = candidate;
  if (!total) return scope.legacyIds[id] ?? null;
  scope.latest = candidate;
  const fingerprint = pair(total, usage);
  const existing = scope.pairs[fingerprint];
  scope.pairs[fingerprint] = existing === undefined || existing?.responseId === identity.responseId ? candidate : false;
  scope.usage[String(usage)] = candidate;
  // A prior snapshot can be published before its modern response arrives.
  const legacy = scope.legacy[fingerprint];
  const snapshotKey = scope.legacyIds[id] ?? (compatible(legacy, candidate) ? legacy.key : null);
  if (snapshotKey) {
    scope.echoes[fingerprint] = candidate;
    scope.anchor = { modern: total, snapshot: total };
  }
  return snapshotKey;
}

export function rememberCodexSnapshot(state, session, rawTotal, rawUsage, identity) {
  // No modern index is necessary to account for legacy-only logs, but retain
  // compact exact evidence for a file which later upgrades or delivers TUR late.
  const total = vector(rawTotal);
  const usage = vector(rawUsage);
  if ((!total || !usage) && !identity.responseId) return;
  const scope = scopeFor(state, session);
  if (identity.responseId) scope.legacyIds[`:${identity.responseId}`] = identity.key;
  if (!total || !usage) return;
  const fingerprint = pair(total, usage);
  const previous = scope.legacy[fingerprint];
  scope.legacy[fingerprint] = previous === undefined || previous?.key === identity.key ? identity : false;
}

export function matchCodexSnapshot(state, session, rawTotal, rawUsage, identity) {
  const scope = state.codexSpend?.[session];
  if (!scope) return null;
  const { responseId } = identity;
  const total = vector(rawTotal);
  const usage = vector(rawUsage);
  const knownId = responseId && scope.ids[`:${responseId}`];
  if (!total || !usage) return knownId ? { baseline: false } : null;
  const fingerprint = pair(total, usage);
  if (knownId) return { baseline: Boolean(knownId.total && same(knownId.total, total) && knownId.seq === scope.latest?.seq) };
  if (Object.hasOwn(scope.echoes, fingerprint) && compatible(scope.echoes[fingerprint], identity)) {
    return { baseline: false };
  }
  if (responseId) return null;

  const exact = scope.pairs[fingerprint];
  const latest = scope.latest;
  if (compatible(exact, identity)) {
    const baseline = exact.seq === latest?.seq;
    if (baseline) scope.anchor = { modern: exact.total, snapshot: total };
    scope.echoes[fingerprint] = exact;
    return { baseline };
  }
  if (!latest || !compatible(latest, identity)) return null;

  if (same(total, latest.total) && compatible(scope.usage[String(usage)], identity)) {
    // Spending-only responses can advance total without changing last usage.
    scope.anchor = { modern: latest.total, snapshot: total };
    scope.echoes[fingerprint] = latest;
    return { baseline: true };
  }
  if (!same(usage, latest.usage)) return null;

  const modernBefore = minus(latest.total, usage);
  const snapshotBefore = minus(total, usage);
  const anchor = scope.anchor ?? { modern: ZERO, snapshot: ZERO };
  const unseen = minus(modernBefore, anchor.modern);
  const offset = minus(latest.total, total);
  // A lagging snapshot chain advances from its previously accepted total,
  // while the modern chain includes a gap (or an already-established offset).
  // In particular, a genuine equal-sized legacy suffix advancing *from the
  // modern total* is not an echo. Never settle an offset on amount alone.
  if (nonnegative(unseen) && nonnegative(offset) && offset.some(Boolean) && same(snapshotBefore, anchor.snapshot)) {
    scope.anchor = { modern: latest.total, snapshot: total };
    scope.echoes[fingerprint] = latest;
    state.codexInferredEcho = true;
    return { baseline: true };
  }
  return null;
}
