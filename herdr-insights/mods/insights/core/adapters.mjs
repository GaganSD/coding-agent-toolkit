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
    taskKeyFor("pi", "span", session, finalIdentity),
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
        session,
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
  const provider = asString(message.provider);
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
      taskKeyFor("claude", "span", session, identity),
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

function codexContext(state, turnId) {
  if (!isPlainObject(state.turns)) state.turns = {};
  if (turnId && isPlainObject(state.turns[turnId])) return state.turns[turnId];
  return {
    model: state.model,
    provider: state.provider,
    project: state.project,
    lastRow: state.lastRow ?? null,
  };
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

function codexDelta(cur, prev) {
  if (!Number.isFinite(prev)) return toNonNegInt(cur);
  if (cur < prev) return toNonNegInt(cur); // counters restarted
  return toNonNegInt(cur - prev);
}

function parseCodex(record, ctx) {
  if (!isPlainObject(record)) return;
  const state = ctx.state;
  const payload = isPlainObject(record.payload) ? record.payload : {};
  const timestamp =
    parseTimestamp(record.timestamp) ?? state.timestamp ?? null;

  if (record.type === "session_meta") {
    state.session = asString(payload.id ?? payload.session_id ?? payload.thread_id, "");
    state.project = asString(payload.cwd, "unknown");
    state.provider = asString(payload.model_provider, "unknown");
    state.timestamp = parseTimestamp(payload.timestamp ?? record.timestamp);
    if (!state.model) state.model = "unknown";
    return;
  }

  if (record.type === "turn_context") {
    const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
    const context = {
      model: asString(payload.model, state.model ?? "unknown"),
      provider: asString(state.provider),
      project: asString(payload.cwd, state.project ?? "unknown"),
      lastRow: null,
    };
    if (!isPlainObject(state.turns)) state.turns = {};
    if (turnId) {
      const previous = state.turns[turnId];
      if (previous?.lastRow) context.lastRow = previous.lastRow;
      state.turns[turnId] = context;
    }
    state.model = context.model;
    state.project = context.project;
    return;
  }

  if (record.type === "token_usage_record") {
    state.modern = true;
    if (timestamp === null) {
      ctx.warn("Codex token usage record has no usable timestamp; skipped");
      return;
    }
    const turnId = asString(payload.turn_id ?? payload.root_turn_id, "");
    const context = codexContext(state, turnId);
    const session = codexSession(state, ctx);
    const usage = isPlainObject(payload.usage) ? payload.usage : null;
    if (!usage) return;
    const tokens = codexNormalized(usage);
    if (!tokens.nonzero) return;
    const responseId = asString(payload.response_id, "");
    const identity = responseId
      ? ["response", responseId]
      : [
          "turn",
          session,
          turnId,
          record.timestamp ?? ctx.lineHash,
          tokens.input,
          tokens.output,
          tokens.cacheRead,
          tokens.cacheWrite,
          tokens.reasoning,
        ];
    const result = ctx.addUsage(
      metaFor(
        "codex",
        session,
        timestamp,
        context.project,
        context.provider,
        context.model,
      ),
      tokens,
      makeDedupKey("codex", ...identity),
    );
    if (turnId) {
      if (!isPlainObject(state.turns)) state.turns = {};
      const entry = state.turns[turnId] ?? context;
      entry.lastRow = { fileId: result.fileId, rowIdx: result.rowIdx };
      state.turns[turnId] = entry;
    }
    state.lastRow = { fileId: result.fileId, rowIdx: result.rowIdx };
    return;
  }

  if (
    record.type === "event_msg" &&
    payload.type === "token_count" &&
    state.modern !== true
  ) {
    if (timestamp === null) return;
    const info = isPlainObject(payload.info) ? payload.info : {};
    const totals = isPlainObject(info.total_token_usage)
      ? info.total_token_usage
      : null;
    const session = codexSession(state, ctx);
    const context = codexContext(state, asString(payload.turn_id, ""));
    let raw;
    let identityTail;

    if (totals) {
      const current = {
        input_tokens: toNonNegInt(totals.input_tokens),
        cached_input_tokens: toNonNegInt(totals.cached_input_tokens),
        cache_write_input_tokens: toNonNegInt(totals.cache_write_input_tokens),
        output_tokens: toNonNegInt(totals.output_tokens),
        reasoning_output_tokens: toNonNegInt(totals.reasoning_output_tokens),
      };
      const previous = state.legacyTotals;
      raw = {};
      for (const key of Object.keys(current)) {
        raw[key] = codexDelta(current[key], previous?.[key]);
      }
      state.legacyTotals = current;
      identityTail = [
        "legacy",
        record.timestamp ?? ctx.lineHash,
        current.input_tokens,
        current.cached_input_tokens,
        current.cache_write_input_tokens,
        current.output_tokens,
        current.reasoning_output_tokens,
      ];
    } else if (isPlainObject(info.last_token_usage)) {
      raw = info.last_token_usage;
      identityTail = [
        "legacy-last",
        record.timestamp ?? ctx.lineHash,
        raw.input_tokens,
        raw.cached_input_tokens,
        raw.cache_write_input_tokens,
        raw.output_tokens,
        raw.reasoning_output_tokens,
      ];
    } else {
      return;
    }

    const tokens = codexNormalized(raw);
    if (!tokens.nonzero) return;
    const result = ctx.addUsage(
      metaFor(
        "codex",
        session,
        timestamp,
        context.project,
        context.provider,
        context.model,
      ),
      tokens,
      makeDedupKey("codex", session, ...identityTail),
    );
    state.lastRow = { fileId: result.fileId, rowIdx: result.rowIdx };
    if (payload.turn_id) {
      if (!isPlainObject(state.turns)) state.turns = {};
      const entry = state.turns[payload.turn_id] ?? context;
      entry.lastRow = state.lastRow;
      state.turns[payload.turn_id] = entry;
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
    const target = context.lastRow ?? state.lastRow;
    if (!target) return;
    const session = codexSession(state, ctx);
    ctx.addTask(
      target.fileId,
      target.rowIdx,
      taskKeyFor(
        "codex",
        "task",
        session,
        turnId || record.timestamp || payload.completed_at || duration,
      ),
      duration,
      session,
      true,
    );
  }
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
