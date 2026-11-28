// Read-only compatibility for unavailable development stores. Readable
// rollouts are reindexed; v9 alias handling is separate from these shapes.

// Old unreadable rollouts can retain pre-v13 links. Protect one member of
// each directed cycle rather than suppressing an entire group of carriers.
export function codexCycleRoots(store, echoes, auxIndex) {
  const visited = new Set();
  const roots = new Set();
  for (const key of echoes) {
    const target = store.dedup[key]?.[auxIndex]?.echo?.key;
    if (!store.dedup[target]?.[auxIndex]?.echo || visited.has(key)) continue;
    const path = new Set();
    let next = key;
    while (next && !visited.has(next)) {
      visited.add(next);
      path.add(next);
      next = store.dedup[next]?.[auxIndex]?.echo?.key;
    }
    if (path.has(next)) {
      let best = next;
      let current = next;
      const spend = (key) => store.dedup[key].slice(2, 6).reduce((sum, n) => sum + n, 0);
      do {
        if (spend(current) > spend(best) || (spend(current) === spend(best) && current < best)) best = current;
        current = store.dedup[current][auxIndex].echo.key;
      } while (current !== next);
      roots.add(best);
    }
  }
  return roots;
}

export function codexCheckpointEvidence(store, echoes, auxIndex, responseKey) {
  const wanted = new Map();
  for (const key of echoes) {
    const echo = store.dedup[key]?.[auxIndex]?.echo;
    if (echo?.total) wanted.set(echo.key + "/" + echo.total, null);
  }
  if (!wanted.size) return wanted;
  for (const file of Object.values(store.files)) {
    if (file.adapter !== "codex") continue;
    for (const scope of Object.values(file.state.codexSpend ?? {})) {
      if (!Array.isArray(scope?.responses)) continue;
      for (const record of scope.responses) {
        if (!Array.isArray(record)) continue;
        const [id, , usage, total] = record;
        if (!id || !Array.isArray(usage) || !Array.isArray(total)) continue;
        const key = responseKey(id) + "/" + total;
        if (!wanted.has(key)) continue;
        const [input, read, write, output, reasoning] = usage;
        const vector = [Math.max(0, input - read - write), output, read, write, reasoning];
        const existing = wanted.get(key);
        // Totals alone do not distinguish different revisions at the same
        // cumulative position. Only their shared spend is certain.
        wanted.set(key, existing ? existing.map((n, i) => Math.min(n, vector[i])) : vector);
      }
    }
  }
  return wanted;
}

export function codexReferencedInput(reference, baseline) {
  const input = reference.input ?? { boundary: "referenced", total: reference.total,
    pending: reference.pending, records: reference.records };
  return { ...input, baseline };
}

export function readCodexInterval(observation, width) {
  if (observation === 0 || (Array.isArray(observation) && observation.length === width)) {
    return [-1, observation];
  }
  return Array.isArray(observation) && observation.length === 2 && Number.isSafeInteger(observation[0])
    ? observation : null;
}
