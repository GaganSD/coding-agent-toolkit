import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkDisclosureConsent,
  normalizeDisclosureEndpoint,
} from "../src/core/disclosure.js";
import {
  SETTINGS_MAX_BYTES,
  SettingsConflictError,
  SettingsStore,
  validateSettings,
} from "../src/settings.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import type { AutomodeSettings } from "../src/types.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "automode-settings-"));
}

async function modeOf(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o777;
}

const VALID_MINIMAL = { version: 1, enabled: true };

test("validateSettings accepts a minimal valid document and applies defaults", () => {
  const s = validateSettings(VALID_MINIMAL);
  assert.equal(s.enabled, true);
  assert.equal(s.classifier, null);
  assert.equal(s.disclosureConsent, "none");
  assert.deepEqual(s.allowlist, []);
  assert.equal(s.disclosureEndpoint, null);
  assert.equal(s.disclosureWorkspace, null);
  assert.equal(s.logRetentionDays, 7);
  assert.equal(s.logMaxEntries, 500);
  assert.equal(s.reviewTimeoutMs, 2000);
  assert.equal(s.reviewMaxRequests, 100);
  assert.equal(s.approvalTimeoutMs, 600_000);
});

test("validateSettings rejects unknown top-level fields, including credentials", () => {
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, apiKey: "sk-secret" }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, credentials: {} }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, extra: 1 }));
});

test("validateSettings rejects prototype-pollution keys without polluting", () => {
  const json = '{"version":1,"enabled":true,"__proto__":{"polluted":true}}';
  assert.throws(() => validateSettings(JSON.parse(json)));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const ruleJson =
    '{"version":1,"enabled":true,"allowlist":[{"type":"command","text":"ls","__proto__":{"x":1}}]}';
  assert.throws(() => validateSettings(JSON.parse(ruleJson)));
  assert.equal(({} as Record<string, unknown>).x, undefined);

  assert.throws(() => validateSettings({ ...VALID_MINIMAL, constructor: {} }));
});

test("validateSettings rejects wrong types", () => {
  assert.throws(() => validateSettings(null));
  assert.throws(() => validateSettings([]));
  assert.throws(() => validateSettings("x"));
  assert.throws(() => validateSettings({ version: 2, enabled: true }));
  assert.throws(() => validateSettings({ version: 1, enabled: "true" }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, disclosureConsent: "yes" }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, classifier: "typesafe" }));
  assert.throws(() =>
    validateSettings({ ...VALID_MINIMAL, classifier: { provider: "p", model: "m", key: "k" } }),
  );
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, classifier: { provider: "", model: "m" } }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, allowlist: {} }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, allowlist: [{ type: "cmd", text: "ls" }] }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, allowlist: [{ type: "command" }] }));
  assert.throws(() =>
    validateSettings({ ...VALID_MINIMAL, allowlist: [{ type: "command", text: "ls", enabled: 1 }] }),
  );
  assert.throws(() =>
    validateSettings({ ...VALID_MINIMAL, allowlist: [{ type: "command", text: "ls", bogus: true }] }),
  );
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, allowlist: [{ type: "command", text: "" }] }));
});

test("validateSettings accepts unicode rule text, rejects control characters", () => {
  const ok = validateSettings({
    ...VALID_MINIMAL,
    blocklist: [{ type: "message", text: "绝不部署到生产环境 🚫" }],
  });
  assert.equal(ok.blocklist[0]?.text, "绝不部署到生产环境 🚫");

  for (const bad of ["badbell", "badescape", "baddel", "badc1"]) {
    assert.throws(
      () => validateSettings({ ...VALID_MINIMAL, allowlist: [{ type: "command", text: bad }] }),
      (e) => e instanceof Error,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  // Tab/newline/CR remain legal inside operator-written text.
  const withNl = validateSettings({
    ...VALID_MINIMAL,
    allowlist: [{ type: "message", text: "line one\nline two\tend" }],
  });
  assert.equal(withNl.allowlist[0]?.text, "line one\nline two\tend");

  assert.throws(() =>
    validateSettings({ ...VALID_MINIMAL, classifier: { provider: "p", model: "m" } }),
  );
});

test("validateSettings enforces numeric bounds", () => {
  const base = { ...VALID_MINIMAL };
  for (const [key, bad] of [
    ["logRetentionDays", 0],
    ["logRetentionDays", 366],
    ["logRetentionDays", 1.5],
    ["logMaxEntries", 0],
    ["logMaxEntries", 100_001],
    ["reviewTimeoutMs", 249],
    ["reviewTimeoutMs", 60_001],
    ["reviewMaxRequests", 0],
    ["approvalTimeoutMs", 4_999],
    ["approvalTimeoutMs", Number.NaN],
  ] as const) {
    assert.throws(() => validateSettings({ ...base, [key]: bad }), (e) => e instanceof Error, `${key}=${bad}`);
  }
  const ok = validateSettings({
    ...base,
    logRetentionDays: 1,
    logMaxEntries: 100_000,
    reviewTimeoutMs: 250,
    reviewMaxRequests: 10_000,
    approvalTimeoutMs: 3_600_000,
  });
  assert.equal(ok.logMaxEntries, 100_000);
});

test("old files without disclosure bindings load with null bindings", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  // Pre-contract-update document: no disclosureEndpoint/disclosureWorkspace keys.
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, enabled: true, disclosureConsent: "approved" }),
  );
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(store.error, null);
  assert.equal(store.current.disclosureConsent, "approved");
  assert.equal(store.current.disclosureProvider, null);
  assert.equal(store.current.disclosureModel, null);
  assert.equal(store.current.disclosureEndpoint, null);
  assert.equal(store.current.disclosureWorkspace, null);
});

test("disclosureEndpoint is normalized to origin+pathname; credential/query URLs are refused", () => {
  assert.equal(
    normalizeDisclosureEndpoint("HTTPS://Example.COM:443/api/v1"),
    "https://example.com/api/v1",
  );
  assert.equal(normalizeDisclosureEndpoint("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/");
  assert.equal(normalizeDisclosureEndpoint("https://user:pw@example.com/x"), null);
  assert.equal(normalizeDisclosureEndpoint("https://example.com/x?key=1"), null);
  assert.equal(normalizeDisclosureEndpoint("https://example.com/x#frag"), null);
  assert.equal(normalizeDisclosureEndpoint("file:///etc/passwd"), null);
  assert.equal(normalizeDisclosureEndpoint("not a url"), null);

  const ok = validateSettings({
    ...VALID_MINIMAL,
    disclosureEndpoint: "https://API.example.com:443/v1",
  });
  assert.equal(ok.disclosureEndpoint, "https://api.example.com/v1");

  for (const bad of [
    "https://user:pw@example.com/x",
    "https://example.com/x?api_key=leak",
    "https://example.com/x#frag",
    "ftp://example.com/x",
  ]) {
    assert.throws(
      () => validateSettings({ ...VALID_MINIMAL, disclosureEndpoint: bad }),
      (e) => e instanceof Error,
      `expected refusal for ${bad}`,
    );
  }
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, disclosureEndpoint: 42 }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, disclosureWorkspace: "" }));
  assert.throws(() => validateSettings({ ...VALID_MINIMAL, disclosureWorkspace: "ws\u0007" }));
});

function consentedSettings(overrides: Partial<AutomodeSettings>): AutomodeSettings {
  return validateSettings({
    version: 1,
    enabled: true,
    classifier: { provider: "typesafe", model: "jev-1.13.2" },
    disclosureConsent: "approved",
    disclosureProvider: "typesafe",
    disclosureModel: "jev-1.13.2",
    disclosureEndpoint: "https://api.typesafe.example/v1",
    disclosureWorkspace: "/canonical/workspace",
    ...overrides,
  });
}

test("disclosure consent: approved with matching bindings is consented", () => {
  const s = consentedSettings({});
  const status = checkDisclosureConsent(s, {
    endpoint: "https://api.typesafe.example/v1",
    workspace: "/canonical/workspace",
  });
  assert.equal(status.consented, true);
});

test("disclosure consent: approved with missing bindings is NOT consent", () => {
  const unbound = validateSettings({
    version: 1,
    enabled: true,
    classifier: { provider: "typesafe", model: "jev-1.13.2" },
    disclosureConsent: "approved",
  });
  const status = checkDisclosureConsent(unbound, {
    endpoint: "https://api.typesafe.example/v1",
    workspace: "/canonical/workspace",
  });
  assert.equal(status.consented, false, "unbound 'approved' cannot upload");

  const endpointOnly = consentedSettings({ disclosureWorkspace: null });
  assert.equal(
    checkDisclosureConsent(endpointOnly, {
      endpoint: "https://api.typesafe.example/v1",
      workspace: "/canonical/workspace",
    }).consented,
    false,
  );
});

test("disclosure consent: endpoint drift for identical provider/model is NOT consent", () => {
  const s = consentedSettings({});
  for (const drifted of [
    "https://api.typesafe.example/v2",
    "https://other.typesafe.example/v1",
    "http://api.typesafe.example/v1",
    "https://api.typesafe.example:8443/v1",
  ]) {
    const status = checkDisclosureConsent(s, { endpoint: drifted, workspace: "/canonical/workspace" });
    assert.equal(status.consented, false, `endpoint drift must not inherit consent: ${drifted}`);
  }
  // An endpoint that cannot be normalized safely never uploads.
  assert.equal(
    checkDisclosureConsent(s, {
      endpoint: "https://api.typesafe.example/v1?x=1",
      workspace: "/canonical/workspace",
    }).consented,
    false,
  );
  assert.equal(
    checkDisclosureConsent(s, { endpoint: null, workspace: "/canonical/workspace" }).consented,
    false,
  );
});

test("disclosure consent: workspace drift is NOT consent", () => {
  const s = consentedSettings({});
  const status = checkDisclosureConsent(s, {
    endpoint: "https://api.typesafe.example/v1",
    workspace: "/canonical/workspace-other",
  });
  assert.equal(status.consented, false);

  for (const consent of ["none", "declined"] as const) {
    const s2 = consentedSettings({ disclosureConsent: consent });
    assert.equal(
      checkDisclosureConsent(s2, {
        endpoint: "https://api.typesafe.example/v1",
        workspace: "/canonical/workspace",
      }).consented,
      false,
    );
  }
  const noClassifier = consentedSettings({ classifier: null });
  assert.equal(
    checkDisclosureConsent(noClassifier, {
      endpoint: "https://api.typesafe.example/v1",
      workspace: "/canonical/workspace",
    }).consented,
    false,
  );
});

test("disclosure consent: approved with endpoint+workspace but wrong/missing provider/model is NOT consent", () => {
  const expected = {
    endpoint: "https://api.typesafe.example/v1",
    workspace: "/canonical/workspace",
  };
  // Missing provider/model binding: approved is not bound, so not consent.
  assert.equal(checkDisclosureConsent(consentedSettings({ disclosureProvider: null }), expected).consented, false);
  assert.equal(checkDisclosureConsent(consentedSettings({ disclosureModel: null }), expected).consented, false);
  assert.equal(
    checkDisclosureConsent(consentedSettings({ disclosureProvider: null, disclosureModel: null }), expected).consented,
    false,
  );
  // Drifted provider/model binding: consent for another pair never covers this one.
  assert.equal(checkDisclosureConsent(consentedSettings({ disclosureModel: "jev-OLD" }), expected).consented, false);
  assert.equal(
    checkDisclosureConsent(consentedSettings({ disclosureProvider: "othertype" }), expected).consented,
    false,
  );
  // Binding to a different pair while the selection matches that pair is consent.
  const rebound = consentedSettings({
    classifier: { provider: "othertype", model: "jev-OLD" },
    disclosureProvider: "othertype",
    disclosureModel: "jev-OLD",
  });
  assert.equal(checkDisclosureConsent(rebound, expected).consented, true);
});

test("missing file legitimately defaults to Off without error", async () => {
  const dir = await tempDir();
  const store = new SettingsStore(path.join(dir, "automode.json"));
  await store.load();
  assert.equal(store.current.enabled, false);
  assert.equal(store.error, null);
  assert.equal(store.epoch, 0);
  assert.deepEqual(store.current, DEFAULT_SETTINGS);
});

test("invalid initial config does NOT silently pass as Off: error is exposed", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  await fs.writeFile(file, "{ not json");
  const store = new SettingsStore(file);
  await store.load();
  assert.notEqual(store.error, null, "invalid initial config must expose an error");
  // Even though current holds safe defaults, the error distinguishes this from
  // a legitimate missing-file Off; callers must halt guarded operation.
  assert.equal(store.current.enabled, false);
});

test("load reads a valid file", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, enabled: true, allowlist: [{ type: "command", text: "ls" }] }),
  );
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(store.error, null);
  assert.equal(store.current.enabled, true);
  assert.equal(store.current.allowlist[0]?.text, "ls");
  assert.equal(store.epoch, 1);
});

test("update persists atomically with 0600 permissions and bumps epoch", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "nested", "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  const next = validateSettings({ version: 1, enabled: true, logMaxEntries: 42 });
  await store.update(next);
  assert.equal(await modeOf(file), 0o600);
  assert.equal(store.epoch, 1);
  assert.equal(store.error, null);

  const reread = new SettingsStore(file);
  await reread.load();
  assert.equal(reread.current.enabled, true);
  assert.equal(reread.current.logMaxEntries, 42);
  assert.deepEqual(reread.current, store.current);

  // No temp files left behind.
  const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("reload returns false when nothing changed, true on external valid change", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(await store.reload(), false);

  await store.update(validateSettings({ version: 1, enabled: true }));
  assert.equal(await store.reload(), false, "own writes must not look like drift");
  const epochAfterUpdate = store.epoch;

  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, enabled: true, blocklist: [{ type: "command", text: "rm -rf /" }] }),
  );
  assert.equal(await store.reload(), true);
  assert.equal(store.epoch, epochAfterUpdate + 1);
  assert.equal(store.error, null);
  assert.equal(store.current.blocklist.length, 1);
});

test("external invalid edit keeps last valid state and exposes error", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  await store.update(validateSettings({ version: 1, enabled: true }));

  await fs.writeFile(file, '{"version":1,"enabled":"definitely"}');
  assert.equal(await store.reload(), false);
  assert.notEqual(store.error, null);
  assert.equal(store.current.enabled, true, "last valid state stays in force, no silent Off");
  assert.equal(store.error !== null && store.current.enabled, true);

  // Recovery: a valid external edit clears the error.
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true }));
  assert.equal(await store.reload(), false, "same effective settings → no change");
  assert.equal(store.error, null);
});

test("external removal after a known file is drift, not a reset to Off", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  await store.update(validateSettings({ version: 1, enabled: true }));

  await fs.rm(file);
  assert.equal(await store.reload(), false);
  assert.notEqual(store.error, null);
  assert.equal(store.current.enabled, true, "removal must not silently disarm");
});

test("update after external modification fails with a conflict, no clobber", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  await store.update(validateSettings({ version: 1, enabled: true }));

  // Simulate a concurrent editor (including same-length content changes).
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: false, logMaxEntries: 7 }));
  await assert.rejects(
    store.update(validateSettings({ version: 1, enabled: false })),
    SettingsConflictError,
  );
  // The external content is untouched by the refused update.
  const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { logMaxEntries: number };
  assert.equal(onDisk.logMaxEntries, 7);

  // After observing the drift via reload, update is allowed again.
  assert.equal(await store.reload(), true);
  await store.update(validateSettings({ version: 1, enabled: false, logMaxEntries: 9 }));
  assert.equal(store.current.logMaxEntries, 9);
});

test("update conflicts when the file is externally created or removed", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true }));
  await assert.rejects(
    store.update(validateSettings({ version: 1, enabled: true })),
    SettingsConflictError,
  );

  const store2 = new SettingsStore(file);
  await store2.load();
  await fs.rm(file);
  await assert.rejects(
    store2.update(validateSettings({ version: 1, enabled: false })),
    SettingsConflictError,
  );
});

test("symlink settings path is rejected on load, reload and update", async () => {
  const dir = await tempDir();
  const target = path.join(dir, "real.json");
  await fs.writeFile(target, JSON.stringify({ version: 1, enabled: true }));
  const link = path.join(dir, "automode.json");
  await fs.symlink(target, link);

  const store = new SettingsStore(link);
  await store.load();
  assert.notEqual(store.error, null);
  assert.match(store.error as string, /symbolic link/);
  assert.equal(store.current.enabled, false);

  await assert.rejects(store.update(validateSettings({ version: 1, enabled: true })));
  // The symlink itself still exists and was not replaced.
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test("update validates its argument and never writes invalid settings", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  const bogus = { ...DEFAULT_SETTINGS, enabled: "yes" } as unknown as AutomodeSettings;
  await assert.rejects(store.update(bogus));
  assert.equal(await store.reload(), false);
  assert.equal(store.error, null);
});

test("update repairs a never-valid invalid file that is unchanged since observation", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  await fs.writeFile(file, "{ not json");
  const store = new SettingsStore(file);
  await store.load();
  assert.notEqual(store.error, null);
  assert.equal(store.halted, true);
  // The official API can repair it: the invalid bytes are exactly those observed.
  await store.update(validateSettings({ version: 1, enabled: false }));
  assert.equal(store.error, null);
  assert.equal(store.halted, false);
  assert.equal(store.current.enabled, false);
  const reread = new SettingsStore(file);
  await reread.load();
  assert.equal(reread.error, null);
});

test("update refuses to repair an invalid file that changed externally after observation", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  await fs.writeFile(file, "{ not json");
  const store = new SettingsStore(file);
  await store.load();
  assert.notEqual(store.error, null);
  await fs.writeFile(file, "{ different but still invalid");
  await assert.rejects(
    store.update(validateSettings({ version: 1, enabled: false })),
    SettingsConflictError,
  );
  assert.equal(await fs.readFile(file, "utf8"), "{ different but still invalid");
  // Replaced by a valid file externally: also drift, never silently clobbered.
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true }));
  await assert.rejects(
    store.update(validateSettings({ version: 1, enabled: false })),
    SettingsConflictError,
  );
});

test("update refuses to clobber a previously valid file that went invalid", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  await store.update(validateSettings({ version: 1, enabled: true }));
  await fs.writeFile(file, "{ corrupt");
  assert.equal(await store.reload(), false);
  assert.notEqual(store.error, null);
  await assert.rejects(
    store.update(validateSettings({ version: 1, enabled: false })),
    SettingsConflictError,
  );
  assert.equal(store.current.enabled, true, "last valid state stays in force");
});

test("repeated load() keeps the last valid state and the error, never resets to Off", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true }));
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(store.current.enabled, true);
  // External corruption, then a repeated load(): last valid stays in force.
  await fs.writeFile(file, "{ corrupt");
  await store.load();
  assert.equal(store.current.enabled, true, "repeated load must not disarm to default Off");
  assert.notEqual(store.error, null);
  assert.equal(store.halted, true);
  // Repeated load after a valid external edit adopts it like reload().
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true, logMaxEntries: 42 }));
  await store.load();
  assert.equal(store.error, null);
  assert.equal(store.current.logMaxEntries, 42);
});

test("concurrent updates from cooperating stores: exactly one wins, no clobber", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const a = new SettingsStore(file);
  const b = new SettingsStore(file);
  await a.load();
  await b.load();
  const results = await Promise.allSettled([
    a.update(validateSettings({ version: 1, enabled: true, logMaxEntries: 11 })),
    b.update(validateSettings({ version: 1, enabled: true, logMaxEntries: 22 })),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one concurrent update may win");
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof SettingsConflictError);
  const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { logMaxEntries: number };
  assert.ok(onDisk.logMaxEntries === 11 || onDisk.logMaxEntries === 22);
  // The loser observes the winner's write as drift on reload.
  const loser = rejected[0] === results[0] ? a : b;
  assert.equal(await loser.reload(), true);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp-") || f.endsWith(".lock"));
  assert.deepEqual(leftovers, []);
});

test("oversized settings file is refused before reading (bounded raw read)", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  await fs.writeFile(file, Buffer.alloc(SETTINGS_MAX_BYTES + 1, 0x7b));
  const store = new SettingsStore(file);
  await store.load();
  assert.notEqual(store.error, null);
  assert.match(store.error as string, /byte bound/);
  assert.equal(store.current.enabled, false);
  assert.equal(store.halted, true);
});

test("rapid successive external edits are each detected (no lost drift)", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "automode.json");
  const store = new SettingsStore(file);
  await store.load();
  for (let i = 1; i <= 3; i += 1) {
    await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true, logMaxEntries: 500 + i }));
    assert.equal(await store.reload(), true, `edit ${i} detected`);
    assert.equal(store.current.logMaxEntries, 500 + i);
  }
  assert.equal(store.epoch, 3);
});
