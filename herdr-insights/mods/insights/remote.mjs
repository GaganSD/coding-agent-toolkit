// Remote machine runner for Insights. Imported by main.js (QuickJS) and by
// Node tests, so it has no imports and touches no host APIs: it builds the
// commands main.js runs with exec(..., { on }) and validates what comes back.
// The worker bundle is installed under ~/.cache/herdr-insights/<hash> on the
// remote; only aggregated usage rows travel back.

export const MAX_INSTALL_PAYLOAD = 120_000;
const PROBE_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 60_000;
const ROWS_TIMEOUT_MS = 45_000;
const HASH = /^[0-9a-f]{16}$/;

// Runs as `node -e INSTALL_SCRIPT <hash> [payload]` (CommonJS). Always prints
// one JSON line. The payload is gzip+base64 JSON {files}; it lands in a temp
// dir that is renamed into place only after the content hash matches, so a
// crash or a concurrent installer never leaves a half-written version.
export const INSTALL_SCRIPT = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const [hash, payload] = process.argv.slice(1);
const [major, minor] = process.versions.node.split(".").map(Number);
const base = path.join(os.homedir(), ".cache", "herdr-insights");
const dir = path.join(base, String(hash));
const ready = (installed) => out({ ok: true, installed, dir, node: process.execPath, version: process.version });
const fail = (error) => out({ ok: false, error });
const done = () => fs.existsSync(path.join(dir, ".complete"));
try {
  if (major < 22 || (major === 22 && minor < 15)) fail("Node 22.15+ is required (found " + process.version + ")");
  else if (!/^[0-9a-f]{16}$/.test(String(hash))) fail("invalid bundle hash");
  else if (done()) ready(true);
  else if (!payload) ready(false);
  else {
    const files = JSON.parse(zlib.gunzipSync(Buffer.from(payload, "base64")).toString("utf8")).files;
    const keys = Object.keys(files || {}).sort();
    const digest = crypto.createHash("sha256").update(JSON.stringify(keys.map((k) => [k, files[k]]))).digest("hex").slice(0, 16);
    if (digest !== hash) fail("bundle hash mismatch");
    else if (!keys.length || keys.some((k) => !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(mjs|js|json)$/.test(k) || typeof files[k] !== "string")) fail("bundle has an invalid file");
    else {
      fs.mkdirSync(base, { recursive: true });
      const tmp = dir + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
      try {
        for (const k of keys) {
          fs.mkdirSync(path.dirname(path.join(tmp, k)), { recursive: true });
          fs.writeFileSync(path.join(tmp, k), files[k]);
        }
        fs.writeFileSync(path.join(tmp, ".complete"), hash + "\n");
        try {
          fs.renameSync(tmp, dir);
        } catch (error) {
          if (!done()) throw error;
        }
        ready(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
} catch (error) {
  fail("install failed: " + String(error && error.message || error).slice(0, 300));
}
`;

const LAUNCH = 'n=$(command -v node) || { printf \'%s\\n\' \'{"ok":false,"error":"node was not found on PATH"}\'; exit 0; }; exec "$n" "$@"';
const LOW_PRIORITY = 'if command -v ionice >/dev/null 2>&1; then exec ionice -c3 nice -n 19 "$@"; fi; exec nice -n 19 "$@"';

function nodeScript(args, timeout) {
  return { command: "sh", args: ["-lc", LAUNCH, "sh", "-e", INSTALL_SCRIPT, "--", ...args], timeout };
}

export function probeCommand(hash) {
  return nodeScript([hash], PROBE_TIMEOUT_MS);
}

export function installCommand(hash, payload) {
  if (typeof payload !== "string" || payload.length >= MAX_INSTALL_PAYLOAD) {
    throw new Error("The Insights worker bundle is too large to install in one command.");
  }
  return nodeScript([hash, payload], INSTALL_TIMEOUT_MS);
}

// Named tzdb identifiers fit this allowlist, including Etc/GMT+ offsets.
// Reject shell syntax and path traversal before sending an argument to Herdr.
export function isTimeZoneId(value) {
  return typeof value === "string" && value.length <= 60
    && /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value);
}

export function timeZoneStoreKey(timeZone) {
  if (!isTimeZoneId(timeZone)) throw new Error("Invalid Insights timezone.");
  return machineFileStem(timeZone);
}

export function rowsCommand(probe, timeZone) {
  if (!isTimeZoneId(timeZone)) throw new Error("Invalid Insights timezone.");
  return {
    command: "sh",
    args: ["-lc", LOW_PRIORITY, "sh", "env", `TZ=${timeZone}`, probe.node, `${probe.dir}/remote-entry.mjs`, "rows"],
    timeout: ROWS_TIMEOUT_MS,
  };
}

function lastJsonLine(stdout) {
  const lines = String(stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("The remote command printed nothing.");
  let value;
  try {
    value = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error("The remote command printed invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The remote command printed unexpected JSON.");
  return value;
}

const isText = (value) => typeof value === "string" && value.length > 0;
const isCount = (value) => Number.isInteger(value) && value >= 0;

export function parseProbe(stdout) {
  const value = lastJsonLine(stdout);
  if (value.ok !== true) {
    return {
      ok: false, installed: false, dir: null, node: null, version: null,
      error: isText(value.error) ? value.error.slice(0, 300) : "The remote check failed.",
    };
  }
  if (!isText(value.dir) || !value.dir.startsWith("/")) throw new Error("The remote check returned no install dir.");
  if (!isText(value.node)) throw new Error("The remote check returned no node path.");
  return {
    ok: true,
    installed: value.installed === true,
    dir: value.dir,
    node: value.node,
    version: isText(value.version) ? value.version : null,
    error: null,
  };
}

const nullableText = (value) => value === null || value === undefined || typeof value === "string";

export function parseRows(stdout) {
  const value = lastJsonLine(stdout);
  if (value.kind !== "insights-remote-rows" || value.version !== 1) throw new Error("The remote helper returned an unexpected payload.");
  if (isText(value.error)) throw new Error(value.error.slice(0, 300));
  const scan = value.scan;
  if (
    typeof value.rows !== "string"
    || !isCount(value.rowCount)
    || !scan || typeof scan !== "object" || typeof scan.status !== "string"
    || !Array.isArray(value.warnings)
    || ![value.generatedAt, value.lastScanAt, value.lastCompletedScanAt].every(nullableText)
  ) {
    throw new Error("The remote helper returned an invalid usage payload.");
  }
  return {
    ...value,
    scan: progressCounters(scan),
    warnings: [],
    warningCount: finiteCount(value.warningCount ?? value.warnings.length),
  };
}

const finiteCount = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

export function hasScanFailure(scan) {
  return scan?.status === "failed" || scan?.failed === true;
}

// Only counters cross to the Mac: the live file a remote scanner has open is
// a path on that machine and is not shown or stored.
function progressCounters(scan) {
  const live = scan.live && typeof scan.live === "object" ? scan.live : null;
  return {
    status: scan.status,
    ...(hasScanFailure(scan) ? { failed: true } : {}),
    processed: finiteCount(scan.processed),
    total: finiteCount(scan.total),
    live: live && {
      phase: typeof live.phase === "string" ? live.phase : null,
      processed: finiteCount(live.processed),
      total: finiteCount(live.total),
      decodedBytes: finiteCount(live.decodedBytes),
    },
  };
}

function failure(result, step) {
  const lines = String(result.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const detail = lines.length ? lines[lines.length - 1].slice(0, 300) : `exit code ${result.code}`;
  return new Error(`Remote ${step} failed: ${detail}`);
}

async function runStep(exec, { command, args, timeout }, step) {
  const result = await exec(command, args, { timeout });
  if (result.code !== 0) throw failure(result, step);
  return result.stdout;
}

/** Probe, install when this bundle version is missing, then fetch usage rows. */
export async function syncMachine({ exec, bundle, timeZone }) {
  const { hash, payload } = await bundle();
  if (!HASH.test(String(hash))) throw new Error("The Insights worker bundle has an invalid hash.");
  let probe = parseProbe(await runStep(exec, probeCommand(hash), "check"));
  if (!probe.ok) throw new Error(probe.error);
  if (!probe.installed) {
    probe = parseProbe(await runStep(exec, installCommand(hash, payload), "install"));
    if (!probe.ok) throw new Error(probe.error);
    if (!probe.installed) throw new Error("Remote install did not complete.");
  }
  const envelope = parseRows(await runStep(exec, rowsCommand(probe, timeZone), "scan"));
  return { probe, envelope };
}

// Lowercase only: macOS disks ignore case, so "Box" and "box" need two files.
const PLAIN_STEM = /^[a-z0-9._-]{1,128}$/;

/** A file name for a machine. Plain names map to themselves; any name that could
 * be confused with the encoded form, or is unsafe, is hex-encoded with "x-". */
export function machineFileStem(name) {
  const text = String(name);
  if (PLAIN_STEM.test(text) && text !== "." && text !== ".." && !text.startsWith("x-")) return text;
  let hex = "";
  for (let index = 0; index < text.length; index += 1) hex += text.charCodeAt(index).toString(16).padStart(4, "0");
  return `x-${hex}`;
}

export function rowsFileText({ machine, envelope, fetchedAt }) {
  return JSON.stringify({ version: 1, kind: "insights-remote-machine-rows", machine, fetchedAt, envelope });
}

export function stateFileText({ machine, attemptedAt, error }) {
  return JSON.stringify({ version: 1, kind: "insights-remote-machine-state", machine, attemptedAt, error: error ?? null });
}
