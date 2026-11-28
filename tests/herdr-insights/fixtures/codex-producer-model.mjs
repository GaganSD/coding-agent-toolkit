// A rollout producer, not a second implementation of the parser. Ground
// truth comes from responses generated before either carrier is published.
const zero = [0, 0, 0, 0, 0];
const fields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const raw = (v) => ({ ...Object.fromEntries(fields.map((key, i) => [key, v[i]])), total_tokens: v[0] + v[3] });
const plus = (a, b) => a.map((n, i) => n + b[i]);
const minus = (a, b) => a.map((n, i) => n - b[i]);
export const dimensions = (r) => [r.session, r.day, r.model, r.tokens.input, r.tokens.output, r.tokens.cacheRead,
  r.tokens.cacheWrite, r.tokens.reasoning, r.messages, r.activeMs];
export const order = (rows) => rows.sort((a, b) => JSON.stringify(a.slice(0, 3)).localeCompare(JSON.stringify(b.slice(0, 3))));

function rng(seed) {
  let state = seed >>> 0;
  return (size) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % size;
  };
}

export function produceCodex(seed) {
  const pick = rng(seed);
  const spends = [];
  const tasks = [];
  const clips = [];
  const threads = [];
  const parentRollouts = [];
  const arbitrary = () => {
    const output = 2 + pick(23);
    return [20 + pick(35), pick(9), pick(6), output, pick(output)];
  };
  const primary = `producer-${seed}`;
  const uuid = (ms) => `019f0000-${ms}-7000-8000-${String(seed).padStart(12, "0")}`;
  const control = seed % 8 === 1;
  const fork = seed % 4 === 0;
  const referenced = seed % 8 === 0;
  const projected = fork && seed % 3 === 0;
  const legacyCopy = fork && !referenced && !projected && seed % 3 === 2;
  const archivedParent = legacyCopy && seed % 16 === 4;
  const flattened = seed % 8 === 2;
  const threadIds = control ? [primary] : [fork ? uuid("2000") : primary, `${primary}-delegate`];
  const header = { type: "session_meta", timestamp: "2026-11-01T09:00:00Z",
    payload: { id: threadIds[0], cwd: "/producer", ...(fork ? { forked_from_id: uuid("1000") } : {}),
      ...(seed % 5 === 0 || projected ? { history_mode: "paginated" } : {}),
      ...(projected ? { session_id: uuid("1000"), thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: uuid("1000"), depth: 1 } } },
        ...(referenced ? {} : { subagent_history_start_ordinal: 2 }) } : {}) } };

  for (const [which, thread_id] of threadIds.entries()) {
    const rows = [];
    const isFork = fork && which === 0;
    let turn_id;
    let context;
    let model;
    let day = "2026-11-01";
    let counter = 0;
    let serial = 0;
    let history = zero;
    let historyScalarOffset = 0;
    let last = zero;
    let modern = control ? zero : arbitrary(); // Independent restored record-counter base.
    let liveContext;
    let sliceStart;
    let revisionStart;
    let abandoned;
    const emit = (type, payload) => {
      const timestamp = new Date(Date.parse(`${day}T10:00:00Z`) + counter++ * 1000).toISOString();
      const item = { type, timestamp, payload: { ...(flattened || type === "token_usage_record" ? { thread_id } : {}), ...payload } };
      rows.push(item);
      return item;
    };
    const start = (turn) => {
      turn_id = turn;
      model = `model-${pick(4)}`;
      context = emit("turn_context", { turn_id, model });
      liveContext = context;
    };
    const entry = (amount) => {
      const result = { thread_id, day, model, amount };
      spends.push(result);
      return result;
    };
    const rawHistory = () => ({ ...raw(history), total_tokens: historyScalarOffset + history[0] + history[3] });
    const publish = (info) => emit("event_msg", { type: "token_count", info: info ?? {
      total_token_usage: rawHistory(), last_token_usage: raw(last),
    } });
    const record = (id, amount, delta, { missing = false, explicitTurn = false } = {}) => {
      modern = plus(modern, delta);
      const payload = { thread_id, ...(control || pick(4) || explicitTurn ? { turn_id } : {}), response_id: id,
        usage: raw(amount), thread_token_usage: raw(modern) };
      return missing ? { payload } : emit("token_usage_record", payload);
    };
    const complete = (duration_ms) => {
      tasks.push({ thread_id, day, model, duration_ms });
      emit("event_msg", { type: "task_complete", duration_ms, ...(control || pick(2) ? { turn_id } : {}) });
    };
    if (isFork || (!control && seed % 3 === 0)) {
      start(isFork ? uuid("1000") : "legacy");
      const legacy = arbitrary();
      history = legacy;
      last = legacy;
      publish();
      if (isFork) {
        // A copied modern counter is not a replacement for copied history.
        const replay = legacyCopy && !archivedParent ? []
          : [record(`${thread_id}-parent`, legacy, legacy, { explicitTurn: archivedParent })];
        if (replay.length) replay[0].payload.thread_id = uuid("1000");
        if (referenced || legacyCopy) {
          const historyCarrier = rows[1];
          const inherited = [rows[0], ...replay, historyCarrier];
          if (archivedParent) {
            // Ordinary live copied fork of a completed archived parent turn.
            inherited.push(emit("event_msg", { type: "task_complete", turn_id, duration_ms: 3000 }));
            rows.splice(0, rows.length, ...inherited);
            tasks.push({ thread_id: uuid("1000"), day, model, duration_ms: 3000 });
          }
          const parent = [{ ...header, payload: { id: uuid("1000"), cwd: "/producer" } }, ...inherited]
            .map((item, ordinal) => ({ ...item, ordinal }));
          if (archivedParent) parent.archived = true;
          const end_byte_offset = parent.reduce((size, item) => size + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
          parent.physicalId = referenced && seed % 16 === 0 ? uuid("1500") : uuid("1000");
          if (referenced) {
            header.payload.history_base = { thread_id: parent.physicalId, end_ordinal_exclusive: parent.length, end_byte_offset };
            if (projected) header.payload.forked_from_ordinal_exclusive = parent.length;
            rows.length = 0;
          }
          parentRollouts.push(parent);
          spends.push({ thread_id: uuid("1000"), day, model, amount: legacy });
        } else if (projected) rows.length = 1; // The copied projection retained context, not usage.
      } else entry(legacy);
    }
    if (isFork) {
      const ordinarySameMs = !referenced && !projected && seed % 3 === 1;
      if (ordinarySameMs) emit("event_msg", { type: "thread_settings_applied", thread_id });
      start((projected && !referenced) || ordinarySameMs ? uuid("2000") : uuid("3000"));
      if (projected) {
        history = zero;
        last = zero;
        modern = zero;
        if (seed % 16 === 12) {
          const first = arbitrary();
          record(`${thread_id}-projected-first`, first, first);
          entry(first);
          history = first;
        }
      }
      const extra = arbitrary();
      history = plus(history, extra);
      entry(extra);
      if (archivedParent) record(`${thread_id}-child-first`, extra, extra, { explicitTurn: true });
      if (archivedParent || (projected && seed % 16 === 12)) last = extra;
      publish(); // Inherited last remains stale on an ordinary referenced fork.
    }
    if (!control && seed % 6 === 5) {
      start("incomplete-at-start");
      const extra = arbitrary();
      history = extra;
      entry(extra);
      publish(); // First incomplete response: no record and last is still zero.
    }
    for (let interval = 0; interval < 6; interval++) {
      if (interval === 3) day = "2026-11-02";
      if (interval === 1) sliceStart = rows.length;
      const resumed = !control && !flattened && interval === 3 && seed % 3 === 1;
      start(isFork ? uuid(String(3100 + interval)) : `turn-${interval}`);
      if (resumed) {
        const extra = arbitrary();
        if (seed % 5 === 0) {
          // Equal raw input/output, but distinct cache or reasoning vectors.
          extra[0] = abandoned[0];
          extra[3] = abandoned[3];
          for (const field of [1, 2, 4]) extra[field] = abandoned[field];
          const field = [1, 2, 4][seed % 3];
          extra[field] = abandoned[field] ? abandoned[field] - 1 : 1;
        } else if (extra[0] === abandoned[0] && extra[3] === abandoned[3]) extra[0] += 1;
        history = plus(history, extra);
        entry(extra);
        // Reopening appends no session_meta. Depending on the failure, last
        // is inherited (an ID-less response) or describes a whole new response
        // whose standalone append was lost.
        if (seed % 2 === 0) last = extra;
        publish();
      }
      if (!control && interval === 2) {
        if (pick(2)) {
          history = zero;
          historyScalarOffset = 0;
          last = zero;
          publish();
        } else {
          const window = 10000;
          publish({ model_context_window: window, total_token_usage: { total_tokens: window },
            last_token_usage: { total_tokens: Math.max(0, window - rawHistory().total_tokens) } });
          history = zero;
          historyScalarOffset = window;
          last = zero;
          if (seed % 4 < 2) publish({ model_context_window: window, total_token_usage: { total_tokens: window },
            last_token_usage: { total_tokens: 0 } });
        }
      }
      const count = control ? 1 : 1 + pick(3);
      const shared = arbitrary();
      let revision;
      let copiedRecord;
      for (let i = 0; i < count; i++) {
        const amount = i === 0 || pick(2) ? shared : arbitrary();
        const id = `${thread_id}-response-${serial++}`;
        const item = entry(amount);
        copiedRecord = record(id, amount, amount);
        history = plus(history, amount);
        last = amount;
        if (i === count - 1) revision = { id, item };
      }
      const repeat = interval === 4 && seed % 11 === 0;
      if (repeat && seed % 2 === 0) rows.push(copiedRecord); // Byte-identical append, same carrier timestamp.
      // Incomplete without an ID adds to history, but neither writes a
      // record nor replaces the last response carried by the snapshot.
      if (!control && pick(3) === 0) {
        const extra = arbitrary();
        history = plus(history, extra);
        entry(extra);
      }
      const snapshot = publish();
      if (repeat && seed % 2 !== 0) emit("token_usage_record", copiedRecord.payload);
      if (interval === 1) revisionStart = rows.length - 1;
      if (flattened && interval === 1 && which === 0) clips.push(seed % 5 ? [liveContext, snapshot] : [snapshot]);
      if (flattened && interval === 4 && which === 1) clips.push(seed % 7 ? [liveContext, copiedRecord] : [copiedRecord]);
      if (!control && pick(3) === 0) {
        if (seed % 2) publish(); // A new rate-limit event with unchanged usage.
        else rows.push(snapshot); // Byte-identical copied event.
      }
      if (!control && interval === 1) {
        const before = revision.item.amount;
        const after = [before[0], before[1] + 1 + pick(5), before[2], before[3], before[4]];
        const update = record(revision.id, after, minus(after, before));
        if (seed % 7 === 2) rows.push(update);
        revision.item.amount = after;
        history = plus(history, minus(after, before));
        last = after;
        publish();
        if (seed % 7 === 3) rows.push(update);
        else if (seed % 7 === 4) emit("token_usage_record", update.payload);
      }
      if (!control && interval === 3) {
        const compaction = arbitrary();
        const compaction_response_id = `${thread_id}-compaction-${serial++}`;
        const missing = seed % 2 === 0;
        const compacted = record(compaction_response_id, compaction, compaction, { missing });
        entry(compaction);
        const marker = missing && seed % 7 === 0 ? undefined
          : missing && seed % 7 === 1 ? `${thread_id}-subsequent-without-usage` : compaction_response_id;
        emit("compacted", { compaction_response_id: marker, latest_token_usage_record: compacted.payload });
        publish({ total_token_usage: rawHistory(), last_token_usage: { total_tokens: 5 } });
      }
      if (!control && interval === 4 && seed % 3 === 2) {
        const unpublished = arbitrary();
        entry(unpublished);
        record(`${thread_id}-lost-snapshot`, unpublished, unpublished, { explicitTurn: true });
        history = plus(history, unpublished);
      }
      const duration = 100 + pick(5901);
      if (!control && !flattened && interval === 2 && seed % 3 === 1) {
        abandoned = arbitrary();
        if (abandoned[0] === last[0] && abandoned[3] === last[3]) abandoned[0] += 1;
        entry(abandoned);
        record(`${thread_id}-interrupted`, abandoned, abandoned, { explicitTurn: true });
      } else complete(duration);
      if (interval === 4 && !flattened && seed % 7 === 0) {
        const noSpend = isFork ? uuid("4000") : "no-spend";
        emit("event_msg", { type: "task_started", turn_id: noSpend });
        if (seed % 2 === 0) {
          // A manual token-budget compact can replace context without a call.
          emit("compacted", { window_number: 2, replacement_history: [] });
          emit("turn_context", { turn_id: noSpend, model: "compact-model" });
          publish({ total_token_usage: rawHistory(), last_token_usage: { ...raw(zero), total_tokens: 17 } });
        } else {
          emit("event_msg", { type: "exec_command_begin", turn_id: noSpend, call_id: "shell", source: "user_shell" });
          emit("event_msg", { type: "exec_command_end", turn_id: noSpend, call_id: "shell", source: "user_shell" });
        }
        emit("event_msg", { type: "task_complete", turn_id: noSpend, duration_ms: 7000 });
        tasks.push({ thread_id, day, model, duration_ms: 7000 });
      }
    }
    const owner = which === 0 ? header : { ...header, payload: { id: thread_id, cwd: "/producer" } };
    if (!control && !flattened && which === 0) {
      clips.push({ owner, rows: rows.slice(0, sliceStart + 4) },
        { owner, rows: rows.slice(seed % 8 === 3 ? revisionStart : sliceStart) });
    }
    threads.push({ owner, rows });
  }
  const records = [header];
  const rollouts = [...parentRollouts];
  if (flattened) {
    // Imported concatenation, not the native on-disk token_count format.
    const pending = threads.map(({ rows }) => [...rows]);
    while (pending.length) {
      const i = pick(pending.length);
      records.push(pending[i].shift());
      if (!pending[i].length) pending.splice(i, 1);
    }
  } else {
    records.push(...threads[0].rows);
    if (referenced || header.payload.history_mode === "paginated") {
      for (const [i, row] of records.entries()) row.ordinal = (header.payload.history_base?.end_ordinal_exclusive ?? 0) + i;
    }
    rollouts.push(...threads.slice(1).map(({ owner, rows }) => [owner, ...rows]));
  }
  const rows = new Map();
  const rowFor = ({ thread_id, day, model }) => {
    const key = [`codex:${thread_id}`, day, model];
    const hash = JSON.stringify(key);
    if (!rows.has(hash)) rows.set(hash, [...key, 0, 0, 0, 0, 0, 0, 0]);
    return rows.get(hash);
  };
  for (const item of spends) {
    const [input, read, write, output, reasoning] = item.amount;
    const row = rowFor(item);
    for (const [i, n] of [input - read - write, output, read, write, reasoning, 1].entries()) row[i + 3] += n;
  }
  for (const task of tasks) rowFor(task)[9] += task.duration_ms;
  return { records, rollouts, expected: order([...rows.values()]), clips: clips.map((clip) => [clip.owner ?? header, ...(clip.rows ?? clip)]),
    splitAt: 1 + pick(records.length - 1) };
}

// Generate a suffix from a genuine historical prefix indexed before its
// first snapshot. Repetition doesn't spend; the unpublished response does.
export function produceCodexRetry(seed, prefix, indexedInput) {
  const pick = rng(seed);
  const last = JSON.parse(prefix.trimEnd().split("\n").at(-1));
  const input = 1 + pick(20);
  const timestamp = (ordinal) => new Date(Date.parse(last.timestamp) + ordinal * 1000).toISOString();
  const repeats = Array.from({ length: 1 + pick(3) }, (_, i) =>
    seed % 2 ? last : { ...last, timestamp: timestamp(i + 1) });
  const snapshot = { timestamp: timestamp(10), type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: raw([indexedInput + input, 0, 0, 0, 0]), last_token_usage: raw([input, 0, 0, 0, 0]) } } };
  return { tail: [...repeats, snapshot].map((record) => JSON.stringify(record) + "\n").join(""),
    input: indexedInput + input };
}
