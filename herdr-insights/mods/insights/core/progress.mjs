import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Best-effort scan progress sidecar next to the store. The native view polls
 * it while a refresh or background indexer is running; it is removed when the
 * writer settles. It contains paths and counters only, never transcript text.
 */
export function progressWriter(storePath) {
  const progressPath = `${storePath}.progress.json`;
  const tempPath = `${progressPath}.${process.pid}-${randomUUID()}.tmp`;
  let lastWrite = 0;
  return {
    update(state) {
      const now = Date.now();
      const done = Number(state?.processed) >= Number(state?.total) && Number(state?.total) > 0;
      if (now - lastWrite < 250 && !done) return;
      lastWrite = now;
      try {
        // Atomic replacement also avoids following an existing sidecar link.
        writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(tempPath, progressPath);
      } catch { /* progress is best-effort */ }
      finally {
        try { unlinkSync(tempPath); } catch { /* renamed or not created */ }
      }
    },
    clear() {
      try {
        unlinkSync(progressPath);
      } catch { /* already gone */ }
    },
  };
}
