import assert from "node:assert/strict";
import { promises as fs, type PathLike } from "node:fs";
import test, { type TestContext } from "node:test";

import { analyzeShell } from "../src/core/shell.js";

async function resolveAs(t: TestContext, resolved: string, command = "/usr/bin/ls", executable = true) {
  // Model a distro symlink without writing to any system directory or executing it.
  const stat = await fs.stat(process.execPath);
  if (!executable) stat.mode &= ~0o111;
  const candidate = command.split(" ")[0]!;
  t.mock.method(fs, "realpath", async (file: PathLike) => {
    assert.equal(file, candidate);
    return resolved;
  });
  t.mock.method(fs, "stat", async (file: PathLike) => {
    assert.ok(file === candidate || file === resolved);
    return stat;
  });
  return analyzeShell(command, "/workspace", "/workspace", {
    env: { PATH: "/usr/bin" },
    protection: { workspace: "/workspace", homeDir: "/home/operator", agentDir: "/agent", extensionDir: "/extension" },
  });
}

for (const resolved of ["/bin/ls", "/usr/bin/ls", "/usr/lib/cargo/bin/coreutils/ls"]) {
  test(`verified read-only command accepts system realpath ${resolved}`, async t => {
    const analysis = await resolveAs(t, resolved, "/usr/bin/ls -la");
    assert.equal(analysis.resolution.opaqueReason, undefined);
    assert.equal(analysis.resolution.resolvedExecutable, resolved);
    assert.deepEqual(analysis.referencedFiles, [resolved], "canonical executable is retained for fingerprinting");
  });
}

for (const resolved of [
  "/usr/lib/cargo/bin/ls", "/usr/lib/cargo/bin/coreutils-evil/ls",
  "/home/operator/.cargo/bin/ls", "/tmp/ls",
]) {
  test(`same-named executable outside the precise system prefixes stays opaque: ${resolved}`, async t => {
    const analysis = await resolveAs(t, resolved);
    assert.match(analysis.resolution.opaqueReason ?? "", /outside trusted system prefixes/);
  });
}

test("system coreutils cannot inherit another program's argument profile", async t => {
  const analysis = await resolveAs(t, "/usr/lib/cargo/bin/coreutils/hostname");
  assert.match(analysis.resolution.opaqueReason ?? "", /different program/);
});

test("workspace-controlled alias to system coreutils stays opaque", async t => {
  const analysis = await resolveAs(t, "/usr/lib/cargo/bin/coreutils/ls", "/workspace/ls");
  assert.match(analysis.resolution.opaqueReason ?? "", /lexically inside the workspace/);
});

test("system coreutils still requires executable permissions", async t => {
  const analysis = await resolveAs(t, "/usr/lib/cargo/bin/coreutils/ls", "/usr/bin/ls", false);
  assert.match(analysis.resolution.opaqueReason ?? "", /not an executable regular file/);
});

test("system coreutils still rejects flags outside the verified read-only subset", async t => {
  const analysis = await resolveAs(t, "/usr/lib/cargo/bin/coreutils/ls", "/usr/bin/ls --unknown-flag");
  assert.match(analysis.resolution.opaqueReason ?? "", /not in the verified read-only set/);
});
