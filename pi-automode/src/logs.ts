import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type { AutomodeSettings, DecisionLog, Rule } from "./types.js";

export class LogError extends Error {}

/** Internal byte ceiling for the log file (not an exposed setting). */
export const LOG_MAX_BYTES = 4 * 1024 * 1024;
/** A single NDJSON line larger than this is corrupt, never parsed. */
const LOG_LINE_MAX_BYTES = 1024 * 1024;
/** Locking for cooperating processes: an operational <file>.lock sidecar. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export interface LogStoreOptions {
  /** Test hook to shrink the byte ceiling. */
  maxBytes?: number;
}

const OUTCOMES = new Set(["allow", "ask", "block"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isRule(value: unknown): value is Rule {
  if (!isPlainObject(value)) return false;
  if (value.type !== "message" && value.type !== "command") return false;
  if (typeof value.text !== "string") return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  return Object.keys(value).every((k) => k === "type" || k === "text" || k === "enabled");
}

const ENTRY_KEYS = new Set([
  "id", "time", "action", "outcome", "source", "reason", "matchedRule",
  "classifier", "input", "output",
]);

/** Strict structural validation; corrupt entries are reported, never repaired. */
export function isDecisionLog(value: unknown): value is DecisionLog {
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((k) => ENTRY_KEYS.has(k))) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.time !== "string" || Number.isNaN(Date.parse(value.time))) return false;
  if (!isPlainObject(value.action)) return false;
  const a = value.action;
  if (typeof a.requestId !== "string") return false;
  if (typeof a.tool !== "string" || a.tool.length === 0) return false;
  if (!isPlainObject(a.args)) return false;
  if (typeof a.cwd !== "string") return false;
  if (!Object.keys(a).every((k) => k === "requestId" || k === "tool" || k === "args" || k === "cwd")) {
    return false;
  }
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return false;
  // No fabricated reasons: source and reason must be present, real text.
  if (typeof value.source !== "string" || value.source.length === 0) return false;
  if (typeof value.reason !== "string" || value.reason.length === 0) return false;
  if (value.matchedRule !== undefined && !isRule(value.matchedRule)) return false;
  return true;
}

interface ParsedLog {
  entries: DecisionLog[];
  corruptLines: number;
  totalBytes: number;
  /** True when only a trailing byte window of an oversized file was read. */
  windowed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable, bounded store of real-action decision records (NDJSON, one entry
 * per line). Truncation and unavailable data are explicit via `warning`.
 * Restrictive permissions (0600), symlink/hardlink rejection, O_NOFOLLOW on
 * every open, and bounds on bytes, entries and age — applied BEFORE parsing,
 * never after slurping an externally grown file. Mutations are serialized
 * between cooperating processes with an operational lock sidecar so
 * concurrent append/prune/clear cannot lose entries.
 */
export class LogStore {
  readonly #filePath: string;
  readonly #maxBytes: number;
  /** Human-readable note about truncation/corruption from the last read; null when clean. */
  warning: string | null = null;

  constructor(filePath: string, options: LogStoreOptions = {}) {
    this.#filePath = filePath;
    this.#maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  }

  get path(): string {
    return this.#filePath;
  }

  /** lstat and reject anything that is not a private, singly-linked regular file. */
  async #statRegular(): Promise<{ missing: true } | { missing: false; size: number }> {
    const st = await fs.lstat(this.#filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (st === null) return { missing: true };
    if (st.isSymbolicLink()) {
      throw new LogError(`log path is a symbolic link: ${this.#filePath}`);
    }
    if (!st.isFile()) {
      throw new LogError(`log path is not a regular file: ${this.#filePath}`);
    }
    if (st.nlink > 1) {
      throw new LogError(`log path has multiple hard links (${st.nlink}); refusing shared storage`);
    }
    return { missing: false, size: st.size };
  }

  /**
   * Bounded parse: the byte bound is enforced BEFORE reading. A file larger
   * than the ceiling is windowed to its newest `maxBytes` bytes (the leading
   * partial line is dropped), and each line is size-capped before JSON.parse.
   */
  async #parseFile(): Promise<ParsedLog | null> {
    const st = await this.#statRegular();
    if (st.missing) return null;
    const windowed = st.size > this.#maxBytes;
    const start = windowed ? st.size - this.#maxBytes : 0;
    const length = st.size - start;
    const handle = await fs.open(this.#filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(length);
      let off = 0;
      while (off < length) {
        const { bytesRead } = await handle.read(bytes, off, length - off, start + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      bytes = bytes.subarray(0, off);
    } finally {
      await handle.close();
    }
    const text = bytes.toString("utf8");
    let lines = text.split("\n");
    if (windowed && lines.length > 0) {
      // The first line of a window is a partial line; never parse it.
      lines = lines.slice(1);
    }
    const entries: DecisionLog[] = [];
    let corruptLines = 0;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > LOG_LINE_MAX_BYTES) {
        corruptLines += 1;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isDecisionLog(parsed)) entries.push(parsed);
        else corruptLines += 1;
      } catch {
        corruptLines += 1;
      }
    }
    return { entries, corruptLines, totalBytes: st.size, windowed };
  }

  #applyBounds(
    entries: DecisionLog[],
    settings: AutomodeSettings,
    notes: string[],
  ): DecisionLog[] {
    const cutoff = Date.now() - settings.logRetentionDays * 86_400_000;
    let kept = entries.filter((e) => Date.parse(e.time) >= cutoff);
    const aged = entries.length - kept.length;
    if (aged > 0) notes.push(`dropped ${aged} entr${aged === 1 ? "y" : "ies"} older than ${settings.logRetentionDays} day(s)`);
    if (kept.length > settings.logMaxEntries) {
      notes.push(`truncated to the most recent ${settings.logMaxEntries} of ${kept.length} entries`);
      kept = kept.slice(kept.length - settings.logMaxEntries);
    }
    const sizeOf = (list: DecisionLog[]) =>
      list.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), "utf8") + 1, 0);
    let bytes = sizeOf(kept);
    if (bytes > this.#maxBytes) {
      const before = kept.length;
      while (kept.length > 0 && bytes > this.#maxBytes) {
        bytes -= Buffer.byteLength(JSON.stringify(kept[0] as DecisionLog), "utf8") + 1;
        kept = kept.slice(1);
      }
      notes.push(`log exceeded ${this.#maxBytes} bytes; dropped ${before - kept.length} oldest entr${before - kept.length === 1 ? "y" : "ies"}`);
    }
    return kept;
  }

  /**
   * Serialize mutations between cooperating processes via an operational
   * `<file>.lock` sidecar (O_EXCL create, stale-lock recovery, bounded wait).
   */
  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.#filePath}.lock`;
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        await handle.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const st = await fs.lstat(lockPath).catch(() => null);
        if (st !== null && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Stale lock from a crashed process; take it over.
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LogError(`timed out acquiring log lock: ${lockPath}`);
        }
        await sleep(20 + Math.floor(Math.random() * 20));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Read valid entries (oldest first) bounded by age, entry count and bytes.
   * Corrupt lines are skipped and reported in `warning`; a missing file is
   * legitimately empty. When bounds drop entries (including aged entries on
   * plain access) or corrupt lines are present, the file itself is pruned
   * durably, serialized against cooperating appenders.
   */
  async read(settings: AutomodeSettings): Promise<DecisionLog[]> {
    this.warning = null;
    const first = await this.#parseFile();
    if (first === null) return [];
    const firstNotes: string[] = [];
    if (first.corruptLines > 0) firstNotes.push(`ignored ${first.corruptLines} corrupt log line(s)`);
    if (first.windowed) firstNotes.push(`log exceeded ${this.#maxBytes} bytes; read the newest byte window only`);
    const firstKept = this.#applyBounds(first.entries, settings, firstNotes);
    const pruned = firstKept.length !== first.entries.length;
    if (!pruned && first.corruptLines === 0 && !first.windowed) {
      this.warning = null;
      return firstKept;
    }
    // Bounds dropped entries, corrupt lines, or an oversized window: make the
    // pruning durable, serialized against cooperating appenders.
    return this.#withLock(async () => {
      const parsed = await this.#parseFile();
      if (parsed === null) {
        this.warning = null;
        return [];
      }
      const notes: string[] = [];
      if (parsed.corruptLines > 0) notes.push(`ignored ${parsed.corruptLines} corrupt log line(s)`);
      if (parsed.windowed) notes.push(`log exceeded ${this.#maxBytes} bytes; read the newest byte window only`);
      const kept = this.#applyBounds(parsed.entries, settings, notes);
      if (kept.length !== parsed.entries.length || parsed.corruptLines > 0 || parsed.windowed) {
        await this.#rewrite(kept);
      }
      this.warning = notes.length > 0 ? notes.join("; ") : null;
      return kept;
    });
  }

  /**
   * Append one real decision record, then enforce bounds with an atomic
   * rewrite when limits are exceeded. The whole append+prune is serialized
   * against cooperating processes so concurrent writers cannot lose entries.
   * Logging failures throw; callers must not convert them into permission.
   */
  async append(entry: DecisionLog, settings: AutomodeSettings): Promise<void> {
    if (!isDecisionLog(entry)) {
      throw new LogError("refusing to append a structurally invalid decision log entry");
    }
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > this.#maxBytes || lineBytes > LOG_LINE_MAX_BYTES) {
      throw new LogError(`entry (${lineBytes} bytes) exceeds the log byte bound (${this.#maxBytes})`);
    }
    await this.#withLock(async () => {
      await this.#statRegular();
      // O_NOFOLLOW: refuse to append through a symlink swapped in after lstat.
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(
          this.#filePath,
          fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
          0o600,
        );
      } catch (err) {
        throw new LogError(`cannot open log for append: ${(err as Error).message}`);
      }
      try {
        await handle.write(line);
      } finally {
        await handle.close();
      }
      await fs.chmod(this.#filePath, 0o600);

      const parsed = await this.#parseFile();
      if (parsed === null) return;
      const overEntries = parsed.entries.length > settings.logMaxEntries;
      const overBytes = parsed.totalBytes > this.#maxBytes;
      const cutoff = Date.now() - settings.logRetentionDays * 86_400_000;
      const overAge = parsed.entries.some((e) => Date.parse(e.time) < cutoff);
      if (overEntries || overBytes || overAge || parsed.corruptLines > 0 || parsed.windowed) {
        const notes: string[] = [];
        const kept = this.#applyBounds(parsed.entries, settings, notes);
        await this.#rewrite(kept);
      }
    });
  }

  async #rewrite(entries: DecisionLog[]): Promise<void> {
    const temp = `${this.#filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const body = entries.map((e) => `${JSON.stringify(e)}\n`).join("");
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(temp, "wx", 0o600);
      await handle.write(Buffer.from(body, "utf8"));
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.#filePath);
    } finally {
      if (handle !== null) await handle.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  /** Remove all decision records. Missing file is fine. */
  async clear(): Promise<void> {
    this.warning = null;
    await this.#withLock(async () => {
      if ((await this.#statRegular()).missing) return;
      await fs.rm(this.#filePath);
    });
  }
}
