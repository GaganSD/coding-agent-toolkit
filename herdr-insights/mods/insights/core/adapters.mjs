import { antigravityConversation } from "./antigravity.mjs";
import { advanceCodexEcho, codexSpendScope, matchCodexSnapshot, observeCodexResponse, rememberCodexSnapshot } from "./codex-spend.mjs";
import {
  MAX_TURN_MS,
  asString,
  hashKey,
  isPlainObject,
  localDay,
  normalizeTokens,
  parseTimestamp,
  toNonNegInt,
} from "./util.mjs";
import {
  taskKeyFor as makeTaskKey,
  dedupKeyFor as makeDedupKey,
  taskKeyFor,
} from "./store.mjs";

function metaFor(harness, session, timestamp, project, provider, model) {
  return {
    day: localDay(timestamp),
    session,
    harness,
    provider: asString(provider),
    model: asString(model),
    project: asString(project),
  };
}

function spanMs(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.min(end - start, MAX_TURN_MS);
}

function historyFor(state, session) {
  if (!isPlainObject(state.sessions)) state.sessions = {};
  let history = state.sessions[session];
  if (!isPlainObject(history)) {
    history = {
      turnStart: null,
      turnFirst: null,
      lastRow: null,
    };
    state.sessions[session] = history;
  }
  return history;
}

function rememberLastRow(history, result) {
  if (!result) return;
  history.lastRow = { fileId: result.fileId, rowIdx: result.rowIdx };
}

function emitTask(ctx, history, session, key, duration, exact) {
  if (!history?.lastRow || !Number.isFinite(duration) || duration <= 0) return;
  ctx.addTask(
    history.lastRow.fileId,
    history.lastRow.rowIdx,
    key,
    duration,
    session,
    exact,
  );
}

// ---------------------------------------------------------------------------
// Pi

function piMainSession(state, ctx) {
  if (state.header?.id) return `pi:${state.header.id}`;
  return `pi-file:${ctx.file.path}`;
}

function piSubagentSession(record, ctx) {
  const runId = asString(record.runId, "");
  const childIndex = Number.isInteger(record.childIndex) ? record.childIndex : 0;
  if (runId) return `pi-sub:${runId}:${childIndex}`;
  return `pi-file:${ctx.file.path}`;
}

function piUsageCarrier(record, ctx) {
  const usage = isPlainObject(record.usage) ? record.usage : null;
  if (!usage) return;
  const state = ctx.state;
  const session = piMainSession(state, ctx);
  const timestamp = parseTimestamp(
    record.timestamp ?? state.header?.timestamp,
  );
  if (timestamp === null) {
    ctx.warn(`Pi ${record.type} record has no usable timestamp; skipped`);
    return;
  }
  const tokens = normalizeTokens({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
  });
  if (!tokens.nonzero) return;
  const identity = record.id ?? `line:${ctx.lineHash}`;
  ctx.addUsage(
    metaFor(
      "pi",
      session,
      timestamp,
      asString(state.header?.cwd, "unknown"),
      record.provider,
      record.model,
    ),
    tokens,
    makeDedupKey("pi", record.type, identity, timestamp),
  );
}

function piTiming(record, ctx, session, timestamp, isFinal, finalIdentity) {
  const history = historyFor(ctx.state, session);
  if (record.role === "user") {
    history.turnStart = timestamp;
    history.turnFirst = null;
    history.lastRow = null;
    return;
  }
  if (record.role !== "assistant") return;
  if (!history.turnFirst) history.turnFirst = timestamp;
  if (!isFinal) return;
  const start = history.turnStart ?? history.turnFirst;
  emitTask(
    ctx,
    history,
    session,
    taskKeyFor("pi", "span", finalIdentity),
    spanMs(start, timestamp),
    false,
  );
  history.turnStart = null;
  history.turnFirst = null;
}

function parsePi(record, ctx) {
  if (!isPlainObject(record)) return;
  const state = ctx.state;

  if (record.type === "session") {
    state.header = {
      id: asString(record.id, ""),
      cwd: asString(record.cwd, ""),
      timestamp: record.timestamp,
      parentSession: asString(record.parentSession, ""),
    };
    state.headerTimestamp = parseTimestamp(record.timestamp);
    return;
  }

  // Pi usage carriers outside assistant messages: cache warming, compaction,
  // and branch-summary usage all contribute to Pi's session totals.
  if (
    record.type === "usage" ||
    record.type === "compaction" ||
    record.type === "branch_summary"
  ) {
    piUsageCarrier(record, ctx);
    return;
  }

  // Pi's own session files: message + message.usage.
  if (record.type === "message" && isPlainObject(record.message)) {
    const message = record.message;
    const role = asString(message.role, "");
    const session = piMainSession(state, ctx);
    const timestamp = parseTimestamp(
      record.timestamp ?? message.timestamp ?? state.header?.timestamp,
    );
    const project = asString(state.header?.cwd, "unknown");
    const provider = asString(message.provider);
    const model = asString(message.model);
    const stopReason = asString(message.stopReason, "");
    const failed =
      stopReason === "error" ||
      stopReason === "aborted" ||
      Boolean(message.errorMessage);
    const final = stopReason === "stop" && !failed;
    const identity =
      record.id ??
      message.responseId ??
      `line:${session}:${ctx.lineHash}`;

    if (role === "user") {
      if (timestamp !== null) piTiming({ role }, ctx, session, timestamp, false, "");
      return;
    }
    if (role === "toolResult") {
      // Tool extensions may report nested-model usage directly. Count the
      // reported event without opening/closing the surrounding assistant turn.
      piUsageCarrier({
        type: "toolResult", usage: message.usage,
        id: record.id ?? message.toolCallId ?? message.responseId,
        timestamp: record.timestamp ?? message.timestamp,
        provider: message.provider, model: message.model,
      }, ctx);
      return;
    }
    if (role !== "assistant") return;
    if (timestamp === null) {
      ctx.warn("Pi assistant record has no usable timestamp; skipped");
      return;
    }

    const history = historyFor(state, session);
    if (!history.turnFirst) history.turnFirst = timestamp;
    const usage = isPlainObject(message.usage) ? message.usage : null;
    if (usage) {
      const tokens = normalizeTokens({
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning,
      });
      if (tokens.nonzero) {
        const result = ctx.addUsage(
          metaFor("pi", session, timestamp, project, provider, model),
          tokens,
          makeDedupKey("pi", identity, timestamp, provider, model),
        );
        rememberLastRow(history, result);
      }
    }
    if (final) {
      piTiming(
        { role: "assistant" },
        ctx,
        session,
        timestamp,
        true,
        hashKey("pi-final", identity, timestamp, provider, model),
      );
    }
    return;
  }

  // Pi sub-agent transcript artifacts. They are JSONL under the same root but
  // put usage and role at the top level and have no session header.
  if (record.recordType === "message" && record.role !== undefined) {
    const role = asString(record.role, "");
    const session = piSubagentSession(record, ctx);
    const timestamp = parseTimestamp(record.timestamp ?? record.ts);
    const project = asString(record.cwd, "unknown");
    const provider = asString(
      record.provider ?? record.message?.provider,
      "unknown",
    );
    const model = asString(record.model ?? record.message?.model, "unknown");
    const stopReason = asString(record.stopReason, "");
    const failed =
      stopReason === "error" ||
      stopReason === "aborted" ||
      Boolean(record.errorMessage);
    const final = stopReason === "stop" && !failed;
    const identity =
      record.message?.responseId ??
      record.responseId ??
      `line:${session}:${ctx.lineHash}`;

    if (role === "user") {
      if (timestamp !== null) piTiming({ role }, ctx, session, timestamp, false, "");
      return;
    }
    if (role !== "assistant") return;
    if (timestamp === null) {
      ctx.warn("Pi sub-agent assistant record has no usable timestamp; skipped");
      return;
    }
    const history = historyFor(state, session);
    if (!history.turnFirst) history.turnFirst = timestamp;
    const usage = isPlainObject(record.usage) ? record.usage : null;
    if (usage) {
      const tokens = normalizeTokens({
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning,
      });
      if (tokens.nonzero) {
        const result = ctx.addUsage(
          metaFor("pi", session, timestamp, project, provider, model),
          tokens,
          makeDedupKey("pi", identity, timestamp, provider, model),
        );
        rememberLastRow(history, result);
      }
    }
    if (final) {
      piTiming(
        { role: "assistant" },
        ctx,
        session,
        timestamp,
        true,
        hashKey("pi-final", identity, timestamp, provider, model),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Code

function claudeSession(record, ctx) {
  const id = asString(record.sessionId ?? record.session_id, "");
  if (id) return `claude:${id}`;
  return `claude-file:${ctx.file.path}`;
}

function claudePrompt(record) {
  return (
    record.type === "user" &&
    !record.sourceToolUseID &&
    !record.toolUseResult &&
    !record.isMeta
  );
}

function claudeReasoning(usage) {
  const details = usage.output_tokens_details;
  if (isPlainObject(details) && Number.isFinite(details.thinking_tokens)) {
    return toNonNegInt(details.thinking_tokens);
  }
  return 0;
}

function claudeCacheWrite(usage) {
  if (Number.isFinite(usage.cache_creation_input_tokens)) {
    return toNonNegInt(usage.cache_creation_input_tokens);
  }
  if (isPlainObject(usage.cache_creation)) {
    let sum = 0;
    for (const value of Object.values(usage.cache_creation)) {
      if (Number.isFinite(value) && value > 0) sum += value;
    }
    return toNonNegInt(sum);
  }
  return 0;
}

function parseClaude(record, ctx) {
  if (!isPlainObject(record)) return;
  const state = ctx.state;
  const session = claudeSession(record, ctx);
  const timestamp = parseTimestamp(record.timestamp) ?? state.fallbackTimestamp ?? null;
  if (timestamp !== null && state.fallbackTimestamp === undefined) {
    state.fallbackTimestamp = timestamp;
  }
  const history = historyFor(state, session);

  if (claudePrompt(record)) {
    if (timestamp !== null) {
      history.turnStart = timestamp;
      history.turnFirst = null;
      history.lastRow = null;
    }
    return;
  }

  if (record.type === "system" && record.subtype === "turn_duration") {
    const duration = Number.isFinite(record.durationMs)
      ? toNonNegInt(record.durationMs)
      : 0;
    if (duration <= 0) return;
    const removed = ctx.removeLatestFallback(session);
    if (!history.lastRow && removed) {
      history.lastRow = { fileId: removed.fileId, rowIdx: removed.rowIdx };
    }
    emitTask(
      ctx,
      history,
      session,
      taskKeyFor(
        "claude",
        "turn-duration",
        record.parentUuid ?? record.uuid ?? record.timestamp,
      ),
      duration,
      true,
    );
    return;
  }

  if (record.type !== "assistant" || !isPlainObject(record.message)) return;
  if (timestamp === null) {
    ctx.warn("Claude assistant record has no usable timestamp; skipped");
    return;
  }
  const message = record.message;
  const usage = isPlainObject(message.usage) ? message.usage : null;
  const model = asString(message.model);
  const provider = asString(message.provider, "anthropic");
  const project = asString(record.cwd, "unknown");
  const identity = message.id ?? record.uuid ?? `line:${session}:${ctx.lineHash}`;

  if (!history.turnFirst) history.turnFirst = timestamp;
  if (usage) {
    const tokens = normalizeTokens({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: claudeCacheWrite(usage),
      reasoning: claudeReasoning(usage),
    });
    if (tokens.nonzero) {
      const result = ctx.addUsage(
        metaFor("claude", session, timestamp, project, provider, model),
        tokens,
        makeDedupKey("claude", identity),
      );
      rememberLastRow(history, result);
    }
  }

  const stop = asString(message.stop_reason, "");
  const failed =
    Boolean(record.isApiErrorMessage) ||
    Boolean(record.error) ||
    Number.isFinite(record.apiErrorStatus) ||
    stop === "error";
  const final =
    !failed && ["end_turn", "stop_sequence", "max_tokens", "stop"].includes(stop);
  if (final) {
    const start = history.turnStart ?? history.turnFirst;
    emitTask(
      ctx,
      history,
      session,
      taskKeyFor("claude", "span", identity),
      spanMs(start, timestamp),
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// Codex

function codexSession(state, ctx) {
  if (state.session) return `codex:${state.session}`;
  return `codex-file:${ctx.file.path}`;
}

function codexRecordSession(state, ctx, payload) {
  const threadId = asString(
    payload.thread_id ??
      payload.session_id ??
      payload.threadId ??
      payload.sessionId,
    "",
  );
  if (threadId) return `codex:${threadId}`;
  return codexSession(state, ctx);
}

function codexUuidV7Ms(id) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id);
  return match ? Number.parseInt(match[1] + match[2], 16) : null;
}

// Supported fork boundary: a canonical UUIDv7 turn strictly newer than the
// initial thread's UUIDv7 millisecond. Equal milliseconds cannot distinguish
// copied from child turns; missing/other-version IDs cannot order them at all.
// Conservatively exclude that prefix and retain a scanner diagnostic rather
// than guessing from record timestamps (which can be rewritten during a copy).
function codexEndsForkReplay(state, record, payload) {
  if (record.type !== "turn_context" && !(record.type === "event_msg" && payload.type === "task_started")) {
    return false;
  }
  const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
  const turnMs = codexUuidV7Ms(turnId);
  if (turnMs === null || turnMs === state.forkStartMs) state.forkBoundaryAmbiguous = true;
  return turnMs !== null && turnMs > state.forkStartMs;
}

function codexContext(state, turnId) {
  if (!isPlainObject(state.turns)) state.turns = {};
  if (turnId && isPlainObject(state.turns[turnId])) return state.turns[turnId];
  return {
    model: state.model,
    provider: state.provider,
    project: state.project,
    lastUsageKey: null,
  };
}

function codexSetUsageTarget(state, scope, turnId, context, key, latest = true) {
  if (turnId) (state.turns[turnId] = context).lastUsageKey = key;
  if (latest) scope.lastUsageKey = key;
}

function codexNormalized(raw) {
  const inputRaw = toNonNegInt(raw.input_tokens);
  const cached = toNonNegInt(raw.cached_input_tokens);
  const cacheWrite = toNonNegInt(raw.cache_write_input_tokens);
  return normalizeTokens({
    input: Math.max(0, inputRaw - cached - cacheWrite),
    output: raw.output_tokens,
    cacheRead: cached,
    cacheWrite,
    reasoning: raw.reasoning_output_tokens,
  });
}

// Both modern thread_token_usage and legacy total_token_usage use raw Codex
// counters: input includes cache, output includes reasoning. Never store the
// normalized (cache-subtracted) vector as the legacy cumulative baseline.
function codexRawTotals(raw) {
  return {
    input_tokens: toNonNegInt(raw.input_tokens),
    cached_input_tokens: toNonNegInt(raw.cached_input_tokens),
    cache_write_input_tokens: toNonNegInt(raw.cache_write_input_tokens),
    output_tokens: toNonNegInt(raw.output_tokens),
    reasoning_output_tokens: toNonNegInt(raw.reasoning_output_tokens),
  };
}

const CODEX_TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const CODEX_TWIN_WINDOW_MS = 5 * 60 * 1000;

function codexZeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function codexTokenVector(tokens) {
  return CODEX_TOKEN_FIELDS.map((field) => toNonNegInt(tokens[field]));
}

function codexSameTokens(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function codexCloseInTime(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
  return Math.abs(left - right) <= CODEX_TWIN_WINDOW_MS;
}

// Coverage is a watermark, not a reset. An echo for an earlier response
// may cover its prefix without canceling more recent unacknowledged usage.
function codexPendingTokens(scope) {
  return codexSubtract(scope.pendingTotal ?? codexZeroTokens(), scope.pendingCovered ?? {});
}

function codexAddPending(scope, tokens) {
  const total = scope.pendingTotal ?? codexZeroTokens();
  scope.pendingTotal = Object.fromEntries(CODEX_TOKEN_FIELDS.map((field) => [field, total[field] + tokens[field]]));
}

function codexCoverPending(scope, through = scope.pendingTotal) {
  if (!through) return;
  const covered = scope.pendingCovered ?? codexZeroTokens();
  scope.pendingCovered = Object.fromEntries(CODEX_TOKEN_FIELDS.map((field) => [field, Math.max(covered[field], through[field])]));
}

// Local per-file request state. Global dedup only reports the delta a copy adds
// to the store, which is zero for a copied file; the legacy cumulative counter
// in that file still has to subtract everything the file itself observed.
function codexObserveModern(state, key, tokens, covered) {
  if (!isPlainObject(state.modernObserved)) state.modernObserved = {};
  const previous = Array.isArray(state.modernObserved[key])
    ? state.modernObserved[key]
    : [];
  const vector = codexTokenVector(tokens);
  const next = vector.map((value, index) =>
    Math.max(value, toNonNegInt(previous[index])),
  );
  const added = codexZeroTokens();
  for (let index = 0; index < CODEX_TOKEN_FIELDS.length; index += 1) {
    const field = CODEX_TOKEN_FIELDS[index];
    added[field] = toNonNegInt(next[index] - Math.max(toNonNegInt(previous[index]), toNonNegInt(covered?.[field])));
  }
  state.modernObserved[key] = next;
  return added;
}

function codexCumulativeVector(raw) {
  return isPlainObject(raw) ? codexTokenVector(codexNormalized(raw)) : null;
}

function codexKnownCumulative(entry) {
  if (Array.isArray(entry.thread)) return entry.thread;
  if (Array.isArray(entry.turn)) return entry.turn;
  return null;
}

// Cumulative counters are the strong identity. The vector/time fallback is
// only used for older payloads where either side lacks those counters.
function codexCumulativeTwin(entry, cumulative) {
  const known = codexKnownCumulative(entry);
  if (!Array.isArray(known) || !Array.isArray(cumulative)) return true;
  return codexSameTokens(known, cumulative);
}

// Replay-only fallback matches are not proof of a shared response. Keep the
// existing twin policy, but expose uncertain attribution instead of claiming
// exact accounting for carrier shapes without a shared identity.
function codexNoteReplayTwin(state, candidate, timestamp, responseId) {
  if (state?.forkReplay && !(responseId && responseId === candidate.responseId)
    && !(Number.isFinite(timestamp) && timestamp === candidate.timestamp)) {
    state.forkUsageAmbiguous = true;
  }
}

function codexPendingTwinKey(
  pending,
  tokens,
  timestamp,
  cumulative,
  responseId,
  turnId,
  session,
  state,
) {
  if (
    !isPlainObject(pending) ||
    (pending.session !== session && !(state.forkReplay && responseId && responseId === pending.responseId)) ||
    typeof pending.key !== "string" ||
    !codexSameTokens(pending.tokens, codexTokenVector(tokens)) ||
    !codexCloseInTime(pending.timestamp, timestamp)
  ) {
    return null;
  }
  if (responseId && pending.responseId && responseId !== pending.responseId) {
    return null;
  }
  if (
    Array.isArray(pending.cumulative) &&
    Array.isArray(cumulative) &&
    !codexSameTokens(pending.cumulative, cumulative)
  ) {
    return null;
  }
  if (turnId && pending.turnId && turnId !== pending.turnId) return null;
  codexNoteReplayTwin(state, pending, timestamp, responseId);
  return pending.key;
}

function codexSubtract(tokens, represented) {
  const out = { ...tokens };
  for (const field of CODEX_TOKEN_FIELDS) {
    out[field] = Math.max(0, tokens[field] - toNonNegInt(represented[field]));
  }
  out.nonzero = CODEX_TOKEN_FIELDS.some((field) => out[field] > 0);
  return out;
}

function codexRememberModern(state, key, tokens, timestamp, identity, delta) {
  if (!Array.isArray(state.modernRecent)) state.modernRecent = [];
  state.modernRecent.push({
    key,
    tokens: codexTokenVector(tokens),
    delta: delta ? codexTokenVector(delta) : null,
    timestamp,
    thread: identity.thread,
    turn: identity.turn,
    responseId: identity.responseId,
    turnId: identity.turnId,
    session: identity.session,
    through: state.pendingTotal ?? codexZeroTokens(),
  });
  if (state.modernRecent.length > 8) state.modernRecent.shift();
}

function codexTakeModernTwin(
  scope,
  tokens,
  timestamp,
  cumulative,
  responseId,
  turnId,
  session,
  perResponse,
  state,
) {
  if (!Array.isArray(scope.modernRecent)) return null;
  const vector = codexTokenVector(tokens);
  for (let index = scope.modernRecent.length - 1; index >= 0; index -= 1) {
    const candidate = scope.modernRecent[index];
    if (!isPlainObject(candidate) || (candidate.session !== session
      && !(state.forkReplay && responseId && responseId === candidate.responseId))) continue;
    // A legacy snapshot may report only the increment of a revised modern
    // response. Require matching cumulative counters for that weaker match.
    const sameDelta = perResponse && codexSameTokens(candidate.delta, vector)
      && codexSameTokens(codexKnownCumulative(candidate), cumulative);
    if (
      typeof candidate.key === "string" &&
      (codexSameTokens(candidate.tokens, vector) || sameDelta) &&
      codexCloseInTime(candidate.timestamp, timestamp) &&
      codexCumulativeTwin(candidate, cumulative) &&
      (!responseId || !candidate.responseId || responseId === candidate.responseId) &&
      (!turnId || !candidate.turnId || turnId === candidate.turnId)
    ) {
      scope.modernRecent.splice(index, 1);
      codexNoteReplayTwin(state, candidate, timestamp, responseId);
      return candidate;
    }
  }
  return null;
}

function parseCodex(record, ctx) {
  if (!isPlainObject(record)) return;
  const state = ctx.state;
  const payload = isPlainObject(record.payload) ? record.payload : {};
  const timestamp =
    parseTimestamp(record.timestamp) ?? state.timestamp ?? null;
  // A header timestamp is an emission fallback, not an exact carrier identity.
  const twinTimestamp = state.forkReplay ? parseTimestamp(record.timestamp) : timestamp;
  if (state.forkReplay && codexEndsForkReplay(state, record, payload)) {
    state.forkReplay = false;
    // Seed only the copied arithmetic baseline, never the parent's identity
    // evidence. An equal-sized child response is still a new response.
    const copied = state.codexReplaySpend;
    if (copied) {
      Object.assign(codexSpendScope(state, codexSession(state, ctx)), {
        legacyTotals: copied.legacyTotals, pendingTotal: copied.pendingTotal, pendingCovered: copied.pendingCovered,
      });
      delete state.codexReplaySpend;
    }
  }

  if (record.type === "session_meta") {
    const threadId = asString(
      payload.id ?? payload.session_id ?? payload.thread_id,
      "",
    );
    const firstHeader = !state.session;
    if (threadId && firstHeader) {
      state.session = threadId;
      const forkStartMs = codexUuidV7Ms(threadId);
      // Without a time-ordered thread id there is no safe boundary; keep
      // the previous behavior rather than risk dropping the child's usage.
      if (forkStartMs !== null && asString(payload.forked_from_id ?? payload.parent_thread_id, "")) {
        state.forkReplay = true;
        state.forkStartMs = forkStartMs;
      }
    }
    if (firstHeader || !state.project) {
      state.project = asString(payload.cwd, state.project ?? "unknown");
    }
    if (firstHeader || !state.provider) {
      state.provider = asString(
        payload.model_provider,
        state.provider ?? "unknown",
      );
    }
    if (firstHeader || state.timestamp === undefined) {
      state.timestamp = parseTimestamp(payload.timestamp ?? record.timestamp);
    }
    if (!state.model) state.model = "unknown";
    return;
  }

  if (record.type === "turn_context") {
    const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
    const context = {
      model: asString(payload.model, state.model ?? "unknown"),
      provider: asString(state.provider),
      project: asString(payload.cwd, state.project ?? "unknown"),
      lastUsageKey: null,
    };
    if (!isPlainObject(state.turns)) state.turns = {};
    if (turnId) {
      const previous = state.turns[turnId];
      if (previous?.lastUsageKey) context.lastUsageKey = previous.lastUsageKey;
      state.turns[turnId] = context;
    }
    state.model = context.model;
    state.project = context.project;
    return;
  }

  if (record.type === "token_usage_record") {
    const session = codexRecordSession(state, ctx, payload);
    const scope = codexSpendScope(state, session);
    // A raw copied baseline does not require an emit-ready per-turn record.
    if (state.forkReplay && isPlainObject(payload.thread_token_usage)) {
      scope.legacyTotals = codexRawTotals(payload.thread_token_usage);
      codexCoverPending(scope);
    }
    if (timestamp === null) {
      if (state.forkReplay && !isPlainObject(payload.thread_token_usage)) state.forkUsageAmbiguous = true;
      ctx.warn("Codex token usage record has no usable timestamp; skipped");
      return;
    }
    const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
    const context = codexContext(state, turnId);
    const usage = isPlainObject(payload.usage) ? payload.usage : null;
    if (!usage) return;
    const tokens = codexNormalized(usage);
    if (!tokens.nonzero) return;
    const responseId = asString(payload.response_id, "");
    const thread = codexCumulativeVector(payload.thread_token_usage);
    const turn = codexCumulativeVector(payload.turn_token_usage);
    const identity = { thread, turn, responseId, turnId, session };
    const responseKey = responseId ? makeDedupKey("codex", "response", responseId)
      : makeDedupKey("codex", "turn", session, turnId, record.timestamp ?? ctx.lineHash, ...codexTokenVector(tokens));
    const pending = scope.pendingTwin;
    const twinKey = codexPendingTwinKey(pending, tokens, twinTimestamp, thread ?? turn, responseId, turnId, session, state);
    scope.pendingTwin = null;

    if (state.forkReplay) {
      const key = scope.responseKeys?.[`:${responseId}`] ?? twinKey ?? responseKey;
      if (responseId && twinKey) (scope.responseKeys ??= {})[`:${responseId}`] = key;
      const observed = codexObserveModern(scope, key, tokens);
      // Thread baselines already cover the observation; turn counters do not.
      if (!isPlainObject(payload.thread_token_usage) && !twinKey) codexAddPending(scope, observed);
      codexRememberModern(scope, key, tokens, twinTimestamp, identity);
      return;
    }
    const { candidate, snapshot: earlier, checkpoint, inferred } = observeCodexResponse(
      scope, payload.thread_token_usage, usage, { responseId, turnId, key: responseKey },
    );
    const snapshot = earlier ?? (twinKey && pending.perResponse
      ? { key: twinKey, tokens: pending.amount } : null);
    const meta = metaFor("codex", session, timestamp, context.project, context.provider, context.model);
    if (responseId) {
      ctx.addCodexResponse(meta, tokens, responseKey);
      if (snapshot) ctx.linkCodexSnapshot(snapshot.key, responseKey);
    } else {
      ctx.addUsage(meta, tokens, snapshot?.key ?? responseKey);
    }
    const covered = checkpoint
      ? Object.fromEntries(CODEX_TOKEN_FIELDS.map((field) => [field, Math.min(tokens[field], checkpoint.tokens[field])]))
      : snapshot?.tokens;
    if (checkpoint) ctx.linkCodexSnapshot(checkpoint.key, responseKey, covered);
    const key = !responseId && snapshot ? snapshot.key : responseKey;
    const observed = codexObserveModern(scope, key, tokens, covered);
    codexAddPending(scope, observed);
    if (candidate) candidate.through = scope.pendingTotal;
    if (snapshot?.total) advanceCodexEcho(scope, candidate, snapshot.total, snapshot.usage);
    if (inferred) state.codexInferredEcho = true;
    codexRememberModern(scope, key, tokens, timestamp, identity, observed);
    codexSetUsageTarget(state, scope, turnId, context, key);
    return;
  }

  if (record.type === "event_msg" && payload.type === "token_count") {
    const info = isPlainObject(payload.info) ? payload.info : {};
    const rawTotal = isPlainObject(info.total_token_usage) ? info.total_token_usage : null;
    const totals = rawTotal ? codexRawTotals(rawTotal) : null;
    const last = isPlainObject(info.last_token_usage) ? info.last_token_usage : null;
    const responseId = asString(payload.response_id, "");
    const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
    const session = codexRecordSession(state, ctx, payload);
    const scope = codexSpendScope(state, session);
    const responseKey = responseId ? makeDedupKey("codex", "response", responseId) : null;
    if (state.forkReplay && totals) {
      // Baselines need neither a usable timestamp nor per-response usage.
      scope.legacyTotals = totals;
      codexCoverPending(scope);
      scope.pendingTwin = null;
      if (last) {
        const tokens = codexNormalized(last);
        const key = responseKey ?? makeDedupKey("codex", session, "legacy", record.timestamp ?? ctx.lineHash, ...Object.values(totals));
        const thread = codexCumulativeVector(totals);
        codexRememberModern(scope, key, tokens, twinTimestamp, { thread, responseId, turnId, session });
        scope.pendingTwin = { key, tokens: codexTokenVector(tokens), timestamp: twinTimestamp, cumulative: thread, responseId, turnId, session };
      }
      return;
    }
    if (timestamp === null) {
      if (state.forkReplay && last) state.forkUsageAmbiguous = true;
      return;
    }
    // A scalar context estimate is not spend or a spending baseline.
    if (!state.forkReplay && last && toNonNegInt(last.total_tokens) && !codexNormalized(last).nonzero) return;
    if (!last && !totals) return;

    const context = codexContext(state, turnId);
    const previous = scope.legacyTotals;
    const reset = Boolean(totals && previous && Object.keys(totals).some((key) => totals[key] < previous[key]));
    const perResponse = Boolean(last && totals);
    const signature = perResponse
      ? makeDedupKey("codex", session, "legacy-response", turnId, ...Object.values(totals), ...Object.values(codexRawTotals(last)))
      : makeDedupKey("codex", session, last ? "legacy-last" : "legacy", record.timestamp ?? ctx.lineHash,
        ...Object.values(last ? codexRawTotals(last) : totals));
    const key = last && responseKey
      ? (state.forkReplay ? responseKey : makeDedupKey("codex", "snapshot-response", session, responseId))
      : signature;
    const seenKey = last && responseId ? `${key}:${signature}` : signature;
    const seen = !state.forkReplay && scope.snapshotTargets?.[seenKey];
    if (seen) {
      codexSetUsageTarget(state, scope, turnId, context, seen, false);
      return; // Never let a re-emission rewind the baseline or consume pending usage.
    }

    scope.pendingTwin = null;
    let tokens;
    if (last) {
      tokens = codexNormalized(last);
    } else {
      const raw = Object.fromEntries(Object.keys(totals).map((field) => [
        field, (!previous || reset) ? totals[field] : totals[field] - previous[field],
      ]));
      // No cumulative progress: in particular, retain any newer modern spend.
      if (!Object.values(raw).some(Boolean) && previous && !reset) return;
      tokens = codexNormalized(raw);
      if (!reset) tokens = codexSubtract(tokens, codexPendingTokens(scope));
    }

    const cumulative = codexCumulativeVector(totals);
    const match = !state.forkReplay && last ? matchCodexSnapshot(scope, rawTotal, last, { responseId, turnId }) : null;
    const compat = !match && (state.forkReplay || last) && (!reset || perResponse)
      ? codexTakeModernTwin(scope, tokens, twinTimestamp, cumulative, responseId, turnId, session, perResponse, state)
      : null;
    const echo = match?.candidate ?? compat;
    if (totals) {
      if (!echo) {
        scope.legacyTotals = totals;
        codexCoverPending(scope);
        if (reset && !last) {
          delete scope.anchor;
          delete scope.provisional;
        }
      } else if (!reset && (echo.total
        ? advanceCodexEcho(scope, echo, rawTotal, last)
        : !echo.seq || echo.seq >= (scope.anchor?.seq ?? 0))) {
        scope.legacyTotals = totals;
        codexCoverPending(scope, echo.through ?? codexZeroTokens());
      }
    }
    if (!tokens.nonzero) return;
    if (state.forkReplay) {
      const dedupKey = echo?.key ?? key;
      const observed = codexObserveModern(scope, dedupKey, tokens);
      if (echo && dedupKey !== key) codexObserveModern(scope, key, tokens);
      if (!echo && CODEX_TOKEN_FIELDS.some((field) => observed[field] > 0)) {
        if (scope.legacyTotals) state.forkUsageAmbiguous = true;
        else codexAddPending(scope, observed);
      }
      if (responseId && echo) (scope.responseKeys ??= {})[`:${responseId}`] = dedupKey;
      scope.pendingTwin = { key: dedupKey, tokens: codexTokenVector(tokens), timestamp: twinTimestamp, cumulative, responseId, turnId, session };
      return;
    }

    if (match?.inferred) state.codexInferredEcho = true;
    // A stale history-last vector is not another observation of the response
    // that just advanced the counter.
    const target = match?.staleLast ? echo.key : key;
    if (!match?.staleLast) {
      ctx.addUsage(metaFor("codex", session, timestamp, context.project, context.provider, context.model), tokens, key);
      if (last && (responseKey || echo)) ctx.linkCodexSnapshot(key, responseKey ?? echo.key);
    }
    (scope.snapshotTargets ??= {})[seenKey] = target;
    codexSetUsageTarget(state, scope, turnId, context, target, !echo || !scope.lastUsageKey);
    if (!echo) {
      rememberCodexSnapshot(scope, rawTotal, last, { key, tokens, responseId, turnId }, previous);
      scope.pendingTwin = { key, tokens: codexTokenVector(tokens), amount: tokens, perResponse: Boolean(last),
        timestamp, cumulative, responseId, turnId, session };
    }
    return;
  }

  if (record.type === "event_msg" && payload.type === "task_complete") {
    const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
    const context = codexContext(state, turnId);
    let duration = Number.isFinite(payload.duration_ms)
      ? toNonNegInt(payload.duration_ms)
      : 0;
    if (!duration) {
      const started = Number(payload.started_at);
      const completed = Number(payload.completed_at);
      if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) {
        duration = toNonNegInt((completed - started) * 1000);
      }
    }
    if (duration <= 0) return;
    const session = codexRecordSession(state, ctx, payload);
    const target = context.lastUsageKey ?? codexSpendScope(state, session).lastUsageKey;
    if (!target || state.forkReplay) return;
    ctx.addCodexTask(
      target,
      taskKeyFor(
        "codex",
        "task",
        session,
        turnId || record.timestamp || payload.completed_at || duration,
      ),
      duration,
      session,
    );
  }
}

// ---------------------------------------------------------------------------
// Antigravity compact transcript fallback; counts are per model step.
function parseAntigravity(record, ctx) {
  if (!isPlainObject(record) || record.source !== "MODEL") return;
  if (!Number.isSafeInteger(record.step_index) || record.step_index < 0) return;
  const conversation = antigravityConversation(ctx.file.path);
  const timestamp = parseTimestamp(record.created_at);
  if (timestamp === null) {
    ctx.warn("Antigravity model step has no usable timestamp; skipped");
    return;
  }
  const tokens = normalizeTokens({
    input: record.input_tokens,
    output: record.output_tokens,
    cacheRead: record.cache_read_tokens,
  });
  if (!tokens.nonzero) return;
  const session = `antigravity:${conversation}`;
  ctx.addUsage(
    metaFor("antigravity", session, timestamp, record.workspace, record.provider, record.model),
    tokens,
    makeDedupKey("antigravity", conversation, record.step_index),
  );
}

// ---------------------------------------------------------------------------
// Declarative custom JSONL

export function getPath(object, path) {
  if (typeof path !== "string" || !path) return undefined;
  const parts = path.split(".");
  let current = object;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, part)) return undefined;
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveField(spec, record, fallback) {
  if (!spec) return fallback;
  if (Object.hasOwn(spec, "literal")) return spec.literal;
  const value = getPath(record, spec.path);
  if (value === undefined || value === null) {
    return Object.hasOwn(spec, "default") ? spec.default : fallback;
  }
  return value;
}

function customIncludes(mapping, record) {
  if (!Array.isArray(mapping.include)) return true;
  for (const condition of mapping.include) {
    const value = getPath(record, condition.path);
    if (Object.hasOwn(condition, "exists")) {
      if (condition.exists && value === undefined) return false;
      if (!condition.exists && value !== undefined) return false;
    } else if (value !== condition.equals) {
      return false;
    }
  }
  return true;
}

function customString(value, fallback = "unknown") {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function parseCustom(record, ctx) {
  if (!isPlainObject(record)) return;
  const mapping = ctx.source.mapping;
  if (!customIncludes(mapping, record)) return;

  if (mapping.roles) {
    const role = customString(resolveField(mapping.role, record), "");
    if (!mapping.roles.includes(role)) return;
  }

  const rawSession = customString(resolveField(mapping.session, record), "");
  const session = rawSession
    ? `custom:${ctx.source.id}:${rawSession}`
    : `custom:${ctx.source.id}:file:${ctx.file.path}`;
  const timestamp = parseTimestamp(resolveField(mapping.timestamp, record));
  if (timestamp === null) {
    ctx.warn(`custom source ${ctx.source.id}: record has no usable timestamp; skipped`);
    return;
  }
  const project = customString(resolveField(mapping.project, record));
  const provider = customString(resolveField(mapping.provider, record));
  const model = customString(resolveField(mapping.model, record));
  const harness = mapping.harness ?? ctx.source.id;

  const rawUsage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
    const spec = mapping.usage[key];
    if (spec) rawUsage[key] = resolveField(spec, record, 0);
  }
  const tokens = normalizeTokens(rawUsage);
  if (!tokens.nonzero) return;

  const messageValue = resolveField(mapping.messageId, record);
  const messageId = customString(messageValue, "");
  const identity = messageId
    ? ["message", messageId]
    : ["line", session, timestamp, ctx.lineHash];
  const dedupKey = makeDedupKey(harness, ...identity);
  const result = ctx.addUsage(
    metaFor(harness, session, timestamp, project, provider, model),
    tokens,
    dedupKey,
  );

  if (mapping.taskDurationMs) {
    const durationValue = resolveField(mapping.taskDurationMs, record);
    if (typeof durationValue === "number" && Number.isFinite(durationValue)) {
      const duration = toNonNegInt(durationValue);
      if (duration > 0) {
        ctx.addTask(
          result.fileId,
          result.rowIdx,
          makeTaskKey(harness, "custom-task", dedupKey),
          duration,
          session,
          true,
        );
      }
    }
  }
}

export const ADAPTER_PARSERS = {
  pi: parsePi,
  claude: parseClaude,
  codex: parseCodex,
  antigravity: parseAntigravity,
  custom: parseCustom,
};

export function parseAdapterRecord(adapter, record, ctx) {
  const parser = ADAPTER_PARSERS[adapter];
  if (!parser) throw new Error(`unknown adapter ${adapter}`);
  parser(record, ctx);
}

// Keep lint honest about the public helpers that tests may import.
export { metaFor, piMainSession, claudeSession, codexSession, resolveField };
export { hashKey };
