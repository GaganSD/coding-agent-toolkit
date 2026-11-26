---
name: pi-subagents
description: Use when the user or applicable instructions ask you to delegate work to sub-agents with the `subagent` tool. Covers splitting work into independent parallel tasks, isolating parallel writers in git worktrees, writing or reusing role templates with exact verification metrics, and checking results.
---

# pi-subagents

The `subagent` tool runs 1–4 fresh Pi sessions inside this one. Each starts with no
history, extensions or skills: only its task brief, its role text, the project's
instruction files and the tools its mode grants. You stay the orchestrator. You split
the work, write the briefs, answer questions, and decide whether the results are
accepted.

**Delegate only when the user asks, directly or through instructions that apply.** A
task being large or parallelisable is not permission on its own.

## 1. Decide what to split

Split by **independent problem domains**, one sub-agent each:

- **Split** when you have several failures with different root causes, separate
  subsystems, or one question per module. Each piece must be understandable without
  the others.
- **Don't split** when failures may share a cause (investigate together first), when
  you don't know yet what's wrong, or when the pieces would edit the same files or
  share state.
- **Do it yourself** when it's a one-line fix or a quick read. Delegating costs a
  brief, a sub-agent's whole context, and your own review of the result.

## 2. Give each task a role

There are no built-in roles. Per task, pass `mode` (`inspect` or `edit`) and either:

- **inline `role`**: instructions for a one-off role, or
- **`template`**: the name of a saved template, for a role you'll reuse. A
  template supplies the role text and its own mode, model and thinking level, and
  inline `role` text is appended after it. A task's `mode` wins over the template's.

`name` (kebab-case, such as `security-reviewer`) labels the sub-agent in the roster.
It defaults to the template name, or to `worker`/`inspector`.

To create a template, read the starter (`template.md` next to this skill; `subagent list` also prints its path). It has the
archetype menu (implementer, bug-fixer, test-writer, refactorer, migrator, verifier,
then code, security, performance, test and api reviewers, and researcher), how to make
verification metrics exact, and a skeleton to copy. Save the result with `write`:

- in the **global** folder from `list` for a role you'd reuse anywhere, or
- in the **project** folder (`.pi/subagent-templates/`) for a role that names this
  project's commands and paths.

Choose whichever fits; project overrides global by name. Run `list` again afterwards
to confirm it loaded. Broken files are listed under `skipped` with the reason.

## 3. Write the brief

The sub-agent sees only what you give it. Each brief needs:

- **Goal**: what done looks like, in one or two sentences.
- **Where**: exact files, functions and commands, plus what you've already learned,
  so it doesn't rediscover it.
- **Constraints**: what not to touch; whether it may install, commit or run
  networked commands.
- **Verification metrics**: exact commands, thresholds and baselines (for example
  "`npm test` exits 0; pass count ≥ 181; `git diff --stat <launch-sha>` lists only `src/parser/**`"),
  unless the template already fixes them.
- **Report format**: what you need back.

| Bad | Good |
|---|---|
| "Fix the tests" | "Fix the 3 failures in `test/abort.test.ts`" plus their names and error text |
| "Fix the race" | The failing assertion, the suspected file and how to reproduce it |
| No constraints | "Test files only; don't change `src/`" |
| "Tell me how it went" | "Report the root cause (file:line), changed paths, and each metric with its evidence" |

## 4. Isolate parallel writers in worktrees

An `edit` task may not share a workspace with any other live task, including an
`inspect` one. Only `inspect` tasks may share. A Git workspace is the whole worktree,
so sibling folders of one checkout still conflict. The
package never creates, merges or deletes worktrees; you do that with git through your
shell.

1. **Check for existing isolation.** Run
   `git rev-parse --show-superproject-working-tree`. If it prints a path you're in a
   submodule, so treat it as a normal checkout. Otherwise, if `git rev-parse --git-dir`
   and `git rev-parse --git-common-dir` resolve to different paths, you're already in
   a linked worktree. Don't nest another one.
2. **Pick the location.** Use the location the user's instructions name. If there is
   none, use a directory outside the repository, such as
   `<parent>/worktrees/<repo>/<branch>`. Never use a folder inside the repo. Never
   overwrite an existing destination: reuse it only if it is the intended worktree.
3. **Create one per writer.** Run
   `git worktree add <location>/<branch> -b <branch> <base>`.
4. **Set up and baseline.** Install dependencies (`npm ci`, `cargo build`, and so on)
   and run the test command. Record the pass count as the baseline the metrics refer
   to. If the baseline already fails, tell the user before delegating.
5. **Launch.** Record each worktree's `git rev-parse HEAD` as its launch SHA, then pass
   each worktree as its task's `cwd`.
6. **Integrate.** Review each branch's diff, merge or cherry-pick it yourself, run
   the full suite on the combined result, then remove worktrees you no longer need.

## 5. Dispatch in one batch

Put independent tasks in **one** `run` call (up to 4). Separate calls are separate
batches, and writer tasks in later calls are rejected while earlier ones still hold
their workspace. The results of one `run` call wake you once, when the batch settles.
Questions wake you right away. Keep every run ID from the receipt, and don't integrate
until each one has settled.

While they run:

- **Don't poll.** Yield; you'll be woken.
- **Questions.** Answer with `reply` using the exact run and question IDs from
  `status`.
- **Corrections.** `steer` takes effect after the current turn; `followUp` queues
  after pending work.
- **Stopping.** `stop` cancels a run. `resume` continues a run that failed
  transiently from its saved transcript.

## 6. Verify before accepting

"Completed" means a report was saved, not that the work is right. For each run:

1. Read its report, at `reportPath`.
2. Check its metrics yourself. Rerun the commands; don't trust a pasted "exit 0".
3. Look at what actually changed and confirm it stays within scope. Use
   `git -C <worktree> diff --stat <launch-sha>` and then the full diff, which together
   cover both committed and uncommitted edits. Add `git -C <worktree> status --porcelain`
   for untracked files.
4. If you ran several workers, check that their edits don't conflict, then run the
   full suite once on the integrated result.
5. Have reviewers cover the change if the user wants review. Treat their findings
   as claims to check too.
