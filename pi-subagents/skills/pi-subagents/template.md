# Sub-agent template starter

pi-subagents ships no fixed roles. Each task either carries `role` instructions
inline or names a saved `template`, or both: the template first, then the inline
text. Use this guide to write one, then save it with your ordinary `write` tool.

- **Global** (`<agentDir>/subagent-templates/<name>.md`): a role you'd reuse in
  any project, such as `security-reviewer`.
- **Project** (`<project>/.pi/subagent-templates/<name>.md`): a role that knows
  this codebase's commands, paths and conventions. Project templates are read only
  when the project is trusted, and they override a global template of the same name.

`subagent list` prints both folder paths and any template that failed to load, with
the reason. The filename must equal `name`.

## 1. Pick a family and an archetype

The mode is the only thing that grants tools. `inspect` has read, grep, find, ls,
diff and contact_agent, and no shell. `edit` adds bash, edit and write. Neither is
an OS sandbox.

### Workers (`mode: edit`) change the workspace

| Archetype | Use for | Verification metrics to write down |
|---|---|---|
| `implementer` | A scoped feature or change | Test command exits 0; typecheck has 0 errors; lint has 0 new warnings; `git diff --stat <launch-sha>` and `git status --porcelain` show only in-scope paths; at least 1 new test covers the new behaviour |
| `bug-fixer` | A reported defect | A repro (test or command) fails before the fix and passes after; the full suite's pass count is at least the baseline; the root cause is named with file:line |
| `test-writer` | Coverage for existing code | New tests pass; each new test fails if the behaviour it covers is broken (mutation or revert check); `git diff --stat <launch-sha>` and `git status --porcelain` show test paths only |
| `refactorer` | Behaviour-preserving restructuring | Pass count equals the baseline, with no skipped or deleted tests; public exports unchanged (diff of the export list is empty); no new dependencies |
| `migrator` | A dependency or API upgrade | Lockfile changes only the named packages; build, typecheck and tests exit 0; each deprecation warning is fixed or listed |
| `verifier` | Run checks and report, change nothing | Every listed command is run and reported with its exit code and a summary; `git status --porcelain` is identical before and after |

`verifier` needs `edit` only for the shell. Its role text must forbid edits; the
host does not enforce that.

### Reviewers (`mode: inspect`) read and report

| Archetype | Use for | Verification metrics to write down |
|---|---|---|
| `code-reviewer` | Correctness of a change | Every changed file is listed as examined; every finding has severity, file:line, evidence and a concrete failure scenario; no finding without a scenario |
| `security-reviewer` | Attack surface of a change or module | Each category (input validation, authn/authz, injection, path traversal, secrets, unsafe deserialisation, SSRF, dependency risk) is marked *finding* or *checked: clean* with evidence; findings carry a CWE id, an exploit scenario and a severity |
| `performance-reviewer` | Hot paths and scaling | Each finding names the path, the input size where it matters, the estimated cost (complexity, allocations, I/O per call) and the cheapest fix |
| `test-reviewer` | Whether tests prove the change | Every changed behaviour maps to a covering test (file:line) or is marked *uncovered*; flaky patterns (sleeps, order dependence) are listed |
| `api-reviewer` | Public interfaces and docs | Each exported symbol, flag or config key that changed is listed with a compatibility verdict (compatible / breaking / undocumented) |
| `researcher` | A question about the codebase | Every claim cites file:line; each answer has a confidence of high, medium or low; open questions are listed separately |

Reviewers' `diff` tool compares the working tree with the HEAD at launch and lists
untracked paths. To review a committed range, put the diff in the brief or in a file.
Reviewers have no shell, so their metrics must be checkable by reading. If a metric
needs a command, run it yourself, or run a `verifier` afterwards as a separate run. An
`edit` task can't share a workspace with any other live task, including an `inspect`
one. Running both at once needs a separate worktree that holds the same change.

## 2. Make the metrics exact

A metric is exact when someone else can check it without asking you anything:

- **Name the command.** Write `npm test --prefix pkg` exits 0, not "tests pass".
- **State the threshold.** Write 0 new lint warnings, not "lint is clean".
- **Give the baseline.** Write pass count ≥ 181 (the count before the change), not
  "no regressions".
- **Bound the scope.** Write `git diff --stat <launch-sha>` and
  `git status --porcelain` list only `src/parser/**` and `test/parser/**`. Comparing
  against the launch commit catches changes that were committed. `status` catches
  untracked files.
- **Cover reviewers too.** Write every finding has file:line and a failure
  scenario, not "be thorough".

Project templates should hard-code the project's real commands. Global templates
should name the kind of command and leave the exact one to the task brief.

## 3. Copy this skeleton

Fill every `<…>` and delete the optional lines you don't use. A template whose
`name` or `mode` is still a placeholder will not load, and `list` will say why. Keep the body under about 150 lines; the
task brief carries the specifics of each run.

```markdown
---
name: <kebab-case name; same as the filename>
description: <one line: what this role does and when to use it>
mode: <inspect or edit>
# model: <provider/id>   optional; omit to use the task's or the agent's model
# thinking: <level>      optional: off, minimal, low, medium, high, xhigh, max
---

## Role
You are a <archetype> for <project or area>. <One or two sentences of purpose.>

## Scope
- In scope: <paths, modules, kinds of change or question>
- Out of scope: <what you must not touch or judge>

## Read first
- <files, specs, diffs, issue text, or "the paths named in the task">

## Method
1. <first step, e.g. reproduce or read the diff>
2. <next step>
3. Check every metric below before reporting.

## Verification metrics
All must hold before you report done. If one cannot be checked, report it as
unverified; do not claim it passed.

| Metric | How to check | Pass when |
|---|---|---|
| <metric> | <exact command or inspection> | <exact threshold> |

## Report
- Outcome: done, partial or blocked (one line why)
- Metrics: each row above with the observed value and its evidence
  (command, exit code, counts, file:line)
- <role-specific section, e.g. Changes (paths) or Findings (severity, file:line, evidence, fix)>
- Unverified: anything you could not check
- Questions: decisions you need, if any (ask with contact_agent while running)
```
