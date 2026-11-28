import assert from "node:assert/strict";
import test from "node:test";
import { parseAdapterRecord } from "../../herdr-insights/mods/insights/core/adapters.mjs";
import { CODEX_PARSER_VERSION } from "../../herdr-insights/mods/insights/core/codex-spend.mjs";
import {
  addCodexTask, addCodexUsage, emptyStore, findFileById, linkCodexSnapshot, newFileEntry, prepareStore, snapshotRows,
} from "../../herdr-insights/mods/insights/core/store.mjs";
import { dimensions, order, produceCodex } from "./fixtures/codex-producer-model.mjs";

process.env.TZ = "UTC";
function readRollout(store, records, file = newFileEntry(store, {
  sourceId: "codex", adapter: "codex", path: `/rollout-${store.nextFileId}${records.physicalId ? `-${records.physicalId}` : ""}.jsonl`,
})) {
  const ctx = {
    file, state: file.state, warn: assert.fail,
    addCodexUsage: (meta, tokens, key) => addCodexUsage(store, file, meta, tokens, key, CODEX_PARSER_VERSION),
    addCodexTask: (...args) => addCodexTask(store, file, ...args),
    linkCodexSnapshot: (...args) => linkCodexSnapshot(store, ...args),
  };
  file.state.codexParserVersion = CODEX_PARSER_VERSION;
  for (const record of records) {
    file.lineNo += 1;
    file.offset += Buffer.byteLength(JSON.stringify(record)) + 1;
    ctx.lineNo = file.lineNo;
    ctx.lineEnd = file.offset;
    parseAdapterRecord("codex", record, ctx);
  }
  return file;
}

const seeds = Number(process.env.CODEX_INVARIANT_SEEDS ?? 300);
assert.ok(Number.isSafeInteger(seeds) && seeds > 0);

test(`Codex producer-model accounting (${seeds} deterministic seeds)`, () => {
  for (let seed = 1; seed <= seeds; seed += 1) {
    const { records, rollouts, expected, clips, splitAt } = produceCodex(seed);
    const full = emptyStore();
    readRollout(full, records);
    for (const rollout of rollouts) readRollout(full, rollout);
    assert.deepEqual(order(snapshotRows(full).map(dimensions)), expected, `full seed ${seed}`);

    const partial = emptyStore();
    if (seed % 2) for (const clip of clips) readRollout(partial, clip);
    const { id } = readRollout(partial, records.slice(0, splitAt));
    const restored = prepareStore(JSON.parse(JSON.stringify(partial)));
    readRollout(restored, records.slice(splitAt), findFileById(restored, id));
    for (const rollout of rollouts) readRollout(restored, rollout);
    if (seed % 2 === 0) for (const clip of clips.toReversed()) readRollout(restored, clip);
    assert.deepEqual(order(snapshotRows(restored).map(dimensions)), expected, `fragments and append seed ${seed}`);
  }
});
