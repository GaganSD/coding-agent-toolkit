#!/usr/bin/env node
// Test-only launcher used by collector-lifecycle-gates.test.mjs. Four separate
// processes wait on the same gate file and then run one foreground slice with a
// deterministic zero budget, so every process promotes instead of finishing the
// archive itself. The delay is a synthetic test hook, never production behavior.
import { existsSync } from "node:fs";
import { collectSnapshot } from "../../herdr-insights/mods/insights/collector.mjs";

const [store, home, gate, delayMs = "40"] = process.argv.slice(2);
if (!store || !home || !gate) {
  process.stderr.write("usage: lifecycle-launcher.mjs <store> <home> <gate> [delayMs]\n");
  process.exit(2);
}
while (!existsSync(gate)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
try {
  const snapshot = await collectSnapshot("snapshot", {
    store,
    home,
    budgetMs: 0,
    testStreamDelayMs: Number(delayMs),
    workerAckMs: 5_000,
  });
  process.stdout.write(`${JSON.stringify({
    launcherPid: process.pid,
    status: snapshot.scan?.status ?? null,
    workerPid: snapshot.scan?.workerPid ?? null,
    pending: Boolean(snapshot.scan?.pendingFile),
    warnings: snapshot.warnings ?? [],
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
