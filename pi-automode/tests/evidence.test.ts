import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEvidence, SNAPSHOT_HASH_MAX_BYTES } from "../src/evidence.js";
import { evaluatePolicy } from "../src/policy.js";
import { validateSettings } from "../src/settings.js";
import type { Action, ActionEvidence } from "../src/types.js";

interface Fixture {
  workspace: string;
  agentDir: string;
  extensionDir: string;
  homeDir: string;
}

async function fixture(): Promise<Fixture> {
  // Canonicalize: on macOS the tmpdir root is itself behind a symlink.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "automode-evidence-")));
  const workspace = path.join(root, "ws");
  const agentDir = path.join(root, "agent");
  const extensionDir = path.join(root, "ext");
  const homeDir = path.join(root, "home");
  for (const d of [workspace, agentDir, extensionDir, homeDir]) {
    await fs.mkdir(d, { recursive: true });
  }
  return { workspace, agentDir, extensionDir, homeDir };
}

function action(tool: string, args: Record<string, unknown>, cwd: string, requestId = "r1"): Action {
  return { requestId, tool, args, cwd };
}

async function evidenceFor(
  fx: Fixture,
  tool: string,
  args: Record<string, unknown>,
  cwd?: string,
): Promise<ActionEvidence> {
  return buildEvidence(action(tool, args, cwd ?? fx.workspace), fx);
}

test("plain workspace file read: canonical path, complete, not sensitive", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "a.txt"), "hello");
  const ev = await evidenceFor(fx, "read", { path: "a.txt" });
  assert.equal(ev.complete, true);
  assert.equal(ev.sensitive, false);
  assert.equal(ev.protectedReason, undefined);
  assert.equal(ev.canonicalPath, path.join(fx.workspace, "a.txt"));
  assert.equal(ev.snapshots[0]?.kind, "file");
  assert.match(ev.snapshots[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("symlink inside workspace pointing outside resolves canonically outside", async () => {
  const fx = await fixture();
  const outside = path.join(fx.homeDir, "outside.txt");
  await fs.writeFile(outside, "secret-ish");
  await fs.symlink(outside, path.join(fx.workspace, "link.txt"));
  const ev = await evidenceFor(fx, "read", { path: "link.txt" });
  assert.equal(ev.canonicalPath, outside, "canonical target escapes the workspace");
  assert.equal(ev.complete, true);
});

test("symlink to a protected target is protected via the canonical path", async () => {
  const fx = await fixture();
  const envTarget = path.join(fx.homeDir, ".env");
  await fs.writeFile(envTarget, "TOKEN=x");
  await fs.symlink(envTarget, path.join(fx.workspace, "innocent.txt"));
  const ev = await evidenceFor(fx, "write", { path: "innocent.txt", content: "x" });
  assert.equal(ev.protectedReason, "secret-file");
  assert.equal(ev.sensitive, true);
});

test("protected names: lexical aliases and paths across the workspace", async () => {
  const fx = await fixture();
  const cases: Array<[string, string]> = [
    [".env", "secret-file"],
    ["sub/dir/.env.production", "secret-file"],
    [".git/hooks/pre-commit", "git-hooks"],
    [".git/config", "git-config"],
    [".git/config.worktree", "git-config"],
    ["vendor/repo/.git/hooks/x", "git-hooks"],
    [".github/workflows/ci.yml", "ci-workflow"],
    ["nested/.github/workflows/ci.yml", "ci-workflow"],
    [".gitlab-ci.yml", "ci-configuration"],
    [".circleci/config.yml", "ci-configuration"],
    ["Jenkinsfile", "ci-configuration"],
    [".pi/settings.json", "project-pi-directory"],
    ["keys/id_ed25519", "secret-file"],
    ["cert.pem", "secret-file"],
  ];
  for (const [rel, reason] of cases) {
    const ev = await evidenceFor(fx, "write", { path: rel, content: "x" });
    assert.equal(ev.protectedReason, reason, `${rel} should be protected (${reason})`);
  }
  const benign = await evidenceFor(fx, "write", { path: "src/index.ts", content: "x" });
  assert.equal(benign.protectedReason, undefined);
});

test("new (not-yet-created) descendants of protected directories stay protected", async () => {
  const fx = await fixture();
  // .git/hooks does not exist on disk; the lexical name must still protect.
  const ev = await evidenceFor(fx, "write", { path: ".git/hooks/post-checkout", content: "x" });
  assert.equal(ev.protectedReason, "git-hooks");
  assert.equal(ev.snapshots[0]?.kind, "missing");
  assert.equal(ev.complete, true, "missing target is provable for a new write");
});

test("agent dir, extension dir and home key stores are protected", async () => {
  const fx = await fixture();
  const agentFile = await buildEvidence(
    action("read", { path: path.join(fx.agentDir, "automode.json") }, fx.workspace),
    fx,
  );
  assert.equal(agentFile.protectedReason, "pi-agent-directory");
  assert.equal(agentFile.sensitive, true);

  const extFile = await buildEvidence(
    action("write", { path: path.join(fx.extensionDir, "src", "index.js"), content: "x" }, fx.workspace),
    fx,
  );
  assert.equal(extFile.protectedReason, "automode-extension-code");

  await fs.mkdir(path.join(fx.homeDir, ".ssh"), { recursive: true });
  const ssh = await buildEvidence(
    action("read", { path: path.join(fx.homeDir, ".ssh", "id_rsa") }, fx.workspace),
    fx,
  );
  assert.equal(ssh.protectedReason, "ssh-key-store");
  assert.equal(ssh.sensitive, true);
});

test("hard-linked targets are incomplete: the floor must not silently approve an alias", async () => {
  const fx = await fixture();
  const original = path.join(fx.workspace, "orig.txt");
  await fs.writeFile(original, "data");
  const alias = path.join(fx.workspace, "alias.txt");
  await fs.link(original, alias);
  const ev = await evidenceFor(fx, "edit", { path: "alias.txt", old_string: "a", new_string: "b" });
  assert.equal(ev.complete, false);
  assert.match(ev.reason ?? "", /hard link/);
  assert.equal((ev.snapshots[0]?.nlink ?? 0) > 1, true);
});

test("bash: a hard-linked operand is incomplete — an exact allow rule still asks", async () => {
  const fx = await fixture();
  const original = path.join(fx.workspace, "orig.txt");
  await fs.writeFile(original, "data");
  const alias = path.join(fx.workspace, "alias.txt");
  await fs.link(original, alias);
  const ev = await evidenceFor(fx, "bash", { command: "cat alias.txt" });
  assert.equal(ev.complete, false, "an nlink>1 operand's workspace-local identity is unprovable");
  assert.match(ev.reason ?? "", /hard link/);
  // The exact allow rule must NOT fire on unprovable operand identity.
  const settings = validateSettings({
    version: 1,
    enabled: true,
    allowlist: [{ type: "command", text: "cat alias.txt" }],
  });
  const decision = evaluatePolicy(ev, settings);
  assert.equal(decision.outcome, "ask");
  assert.notEqual(decision.source, "rule:allowlist");
});

test("path traversal outside the workspace resolves canonically outside", async () => {
  const fx = await fixture();
  const ev = await evidenceFor(fx, "read", { path: "../agent/automode.json" });
  assert.equal(ev.canonicalPath, path.join(fx.agentDir, "automode.json"));
  assert.equal(ev.protectedReason, "pi-agent-directory");
});

test("missing path argument and non-string arguments make evidence incomplete", async () => {
  const fx = await fixture();
  const ev = await evidenceFor(fx, "read", {});
  assert.equal(ev.complete, false);
  assert.match(ev.reason ?? "", /path/);
  const ev2 = await evidenceFor(fx, "read", { path: 42 });
  assert.equal(ev2.complete, false);
});

test("fingerprints bind exact bytes, cwd and content — not request IDs", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "a.txt"), "one");
  const a1 = await buildEvidence(action("read", { path: "a.txt" }, fx.workspace, "req-1"), fx);
  const a2 = await buildEvidence(action("read", { path: "a.txt" }, fx.workspace, "req-2"), fx);
  assert.equal(a1.fingerprint, a2.fingerprint, "request ID must not affect the fingerprint");

  const b = await buildEvidence(action("read", { path: "a.txt " }, fx.workspace), fx);
  assert.notEqual(b.fingerprint, a1.fingerprint, "one differing byte changes the fingerprint");

  const sub = path.join(fx.workspace, "sub");
  await fs.mkdir(sub);
  const c = await buildEvidence(action("read", { path: "../a.txt" }, sub), fx);
  assert.equal(c.canonicalPath, a1.canonicalPath);
  assert.notEqual(c.fingerprint, a1.fingerprint, "different cwd changes the fingerprint");

  await fs.writeFile(path.join(fx.workspace, "a.txt"), "two");
  const a3 = await buildEvidence(action("read", { path: "a.txt" }, fx.workspace, "req-1"), fx);
  assert.notEqual(a3.fingerprint, a1.fingerprint, "changed target content changes the fingerprint");
});

test("bash: simple proven command resolves completely; composition is opaque", async () => {
  const fx = await fixture();
  const ls = await evidenceFor(fx, "bash", { command: "ls -la" });
  assert.equal(ls.complete, true, `expected complete, got: ${ls.reason ?? ""}`);
  assert.ok(ls.shell?.resolvedExecutable);
  assert.equal(ls.shell?.opaqueReason, undefined);

  for (const cmd of ["ls | grep x", "echo $(whoami)", "echo hi > f.txt", "ls; ls", "ls && pwd"]) {
    const ev = await evidenceFor(fx, "bash", { command: cmd });
    assert.equal(ev.complete, false, cmd);
    assert.match(ev.reason ?? "", /shell evidence incomplete/);
  }
});

test("bash: git is opaque even for read-only subcommands", async () => {
  const fx = await fixture();
  for (const cmd of ["git status", "git diff --stat", "git log -1"]) {
    const ev = await evidenceFor(fx, "bash", { command: cmd });
    assert.equal(ev.complete, false, cmd);
    assert.match(ev.shell?.opaqueReason ?? "", /not in the narrowly verified set/);
  }
});

test("bash: interpreters and package managers are opaque but snapshot relevant inputs", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
  const npm = await evidenceFor(fx, "bash", { command: "npm test -- parser" });
  assert.equal(npm.complete, false);
  const pkgSnap = npm.snapshots.find((s) => s.canonicalPath.endsWith("package.json"));
  assert.ok(pkgSnap, "package.json snapshot recorded");
  assert.match(pkgSnap.sha256 ?? "", /^[0-9a-f]{64}$/);

  await fs.writeFile(path.join(fx.workspace, "run.sh"), "echo hi");
  const script = await evidenceFor(fx, "bash", { command: "bash run.sh" });
  assert.equal(script.complete, false);
  const scriptSnap = script.snapshots.find((s) => s.canonicalPath.endsWith("run.sh"));
  assert.ok(scriptSnap, "script snapshot recorded");

  // Changing the referenced script changes the fingerprint even though the
  // command bytes are identical (script-write → execute revalidation).
  const before = script.fingerprint;
  await fs.writeFile(path.join(fx.workspace, "run.sh"), "echo pwned");
  const after = (await evidenceFor(fx, "bash", { command: "bash run.sh" })).fingerprint;
  assert.notEqual(after, before);
});

test("bash: PATH/workspace executable shadowing is opaque", async () => {
  const fx = await fixture();
  const bin = path.join(fx.workspace, "bin");
  await fs.mkdir(bin);
  const fakeLs = path.join(bin, "ls");
  await fs.writeFile(fakeLs, "#!/bin/sh\necho shadowed");
  await fs.chmod(fakeLs, 0o755);
  // PATH containing a workspace directory: resolution lands inside the workspace.
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const shadowed = await evidenceFor(fx, "bash", { command: "ls" });
    assert.equal(shadowed.complete, false);
    assert.match(shadowed.shell?.opaqueReason ?? "", /workspace/);
  } finally {
    process.env.PATH = savedPath;
  }

  const explicit = await evidenceFor(fx, "bash", { command: "./bin/ls" });
  assert.equal(explicit.complete, false);
});

test("bash: shell startup environment (BASH_ENV) makes evidence incomplete", async () => {
  const fx = await fixture();
  process.env.BASH_ENV = "/tmp/whatever";
  try {
    const ev = await evidenceFor(fx, "bash", { command: "ls" });
    assert.equal(ev.complete, false);
    assert.match(ev.shell?.opaqueReason ?? "", /BASH_ENV/);
  } finally {
    delete process.env.BASH_ENV;
  }
});

test("bash: leading env assignments and unterminated quotes are opaque", async () => {
  const fx = await fixture();
  const envAssign = await evidenceFor(fx, "bash", { command: "FOO=bar ls" });
  assert.equal(envAssign.complete, false);
  const unterminated = await evidenceFor(fx, "bash", { command: "echo 'unterminated" });
  assert.equal(unterminated.complete, false);
  const missingArg = await evidenceFor(fx, "bash", {});
  assert.equal(missingArg.complete, false);
});

test("unknown tools still produce evidence with a fingerprint (policy blocks them)", async () => {
  const fx = await fixture();
  const ev = await evidenceFor(fx, "mcp_server_tool", { anything: true });
  assert.match(ev.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(ev.canonicalPath, undefined);
});

test("raw Pi-expanding path syntax fails closed (runtime must normalize first)", async () => {
  const fx = await fixture();
  // Pi's resolveToCwd rewrites each of these before touching the filesystem
  // (unicode spaces -> space, strip one '@', expand '~', decode file://).
  // Reaching the core raw means the runtime skipped translation; the literal
  // spelling must NEVER be classified as the real target and floor-Allowed.
  const risky = [
    "@.env",
    "@.git/hooks/pre-commit",
    "@/etc/passwd",
    "~/.ssh/config",
    "~",
    "file:///etc/passwd",
    "\u00A0.env", // NBSP: Pi normalizes to ' .env'
    "dir\u2009/.env", // thin space
  ];
  for (const p of risky) {
    const ev = await evidenceFor(fx, "write", { path: p, content: "x" });
    assert.equal(ev.complete, false, `${JSON.stringify(p)} must be incomplete`);
    assert.match(ev.reason ?? "", /Pi-expanding syntax/, JSON.stringify(p));
  }
  // Even when the literal spelling exists on disk, it stays incomplete.
  await fs.writeFile(path.join(fx.workspace, "@.env"), "TOKEN=x");
  const at = await evidenceFor(fx, "read", { path: "@.env" });
  assert.equal(at.complete, false, "literal '@.env' file must not launder the raw syntax");
  // A plain literal path is unaffected.
  await fs.writeFile(path.join(fx.workspace, "plain.txt"), "x");
  const plain = await evidenceFor(fx, "read", { path: "plain.txt" });
  assert.equal(plain.complete, true);
});

test("protected names match case-folded and NFC/NFD-conservatively (APFS aliases)", async () => {
  const fx = await fixture();
  // On case-insensitive/normalizing filesystems a NEW file spelled .ENV or
  // .GIT/... IS .env / .git/... on disk; there is no realpath to recover the
  // true case, so the lexical classification must fold.
  const cases: Array<[string, string]> = [
    [".ENV", "secret-file"],
    [".Env", "secret-file"],
    [".envrc", "secret-file"],
    [".ENVRC", "secret-file"],
    [".env/production", "secret-file"], // .env as a directory: descendants stay secret
    [".GIT/hooks/post-checkout", "git-hooks"],
    [".Git/CoNfIg", "git-config"],
    [".git", "git-metadata"], // worktree gitdir pointer file
    [".git/index", "git-metadata"],
    ["sub/repo/.GIT/refs/heads/main", "git-metadata"],
    [".PI/settings.json", "project-pi-directory"],
    ["ID_RSA", "secret-file"],
    ["keys/ID_ED25519", "secret-file"],
    ["CERT.PEM", "secret-file"],
    ["JENKINSFILE", "ci-configuration"],
    [".GITHUB/workflows/ci.yml", "ci-workflow"],
    [".CIRCLECI/config.yml", "ci-configuration"],
  ];
  for (const [rel, reason] of cases) {
    const ev = await evidenceFor(fx, "write", { path: rel, content: "x" });
    assert.equal(ev.protectedReason, reason, `${rel} should be protected (${reason})`);
  }
});

test("fingerprint binds nlink: a new hardlink alias invalidates a prior allow", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "fp.txt"), "data");
  const before = await evidenceFor(fx, "read", { path: "fp.txt" });
  await fs.link(path.join(fx.workspace, "fp.txt"), path.join(fx.workspace, "fp-alias.txt"));
  const after = await evidenceFor(fx, "read", { path: "fp.txt" });
  assert.notEqual(after.fingerprint, before.fingerprint, "nlink 1->2 must change the fingerprint");
  assert.equal(after.complete, false, "nlink>1 stays an Ask");
  assert.equal(after.snapshots[0]?.nlink, 2);
});

test("protected/sensitive targets are snapshotted metadata-only (no secret bytes hashed)", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, ".env"), "TOKEN=supersecret");
  const ev = await evidenceFor(fx, "write", { path: ".env", content: "x" });
  assert.equal(ev.protectedReason, "secret-file");
  const snap = ev.snapshots[0];
  assert.ok(snap);
  assert.equal(snap.sha256, undefined, "never content-hash a known secret");
  assert.equal(snap.size, 17, "metadata still bound");
  assert.ok(snap.ino !== undefined && snap.dev !== undefined);
});

test("oversized files are hashed over a bounded prefix, never slurped whole", async () => {
  const fx = await fixture();
  const big = path.join(fx.workspace, "big.bin");
  await fs.writeFile(big, Buffer.alloc(SNAPSHOT_HASH_MAX_BYTES + 1, 0x61));
  const ev = await evidenceFor(fx, "read", { path: "big.bin" });
  const snap = ev.snapshots[0];
  assert.ok(snap);
  assert.match(snap.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(snap.hashTruncated, true);
  assert.equal(snap.size, SNAPSHOT_HASH_MAX_BYTES + 1);
  assert.equal(ev.complete, true);
});

test("bash: mutation/exec-flag programs are opaque even with exact-looking bytes", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "in.txt"), "b\na\n");
  const opaque = [
    "sort -o .git/hooks/pre-commit in.txt", // POSIX -o writes
    "sort -o out.txt in.txt", // destination never classified
    "sort --compress-program=/tmp/x in.txt", // executes a helper
    "date 0101000025", // BSD clock set
    "date -s @0", // GNU clock set
    "diff --output=x a b",
    "grep -r x .",
    "ls -o", // flag outside the verified read-only set
    "cat ~/.ssh/config", // tilde expands after our lex
    "cat *.txt", // glob expands after our lex
    "cat /etc/passwd", // operand canonically outside the workspace
  ];
  for (const command of opaque) {
    const ev = await evidenceFor(fx, "bash", { command });
    assert.equal(ev.complete, false, command);
    assert.match(ev.reason ?? "", /shell evidence incomplete/, command);
  }
  // A protected operand of a proven program is opaque too.
  const prot = await evidenceFor(fx, "bash", { command: "cat ../agent/automode.json" });
  assert.equal(prot.complete, false);
  assert.match(prot.shell?.opaqueReason ?? "", /protected/);
  // A symlink operand escaping the workspace is opaque.
  await fs.symlink(path.join(fx.homeDir, "outside.txt"), path.join(fx.workspace, "esc.txt"));
  await fs.writeFile(path.join(fx.homeDir, "outside.txt"), "x");
  const esc = await evidenceFor(fx, "bash", { command: "cat esc.txt" });
  assert.equal(esc.complete, false);
  // The verified subset still works: proven program, allowlisted flags,
  // workspace-local operand — and the executable itself is snapshotted.
  const ok = await evidenceFor(fx, "bash", { command: "cat in.txt" });
  assert.equal(ok.complete, true, ok.reason ?? "");
  assert.ok(
    ok.snapshots.some((s) => s.canonicalPath === ok.shell?.resolvedExecutable && s.sha256 !== undefined),
    "executable content must be bound into evidence",
  );
});

test("bash: a same-named binary outside trusted prefixes is never trusted by name", async () => {
  const fx = await fixture();
  const fakebin = path.join(fx.homeDir, "fakebin");
  await fs.mkdir(fakebin);
  const fakeCat = path.join(fakebin, "cat");
  await fs.writeFile(fakeCat, "#!/bin/sh\ncp \"$2\" /tmp/pwned\n");
  await fs.chmod(fakeCat, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakebin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const ev = await evidenceFor(fx, "bash", { command: "cat in.txt" });
    assert.equal(ev.complete, false);
    assert.match(ev.shell?.opaqueReason ?? "", /trusted system prefixes/);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("bash: Pi prepends <agentDir>/bin to the shell PATH; a planted binary there is opaque", async () => {
  const fx = await fixture();
  const agentBin = path.join(fx.agentDir, "bin");
  await fs.mkdir(agentBin, { recursive: true });
  const planted = path.join(agentBin, "ls");
  await fs.writeFile(planted, "#!/bin/sh\necho pwned\n");
  await fs.chmod(planted, 0o755);
  const ev = await evidenceFor(fx, "bash", { command: "ls" });
  assert.equal(ev.shell?.resolvedExecutable, planted, "resolution must model Pi's PATH prepend");
  assert.equal(ev.complete, false, "a planted agentDir/bin binary is not a verified system tool");
  await fs.rm(agentBin, { recursive: true, force: true });
  const clean = await evidenceFor(fx, "bash", { command: "ls" });
  assert.equal(clean.complete, true, clean.reason ?? "");
});

test("bash: exported BASH_FUNC_* shell functions make every command opaque", async () => {
  const fx = await fixture();
  process.env["BASH_FUNC_ls%%"] = "() { echo pwned; }";
  try {
    const ev = await evidenceFor(fx, "bash", { command: "ls" });
    assert.equal(ev.complete, false);
    assert.match(ev.shell?.opaqueReason ?? "", /BASH_FUNC/);
  } finally {
    delete process.env["BASH_FUNC_ls%%"];
  }
});

// ---------------------------------------------------------------
// Integration regressions (parent-confirmed): two shell-analysis bugs that
// produced complete/floor-allowable evidence for effectful invocations.

test("bash: empty quoted operands are real arguments — `hostname ''` is a setter, never complete", async () => {
  const fx = await fixture();
  // The lexer previously dropped empty quoted tokens, so `hostname ''` /
  // `hostname ""` looked like the zero-operand read-only form while the real
  // shell would set the hostname to the empty string.
  for (const cmd of ["hostname ''", 'hostname ""']) {
    const ev = await evidenceFor(fx, "bash", { command: cmd });
    assert.equal(ev.complete, false, `${cmd} must not be complete/Allow-eligible`);
    if (ev.shell?.resolvedExecutable !== undefined) {
      assert.match(ev.shell.opaqueReason ?? "", /takes no operands/, cmd);
    }
  }
  // Sanity: the genuinely zero-operand form stays provable when resolvable.
  const plain = await evidenceFor(fx, "bash", { command: "hostname" });
  if (plain.shell?.resolvedExecutable !== undefined) {
    assert.equal(plain.complete, true, plain.reason ?? "");
  }
  // Empty quoted PATH operands stay visible to operand verification too:
  // `cat ''` RETAINS the empty argument, which resolves to the cwd (the
  // workspace directory) — a harmless read-only directory operand inside the
  // workspace, not an opaque invocation. The proof it was analysed: the
  // resolved workspace directory is referenced and snapshotted, unlike
  // operand-free `cat`, which references only the executable.
  const emptyOperand = await evidenceFor(fx, "bash", { command: "cat ''" });
  assert.equal(
    emptyOperand.shell?.opaqueReason,
    undefined,
    `in-workspace cwd-directory operand is harmless read-only, not opaque: ${emptyOperand.shell?.opaqueReason ?? ""}`,
  );
  const cwdSnaps = emptyOperand.snapshots.filter((s) => s.canonicalPath === emptyOperand.workspace);
  assert.equal(cwdSnaps.length, 1, "the empty operand's resolved cwd directory is snapshotted");
  assert.equal(cwdSnaps[0]?.kind, "directory", "the empty operand resolves to the session cwd directory");
  const noOperand = await evidenceFor(fx, "bash", { command: "cat" });
  assert.equal(
    noOperand.snapshots.some((s) => s.canonicalPath === noOperand.workspace),
    false,
    "operand-free cat references no workspace directory — the retained empty operand made the difference",
  );
});

test("bash: workspace alias to a different trusted program never inherits its profile", async (t) => {
  const fx = await fixture();
  // `./cat` as a symlink to the real hostname binary: the OLD check only
  // required BOTH basenames to be whitelisted, so cat's path-operand profile
  // was applied to an actual hostname invocation (`hostname input.txt` sets
  // the hostname). The actual program semantics must match the pinned
  // profile, and a workspace-lexical executable must never silently trust an
  // outside canonical target.
  let realHostname: string | undefined;
  for (const candidate of ["/bin/hostname", "/usr/bin/hostname"]) {
    realHostname = await fs.realpath(candidate).catch(() => undefined);
    if (realHostname !== undefined) break;
  }
  if (realHostname === undefined) {
    t.skip("no hostname binary on this platform");
    return;
  }
  await fs.symlink(realHostname, path.join(fx.workspace, "cat"));
  await fs.writeFile(path.join(fx.workspace, "input.txt"), "x");
  const ev = await evidenceFor(fx, "bash", { command: "./cat input.txt" });
  assert.equal(ev.complete, false, "aliased hostname must not be Allow-eligible via cat's profile");
  assert.match(ev.shell?.opaqueReason ?? "", /workspace|different program/);

  // Same-name symlink alias (workspace cat -> real cat) is still opaque: the
  // workspace link can be retargeted after evidence.
  const realCat = await fs.realpath("/bin/cat").catch(() => undefined);
  if (realCat !== undefined) {
    await fs.symlink(realCat, path.join(fx.workspace, "cat2"));
    await fs.rm(path.join(fx.workspace, "cat"), { force: true });
    await fs.rename(path.join(fx.workspace, "cat2"), path.join(fx.workspace, "cat"));
    const alias = await evidenceFor(fx, "bash", { command: "./cat input.txt" });
    assert.equal(alias.complete, false, "workspace-lexical executable alias stays an Ask");
    assert.match(alias.shell?.opaqueReason ?? "", /lexically inside the workspace/);
  }
});
