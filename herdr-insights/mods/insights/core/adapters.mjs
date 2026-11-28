import { antigravityConversation } from "./antigravity.mjs";
import {
  codexRawVector, codexResponseIdKey, codexSpendScope,
  clearCodexPending, excludeCodexCompaction, isCodexWindowFill, recordCodexSpend, settleCodexInterval,
} from "./codex-spend.mjs";
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

function codexPayloadThread(payload) {
  return asString(
    payload.thread_id ??
      payload.session_id ??
      payload.threadId ??
      payload.sessionId,
    "",
  );
}

function codexRecordSession(state, ctx, payload) {
  const threadId = codexPayloadThread(payload);
  if (threadId) return `codex:${threadId}`;
  if (payload.type === "token_count" && state.codexImportThread) return state.codexImportThread;
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
  // Some copied rollouts have a cutoff that includes already-owned history.
  // Explicit child ownership is stronger than that conflicting cutoff.
  if (payload.thread_id === state.session && ((record.type === "event_msg" && payload.type === "thread_settings_applied") ||
    (state.codexFirstChildOrdinal !== undefined && record.type === "token_usage_record"))) return true;
  const hasOrdinal = Number.isSafeInteger(state.codexFirstChildOrdinal) && Number.isSafeInteger(record.ordinal);
  if (hasOrdinal) {
    if (record.ordinal >= state.codexFirstChildOrdinal) return true;
    if (!state.codexLegacyForkOrdinal) return false;
  }
  if (record.type !== "turn_context" && !(record.type === "event_msg" && payload.type === "task_started")) {
    return false;
  }
  const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
  const turnMs = codexUuidV7Ms(turnId);
  if (!hasOrdinal && (turnMs === null || turnMs === state.forkStartMs)) state.forkBoundaryAmbiguous = true;
  return turnMs !== null && turnMs > state.forkStartMs;
}

function codexTurn(state, scope, id) {
  const key = codexResponseIdKey(id);
  return scope.turns?.[key] ?? {
    model: scope.model ?? "unknown", provider: state.provider, project: scope.project ?? state.project, lastUsageKey: null,
    ...state.codexTurnMetadata?.[key],
  };
}

function codexTarget(scope, id, context, key) {
  if (id) ((scope.turns ??= {})[codexResponseIdKey(id)] = context).lastUsageKey = key;
  scope.lastUsageKey = key;
}

function codexNormalized([input, read, write, output, reasoning]) {
  read = Math.min(input, read);
  write = Math.min(input - read, write);
  return normalizeTokens({ input: input - read - write, cacheRead: read, cacheWrite: write, output, reasoning });
}

// Only old copied prefixes use last-only carriers. They are not a reliable
// cumulative baseline unless their copied response or raw timestamp agrees.
function codexReplayLast(state, scope, kind, key, vector, timestamp, responseId) {
  const previous = scope.replayLast;
  const sameId = responseId && responseId === previous?.responseId;
  const sameTime = Number.isFinite(timestamp) && timestamp === previous?.timestamp;
  const sameVector = String(previous?.vector) === String(vector);
  const compatible = !(previous?.responseId && responseId) && sameVector;
  const twin = previous && previous.kind !== kind && (sameId || compatible);
  const repeat = previous && previous.kind === kind && (sameId || (sameTime && compatible));
  if ((!Number.isFinite(timestamp) && !responseId) || (twin && !sameId && !sameTime)) state.forkUsageAmbiguous = true;
  if (scope.historyTotal && kind === "last" && !sameId && !sameTime) state.forkUsageAmbiguous = true;
  const identity = twin || repeat ? previous.key : key;
  if (!scope.historyTotal && !scope.replayThreadTotal) recordCodexSpend(scope, identity, vector);
  scope.replayLast = { kind, key: identity, vector, timestamp, responseId: responseId || ((twin || repeat) && previous.responseId) || "" };
}

function codexBeginTurn(scope, turnId) {
  if (!turnId) return;
  if (scope.pendingTurn && scope.pendingTurn !== turnId && !scope.pendingTurnCompleted) {
    scope.previousPending = { turn: scope.pendingTurn, delta: scope.recordDelta, records: { ...scope.pendingRecords } };
  }
  scope.activeTurnId = turnId;
}

function parseCodex(record, ctx, embedded = false) {
  if (!isPlainObject(record)) return;
  const state = ctx.state;
  if (ctx.lineNo === undefined && !embedded) state.codexOrdinal = (state.codexOrdinal ?? 0) + 1;
  const ordinal = ctx.lineNo ?? state.codexOrdinal;
  const payload = isPlainObject(record.payload) ? record.payload : {};
  const rawTimestamp = parseTimestamp(record.timestamp);
  const timestamp = rawTimestamp ?? state.timestamp ?? null;
  if (state.forkReplay && codexEndsForkReplay(state, record, payload)) {
    state.forkReplay = false;
    delete state.codexReplayParent;
    const copied = state.codexReplaySpend;
    if (copied) {
      const child = codexSpendScope(state, codexSession(state, ctx));
      // Restored history wins even if the independent record counter was
      // later replayed. No copied response identity is inherited.
      child.historyTotal = copied.historyTotal;
      child.copiedHistory = Boolean(copied.historyTotal);
      if (!child.historyTotal) {
        if (copied.replayThreadTotal) child.forkHistoryUnknown = true;
        else child.recordDelta = copied.recordDelta; // Last-only compatibility.
      }
      delete state.codexReplaySpend;
    }
  }
  if (record.type === "session_meta") {
    const id = asString(payload.id ?? payload.session_id ?? payload.thread_id, "");
    if (!state.session || (id && id !== state.session && state.forkStartMs === undefined)) {
      if (id) state.session = id;
      delete state.codexTurnMetadata;
      state.project = asString(payload.cwd, "unknown");
      state.provider = asString(payload.model_provider, "unknown");
      state.timestamp = parseTimestamp(payload.timestamp ?? record.timestamp);
      const base = payload.history_base;
      state.codexPhysicalId = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(ctx.file.path)?.[1] ?? id;
      if (isPlainObject(base) && typeof base.thread_id === "string" && base.thread_id !== state.codexPhysicalId &&
        Number.isSafeInteger(base.end_ordinal_exclusive) && base.end_ordinal_exclusive > 0 &&
        Number.isSafeInteger(base.end_byte_offset) && base.end_byte_offset > 0) {
        state.codexHistoryBase = [base.thread_id, base.end_ordinal_exclusive, base.end_byte_offset];
      }
      state.codexPaginated = payload.history_mode === "paginated";
      const forkParent = asString(payload.forked_from_id ?? payload.parent_thread_id, "");
      if (Number.isSafeInteger(payload.subagent_history_start_ordinal) && payload.subagent_history_start_ordinal >= 0) {
        state.codexFirstChildOrdinal = payload.subagent_history_start_ordinal;
        const version = typeof payload.cli_version === "string" && /^0\.(\d+)\.(\d+)/.exec(payload.cli_version);
        // Before record-bearing releases, copied agent rollouts could include
        // already-owned turns below the stored cutoff. Retain the legacy
        // turn boundary for those releases only.
        state.codexLegacyForkOrdinal = Boolean(version && (+version[1] < 153 || (+version[1] === 153 && +version[2] < 4)));
      }
      // A referenced inherited-session agent inherits context, not the
      // parent's TokenCount events. A later revert can reference the agent's
      // own already-published history beyond the parent boundary.
      const inheritedSession = typeof payload.session_id === "string" && payload.session_id !== id;
      const cutoff = payload.forked_from_ordinal_exclusive;
      const projectsAncestor = state.codexHistoryBase && inheritedSession &&
        (Number.isSafeInteger(cutoff) ? base.end_ordinal_exclusive <= cutoff : base.thread_id === payload.forked_from_id);
      const copiedProjection = !state.codexHistoryBase && state.codexPaginated && state.codexFirstChildOrdinal !== undefined;
      state.codexPaginatedFork = state.codexPaginated && Boolean(forkParent || copiedProjection);
      state.codexFilteredHistory = Boolean(state.codexPaginated && (projectsAncestor || copiedProjection));
      const forkStartMs = codexUuidV7Ms(id);
      if (!state.codexHistoryBase && (copiedProjection || (forkParent && forkStartMs !== null))) {
        state.forkReplay = true;
        state.forkStartMs = forkStartMs;
        if (forkParent && ctx.observeCodexTask) state.codexReplayParent = `codex:${forkParent}`;
      }
    } else if (!state.forkReplay && id && id === state.session) {
      const scope = codexSpendScope(state, codexSession(state, ctx));
      clearCodexPending(scope);
      delete scope.previousPending;
      scope.resumeBoundary = true;
    }
    return;
  }

  if (!["turn_context", "compacted", "token_usage_record"].includes(record.type) &&
    !(record.type === "event_msg" && ["token_count", "task_started", "task_complete"].includes(payload.type))) return;
  const session = codexRecordSession(state, ctx, payload);
  const responseId = asString(payload.response_id, "");
  const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
  const scope = codexSpendScope(state, session);
  const activeTurn = turnId || scope.activeTurnId || "";
  const context = codexTurn(state, scope, activeTurn);
  const timeKey = record.timestamp ?? ctx.lineHash ?? timestamp;
  if (record.type === "turn_context") {
    const meta = { model: asString(payload.model, scope.model ?? "unknown"),
      provider: asString(state.provider), project: asString(payload.cwd, scope.project ?? state.project ?? "unknown") };
    Object.assign(scope, meta);
    if (turnId) {
      const key = codexResponseIdKey(turnId);
      (scope.turns ??= {})[key] = { ...meta, lastUsageKey: scope.turns?.[key]?.lastUsageKey ?? null };
      codexBeginTurn(scope, turnId);
      if (!codexPayloadThread(payload)) delete state.codexImportThread;
      if (!payload.thread_id && !payload.session_id && !payload.threadId && !payload.sessionId) {
        (state.codexTurnMetadata ??= {})[key] = meta;
      }
    }
    return;
  }
  if (record.type === "event_msg" && payload.type === "task_started") {
    codexBeginTurn(scope, turnId);
    if (!codexPayloadThread(payload)) delete state.codexImportThread;
    return;
  }
  if (record.type === "compacted") {
    const id = asString(payload.compaction_response_id, "");
    const usage = payload.latest_token_usage_record;
    const latestId = isPlainObject(usage) ? asString(usage.response_id, "") : "";
    if (!state.forkReplay && latestId && (!codexPayloadThread(usage) || codexRecordSession(state, ctx, usage) === session)) {
      const known = scope.responses?.[codexResponseIdKey(latestId)];
      parseCodex({ type: "token_usage_record", timestamp: record.timestamp, payload: usage }, ctx, true);
      if (!known && latestId !== id) excludeCodexCompaction(scope, latestId);
    }
    if (id) excludeCodexCompaction(scope, id);
    return;
  }
  if (record.type === "token_usage_record") {
    const usage = isPlainObject(payload.usage) ? payload.usage : null;
    if (state.forkReplay && isPlainObject(payload.thread_token_usage)) scope.replayThreadTotal = true;
    if (timestamp === null) {
      if (state.forkReplay && !scope.replayThreadTotal) state.forkUsageAmbiguous = true;
      ctx.warn("Codex token usage record has no usable timestamp; skipped");
      return;
    }
    if (!usage) return;
    const vector = codexRawVector(usage);
    const tokens = codexNormalized(vector);
    if (!tokens.nonzero) return;
    const key = responseId ? makeDedupKey("codex", "response", responseId)
      : makeDedupKey("codex", "turn", session, turnId, timeKey, ...vector);
    if (ctx.observeCodexLegacyKey) {
      const value = [vector[0], tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite];
      ctx.observeCodexLegacyKey(key, value, Boolean(responseId && !state.forkReplay));
      if (!responseId) ctx.observeCodexLegacyKey(makeDedupKey("codex", "turn", session, turnId, timeKey,
        tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning), value);
    }
    if (state.forkReplay) {
      codexReplayLast(state, scope, "record", key, vector, rawTimestamp, responseId);
      return;
    }
    if (!responseId) state.codexAmbiguousEcho = true;
    if (turnId && session !== codexSession(state, ctx) &&
      state.codexSpend?.[codexSession(state, ctx)]?.activeTurnId === turnId) state.codexImportThread = session;
    scope.carrierDepth = (scope.carrierDepth ?? 0) + 1;
    if (!scope.responses && activeTurn && scope.legacyLastTurn === activeTurn && String(scope.legacyLast) === String(vector)) {
      state.codexPossibleSnapshotFirst = true;
    }
    // Diagnostic only: timestamps do not participate in interval matching.
    if (rawTimestamp !== null) {
      if (rawTimestamp < (scope.latestSnapshotAt ?? -Infinity)) state.codexCarrierOrderAmbiguous = true;
      scope.latestRecordAt = Math.max(rawTimestamp, scope.latestRecordAt ?? -Infinity);
    }
    ctx.addCodexUsage(metaFor("codex", session, timestamp, context.project, context.provider, context.model), tokens, key);
    const responseKey = responseId ? codexResponseIdKey(responseId) : key;
    // Save raw carrier identity only for revisions and their overlapping
    // observations; the response ID is still the spend ledger identity.
    const known = scope.responses?.[responseKey];
    const coalescedRevision = scope.pendingRecords?.[responseKey];
    const delta = recordCodexSpend(scope, responseKey, vector, scope.legacyHistoryResponses?.[responseKey]);
    if (scope.recordDelta && activeTurn) {
      scope.pendingTurn = activeTurn;
      scope.pendingTurnCompleted = false;
    }
    const carrier = makeDedupKey("codex", "record-carrier", key, timeKey, ...vector);
    if (known) (scope.revisionCarriers ??= {})[carrier] = delta;
    if (coalescedRevision && scope.pendingCarriers) delete scope.pendingCarriers[responseKey];
    else if (delta?.some(Boolean)) (scope.pendingCarriers ??= {})[responseKey] = carrier;
    if (scope.legacyHistoryResponses) delete scope.legacyHistoryResponses[responseKey];
    codexTarget(scope, activeTurn, context, key);
    scope.lastCarrierKey = key;
    return;
  }
  if (record.type === "event_msg" && payload.type === "token_count") {
    const info = isPlainObject(payload.info) ? payload.info : {};
    const total = isPlainObject(info.total_token_usage) ? info.total_token_usage : null;
    const last = isPlainObject(info.last_token_usage) ? info.last_token_usage : null;
    if (!total && !last) return;
    const vector = total ? codexRawVector(total) : null;
    const lastVector = last ? codexRawVector(last) : null;
    const windowFill = total && isCodexWindowFill(info, total, last) ? `${total.total_tokens}/${last.total_tokens}` : null;
    if (total && !windowFill && !vector.some(Boolean) && toNonNegInt(total.total_tokens)) return;
    const key = makeDedupKey("codex", session, "history", timeKey, responseId, turnId, vector, lastVector);
    if (total && session === codexSession(state, ctx)) {
      const physicalOrdinal = Number.isSafeInteger(record.ordinal) ? record.ordinal + 1 :
        ordinal + (state.codexHistoryBase?.[1] ?? 0);
      (state.codexHistoryPoints ??= []).push([physicalOrdinal, ctx.lineEnd ?? 0, vector]);
    }
    const alias = responseId && total && last ? makeDedupKey("codex", "response", responseId)
      : total && last ? makeDedupKey("codex", session, "legacy-response", turnId, ...vector, ...lastVector)
      : makeDedupKey("codex", session, total ? "legacy" : "legacy-last", timeKey, ...(vector ?? lastVector));
    const namedAlias = Boolean(responseId && total && last);
    const modern = Boolean(scope.responses);
    const legacyKey = !modern && responseId && last ? makeDedupKey("codex", "snapshot-response", session, responseId) : key;
    // Historical v5–v8 knew only timestamp-and-cumulative identities. v9
    // added per-response aliases without changing the historical scheme.
    const historical = total && last ? makeDedupKey("codex", session, "legacy", timeKey, ...vector) : null;
    const rawLast = !total && last && [last.input_tokens, last.cached_input_tokens, last.cache_write_input_tokens,
      last.output_tokens, last.reasoning_output_tokens];
    const historicalLast = rawLast && rawLast.every((value) => value !== undefined)
      ? makeDedupKey("codex", session, "legacy-last", timeKey, ...rawLast) : null;
    // A copied carrier can prove a prior index entry without being spend
    // of this thread. Named snapshots still cannot witness standalone
    // records merely by naming them; only their history identity is here.
    if (timestamp !== null && ctx.observeCodexLegacyKey) {
      if (historical) ctx.observeCodexLegacyKey(historical);
      if (historicalLast) ctx.observeCodexLegacyKey(historicalLast);
      if (!namedAlias) ctx.observeCodexLegacyKey(alias);
      if (legacyKey !== alias) ctx.observeCodexLegacyKey(legacyKey);
    }
    if (state.forkReplay) {
      if (total) {
        const mark = String(vector);
        if (!vector.some(Boolean) && scope.historyTotal?.some(Boolean)) delete scope.replayHistory;
        const seen = scope.replayHistory ??= {};
        if (!seen[mark] || String(scope.historyTotal) === mark) {
          scope.historyTotal = vector;
          seen[mark] = true;
          delete scope.recordDelta;
          delete scope.pendingRecords;
          if (lastVector?.some(Boolean)) scope.replayLast = { kind: "last", key, vector: lastVector, timestamp: rawTimestamp, responseId };
        }
      } else if (lastVector.some(Boolean)) {
        const lastKey = responseId ? makeDedupKey("codex", "response", responseId) : key;
        codexReplayLast(state, scope, "last", lastKey, lastVector, rawTimestamp, responseId);
      }
      return;
    }
    if (timestamp === null) return;
    const legacySignature = !modern && last && total
      ? makeDedupKey("codex", session, "legacy-response", scope.legacyEpoch ?? 0, turnId, responseId, ...vector, ...lastVector) : key;
    const identifiedLegacy = !modern && Boolean(responseId && last);
    const target = metaFor("codex", session, timestamp, context.project, context.provider, context.model);
    const referenced = total && !scope.historyTotal && state.codexHistoryBase && session === codexSession(state, ctx);
    const boundary = referenced ? "referenced" : !scope.historyTotal && state.codexFilteredHistory ? "projected-fork"
      : scope.copiedHistory ? "copied" : scope.resumeBoundary ? "resume"
      : !scope.historyTotal && state.codexPaginatedFork ? "clipped-paginated"
        : !scope.historyTotal && state.codexPaginated && modern ? "paginated-root" : modern ? "modern" : "legacy";
    let charge;
    if (total) {
      if (scope.forkHistoryUnknown) {
        state.forkUsageAmbiguous = true;
        delete scope.forkHistoryUnknown;
      }
      if (!windowFill && (scope.intervals?.[key] !== undefined || scope.historySeen?.[legacySignature])) return;
      if (rawTimestamp !== null) {
        if (rawTimestamp < (scope.latestRecordAt ?? -Infinity)) state.codexCarrierOrderAmbiguous = true;
        scope.latestSnapshotAt = Math.max(rawTimestamp, scope.latestSnapshotAt ?? -Infinity);
      }
      if (!modern && !vector.some(Boolean) && scope.historyTotal?.some(Boolean)) scope.legacyEpoch = (scope.legacyEpoch ?? 0) + 1;
      const old = turnId && scope.previousPending?.turn === turnId ? scope.previousPending : null;
      const input = { boundary, baseline: scope.historyTotal, total: vector, last: lastVector,
        inheritance: (referenced || boundary === "projected-fork") && state.codexFilteredHistory ? "filtered" : undefined,
        priorLast: scope.legacyLast, fill: windowFill, priorFill: scope.windowFill,
        interrupted: !old ? scope.previousPending?.delta : undefined,
        interruptedRecords: !old ? scope.previousPending?.records : undefined,
        pending: old?.delta ?? scope.recordDelta, records: old?.records ?? scope.pendingRecords };
      if (!scope.historyTotal && !modern) scope.startedWithoutRecord = true;
      const settled = settleCodexInterval({ ...input, target });
      charge = settled.charge;
      if (referenced && !windowFill) {
        state.codexReferencedInterval = { key: legacyKey, input: { ...input, target: settled.target } };
        scope.copiedHistory = true;
      }
      if (scope.pendingCarriers && !old && settled.next.close && !windowFill &&
        (charge?.some(Boolean) || scope.startedWithoutRecord)) {
        (scope.intervalInputs ??= {})[referenced ? legacyKey : key] = [{ ...input, target }, scope.pendingCarriers];
      }
      scope.historyTotal = settled.next.historyTotal;
      scope.windowFill = settled.next.windowFill;
      if (settled.next.close) {
        if (old) {
          const remaining = { ...scope.pendingRecords };
          for (const [id, prior] of Object.entries(old.records ?? {})) {
            if (!remaining[id]) continue;
            const delta = remaining[id].map((n, i) => n - prior[i]);
            if (delta.some(Boolean)) remaining[id] = delta;
            else delete remaining[id];
            if (scope.pendingCarriers) delete scope.pendingCarriers[id];
          }
          scope.pendingRecords = remaining;
          scope.recordDelta = (scope.recordDelta ?? [0, 0, 0, 0, 0]).map((n, i) => n - (old.delta?.[i] ?? 0));
        } else clearCodexPending(scope);
        delete scope.previousPending;
        delete scope.resumeBoundary;
      }
      if (!modern) (scope.historySeen ??= {})[legacySignature] = true;
      scope.legacyLast = lastVector;
      scope.legacyLastTurn = activeTurn;
      const responseKey = identifiedLegacy && codexResponseIdKey(responseId);
      const prior = responseKey && scope.legacyHistoryResponses?.[responseKey];
      if (responseKey && settled.next.useLast) (scope.legacyHistoryResponses ??= {})[responseKey] = lastVector;
      if (!charge && prior && lastVector && prior[0] === lastVector[0] && prior[3] === lastVector[3]) {
        ctx.addCodexUsage(target, codexNormalized(lastVector), legacyKey);
      }
      const tokens = charge && codexNormalized(charge);
      scope.carrierDepth = (scope.carrierDepth ?? 0) + 1;
      const intervalKey = referenced ? legacyKey : key;
      (scope.intervals ??= {})[intervalKey] = [scope.carrierDepth, tokens?.nonzero
        ? [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning] : 0];
      if (scope.lastCarrierKey && !tokens?.nonzero) (scope.intervalTargets ??= {})[intervalKey] = scope.lastCarrierKey;
      if (tokens?.nonzero && target.model !== "unknown") (scope.intervalRows ??= {})[intervalKey] = settled.target;
      if (referenced && !windowFill) codexTarget(scope, activeTurn, context, legacyKey);
    } else {
      if (!lastVector.some(Boolean)) return;
      if (modern) state.codexAmbiguousEcho = true;
      charge = settleCodexInterval({ boundary, last: lastVector, target }).charge;
    }
    const tokens = charge && codexNormalized(charge);
    if (!tokens?.nonzero) return;
    if (namedAlias) ctx.observeCodexLegacyKey?.(alias, [charge[0], tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]);
    ctx.addCodexUsage(target, tokens, legacyKey);
    if (state.codexReferencedInterval?.key !== legacyKey) {
      (state.codexLegacyAliases ??= {})[legacyKey] = historical || historicalLast ? [alias, historical ?? historicalLast] : alias;
    }
    if (identifiedLegacy) ctx.linkCodexSnapshot(legacyKey, makeDedupKey("codex", "response", responseId));
    codexTarget(scope, activeTurn, context, legacyKey);
    return;
  }
  if (record.type === "event_msg" && payload.type === "task_complete") {
    let duration = Number.isFinite(payload.duration_ms) ? toNonNegInt(payload.duration_ms) : 0;
    if (!duration) {
      const started = Number(payload.started_at);
      const completed = Number(payload.completed_at);
      if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) duration = toNonNegInt((completed - started) * 1000);
    }
    // Like main, a no-spend completion uses the thread's previous usage
    // bucket when available, including a turn with its own context.
    const target = context.lastUsageKey ?? scope.lastUsageKey;
    if (activeTurn && activeTurn === scope.pendingTurn) scope.pendingTurnCompleted = true;
    if (activeTurn && activeTurn === scope.activeTurnId) delete scope.activeTurnId;
    if (!duration) return;
    const carrier = turnId || record.timestamp || payload.completed_at;
    const taskKey = taskKeyFor("codex", "task", session, carrier || activeTurn || duration);
    const legacyKey = carrier || !activeTurn ? taskKey : taskKeyFor("codex", "task", session, duration);
    if (state.forkReplay) {
      const parent = state.codexReplayParent;
      const parentKey = parent && taskKeyFor("codex", "task", parent, carrier || duration);
      ctx.observeCodexTask?.(legacyKey, duration, { parentKey, parent });
    } else {
      if (target) ctx.addCodexTask(target, taskKey, duration, session);
      ctx.observeCodexTask?.(taskKey, duration);
      if (legacyKey !== taskKey) ctx.observeCodexTask?.(legacyKey, duration, null, taskKey);
    }
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
