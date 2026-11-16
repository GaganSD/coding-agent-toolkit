import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NativeReviewer, type ReviewerEvidence, type ReviewerSettings, type ReviewInput } from "../src/reviewer.js";
import { patternCandidates } from "../src/decision-model/patterns.js";
import { buildReviewInput } from "../src/decision-model/envelope.js";

const fixture = <T>(path: string): T => JSON.parse(readFileSync(new URL(`fixtures/reviewer/${path}.json`, import.meta.url), "utf8")) as T;
const evidence = () => fixture<ReviewerEvidence>("evidence/basic");
const settings = () => fixture<ReviewerSettings>("settings/approved");
const model = { provider: "typesafe", id: "jev-1.13.0", api: "typesafe-system-one", baseUrl: "https://api.typesafe.ai/v1", type: "classifier" };
function registry() {
  const contexts: ReviewInput[] = [];
  return { contexts, findOfType: () => model, getAvailableOfType: async () => [model],
    classify: async (_model: unknown, context: ReviewInput) => {
      contexts.push(context);
      return { provider: model.provider, model: model.id, stopReason: "stop", answers: {
        permission_pattern: { type: "choice", choice: "candidate_0", confidence: 0.999,
          probabilities: { candidate_0: 0.999, none: 0.001 } },
      } };
    } };
}
test("native classifier selects a typed candidate without generating arbitrary permission text", async () => {
  const reg = registry();
  const result = await new NativeReviewer().propose(evidence(), settings(), reg);
  assert.equal(result.status, "completed");
  assert.equal(result.output?.permission_pattern?.choice, "candidate_0");
  const context = reg.contexts[0]!;
  assert.deepEqual(Object.keys(context.questions), ["permission_pattern"]);
  assert.ok(context.questions.permission_pattern?.criteria.none);
  assert.match(JSON.stringify(context.state.pattern_candidates), /npm test \*/);
  assert.equal(JSON.stringify(context.state).includes("allowlist"), false);
});
test("old consent cannot call pattern selection or send exact command text", async () => {
  const reg = registry();
  const result = await new NativeReviewer().propose(evidence(), { ...settings(), disclosureVersion: null }, reg);
  assert.equal(result.status, "skipped");
  assert.equal(reg.contexts.length, 0);
});
test("semantic opacity is explicit, while genuinely incomplete evidence stays local", () => {
  const opaque = evidence();
  opaque.complete = false;
  opaque.reviewableShell = true;
  const built = buildReviewInput(opaque);
  assert.equal(built.ok, true);
  assert.equal(buildReviewInput({ ...opaque, reviewableShell: false }).ok, false);
  opaque.action.args.command = "cat .env";
  assert.equal(buildReviewInput(opaque).ok, false);
});
test("native file candidates are generalized, tool-scoped and bounded away from filesystem root", () => {
  const basic = evidence();
  basic.action.tool = "read";
  basic.canonicalPath = "/shared/project/a.txt";
  assert.deepEqual(patternCandidates(basic)[0]?.rules, [{ tool: "read", text: "/shared/project/*" }]);
  basic.canonicalPath = "/a.txt";
  assert.deepEqual(patternCandidates(basic), []);
  basic.canonicalPath = "/shared/project/a.txt";
  basic.sensitive = true;
  assert.deepEqual(patternCandidates(basic), []);
});
