import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Gate } from "../src/gate.js";
import { ApprovalManager } from "../src/approval.js";
import { SettingsStore } from "../src/settings.js";
import { LogStore } from "../src/logs.js";
import { EpochController } from "../src/runtime/epoch.js";
import { buildEvidence } from "../src/evidence.js";
import { evaluatePolicy } from "../src/policy.js";
import type { AutomodeSettings, DecisionLog } from "../src/types.js";
import type { ReviewReceipt } from "../src/reviewer.js";

const endpoint = "https://api.example.com/v1";
function receipt(choice = "safe", probability = 0.999, confidence = 0.999): ReviewReceipt {
  const others = (1 - probability) / 2;
  return { status: "completed", source: "native-decision-model:typesafe/test", durationMs: 1,
    decisionModel: { provider: "typesafe", model: "test", endpoint },
    output: { safety: { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(["safe", "unsafe", "uncertain"].map((label) => [label, label === choice ? probability : others])) } } };
}
async function harness(options: { result?: ReviewReceipt; proposal?: ReviewReceipt; onSelect?: (title: string) => void; settings?: Partial<AutomodeSettings>; answers?: string[];
  onReview?: () => void; onAppend?: (entry: DecisionLog) => void; registry?: unknown } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "automode-authorization-")));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "extension");
  for (const dir of [workspace, agentDir, extensionDir]) mkdirSync(dir);
  const settings = new SettingsStore(join(agentDir, "automode.json"));
  await settings.load();
  await settings.update({ ...settings.current, enabled: true, decisionModel: { provider: "typesafe", model: "test" },
    disclosureConsent: "approved", disclosureVersion: 1, disclosureProvider: "typesafe", disclosureModel: "test",
    disclosureEndpoint: endpoint, disclosureWorkspace: workspace, ...options.settings });
  const logs = new LogStore(join(agentDir, "automode-logs.json"));
  const epochs = new EpochController();
  const approval = new ApprovalManager({ settings, epochs });
  let reviews = 0;
  let executions = 0;
  const titles: string[] = [];
  const optionLists: string[][] = [];
  const answers = [...(options.answers ?? ["Decline"])];
  const ctx = { mode: "tui", hasUI: true, cwd: workspace,
    modelRegistry: "registry" in options ? options.registry : { findOfType: () => ({ baseUrl: endpoint }) },
    ui: { select: async (title: string, choices?: string[]) => {
      titles.push(title); if (choices) optionLists.push(choices); options.onSelect?.(title); return answers.shift();
    }, notify: () => {} } };
  const gate = new Gate({ settings, logs: { append: async (entry, cfg) => { options.onAppend?.(entry); await logs.append(entry, cfg); } },
    epochs, approval, buildEvidence, evaluatePolicy, dirs: { workspace, agentDir, extensionDir }, host: () => ({}),
    reviewer: {
      review: async () => { reviews++; options.onReview?.(); return options.result ?? receipt(); },
      propose: async () => options.proposal ?? { ...receipt(), output: { permission_pattern: {
        type: "choice", choice: "candidate_0", confidence: 0.999, probabilities: { candidate_0: 0.999, none: 0.001 },
      } } },
    } });
  const call = (command = "git status") => gate.executeGuarded({ tool: "bash", args: { command }, ctx,
    requestId: "authorization", run: async () => { executions++; return "executed"; } });
  return { root, workspace, agentDir, settings, logs, epochs, gate, approval, ctx, titles, optionLists, call,
    get reviews() { return reviews; }, get executions() { return executions; },
    [Symbol.dispose]() { rmSync(root, { recursive: true, force: true }); } };
}

test("completed validated high-safe judgment authorizes a real opaque command without a dialog", async () => {
  using h = await harness();
  assert.equal(await h.call(), "executed");
  assert.equal(h.reviews, 1);
  assert.equal(h.executions, 1);
  assert.equal(h.titles.length, 0);
  const entries = await h.logs.read(h.settings.current);
  assert.equal(entries.at(-1)?.source, "native-decision-model:typesafe/test");
});
test("unsafe, uncertain, low probability/confidence, malformed, timeout and identity mismatch never auto-allow", async () => {
  const malformed = receipt();
  malformed.output!.safety!.probabilities.safe = 99;
  const wrongIdentity = { ...receipt(), decisionModel: { provider: "other", model: "test", endpoint } };
  for (const result of [receipt("unsafe"), receipt("uncertain"), receipt("safe", 0.98), receipt("safe", 0.999, 0.5),
    malformed, { ...receipt(), status: "timeout" as const }, wrongIdentity]) {
    using h = await harness({ result });
    await assert.rejects(h.call(), /declined/);
    assert.equal(h.executions, 0);
    assert.equal(h.titles.length, 1);
  }
});
test("old disclosure consent loads but cannot upload or authorize", async () => {
  using h = await harness({ settings: { disclosureVersion: null } });
  await assert.rejects(h.call(), /declined/);
  assert.equal(h.reviews, 0);
  assert.equal(h.executions, 0);
});
test("a hard block bypasses the model and cannot be lifted", async () => {
  using h = await harness();
  await assert.rejects(h.call("rm -rf /"), /blocklist/);
  assert.equal(h.reviews, 0);
  assert.equal(h.executions, 0);
});
test("decline replay is checked before a second model call", async () => {
  using h = await harness({ result: receipt("unsafe") });
  await assert.rejects(h.call(), /declined/);
  await assert.rejects(h.call(), /declined/);
  assert.equal(h.reviews, 1);
  assert.equal(h.executions, 0);
});
test("model authorization still requires a working final audit append", async () => {
  using h = await harness({ onAppend: (entry) => { if (entry.outcome === "allow") throw new Error("disk failed"); } });
  await assert.rejects(h.call(), /decision log unavailable/);
  assert.equal(h.executions, 0);
});
test("lifecycle invalidation during model review never executes its late safe answer", async () => {
  let invalidate = () => {};
  using h = await harness({ onReview: () => invalidate() });
  invalidate = () => h.epochs.invalidate("session changed");
  await assert.rejects(h.call(), /session changed/);
  assert.equal(h.executions, 0);
});
test("composed/secret-bearing/unsupported commands cannot use a forged safe receipt", async () => {
  for (const command of ["git status; echo x", "cat .env", "sort -o out.txt in.txt"]) {
    using h = await harness();
    writeFileSync(join(h.workspace, "in.txt"), "x");
    await assert.rejects(h.call(command), /declined/);
    assert.equal(h.executions, 0);
  }
});

test("Always Allow confirms a model-selected generalized bundle and skips future matching reviews", async () => {
  using h = await harness({ result: receipt("unsafe"), answers: ["Always Allow", "Save and allow"] });
  assert.equal(await h.call(), "executed");
  assert.equal(h.settings.current.allowlist.length, 2);
  assert.match(h.titles[1] ?? "", /bash\/exact: git status/);
  assert.match(h.titles[1] ?? "", /bash\/glob: git status \*/);
  assert.equal(await h.call("git status --short"), "executed");
  assert.equal(h.reviews, 1, "saved scope skips later semantic checks");
  assert.equal((await h.logs.read(h.settings.current)).find((entry) => entry.source === "approval-always")?.outcome, "allow");
});
test("Always Allow cancellation, no suitable pattern, and stale confirmation never save or execute", async () => {
  using cancelled = await harness({ result: receipt("unsafe"), answers: ["Always Allow", "Cancel"] });
  await assert.rejects(cancelled.call(), /cancelled/);
  assert.equal(cancelled.settings.current.allowlist.length, 0);
  assert.equal(cancelled.executions, 0);
  using unsuitable = await harness({ result: receipt("unsafe"), answers: ["Always Allow"],
    proposal: { ...receipt(), output: { permission_pattern: { type: "choice", choice: "none", confidence: 0.999, probabilities: { none: 0.999, candidate_0: 0.001 } } } } });
  await assert.rejects(unsuitable.call(), /no sufficiently confident suitable/);
  assert.equal(unsuitable.settings.current.allowlist.length, 0);
  const proposalEntries = await unsuitable.logs.read(unsuitable.settings.current);
  assert.equal(proposalEntries.at(-1)?.source, "approval-always-refused");
  assert.ok((proposalEntries.find((entry) => entry.source === "approval-always-proposal")?.decisionModel as ReviewReceipt | undefined)?.output);
  let invalidate = () => {};
  using stale = await harness({ result: receipt("unsafe"), answers: ["Always Allow", "Save and allow"],
    onSelect: (title) => { if (title.startsWith("Save reusable")) invalidate(); } });
  invalidate = () => stale.epochs.invalidate("session changed");
  await assert.rejects(stale.call(), /session changed/);
  assert.equal(stale.settings.current.allowlist.length, 0);
});
test("Always Allow is hidden unless live model provider/model/endpoint/workspace/version consent is valid", async () => {
  const assertHidden = async (h: Awaited<ReturnType<typeof harness>>) => {
    await assert.rejects(h.call(), /declined/);
    assert.equal(h.executions, 0);
    assert.ok(!h.optionLists[0]?.includes("Always Allow"));
  };
  using wrongProvider = await harness({ result: receipt("unsafe"), settings: { disclosureProvider: "other" } });
  await assertHidden(wrongProvider);
  using wrongModel = await harness({ result: receipt("unsafe"), settings: { disclosureModel: "other" } });
  await assertHidden(wrongModel);
  using wrongEndpoint = await harness({ result: receipt("unsafe"), settings: { disclosureEndpoint: "https://other.example/v1" } });
  await assertHidden(wrongEndpoint);
  using wrongWorkspace = await harness({ result: receipt("unsafe"), settings: { disclosureWorkspace: "/tmp/other-workspace" } });
  await assertHidden(wrongWorkspace);
  using oldVersion = await harness({ result: receipt("unsafe"), settings: { disclosureVersion: null } });
  await assertHidden(oldVersion);
  using missingRegistry = await harness({ result: receipt("unsafe"), registry: undefined });
  await assertHidden(missingRegistry);
  using missingModel = await harness({ result: receipt("unsafe"), registry: { findOfType: () => undefined } });
  await assertHidden(missingModel);
  using valid = await harness({ result: receipt("unsafe") });
  await assert.rejects(valid.call(), /declined/);
  assert.equal(valid.executions, 0);
  assert.ok(valid.optionLists[0]?.includes("Always Allow"));
});

test("Always Allow never saves authority when the mandatory rule audit fails", async () => {
  using h = await harness({ result: receipt("unsafe"), answers: ["Always Allow", "Save and allow"],
    onAppend: (entry) => { if (entry.source === "approval-always-rule") throw new Error("rule audit failed"); } });
  await assert.rejects(h.call(), /rule audit failed/);
  assert.equal(h.settings.current.allowlist.length, 0);
  assert.equal(h.executions, 0);
});

test("unanswered approval expiry accepts safe > 0.50 with confidence >= 0.67 and audits fallback", async () => {
  using h = await harness({ result: receipt("safe", 0.51, 0.67) });
  h.approval.request = async () => ({ kind: "expired" });
  assert.equal(h.settings.current.reviewConfidenceThreshold, 0.67);
  assert.equal(h.settings.current.approvalTimeoutMs, 60_000);
  assert.equal(await h.call(), "executed");
  assert.equal(h.executions, 1);
  assert.equal((await h.logs.read(h.settings.current)).at(-1)?.source, "approval-timeout-model");
});

test("real entry deadline closes the unanswered dialog but eligible timeout fallback still executes", async () => {
  using h = await harness({ result: receipt("safe", 0.7, 0.8), settings: { approvalTimeoutMs: 5000 } });
  const keepalive = setTimeout(() => {}, 10_000);
  h.ctx.ui.select = async (_title: string, _choices?: string[], opts?: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) resolve();
      else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return undefined;
  };
  try {
    assert.equal(await h.call(), "executed");
    assert.equal(h.executions, 1);
    assert.equal((await h.logs.read(h.settings.current)).at(-1)?.source, "approval-timeout-model");
  } finally { clearTimeout(keepalive); }
});

test("timeout fallback rejects ties, unsafe, uncertain, low confidence, failed and stale-consent reviews", async () => {
  for (const result of [receipt("safe", 0.50), receipt("safe", 0.51, 0.66), receipt("unsafe", 0.8),
    receipt("uncertain", 0.8), { ...receipt(), status: "timeout" as const }]) {
    using h = await harness({ result });
    h.approval.request = async () => ({ kind: "expired" });
    await assert.rejects(h.call(), /declined/);
    assert.equal(h.executions, 0);
  }
  using stale = await harness({ settings: { disclosureVersion: null } });
  stale.approval.request = async () => ({ kind: "expired" });
  await assert.rejects(stale.call(), /declined/);
  assert.equal(stale.executions, 0);
});

test("timeout fallback never overrides explicit decline, cancellation, or audit failure", async () => {
  using declined = await harness({ result: receipt("safe", 0.7, 0.8) });
  await assert.rejects(declined.call(), /declined/);
  assert.equal(declined.executions, 0);
  using cancelled = await harness({ result: receipt("safe", 0.7, 0.8) });
  cancelled.approval.request = async () => { cancelled.epochs.invalidate("session changed"); return { kind: "expired" }; };
  await assert.rejects(cancelled.call(), /session changed/);
  assert.equal(cancelled.executions, 0);
  using audit = await harness({ result: receipt("safe", 0.7, 0.8), onAppend: (entry) => {
    if (entry.source === "approval-timeout-model") throw new Error("audit unavailable");
  } });
  audit.approval.request = async () => ({ kind: "expired" });
  await assert.rejects(audit.call(), /decision log unavailable/);
  assert.equal(audit.executions, 0);
});

test("timeout fallback rechecks evidence and cannot authorize protected or composed actions", async () => {
  using changed = await harness({ result: receipt("safe", 0.7, 0.8) });
  const target = join(changed.root, "shared.txt");
  writeFileSync(target, "before");
  changed.approval.request = async () => { writeFileSync(target, "after"); return { kind: "expired" }; };
  await assert.rejects(changed.gate.executeGuarded({ tool: "read", args: { path: target }, ctx: changed.ctx,
    requestId: "changed-target", run: async () => assert.fail("changed evidence executed") }), /action or target changed/);
  assert.equal(changed.executions, 0);
  for (const command of ["cat .env", "git status; echo x"]) {
    using h = await harness({ result: receipt("safe", 0.7, 0.8) });
    h.approval.request = async () => ({ kind: "expired" });
    await assert.rejects(h.call(command), /declined/);
    assert.equal(h.executions, 0);
  }
});

test("Always Allow supports a reusable native-read directory scope, not one rule per file", async () => {
  using h = await harness({ result: receipt("unsafe"), answers: ["Always Allow", "Save and allow"] });
  const shared = join(h.root, "shared");
  mkdirSync(shared);
  for (const file of ["one.txt", "two.txt"]) writeFileSync(join(shared, file), file);
  let executions = 0;
  const call = (file: string) => h.gate.executeGuarded({ tool: "read", args: { path: join(shared, file) }, ctx: h.ctx,
    requestId: file, run: async () => { executions++; } });
  await call("one.txt");
  await call("two.txt");
  assert.equal(executions, 2);
  assert.equal(h.reviews, 1);
  assert.deepEqual(h.settings.current.allowlist, [{ tool: "read", text: `${shared}/*` }]);
  assert.match(h.titles[1] ?? "", /read\/glob:/);
});
