import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SURFACES } from "../extensions/pi-slate/surfaces.ts";

const entry = process.env.SLATE_COMPAT_HOST
  ? join(await realpath(process.env.SLATE_COMPAT_HOST), "dist/index.js")
  : fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostDir = dirname(dirname(entry));
const { version } = JSON.parse(await readFile(join(hostDir, "package.json"), "utf8"));
const packageDir = await realpath(process.env.SLATE_COMPAT_PACKAGE ?? fileURLToPath(new URL("../", import.meta.url)));
const probe = fileURLToPath(new URL("../scripts/host-smoke.mjs", import.meta.url));

async function runProbe(mode, surfaces, fault) {
  const root = await mkdtemp(join(tmpdir(), "slate-host-compat-"));
  try {
    // Deliberately do not inherit provider keys, credentials, project settings or operator HOME.
    const env = {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
      SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
      PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", TERM: "xterm-256color", NO_COLOR: "1",
      SLATE_COMPAT_HOST_ENTRY: entry, SLATE_COMPAT_HOST_DIR: hostDir, SLATE_COMPAT_VERSION: version,
      SLATE_COMPAT_PACKAGE: packageDir, SLATE_COMPAT_MODE: mode, SLATE_COMPAT_SURFACES: surfaces, SLATE_COMPAT_FAULT: fault,
    };
    const result = spawnSync(process.execPath, [probe], { env, cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const mode of ["regular", "fullscreen"]) {
  for (const [label, surfaces] of [["defaults", "fresh"], ["none", "[]"], ["full", JSON.stringify(SURFACES)]]) {
    test(`real Pi ${version}: ${mode}, ${label} — init, mount, render, replace, shutdown`, async () => {
      const result = await runProbe(mode, surfaces);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const receipt = JSON.parse(result.stdout.trim());
      assert.equal(receipt.host, version); assert.equal(receipt.rendered, true);
      assert.equal(receipt.replaced, true); assert.equal(receipt.shutdown, true); assert.equal(receipt.networkRequests, 0);
    });
  }
}
for (const [fault, expected] of [["quit-shutdown", /Injected quit-only shutdown fault/], ["transcript", /transcript window did not mount/]]) {
  test(`real Pi ${version}: canary rejects ${fault} instead of reporting a false success`, async () => {
    const result = await runProbe("fullscreen", JSON.stringify(SURFACES), fault);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  });
}
