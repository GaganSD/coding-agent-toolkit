import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEvidence } from "../src/evidence.js";
import { evaluatePolicy } from "../src/policy.js";
import { validateSettings } from "../src/settings.js";
import type { Action, AutomodeSettings } from "../src/types.js";

interface Fixture {
  workspace: string;
  agentDir: string;
  extensionDir: string;
  homeDir: string;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "automode-policy-")));
  const fx = {
    workspace: path.join(root, "ws"),
    agentDir: path.join(root, "agent"),
    extensionDir: path.join(root, "ext"),
    homeDir: path.join(root, "home"),
  };
  for (const d of Object.values(fx)) await fs.mkdir(d, { recursive: true });
  return fx;
}

function settings(overrides: Record<string, unknown> = {}): AutomodeSettings {
  return validateSettings({ version: 1, enabled: true, ...overrides });
}

async function decide(
  fx: Fixture,
  tool: string,
  args: Record<string, unknown>,
  cfg: AutomodeSettings,
  cwd?: string,
) {
  const action: Action = { requestId: "r", tool, args, cwd: cwd ?? fx.workspace };
  const evidence = await buildEvidence(action, fx);
  return { decision: evaluatePolicy(evidence, cfg), evidence };
}

test("unknown/custom tools are blocked; one-shot approval cannot lift that", async () => {
  const fx = await fixture();
  const { decision } = await decide(fx, "web_search", { query: "x" }, settings());
  assert.equal(decision.outcome, "block");
  assert.equal(decision.source, "policy:unsupported-route");

  const codemode = await decide(fx, "codemode", { code: "1" }, settings());
  assert.equal(codemode.decision.outcome, "block");
});

test("dangling symlinks cannot turn protected writes into approvable actions", async () => {
  const fx = await fixture();
  for (const [index, target] of [
    path.join(fx.workspace, ".env"),
    path.join(fx.workspace, ".git", "config"),
    path.join(fx.agentDir, "absent.json"),
  ].entries()) {
    const link = path.join(fx.workspace, `notes-${index}.txt`);
    await fs.symlink(path.relative(fx.workspace, target), link);
    const { decision, evidence } = await decide(fx, "write", { path: link, content: "blocked" }, settings());
    assert.equal(evidence.canonicalPath, target);
    assert.equal(decision.outcome, "block");
    assert.equal(decision.source, "policy:protected-write");
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  }
});

test("shell PATH preserves an existing agent-bin entry instead of moving it first", async () => {
  const fx = await fixture();
  const bin = path.join(fx.agentDir, "bin");
  const earlier = path.join(fx.homeDir, "bin");
  await fs.mkdir(bin);
  await fs.mkdir(earlier);
  await fs.symlink("/bin/ls", path.join(bin, "ls"));
  await fs.writeFile(path.join(earlier, "ls"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const alias = path.join(fx.homeDir, "agent-alias");
  await fs.symlink(fx.agentDir, alias, "dir");
  const savedPath = process.env.PATH;
  try {
    for (const agentDir of [fx.agentDir, alias]) {
      process.env.PATH = [earlier, "/usr/bin", path.join(agentDir, "bin")].join(path.delimiter);
      const { decision, evidence } = await decide({ ...fx, agentDir }, "bash", { command: "ls -la" }, settings({
        allowlist: [{ text: "ls -la" }],
      }));
      assert.equal(evidence.shell?.resolvedExecutable, path.join(earlier, "ls"));
      assert.equal(decision.outcome, "ask");
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("protected writes block; protected reads are a local Ask", async () => {
  const fx = await fixture();
  const write = await decide(fx, "write", { path: ".env", content: "x" }, settings());
  assert.equal(write.decision.outcome, "block");
  assert.equal(write.decision.source, "policy:protected-write");

  const read = await decide(fx, "read", { path: ".env" }, settings());
  assert.equal(read.decision.outcome, "ask");
  assert.equal(read.decision.source, "policy:sensitive-read");

  const hook = await decide(fx, "edit", { path: ".git/hooks/pre-commit" }, settings());
  assert.equal(hook.decision.outcome, "block");
});

test("exact block commands match every byte; differing bytes do not match", async () => {
  const fx = await fixture();
  const cfg = settings({ blocklist: [{ text: "git push --force" }] });
  const hit = await decide(fx, "bash", { command: "git push --force" }, cfg);
  assert.equal(hit.decision.outcome, "block");
  assert.equal(hit.decision.source, "rule:blocklist");
  assert.equal(hit.decision.matchedRule?.text, "git push --force");

  for (const cmd of ["git push --force origin main", "git push --force ", "git  push --force"]) {
    const miss = await decide(fx, "bash", { command: cmd }, cfg);
    assert.notEqual(miss.decision.outcome, "block", `${JSON.stringify(cmd)} must not byte-match`);
    assert.equal(miss.decision.outcome, "ask");
  }
});

test("disabled rules never match", async () => {
  const fx = await fixture();
  const cfg = settings({
    blocklist: [{ text: "git push --force", enabled: false }],
  });
  const { decision } = await decide(fx, "bash", { command: "git push --force" }, cfg);
  assert.notEqual(decision.outcome, "block");
});

test("glob block rules match wildcards across the full command text", async () => {
  const fx = await fixture();
  const cfg = settings({
    blocklist: [{ text: "rm -rf *" }, { text: "git push --force*" }, { text: "* --output=/dev/sd*" }],
  });
  for (const cmd of ["rm -rf .", "rm -rf /tmp/x", "rm -rf *", "git push --force", "git push --force origin main"]) {
    const { decision } = await decide(fx, "bash", { command: cmd }, cfg);
    assert.equal(decision.outcome, "block", cmd);
    assert.equal(decision.source, "rule:blocklist");
  }
  // `rm -rf *` needs the trailing space: the bare command is not matched.
  const bare = await decide(fx, "bash", { command: "rm -rf" }, cfg);
  assert.notEqual(bare.decision.outcome, "block");
  // Leading-wildcard bucket: matched regardless of the command's first token.
  const lead = await decide(fx, "bash", { command: "sort --output=/dev/sda in.txt" }, cfg);
  assert.equal(lead.decision.outcome, "block");
});

test("glob metacharacters other than * are literal", async () => {
  const fx = await fixture();
  const cfg = settings({ blocklist: [{ text: "echo a+b (c) *" }] });
  const hit = await decide(fx, "bash", { command: "echo a+b (c) literally" }, cfg);
  assert.equal(hit.decision.outcome, "block");
  // `?` and `.` in the rule are literal, not regex wildcards.
  const miss = await decide(fx, "bash", { command: "echo aXb c literally" }, cfg);
  assert.notEqual(miss.decision.outcome, "block");
  const regexCfg = settings({ blocklist: [{ text: "echo file?.txt *" }] });
  const q = await decide(fx, "bash", { command: "echo file?.txt x" }, regexCfg);
  assert.equal(q.decision.outcome, "block");
  const qMiss = await decide(fx, "bash", { command: "echo file1.txt x" }, regexCfg);
  assert.notEqual(qMiss.decision.outcome, "block");
});

test("workspace file floor allows ordinary reads/edits/writes", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "a.txt"), "x");
  const cfg = settings();
  for (const tool of ["read", "edit", "write"] as const) {
    const { decision } = await decide(fx, tool, { path: "a.txt" }, cfg);
    assert.equal(decision.outcome, "allow", tool);
    assert.equal(decision.source, "policy:workspace-floor");
  }
  // New file inside the workspace.
  const fresh = await decide(fx, "write", { path: "src/new.ts", content: "x" }, cfg);
  assert.equal(fresh.decision.outcome, "allow");
});

test("floor never covers outside-workspace or incomplete targets", async () => {
  const fx = await fixture();
  const cfg = settings();
  const outside = await decide(fx, "read", { path: "../home/notes.txt" }, cfg);
  assert.equal(outside.decision.outcome, "ask");
  assert.equal(outside.decision.source, "policy:outside-workspace");

  // Hard-linked alias inside the workspace: evidence incomplete → Ask, not Allow.
  const orig = path.join(fx.workspace, "orig.txt");
  await fs.writeFile(orig, "data");
  await fs.link(orig, path.join(fx.workspace, "alias.txt"));
  const hard = await decide(fx, "edit", { path: "alias.txt" }, cfg);
  assert.equal(hard.decision.outcome, "ask");
  assert.equal(hard.decision.source, "policy:incomplete-evidence");
});

test("exact operator permission covers simple opaque commands, unlike built-in defaults", async () => {
  const fx = await fixture();
  const cfg = settings({ allowlist: [{ text: "ls -la" }] });
  const ok = await decide(fx, "bash", { command: "ls -la" }, cfg);
  assert.equal(ok.decision.outcome, "allow", ok.decision.reason);
  assert.equal(ok.decision.source, "rule:allowlist");
  assert.equal(ok.decision.matchedRule?.text, "ls -la");

  // Different bytes miss the operator rule but the built-in `ls *` default covers them.
  const miss = await decide(fx, "bash", { command: "ls -la " }, cfg);
  assert.equal(miss.decision.outcome, "allow");
  assert.equal(miss.decision.source, "rule:default-allowlist");

  // Explicit operator authority, not a claim of proven program effects.
  const npmCfg = settings({ allowlist: [{ text: "npm test -- parser" }] });
  await fs.writeFile(path.join(fx.workspace, "package.json"), "{}");
  const npm = await decide(fx, "bash", { command: "npm test -- parser" }, npmCfg);
  assert.equal(npm.decision.outcome, "allow");
  assert.equal(npm.decision.source, "rule:allowlist");

  const gitCfg = settings({ allowlist: [{ text: "git status" }] });
  const git = await decide(fx, "bash", { command: "git status" }, gitCfg);
  assert.equal(git.decision.outcome, "allow", "operator explicitly authorized this invocation");
  const exactMiss = await decide(fx, "bash", { command: "git status " }, gitCfg);
  assert.equal(exactMiss.decision.outcome, "ask", "extra bytes do not inherit exact authority");
});

test("built-in default rules apply alongside operator rules", async () => {
  const fx = await fixture();
  const cfg = settings();
  // Default allowlist: plain verified read-only commands run without a rule.
  const ls = await decide(fx, "bash", { command: "ls" }, cfg);
  assert.equal(ls.decision.outcome, "allow", ls.decision.reason);
  assert.equal(ls.decision.source, "rule:default-allowlist");
  // Default blocklist: catastrophic patterns block with no operator rule.
  const rm = await decide(fx, "bash", { command: "rm -rf /" }, cfg);
  assert.equal(rm.decision.outcome, "block");
  assert.equal(rm.decision.source, "rule:default-blocklist");
  const dd = await decide(fx, "bash", { command: "dd if=/dev/zero of=/dev/sda bs=1M" }, cfg);
  assert.equal(dd.decision.outcome, "block");
  assert.equal(dd.decision.source, "rule:default-blocklist");
  // A default block outranks even a matching operator allowlist rule.
  const allowRm = settings({ allowlist: [{ text: "rm -rf /" }] });
  const overridden = await decide(fx, "bash", { command: "rm -rf /" }, allowRm);
  assert.equal(overridden.decision.outcome, "block");
  // An operator block outranks a default allowlist entry.
  const blockLs = settings({ blocklist: [{ text: "ls *" }] });
  const blocked = await decide(fx, "bash", { command: "ls -la" }, blockLs);
  assert.equal(blocked.decision.outcome, "block");
});

test("blocklist outranks an identical allowlist rule", async () => {
  const fx = await fixture();
  const cfg = settings({
    allowlist: [{ text: "ls -la" }],
    blocklist: [{ text: "ls -la" }],
  });
  const { decision } = await decide(fx, "bash", { command: "ls -la" }, cfg);
  assert.equal(decision.outcome, "block");
});

test("unmatched bash with no rules asks", async () => {
  const fx = await fixture();
  const { decision } = await decide(fx, "bash", { command: "git status" }, settings());
  assert.equal(decision.outcome, "ask");
  assert.equal(decision.source, "policy:no-matching-rule");
});

test("script change after an allow rule: fingerprint revalidation catches it", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "run.sh"), "echo v1");
  const cfg = settings({ allowlist: [{ text: "bash run.sh" }] });
  const first = await decide(fx, "bash", { command: "bash run.sh" }, cfg);
  // Explicit operator permission still binds script content for final revalidation.
  assert.equal(first.decision.outcome, "allow");
  await fs.writeFile(path.join(fx.workspace, "run.sh"), "echo v2-changed");
  const second = await decide(fx, "bash", { command: "bash run.sh" }, cfg);
  assert.notEqual(
    second.evidence.fingerprint,
    first.evidence.fingerprint,
    "changed script must change the evidence fingerprint",
  );
});

test("policy is pure with respect to settings identity (no mutation)", async () => {
  const fx = await fixture();
  const cfg = settings({ blocklist: [{ text: "ls" }] });
  const snapshot = JSON.stringify(cfg);
  await decide(fx, "bash", { command: "ls" }, cfg);
  assert.equal(JSON.stringify(cfg), snapshot);
});

test("glob allowlist rules allow verified commands and stay literal elsewhere", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "a.txt"), "x\n");
  const cfg = settings({ allowlist: [{ text: "wc *" }] });
  const ok = await decide(fx, "bash", { command: "wc -l a.txt" }, cfg);
  assert.equal(ok.decision.outcome, "allow", ok.decision.reason);
  assert.equal(ok.decision.matchedRule?.text, "wc *");
  // `wc *` does not cover the bare `wc` (no trailing space to match).
  const bare = await decide(fx, "bash", { command: "wc" }, cfg);
  assert.equal(bare.decision.outcome, "ask");
  assert.equal(bare.decision.source, "policy:no-matching-rule");
});

test("raw Pi-expanding path syntax never floor-allows (fail closed)", async () => {
  const fx = await fixture();
  const cfg = settings();
  // Pi would strip the '@' and write {ws}/.env; raw, the core must Ask, never Allow.
  const at = await decide(fx, "write", { path: "@.env", content: "x" }, cfg);
  assert.equal(at.decision.outcome, "ask");
  assert.equal(at.decision.source, "policy:incomplete-evidence");
  const tilde = await decide(fx, "write", { path: "~/.ssh/config", content: "x" }, cfg);
  assert.equal(tilde.decision.outcome, "ask");
  const url = await decide(fx, "read", { path: "file:///etc/passwd" }, cfg);
  assert.equal(url.decision.outcome, "ask");
});

test("APFS case aliases of protected names block writes inertly", async () => {
  const fx = await fixture();
  const cfg = settings();
  for (const rel of [".ENV", ".GIT/hooks/post-checkout", ".git", ".git/index", ".envrc"]) {
    const { decision } = await decide(fx, "write", { path: rel, content: "x" }, cfg);
    assert.equal(decision.outcome, "block", rel);
    assert.equal(decision.source, "policy:protected-write");
  }
});

test("allowlisted sort/date/diff with write or exec flags ask, never allow", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "in.txt"), "b\na\n");
  const commands = [
    "sort -o .git/hooks/pre-commit in.txt",
    "sort -o out.txt in.txt",
    "sort --compress-program=/tmp/x in.txt",
    "date 0101000025",
    "date -s @0",
    "diff --output=hook .git/hooks/pre-commit",
  ];
  // out.txt is a symlink into the agent directory: dest must not be trusted.
  await fs.symlink(path.join(fx.agentDir, "automode.json"), path.join(fx.workspace, "out.txt"));
  for (const command of commands) {
    const cfg = settings({ allowlist: [{ text: command }] });
    const { decision } = await decide(fx, "bash", { command }, cfg);
    assert.equal(decision.outcome, "ask", command);
    assert.equal(decision.source, "policy:opaque-shell", command);
  }
});

test("allowlisted cat is only allowed for the verified system binary on workspace files", async () => {
  const fx = await fixture();
  await fs.writeFile(path.join(fx.workspace, "in.txt"), "x");
  const cfg = settings({ allowlist: [{ text: "cat in.txt" }] });
  const ok = await decide(fx, "bash", { command: "cat in.txt" }, cfg);
  assert.equal(ok.decision.outcome, "allow", ok.decision.reason);

  // A fake `cat` earlier on PATH (outside the workspace) is not proof.
  const fakebin = path.join(fx.homeDir, "fakebin");
  await fs.mkdir(fakebin);
  await fs.writeFile(path.join(fakebin, "cat"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(fakebin, "cat"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakebin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const fake = await decide(fx, "bash", { command: "cat in.txt" }, cfg);
    assert.equal(fake.decision.outcome, "ask");
    assert.equal(fake.decision.source, "policy:opaque-shell");
  } finally {
    process.env.PATH = savedPath;
  }

  // A protected operand asks even though the program is verified.
  const protCfg = settings({ allowlist: [{ text: "cat .env" }] });
  const prot = await decide(fx, "bash", { command: "cat .env" }, protCfg);
  assert.equal(prot.decision.outcome, "ask");
});
