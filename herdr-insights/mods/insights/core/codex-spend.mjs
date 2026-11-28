import { isPlainObject, toNonNegInt } from "./util.mjs";

export const CODEX_PARSER_VERSION = 20;
export const codexResponseIdKey = (id) => `:${id}`;

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const ZERO = Object.freeze([0, 0, 0, 0, 0]);
const minus = (a, b) => a.map((n, i) => n - b[i]);

export function codexSpendScope(state, session) {
  if (state.forkReplay) return state.codexReplaySpend ??= {};
  const scopes = state.codexSpend ??= {};
  return scopes[session] ??= {};
}

export const codexRawVector = (raw) => FIELDS.map((field) => toNonNegInt(raw?.[field]));

// The per-file maxima are independent of the global dedup owner: a copied
// interval must still subtract the records it contains. Keep deltas in raw
// counter space so a cache reclassification does not buy new input tokens.
export function recordCodexSpend(scope, key, current, countedLegacy = ZERO) {
  const previous = (scope.responses ??= {})[key] ?? countedLegacy;
  const merged = current.map((n, i) => Math.max(n, previous[i]));
  merged[1] = Math.min(merged[0], merged[1]);
  merged[2] = Math.min(merged[0] - merged[1], merged[2]);
  scope.responses[key] = merged;
  const delta = minus(merged, previous);
  if (!delta.some(Boolean)) return delta;
  scope.recordDelta = (scope.recordDelta ?? ZERO).map((n, i) => n + delta[i]);
  const pending = scope.pendingRecords ??= {};
  pending[key] = (pending[key] ?? ZERO).map((n, i) => n + delta[i]);
  return delta;
}

// An installed compaction identifies its response. Its spend is still in
// the response ledger; only its unacknowledged increment is removed here.
export function excludeCodexCompaction(scope, responseId) {
  const key = codexResponseIdKey(responseId);
  const delta = scope.pendingRecords?.[key];
  if (!delta) return;
  scope.recordDelta = minus(scope.recordDelta, delta);
  delete scope.pendingRecords[key];
}

export function isCodexWindowFill(info, rawTotal, last) {
  const window = toNonNegInt(info.model_context_window ?? info.modelContextWindow);
  // fill_to_context_window replaces both raw vectors with scalar-only
  // values. The preceding internal total may never have been published.
  return window > 0 && rawTotal?.total_tokens === window && isPlainObject(last) &&
    !codexRawVector(rawTotal).some(Boolean) && !codexRawVector(last).some(Boolean) &&
    Number.isSafeInteger(last.total_tokens) && last.total_tokens >= 0 && last.total_tokens <= window;
}

export function clearCodexPending(scope) {
  delete scope.recordDelta;
  delete scope.pendingRecords;
  delete scope.pendingTurn;
  delete scope.pendingTurnCompleted;
  delete scope.pendingCarriers;
}

function codexIntervalResidual(increase, pending = ZERO, records) {
  const fits = (usage, capacity) => usage[0] <= capacity[0] && usage[3] <= capacity[3];
  let remaining = minus(increase, pending);
  if (!fits(pending, increase)) {
    // Imported offsets and interrupted appends may leave records whose entire
    // increment cannot possibly fit. Never spend part of one against history.
    remaining = increase;
    for (const record of Object.values(records ?? {}).reverse()) {
      if (fits(record, remaining)) remaining = minus(remaining, record);
    }
  }
  const residual = remaining.map((n) => Math.max(0, n));
  residual[1] = Math.min(residual[0], residual[1]);
  residual[2] = Math.min(residual[0] - residual[1], residual[2]);
  if (!residual[0] && !residual[3]) residual[4] = 0;
  return residual;
}

// Pure settlement of one history carrier. Only its baseline and the whole
// record increments in its interval can cover history spend. Ledger records
// are charged independently. The caller owns persistence and attribution.
export function settleCodexInterval({ boundary, baseline, total, last, priorLast, fill, priorFill,
  pending, records, interrupted, interruptedRecords, inheritance, target }) {
  pending ??= Object.values(records ?? {}).reduce((sum, record) => sum.map((n, i) => n + record[i]), ZERO);
  const previous = inheritance === "filtered" ? ZERO : baseline ?? ZERO;
  if (!total) return { charge: last ?? null, target, next: null };
  if (fill) {
    const repeated = priorFill === fill && !previous.some(Boolean);
    return { charge: null, target, next: { historyTotal: [...ZERO], windowFill: fill, close: !repeated } };
  }
  const delta = boundary === "clipped-paginated" && !baseline && last?.some(Boolean) ? last : minus(total, previous);
  const advancing = Boolean(delta[0] || delta[3]);
  const reset = delta[0] < 0 || delta[3] < 0;
  const staleLast = baseline && !reset && last?.every((n, i) => n === priorLast?.[i]);
  const useLast = advancing && (boundary === "legacy" || boundary === "clipped-paginated") && !staleLast &&
    !pending.some(Boolean) && total.some(Boolean) && last?.some(Boolean);
  // An unfinished preceding turn plus restored last-response evidence can
  // identify a resume without a new session header. A completed turn cannot.
  const sameVector = (a, b) => Boolean(a && b && a.length === b.length && a.every((n, i) => n === b[i]));
  const entirelyInterrupted = interrupted?.every((n, i) => n === pending[i]);
  const priorRecords = Object.values(interruptedRecords ?? {});
  const distinctLast = last && (priorRecords.length ? !priorRecords.some((record) => sameVector(record, last))
    : !sameVector(interrupted, last));
  // If last is itself the whole advance, distinct unpublished responses
  // from an interrupted turn cannot be part of that advance.
  const differentAdvance = interrupted && !reset && delta[0] === interrupted[0] && delta[3] === interrupted[3] &&
    !sameVector(delta, interrupted);
  const excludeInterrupted = interrupted && (differentAdvance || distinctLast &&
    (!reset && sameVector(delta, last) || staleLast && entirelyInterrupted));
  if (excludeInterrupted) {
    pending = minus(pending, interrupted);
    records = Object.fromEntries(Object.entries(records ?? {}).map(([id, record]) =>
      [id, minus(record, interruptedRecords?.[id] ?? (entirelyInterrupted ? record : ZERO))]));
  }
  const charge = !advancing ? null : useLast ? last :
    codexIntervalResidual(reset ? total : delta, pending, records);
  return { charge, target, next: { historyTotal: total, windowFill: null, useLast,
    close: advancing || (delta.some(Boolean) && !pending[0] && !pending[3]) } };
}
