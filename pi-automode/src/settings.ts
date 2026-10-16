import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { canonicalJson } from "./core/canonical-json.js";
import { normalizeDisclosureEndpoint } from "./core/disclosure.js";
import { DEFAULT_SETTINGS } from "./types.js";
import type { AutomodeSettings, Rule } from "./types.js";

export class SettingsError extends Error {}
/** Thrown by update() when the on-disk file changed outside this store. */
export class SettingsConflictError extends SettingsError {}

/**
 * Validated numeric bounds. Every exposed tuning lives in the one settings
 * JSON; these bounds are internal validation, not extra settings.
 */
export const SETTINGS_LIMITS = Object.freeze({
  logRetentionDays: Object.freeze({ min: 1, max: 365 }),
  logMaxEntries: Object.freeze({ min: 1, max: 100_000 }),
  reviewTimeoutMs: Object.freeze({ min: 250, max: 60_000 }),
  reviewMaxRequests: Object.freeze({ min: 1, max: 10_000 }),
  approvalTimeoutMs: Object.freeze({ min: 5_000, max: 3_600_000 }),
} as const);

/**
 * Internal raw-read ceiling for the settings file (not an exposed setting).
 * Files larger than this are refused BEFORE they are read into memory.
 */
export const SETTINGS_MAX_BYTES = 1024 * 1024;
/** Locking for cooperating stores: an operational <file>.lock sidecar. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

const KNOWN_KEYS = new Set([
  "version",
  "enabled",
  "classifier",
  "disclosureConsent",
  "disclosureProvider",
  "disclosureModel",
  "disclosureEndpoint",
  "disclosureWorkspace",
  "allowlist",
  "blocklist",
  "logRetentionDays",
  "logMaxEntries",
  "reviewTimeoutMs",
  "reviewMaxRequests",
  "approvalTimeoutMs",
]);

/** Reject control characters other than tab/newline/CR in operator-visible text. */
const REJECTED_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(message: string): never {
  throw new SettingsError(message);
}

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`${where}: unknown field ${JSON.stringify(key)}`);
  }
}

function validateText(value: unknown, where: string, max: number): string {
  if (typeof value !== "string") fail(`${where}: expected string`);
  const s = value as string;
  if (s.length === 0) fail(`${where}: empty string`);
  if (s.length > max) fail(`${where}: longer than ${max} characters`);
  if (REJECTED_CONTROL.test(s)) fail(`${where}: contains control characters`);
  return s;
}

function validateRule(value: unknown, where: string): Rule {
  if (!isPlainObject(value)) fail(`${where}: expected object`);
  checkKeys(value, new Set(["type", "text", "enabled"]), where);
  const type = value.type;
  if (type !== "message" && type !== "command") fail(`${where}: type must be "message" or "command"`);
  const text = validateText(value.text, `${where}.text`, 4000);
  const rule: Rule = { type, text };
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") fail(`${where}.enabled: expected boolean`);
    rule.enabled = value.enabled;
  }
  return Object.freeze(rule);
}

function validateNumber(
  value: unknown,
  where: string,
  limits: { min: number; max: number },
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${where}: expected integer`);
  const n = value as number;
  if (n < limits.min || n > limits.max) {
    fail(`${where}: ${n} outside [${limits.min}, ${limits.max}]`);
  }
  return n;
}

function validateRuleList(value: unknown, where: string): Rule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${where}: expected array`);
  return value.map((entry, i) => validateRule(entry, `${where}[${i}]`));
}

/**
 * Strictly validate unknown data into AutomodeSettings. Unknown fields
 * (including credentials or `__proto__`) are rejected; optional tuning fields
 * default. The result is a fresh, deeply frozen plain object — no shared
 * references with the input, so validation cannot carry prototype pollution.
 */
export function validateSettings(input: unknown): AutomodeSettings {
  if (!isPlainObject(input)) fail("settings: expected a plain object");
  checkKeys(input, KNOWN_KEYS, "settings");

  if (input.version !== 1) fail("settings.version: must be 1");
  if (typeof input.enabled !== "boolean") fail("settings.enabled: expected boolean");

  let classifier: AutomodeSettings["classifier"] = null;
  if (input.classifier !== undefined && input.classifier !== null) {
    if (!isPlainObject(input.classifier)) fail("settings.classifier: expected object or null");
    checkKeys(input.classifier, new Set(["provider", "model"]), "settings.classifier");
    classifier = Object.freeze({
      provider: validateText(input.classifier.provider, "settings.classifier.provider", 200),
      model: validateText(input.classifier.model, "settings.classifier.model", 200),
    });
  }

  let disclosureConsent: AutomodeSettings["disclosureConsent"] = DEFAULT_SETTINGS.disclosureConsent;
  if (input.disclosureConsent !== undefined) {
    if (
      input.disclosureConsent !== "none" &&
      input.disclosureConsent !== "approved" &&
      input.disclosureConsent !== "declined"
    ) {
      fail("settings.disclosureConsent: must be none | approved | declined");
    }
    disclosureConsent = input.disclosureConsent;
  }

  // Consent bindings: null (unbound) by default; old files may omit them.
  // Endpoint URLs carrying credentials/query/fragment are refused outright —
  // they must stay local, never be normalized into something uploadable.
  let disclosureProvider: string | null = null;
  if (input.disclosureProvider !== undefined && input.disclosureProvider !== null) {
    disclosureProvider = validateText(input.disclosureProvider, "settings.disclosureProvider", 200);
  }
  let disclosureModel: string | null = null;
  if (input.disclosureModel !== undefined && input.disclosureModel !== null) {
    disclosureModel = validateText(input.disclosureModel, "settings.disclosureModel", 200);
  }
  let disclosureEndpoint: string | null = null;
  if (input.disclosureEndpoint !== undefined && input.disclosureEndpoint !== null) {
    const raw = validateText(input.disclosureEndpoint, "settings.disclosureEndpoint", 2000);
    const normalized = normalizeDisclosureEndpoint(raw);
    if (normalized === null) {
      fail("settings.disclosureEndpoint: must be an http(s) URL without userinfo, query or fragment");
    }
    disclosureEndpoint = normalized;
  }
  let disclosureWorkspace: string | null = null;
  if (input.disclosureWorkspace !== undefined && input.disclosureWorkspace !== null) {
    disclosureWorkspace = validateText(input.disclosureWorkspace, "settings.disclosureWorkspace", 4000);
  }

  const settings: AutomodeSettings = {
    version: 1,
    enabled: input.enabled,
    classifier,
    disclosureConsent,
    disclosureProvider,
    disclosureModel,
    disclosureEndpoint,
    disclosureWorkspace,
    allowlist: validateRuleList(input.allowlist, "settings.allowlist"),
    blocklist: validateRuleList(input.blocklist, "settings.blocklist"),
    logRetentionDays: validateNumber(
      input.logRetentionDays, "settings.logRetentionDays", SETTINGS_LIMITS.logRetentionDays, DEFAULT_SETTINGS.logRetentionDays,
    ),
    logMaxEntries: validateNumber(
      input.logMaxEntries, "settings.logMaxEntries", SETTINGS_LIMITS.logMaxEntries, DEFAULT_SETTINGS.logMaxEntries,
    ),
    reviewTimeoutMs: validateNumber(
      input.reviewTimeoutMs, "settings.reviewTimeoutMs", SETTINGS_LIMITS.reviewTimeoutMs, DEFAULT_SETTINGS.reviewTimeoutMs,
    ),
    reviewMaxRequests: validateNumber(
      input.reviewMaxRequests, "settings.reviewMaxRequests", SETTINGS_LIMITS.reviewMaxRequests, DEFAULT_SETTINGS.reviewMaxRequests,
    ),
    approvalTimeoutMs: validateNumber(
      input.approvalTimeoutMs, "settings.approvalTimeoutMs", SETTINGS_LIMITS.approvalTimeoutMs, DEFAULT_SETTINGS.approvalTimeoutMs,
    ),
  };
  Object.freeze(settings.allowlist);
  Object.freeze(settings.blocklist);
  return Object.freeze(settings);
}

interface FileSig {
  size: number;
  sha256: string;
}

function sameSig(a: FileSig, b: FileSig): boolean {
  return a.size === b.size && a.sha256 === b.sha256;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DiskState =
  | { kind: "missing" }
  | { kind: "ok"; sig: FileSig; settings: AutomodeSettings }
  | { kind: "invalid"; sig: FileSig; message: string };

function cloneSettings(settings: AutomodeSettings): AutomodeSettings {
  return validateSettings(structuredClone(settings));
}

/**
 * Atomic, validated operator settings store for `<agent-dir>/automode.json`.
 *
 * - A truly missing file legitimately defaults to Off.
 * - An invalid file keeps the last valid state and exposes `error`; an
 *   invalid *initial* file therefore never silently passes as permissive Off
 *   (callers must treat a non-null `error` as a halt of guarded operation).
 * - Persistence: temp-file + rename, 0600 permissions, symlink rejection,
 *   and concurrent-edit detection via content signatures.
 */
export class SettingsStore {
  readonly #filePath: string;
  #current: AutomodeSettings = cloneSettings(DEFAULT_SETTINGS);
  #epoch = 0;
  #error: string | null = null;
  #sig: FileSig | null = null;
  /** True once the file was observed present (for external-removal drift). */
  #fileKnown = false;
  #loaded = false;
  /**
   * Content signature of the last observed INVALID file. Lets a verified
   * operator update repair a file that was never successfully loaded — but
   * only while the invalid bytes are exactly the ones we observed; any
   * external change since then is drift and still conflicts.
   */
  #observedInvalidSig: FileSig | null = null;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  get path(): string {
    return this.#filePath;
  }

  get current(): AutomodeSettings {
    return this.#current;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get error(): string | null {
    return this.#error;
  }

  /**
   * True when guarded operation must halt: the configuration on disk is
   * invalid, missing after being known, or otherwise unverified. Callers
   * must treat this as a halt, never as a permissive Off.
   */
  get halted(): boolean {
    return this.#error !== null;
  }

  async #readDisk(): Promise<DiskState> {
    const st = await fs.lstat(this.#filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (st === null) return { kind: "missing" };
    if (st.isSymbolicLink()) {
      throw new SettingsError(`settings path is a symbolic link: ${this.#filePath}`);
    }
    if (!st.isFile()) {
      throw new SettingsError(`settings path is not a regular file: ${this.#filePath}`);
    }
    // Bounded raw read: refuse oversized files before loading a byte.
    if (st.size > SETTINGS_MAX_BYTES) {
      throw new SettingsError(`settings file exceeds the ${SETTINGS_MAX_BYTES}-byte bound (${st.size} bytes)`);
    }
    // O_NOFOLLOW: refuse to read through a symlink swapped in after lstat.
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.#filePath, { flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW });
    } catch (err) {
      throw new SettingsError(`settings file could not be read safely: ${(err as Error).message}`);
    }
    const sig: FileSig = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      return { kind: "invalid", sig, message: `settings JSON parse failed: ${(err as Error).message}` };
    }
    try {
      return { kind: "ok", sig, settings: validateSettings(parsed) };
    } catch (err) {
      return { kind: "invalid", sig, message: (err as Error).message };
    }
  }

  /**
   * Initial load. Missing file → defaults Off; invalid file → `error` set,
   * defaults kept. A REPEATED load must not reset a valid in-memory state:
   * it behaves like reload() — last valid settings stay in force and disk
   * problems surface through `error`.
   */
  async load(): Promise<void> {
    if (this.#loaded) {
      await this.reload();
      return;
    }
    this.#loaded = true;
    this.#current = cloneSettings(DEFAULT_SETTINGS);
    this.#epoch = 0;
    this.#error = null;
    this.#sig = null;
    this.#fileKnown = false;
    this.#observedInvalidSig = null;
    try {
      const disk = await this.#readDisk();
      if (disk.kind === "missing") return;
      if (disk.kind === "invalid") {
        this.#error = disk.message;
        this.#observedInvalidSig = disk.sig;
        return;
      }
      this.#current = disk.settings;
      this.#epoch = 1;
      this.#sig = disk.sig;
      this.#fileKnown = true;
    } catch (err) {
      this.#error = (err as Error).message;
    }
  }

  /**
   * Re-read the file. Returns true only when valid settings changed (epoch
   * incremented). Invalid or externally removed configuration keeps the last
   * valid state and exposes `error`.
   *
   * External-drift contract for the runtime: a valid external edit returns
   * true and bumps `epoch` exactly like a local `update()` — including an
   * external `enabled: false`. The runtime must treat any epoch change it did
   * not cause through its own verified operator path as drift: halt guarded
   * operation and require operator re-verification. It must NOT auto-disarm
   * into Off just because an externally edited file says `enabled: false`.
   */
  async reload(): Promise<boolean> {
    if (!this.#loaded) await this.load();
    let disk: DiskState;
    try {
      disk = await this.#readDisk();
    } catch (err) {
      this.#error = (err as Error).message;
      return false;
    }
    if (disk.kind === "missing") {
      if (!this.#fileKnown && this.#observedInvalidSig === null && this.#error === null) return false;
      if (this.#fileKnown) {
        this.#error = "settings file was removed externally; guarded operation halted until re-verified";
        this.#fileKnown = false;
        this.#sig = null;
        this.#observedInvalidSig = null;
        return false;
      }
      return false;
    }
    if (disk.kind === "invalid") {
      // Keep the last valid state; an invalid edit never silently disarms.
      this.#error = disk.message;
      this.#observedInvalidSig = disk.sig;
      return false;
    }
    this.#fileKnown = true;
    this.#observedInvalidSig = null;
    if (this.#sig !== null && this.#error === null && sameSig(disk.sig, this.#sig)) {
      return false;
    }
    this.#sig = disk.sig;
    if (canonicalJson(disk.settings) === canonicalJson(this.#current)) {
      this.#error = null;
      return false;
    }
    this.#current = disk.settings;
    this.#epoch += 1;
    this.#error = null;
    return true;
  }

  /**
   * Drift check for update(). Throws SettingsConflictError when the on-disk
   * file diverges from what this store last observed. One exception: a file
   * that was NEVER successfully loaded and is byte-identical to the invalid
   * content we observed may be repaired by a verified operator update.
   */
  async #checkDrift(): Promise<void> {
    let disk: DiskState;
    try {
      disk = await this.#readDisk();
    } catch (err) {
      if (err instanceof SettingsError) {
        // Structurally unreadable on-disk state is drift relative to our
        // last valid snapshot; refuse to silently clobber it.
        throw new SettingsConflictError(
          `settings file changed externally and is no longer valid: ${err.message}`,
        );
      }
      throw err;
    }
    if (disk.kind === "missing") {
      if (this.#fileKnown || this.#observedInvalidSig !== null) {
        throw new SettingsConflictError("settings file was removed externally; refusing to overwrite");
      }
      return; // legitimately absent since first observation: creating is fine
    }
    if (disk.kind === "invalid") {
      if (
        this.#sig === null
        && this.#observedInvalidSig !== null
        && sameSig(disk.sig, this.#observedInvalidSig)
      ) {
        return; // unchanged never-valid file: a verified update may repair it
      }
      throw new SettingsConflictError(
        this.#sig !== null
          ? "settings file became invalid externally; refusing to clobber drift from a previously valid file"
          : "settings file changed externally and is no longer valid; refusing to overwrite",
      );
    }
    // disk.kind === "ok"
    if (this.#sig === null) {
      throw new SettingsConflictError(
        this.#observedInvalidSig !== null
          ? "settings file was replaced externally since the invalid file was observed; refusing to overwrite"
          : "settings file was created externally; refusing to overwrite",
      );
    }
    if (!sameSig(disk.sig, this.#sig)) {
      throw new SettingsConflictError("settings file changed externally; refusing to overwrite");
    }
  }

  /**
   * Serialize updates between cooperating stores via an operational
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
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) {
          throw new SettingsError(`timed out acquiring settings lock: ${lockPath}`);
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
   * Validate and atomically persist new settings. Throws
   * SettingsConflictError when the on-disk file changed outside this store
   * since our last read/write (concurrent-edit / external-drift detection).
   */
  async update(next: AutomodeSettings): Promise<void> {
    const validated = cloneSettings(next);

    // Early drift check (fast path), then a LATE check under the store lock
    // so cooperating stores cannot interleave a write between check and
    // rename (CAS semantics).
    if (this.#loaded) await this.#checkDrift();

    const dir = path.dirname(this.#filePath);
    const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");

    await this.#withLock(async () => {
      if (this.#loaded) await this.#checkDrift();
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${this.#filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      let handle: fs.FileHandle | null = null;
      try {
        // Re-check the final path is not a symlink immediately before rename;
        // rename would replace the link itself, but we refuse to do so silently.
        const lst = await fs.lstat(this.#filePath).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return null;
          throw err;
        });
        if (lst !== null && lst.isSymbolicLink()) {
          throw new SettingsError(`settings path is a symbolic link: ${this.#filePath}`);
        }
        handle = await fs.open(temp, "wx", 0o600);
        await handle.write(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.chmod(temp, 0o600);
        await fs.rename(temp, this.#filePath);
        // Best-effort directory fsync for durability of the rename.
        try {
          const d = await fs.open(dir, "r");
          await d.sync();
          await d.close();
        } catch {
          /* directory fsync unsupported on some filesystems */
        }
      } finally {
        if (handle !== null) await handle.close().catch(() => {});
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    });

    this.#loaded = true;
    this.#current = validated;
    this.#epoch += 1;
    this.#error = null;
    this.#fileKnown = true;
    this.#observedInvalidSig = null;
    this.#sig = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}
