// Upgrade canary: install the built artifact and a freshly resolved latest Pi in a temporary consumer.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment, npm, run } from "../../scripts/lib.mjs";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const artifacts = fileURLToPath(new URL("../../.artifacts/pi-slate/", import.meta.url));
const metadata = JSON.parse(readFileSync(join(artifacts, "manifest.json"), "utf8"));
assert.equal(metadata.name, "pi-slate");
assert.equal(metadata.filename, `pi-slate-${metadata.version}.tgz`);
const temporary = mkdtempSync(join(tmpdir(), "slate-latest-host-"));
try {
  const env = isolatedEnvironment(temporary);
  console.log("Installing the packed Slate artifact and resolving the latest stable Pi host (setup network only).");
  npm(["install", "--prefix", temporary, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--package-lock=false",
    "@earendil-works/pi-coding-agent@latest", join(artifacts, metadata.filename)], { cwd: temporary, env, stdio: "inherit" });
  const host = join(temporary, "node_modules/@earendil-works/pi-coding-agent");
  const { version } = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));
  console.log(`Latest-host canary: Pi ${version}, packed Slate ${metadata.version}`);
  run(process.execPath, ["--experimental-strip-types", "--test", "tests/host-compat.test.mjs"], {
    cwd: packageDir, env: { ...env, SLATE_COMPAT_HOST: host, SLATE_COMPAT_PACKAGE: join(temporary, "node_modules/pi-slate") }, stdio: "inherit",
  });
} finally { rmSync(temporary, { recursive: true, force: true }); }
