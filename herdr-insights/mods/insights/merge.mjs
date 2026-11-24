// Merge this computer's snapshot with cached snapshots from remote Herdr
// machines. Pure: no I/O. Remote records are untrusted JSON written by an
// earlier fetch, so every field is validated and every row is rebuilt from an
// allowlist; a bad record is skipped with a warning and never breaks the
// dashboard. Rows from this computer carry `machine: null`.
import { isPlainObject, toNonNegInt, tokenTotal } from "./core/util.mjs";

export const REMOTE_RECORD_VERSION = 1;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_FIELDS = ["harness", "provider", "model", "project"];
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

function text(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

// No "/": session ids are scoped as `<machine>/<session>` and must not collide.
// The dashboard trims machine selections before matching names.
function validMachineName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && value === value.trim() && !value.includes("/");
}

function validDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function remoteRow(raw, machine) {
  if (!isPlainObject(raw) || !validDay(raw.day)) return null;
  const tokens = {};
  for (const field of TOKEN_FIELDS) tokens[field] = toNonNegInt(raw.tokens?.[field]);
  tokens.total = tokenTotal(tokens);
  const session = text(raw.session);
  const row = {
    day: raw.day,
    session: session ? `${machine}/${session}` : "",
    machine,
    tokens,
    messages: toNonNegInt(raw.messages),
    activeMs: toNonNegInt(raw.activeMs),
    longestTaskMs: toNonNegInt(raw.longestTaskMs),
  };
  for (const field of TEXT_FIELDS) row[field] = text(raw[field]);
  return row;
}

/** "ok": last fetch succeeded; "offline": last fetch failed, older rows kept; "error": no rows yet. */
export function machineStatus(record) {
  const hasData = isPlainObject(record?.snapshot) && Array.isArray(record.snapshot.rows);
  if (!hasData) return "error";
  return record.error ? "offline" : "ok";
}

function fetchedTime(record) {
  const time = Date.parse(record?.fetchedAt ?? "");
  return Number.isFinite(time) ? time : -Infinity;
}

function validRecords(records, warnings) {
  const byName = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) {
      warnings.push("remote machine record is not an object; skipped.");
      continue;
    }
    if (record.version !== REMOTE_RECORD_VERSION) {
      warnings.push(`remote machine record version ${text(record.version)} is not supported; skipped.`);
      continue;
    }
    if (!validMachineName(record.machine)) {
      warnings.push(`remote machine record name "${text(record.machine).slice(0, 128)}" is invalid; skipped.`);
      continue;
    }
    const existing = byName.get(record.machine);
    if (!existing || fetchedTime(record) > fetchedTime(existing)) byName.set(record.machine, record);
  }
  return [...byName.values()].sort((a, b) => a.machine.localeCompare(b.machine));
}

export function mergeSnapshots(local, records) {
  const base = isPlainObject(local) ? local : {};
  const warnings = Array.isArray(base.warnings) ? [...base.warnings] : [];
  const localRows = (Array.isArray(base.rows) ? base.rows : []).map((row) => ({ ...row, machine: null }));
  const rows = [...localRows];
  const machines = [{
    name: null,
    status: "ok",
    rowCount: localRows.length,
    fetchedAt: base.generatedAt ?? null,
    lastCompletedScanAt: base.lastCompletedScanAt ?? null,
    error: null,
  }];

  for (const record of validRecords(records, warnings)) {
    const status = machineStatus(record);
    let rowCount = 0;
    let dropped = 0;
    if (status !== "error") {
      for (const raw of record.snapshot.rows) {
        const row = remoteRow(raw, record.machine);
        if (row) {
          rows.push(row);
          rowCount += 1;
        } else {
          dropped += 1;
        }
      }
    }
    if (dropped) warnings.push(`${record.machine}: ${dropped} invalid usage row(s) skipped.`);
    machines.push({
      name: record.machine,
      status,
      rowCount,
      fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : null,
      lastCompletedScanAt: typeof record.snapshot?.lastCompletedScanAt === "string"
        ? record.snapshot.lastCompletedScanAt
        : null,
      error: record.error ? text(record.error) : null,
    });
  }

  return { ...base, rows, machines, warnings };
}
