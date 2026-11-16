import assert from "node:assert/strict";
import test from "node:test";
import { compilePattern, compileRules, matchCommandRule, matchCompiled } from "../src/core/rules.js";
import { validateSettings } from "../src/settings.js";
import type { Rule } from "../src/types.js";

test("glob matches every byte including newline, with an absolute end boundary", () => {
  assert.equal(compilePattern("ls *x").test("ls x\n"), false);
  assert.equal(compilePattern("ls *").test("ls a\nb"), true);
  assert.equal(compilePattern("*x*").test("ax"), true);
  assert.equal(compilePattern("*").test(""), true);
  assert.equal(compilePattern("a?b").test("acb"), false);
});
test("exact mode preserves literal wildcard and whitespace", () => {
  const rules: Rule[] = [{ text: "echo *", mode: "exact" }];
  assert.equal(matchCommandRule(rules, "echo *"), rules[0]);
  assert.equal(matchCommandRule(rules, "echo hi"), undefined);
  assert.equal(matchCommandRule([{ text: "git status" }], "git status "), undefined);
});
test("safe regex supports anchors, classes and bounded-state quantifiers", () => {
  const pattern = compilePattern("^git status[ ]+--short?$", "regex");
  assert.equal(pattern.test("git status --short"), true);
  assert.equal(pattern.test("git status  --shor"), true);
  assert.equal(pattern.test("git status --short\n"), false);
  assert.equal(compilePattern("a*b+c?\\d[0-9]", "regex").test("aabbc12"), true);
  assert.equal(compilePattern("a\\$", "regex").test("a$"), true);
  assert.equal(compilePattern(".*", "regex").test("a\nb"), false);
});
test("unsafe or unsupported regex syntax fails validation", () => {
  for (const text of ["(a+)+", "a|b", "a{2}", "(?=x)", "\\1", "[abc", "a**"]) {
    assert.throws(() => validateSettings({ version: 1, enabled: true, allowlist: [{ text, mode: "regex" }] }));
  }
});
test("tool namespaces cannot accidentally grant another route", () => {
  const rules: Rule[] = [{ tool: "read", text: "/shared/*" }];
  assert.equal(matchCommandRule(rules, "/shared/a", "read"), rules[0]);
  assert.equal(matchCommandRule(rules, "/shared/a", "write"), undefined);
  assert.equal(matchCommandRule(rules, "/shared/a"), undefined);
});
test("exact priority, disabled rules and mutable caller changes", () => {
  const rules: Rule[] = [{ text: "*", enabled: false }, { text: "git *" }, { text: "git status" }];
  assert.equal(matchCommandRule(rules, "git status"), rules[2]);
  assert.equal(matchCommandRule(rules, "ls"), undefined);
  rules.push({ text: "ls" });
  assert.equal(matchCommandRule(rules, "ls"), rules[3]);
});
test("literal-prefix trie excludes unrelated shared-first-character patterns", () => {
  const rules: Rule[] = Array.from({ length: 3000 }, (_, i) => ({ text: `git cmd${i} *` }));
  const index = compileRules(rules);
  let calls = 0;
  const walk = (node: typeof index.root): void => {
    for (const candidate of node.patterns) {
      const old = candidate.pattern.test;
      candidate.pattern = { ...candidate.pattern, test: (text) => { calls++; return old(text); } };
    }
    for (const child of node.children.values()) walk(child);
  };
  walk(index.root);
  assert.equal(matchCompiled(index, "git cmd2899 --help"), rules[2899]);
  assert.equal(calls, 1);
});
test("oversized matching work fails closed instead of skipping a blocklist candidate", () => {
  assert.throws(() => matchCommandRule([{ text: "*z".repeat(500) }], "a".repeat(20000)), /bounded work budget/);
});

test("pathological wildcard/regex input does not use recursive backtracking", () => {
  assert.equal(compilePattern(`${"*a".repeat(100)}z`).test("a".repeat(500)), false);
  assert.equal(compilePattern(`${"a*".repeat(100)}z`, "regex").test("a".repeat(500)), false);
});
