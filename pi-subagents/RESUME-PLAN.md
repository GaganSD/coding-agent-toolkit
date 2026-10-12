# Plan: Resume transiently failed sub-agents

> **Task**: t-b004
> **Issue**: [#58 feat: allow resuming failed agents](https://github.com/GaganSD/pi-extensions/issues/58)
> **Package**: `@gagansd/pi-subagents` 0.0.5
> **Date**: 2026-10-12
> **Status**: Proposed

**Verdict**: Add an explicit `resume` action for failed runs with a structured,
transient provider or network failure. Reopen the saved native transcript inside
the same owning Pi runtime, preserve the run ID and workspace rules, and never
resume cancelled, completed, or uncertain-cleanup runs.

**Cost**: one lifecycle state, one control action, transcript restoration,
bounded attempt metadata, UI and documentation, plus cross-version tests.

**Next**: prove public transcript restoration on Pi 1.0 and 1.1 before changing
model-facing controls.

## Vocabulary and boundary

- **Resume** means an explicit new attempt on the same run ID. It does not replay the original task.
- **Eligible** means a durable transcript exists, cleanup is confirmed, and the failure has a structured transient signal.
- **Attempt** means the original launch or one explicit resume. Each run gets at most three resumes by default.
- **Evidence** means the transcript, report, metadata, and attempt history. Evidence never grants control after the owning runtime ends.
- The first release resumes only runs still owned by the current manager. Restart and reload recovery remain a separate design problem.
- Pi's built-in provider retry remains the first response. This feature adds no automatic retry, queue, model fallback, or detached runner.

## Current state

`RunManager` owns live execution and disposes native sessions after failure.
The artifact store durably keeps `run.json` and the native transcript. The tool
and `/subagents` command have no resume action. The current vision treats old
artifacts as evidence rather than execution authority.

## 1. Requirements

- **R-1 Classify transient provider failures as resumable** — issue #58 body.
- **R-2 Continue from the saved native conversation** — issue #58 body and the current session/evidence boundary.
- **R-3 Preserve ownership, cleanup, workspace, and evidence safety** — `VISION.md` authority and evidence rules.
- **R-4 Bound every resume and require an explicit operator action** — `VISION.md` limits on concurrency, admissions, and fallback.
- **R-5 Expose one consistent resume control to the agent and operator** — existing tool/command/conversation contracts.
- **R-6 Deliver a tested, documented, AI-attributed upstream change** — issue #58 comment and the user request.

## 2. The approach, requirement by requirement

### R-1 Classify transient provider failures as resumable

- **Approach**: Classify structured provider and transport errors at the native-session boundary. Accept retryable rate limits, server failures, and transport resets. Fail closed when the error shape is unknown.
- **Touches**: Failure classification, native session lifecycle, and persisted run metadata.
- **Test seam**: RunManager fault fixtures plus a real Pi provider fixture that emits structured failures.
- **Acceptance**:
  - [ ] A final transient provider or transport failure marks the run eligible.
  - [ ] Authentication, invalid-request, local I/O, policy, cancellation, manager deadline, and cleanup failures are not eligible.
  - [ ] An error without a reliable classification is not eligible.
- **Hard part**: Provider error shapes differ across supported Pi versions. Message-text matching must not decide resumability.

### R-2 Continue from the saved native conversation

- **Approach**: Reopen the existing session through Pi's public session API and send one bounded continuation prompt. Preserve the original tool loadout, model, thinking level, and launch Git baseline.
- **Touches**: Transcript restoration, native session construction, diff-tool baseline, and report publication.
- **Test seam**: A native integration fixture that completes a tool call, fails the provider request, then restores the transcript.
- **Acceptance**:
  - [ ] The resumed attempt uses the same transcript path and native session identity.
  - [ ] Completed tool calls are not replayed.
  - [ ] The original task is not duplicated as a second initial request.
  - [ ] A successful continuation saves the normal report and terminal metadata.
  - [ ] A changed workspace baseline is detected rather than silently replaced.
- **Hard part**: A failed provider turn may leave a partial assistant entry. Restoration must use public Pi semantics, not private agent state or prompt replay.

### R-3 Preserve ownership, cleanup, workspace, and evidence safety

- **Approach**: Keep one manager record and one cleanup owner. Add a `resuming` transition, retain the exact run ID, and keep the run live while the replacement native session is active.
- **Touches**: Run state machine, cleanup fence, workspace admission, and bounded attempt history.
- **Test seam**: RunManager lifecycle and race tests with fake sessions and blocked cleanup.
- **Acceptance**:
  - [ ] Only the exact owning manager can resume a run.
  - [ ] A resumed run rechecks the process fence and workspace overlap before startup.
  - [ ] Stop and shutdown can cancel a resume without releasing uncertain cleanup.
  - [ ] Previous failure metadata remains available after a later successful attempt.
  - [ ] `cleanup_unknown`, cancelled, completed, and still-live runs reject resume.
- **Hard part**: Resume must wait for the failed attempt's final persistence and disposal without creating a second active session.

### R-4 Bound every resume and require an explicit operator action

- **Approach**: Add a bounded per-run resume allowance, defaulting to three resumes. Resumes consume that allowance but do not reset the cumulative launch budget.
- **Touches**: Configuration, admission serialization, timeout ownership, and resume concurrency guards.
- **Test seam**: Manager admission tests with concurrent resume, stop, launch, and budget requests.
- **Acceptance**:
  - [ ] No resume starts without an explicit `resume` request.
  - [ ] A second concurrent resume is rejected or coalesced without double-starting.
  - [ ] Resume attempts cannot bypass `maxConcurrent`, workspace conflicts, or the process fence.
  - [ ] Exhausted attempts become terminal and cannot be resumed again.
  - [ ] Every resumed attempt receives the normal bounded timeout and cleanup deadline.
- **Hard part**: The original admission count must remain monotonic while resumed work still occupies normal runtime capacity.

### R-5 Expose one consistent resume control to the agent and operator

- **Approach**: Add `action: "resume"` with an exact run ID, mirror it in `/subagents resume <id>`, and add a visible Resume action for eligible failed threads. Keep notifications allowlisted and display-only dashboards non-authoritative.
- **Touches**: Tool schema and parser, command routing, thread actions, status views, and completion notices.
- **Test seam**: Contract, extension, human-UX, and dashboard tests using the same manager action.
- **Acceptance**:
  - [ ] The model receives a bounded receipt with the exact run ID and current state.
  - [ ] `/subagents resume` and the thread action enforce the same eligibility checks.
  - [ ] Ineligible failures show why resume is unavailable without exposing uncontrolled provider text in a wake-up message.
  - [ ] A resumed run remains addressable while it starts, runs, fails again, or completes.
  - [ ] Existing `run`, `status`, `stop`, `steer`, and `reply` contracts remain compatible.
- **Hard part**: A stale failed-thread button must not race a new resume or target a different run after the roster changes.

### R-6 Deliver a tested, documented, AI-attributed upstream change

- **Approach**: Update the package boundary and user documentation, run the supported checks, synchronize the reviewed package locally, and open a clearly AI-attributed PR against upstream.
- **Touches**: Vision, README, changelog, package checks, local installation, and GitHub PR metadata.
- **Test seam**: Packed-package smoke test plus manual interactive resume and failure-recovery checks.
- **Acceptance**:
  - [ ] Documentation distinguishes explicit same-runtime resume from evidence browsing and restart recovery.
  - [ ] Pi 1.0 and 1.1 compatibility checks cover the public restore path.
  - [ ] The reviewed package is installed locally and smoke-tested without publishing.
  - [ ] The upstream PR links issue #58, lists the tests, and explicitly attributes AI assistance.
  - [ ] The PR does not claim automatic retry, model fallback, or verified agent work.
- **Hard part**: The PR must be useful to the upstream maintainer without implying that AI authorship transfers review or merge responsibility.

## 3. Phases

### Phase 1 — Prove safe native restoration

**Covers**: R-1 Classify transient provider failures as resumable, and R-2 Continue from the saved native conversation.

**Goal**: A disposable fixture restores a failed provider conversation and continues it without replaying completed work.

**Tasks**

- Verify public session reopening on Pi 1.0 and Pi 1.1.
- Inject a transient provider failure after a completed tool call.
- Reopen the saved transcript and continue with the original tool loadout.
- Record the launch baseline and native identity needed by a later attempt.
- Reject ambiguous, permanent, and manager-owned failure signals.

**Proof**: The native fixture completes after restoration, records one tool execution, and fails closed for unsupported restore APIs.

**Not here**: Tool schema, UI actions, reload recovery, and automatic retry.

### Phase 2 — Add the bounded resume lifecycle

**Covers**: R-1 Classify transient provider failures as resumable, R-2 Continue from the saved native conversation, R-3 Preserve ownership, cleanup, workspace, and evidence safety, and R-4 Bound every resume and require an explicit operator action.

**Goal**: An eligible failed record accepts one safe continuation while all normal ownership and cleanup fences remain active.

**Tasks**

- Persist eligibility, attempt count, launch baseline, and bounded failure history.
- Add the `resuming` transition without changing the run identity.
- Rebuild the native session from the saved transcript and preserve the baseline.
- Recheck owner, model/auth, workspace overlap, and the process cleanup fence.
- Enforce per-run resume limits, timeout deadlines, and admission serialization.
- Exercise resume versus stop, shutdown, launch, cleanup, and repeated failure races.

**Proof**: RunManager tests show one active session, monotonic admissions, preserved evidence, and no capacity release after uncertain cleanup.

**Not here**: New operator-facing actions or cross-reload artifact discovery.

### Phase 3 — Make resume controllable and legible

**Covers**: R-4 Bound every resume and require an explicit operator action, and R-5 Expose one consistent resume control to the agent and operator.

**Goal**: The owning agent or human can resume an eligible failure and see exactly what happened.

**Tasks**

- Add the closed `resume` action and allowlisted launch/status receipts.
- Add `/subagents resume <id>` with exact and unique-prefix resolution.
- Add an eligible-only Resume action to the failed conversation view.
- Reset notification state per attempt without duplicating terminal notices.
- Keep dashboard snapshots display-only and preserve existing controls.
- Cover stale buttons, concurrent actions, notices, and settled-thread drafts.

**Proof**: Contract and human-UX suites invoke the same manager path and preserve all existing action schemas.

**Not here**: Automatic retry, restart recovery, or changes to native tool permissions.

### Phase 4 — Document, validate, and install

**Covers**: R-3 Preserve ownership, cleanup, workspace, and evidence safety, R-5 Expose one consistent resume control to the agent and operator, and R-6 Deliver a tested, documented, AI-attributed upstream change.

**Goal**: The feature is understandable, compatible, and present in the reviewed local package.

**Tasks**

- Align the vision, README, tool description, changelog, and status labels.
- Document transient-error eligibility and same-runtime limits.
- Run typecheck, lint, unit, integration, pack, and clean-consumer checks.
- Run Pi 1.0 and 1.1 restore fixtures plus an offline interactive smoke test.
- Synchronize the reviewed package into the operator's local Pi setup and reload it.

**Proof**: The packed installation resumes one injected provider failure, keeps its transcript, and passes the documented checks without network access.

**Not here**: npm publication, detached execution, or restart-based authority recovery.

### Phase 5 — Open the AI-attributed upstream PR

**Covers**: R-6 Deliver a tested, documented, AI-attributed upstream change.

**Goal**: Upstream receives a small, reviewable PR that resolves issue #58 with clear ownership and limits.

**Tasks**

- Create a short-lived feature branch from upstream `main`.
- Commit with the repository's `[AI]` prefix and a focused feature message.
- Write a PR body linking #58, the behavior boundary, tests, and known non-goals.
- Add an explicit AI attribution section stating that Pi-assisted implementation was reviewed by the human maintainer.
- Leave merge, release preparation, and npm publication to the upstream maintainer.

**Proof**: A PR URL exists on `GaganSD/pi-extensions`, references issue #58, reports passing checks, and contains the explicit AI attribution.

**Not here**: Merging the PR, publishing a package, or claiming the resumed agent's work is verified.

## 4. Change log and delivery endpoint

- **2026-10-12** — Created this plan from issue #58, the current `pi-subagents` lifecycle, and the package vision.
- **2026-10-12** — Phase 1 landed: public transcript restoration, transient classification, and launch baseline capture.
- **2026-10-12** — Phase 2 landed: bounded same-runtime resume lifecycle with admission, workspace, and cleanup fences.
- **2026-10-12** — Phase 3 landed: resume on the tool, slash command, and thread, with allowlisted receipts.
- **2026-10-12** — Phase 4: vision, README, and changelog alignment in progress; validation and rollout follow.
- **Delivery endpoint** — This plan concludes with the AI-attributed upstream PR in Phase 5, linked to issue #58 and reviewed by the human maintainer.
