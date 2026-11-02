// Benchmark-only instrumentation. Wraps structuredClone without changing its
// result so the benchmark can prove the collector never clones the accumulated
// store. Loaded only when INSIGHTS_CLONE_LOG is set by the benchmark runner.
import { appendFileSync } from "node:fs";

const target = process.env.INSIGHTS_CLONE_LOG;
if (target) {
  const original = globalThis.structuredClone;
  let total = 0;
  let wholeStore = 0;
  globalThis.structuredClone = function countedStructuredClone(value, options) {
    total += 1;
    if (
      value &&
      typeof value === "object" &&
      value.files && value.dedup && value.tasks && value.config && value.scan
    ) {
      wholeStore += 1;
    }
    return original.call(this, value, options);
  };
  process.on("exit", () => {
    try {
      appendFileSync(
        target,
        `${JSON.stringify({ pid: process.pid, total, wholeStore })}\n`,
      );
    } catch {
      // A benchmark child must never fail because its probe log is gone.
    }
  });
}
