# Implementation plan

> **Build record.** The package lives in
> [`pi-extensions/pi-automode`](https://github.com/GaganSD/pi-extensions/tree/main/pi-automode)
> and is published as `@gagansd/pi-automode` (MIT).

## Scope being built

A runnable, parent-only Pi 1.1.0 beta in this directory. Five commands only: `/automode`, `/automode on`, `/automode off`, `/automode rules`, `/automode logs`. One operator settings file, `<agent-dir>/automode.json`; bounded local logs are operational records. No extra model-facing permission tool, grant/task workflows, provider SDK, or remote telemetry. Child sessions, codemode and MCP are unsupported; the isolated launcher does not load these executable resources.

Two entry points: the ordinary Pi extension, explicitly supervised because the host can skip a failed extension, and an isolated-resource SDK launcher that verifies its gate before starting the TUI and after each runtime replacement. The launcher must not discover additional executable extensions or MCP servers, must not execute project credential commands, and must fail if its gate cannot load. Neither entry point is a sandbox; manual shell, model/provider traffic, approved shell internals, and trusted extension/host code remain outside the permission boundary.

## Architecture

- `src/types.ts`, `settings.ts`, `evidence.ts`, `policy.ts`, `logs.ts`: validated data, atomic operator configuration, canonical paths/evidence, pure precedence, bounded actual-decision records.
- `src/reviewer.ts`: native classifier adapter with consent, bounded disclosure, outer deadline, cancellation, exact typed-result validation and usage accounting. No provider cascade. **Shadow only in this beta**: no measured/calibrated profile exists yet; model output never creates Allow or clears an unresolved message block.
- `src/approval.ts`, `gate.ts`, `ui.ts`, `index.ts`: serialized local operator dialogs, epochs/cancellation/revalidation, the `tool_call` enforcement hook, focused Pi-native dialogs, commands and lifecycle.
- `src/launcher.ts` and `bin/`: verified SDK startup/replacement with only the gate's extension and four supported tools.
- `tests/`: unit, real Pi-loader/session smoke, integration and adversarial regression tests. No paid model calls or live destructive scenarios.

## Shared contracts for parallel implementation

All TypeScript modules use ESM `.js` import specifiers. Pure/core modules do not import Pi at runtime.

- `Rule`: `{ type: "message" | "command"; text: string; enabled?: boolean }`.
- `AutomodeSettings`: `{ version: 1; enabled: boolean; classifier: { provider: string; model: string } | null; disclosureConsent: "none" | "approved" | "declined"; disclosureProvider: string | null; disclosureModel: string | null; disclosureEndpoint: string | null; disclosureWorkspace: string | null; allowlist: Rule[]; blocklist: Rule[]; logRetentionDays: number; logMaxEntries: number; reviewTimeoutMs: number; reviewMaxRequests: number; approvalTimeoutMs: number }`. Numeric limits/defaults are validated. Disclosure binds to the exact selected provider/model pair, the selected model's credential-free endpoint, and the canonical workspace; a missing binding cannot authorize upload, a selected provider/model that differs from the bound pair is not consent, and changing any binding requires fresh confirmation. Older files may default missing bindings to null, but their unbound approved value is not valid consent. Defaults Off, no consent, null provider/model/endpoint/workspace binding, empty rules, seven days/500 entries, 2-second review deadline, 100 requests/session, 10-minute approval deadline. Every exposed setting is in this JSON. Unknown fields are rejected, including credentials.
- `Action`: `{ requestId: string; tool: string; args: Record<string, unknown>; cwd: string }`.
- `ActionEvidence`: `{ action: Action; workspace: string; canonicalPath?: string; protectedReason?: string; sensitive: boolean; complete: boolean; fingerprint: string; reason?: string; snapshots: FileSnapshot[] }`. `FileSnapshot` and additional evidence fields belong to the core worker. Fingerprints bind exact arguments, cwd, canonical targets and relevant evidence; request IDs are not authority.
- `Decision`: `{ outcome: "allow" | "ask" | "block"; source: string; reason: string; matchedRule?: Rule }`.
- `buildEvidence(action, {workspace, agentDir, extensionDir}): Promise<ActionEvidence>`; `evaluatePolicy(evidence, settings): Decision`.
- `SettingsStore`: constructor `(filePath: string)`; `path`, `current`, `epoch`, `error`; `load(): Promise<void>`; `reload(): Promise<boolean>` (true when valid settings change); `update(next: AutomodeSettings): Promise<void>`. Invalid config keeps the last valid state and exposes error; no valid initial config must not silently pass as Off. Missing file legitimately defaults Off. Persistence uses restrictive permissions, temp/rename, symlink rejection, and concurrent-edit detection.
- `DecisionLog`: `{ id: string; time: string; action: Action; outcome: "allow" | "ask" | "block"; source: string; reason: string; matchedRule?: Rule; classifier?: unknown; input?: unknown; output?: unknown }`. No fabricated reasons. `LogStore(filePath: string)`; `read(settings): Promise<DecisionLog[]>`; `append(entry, settings): Promise<void>`; `clear(): Promise<void>`. Truncation/unavailable data must be explicit. Restrictive filesystem permissions and bounded bytes as well as entries/age.
- `NativeReviewer.review(evidence, settings, registry, signal?): Promise<ReviewReceipt>`; `ReviewReceipt` with `status`, `source`, optional captured `input`, `output`, `usage`, and `reason`. Constructor/options and precise receipt types belong to reviewer worker; adapter stays structurally compatible with Pi's registry rather than depending on a fake provider implementation. Gate awaits this only when relevant, treats it as shadow evidence, and never approves based on it.
- `createAutomodeExtension(options?)` returns an ExtensionFactory; `options` includes explicit `agentDir`, `workspace`, `extensionDir`, and a non-agent-facing health receipt callback for the launcher. The standard entrypoint is `src/index.ts` default factory. Runtime/launcher workers coordinate the exact receipt contract.

## Enforcement invariants

1. While Off, the `tool_call` hook has no opinion and Pi's stock tools run without Automode policy/logging. Off is deliberate, not outage fallback.
2. While On, review every native read/edit/write/bash call at Pi's `tool_call` hook before execution, without replacing tool definitions or customizing shell prefixes/spawn behavior. Freeze a private copy of the final arguments before review, and on allow write the reviewed (path-translated) arguments back into the host event so the tool executes the reviewed target. Unsupported exposed parent-tool routes Block; one-shot approval cannot lift missing coverage. The hook boundary is not a sandbox: an extension loaded after the gate can still change arguments, so the launcher loads no other extensions and the supervised extension requires a trusted stack. This is not separate child-session or direct-service interception.
3. Precedence: supported route/integrity → protected writes → exact block commands → unresolved message block (Ask) → workspace file floor and narrowly supported exact shell allows → Ask. Protected/sensitive reads are local Ask, never hosted. Path containment includes lexical protected names and canonical/symlink targets, new descendants and hard-link handling; unprovable cases ask/block.
4. No blanket shell prefixes. Exact command rule matching preserves every byte. Opaque scripts, interpreters and compositions still Ask if executable evidence is incomplete. Explain this conservative beta limitation rather than pretending a matching command proves effects.
5. All pending calls invalidate on policy/settings drift, On/Off changes, abort, session switch/tree/reload/shutdown. Off never releases held calls. Revalidate exact identity and filesystem evidence immediately before execution; consume one-shot approval once. Policy changes/decline cannot turn into a new automatic dialog loop.
6. Only a live local TUI can approve or mutate settings. Stock Pi runs slash commands before its input event and supplies no command-origin authentication: command invocation alone cannot authorize a change. Use an explicit host-owned terminal confirmation for toggles/saves; RPC/print and model-generated answers cannot approve. Approval defaults to Decline; Escape/timeout/error means no execution.
7. Invalid or externally changed configuration visibly halts On operation until the operator re-verifies. Changing classifier selection resets disclosure consent. No keys in extension JSON, no project override widening authority.
8. Jev uses the native registry only, with consent for the selected provider/model/endpoint. Do not send source bodies or secret-bearing arguments just because a scanner found nothing. Shadow results remain local records and do not relax policy. `jev-latest` is not a verified provider-resolved pin.
9. Gate failures and logging/storage errors must not silently become permission. UI and logs escape terminal-control characters, preserve original local action text, and report actual decisions without invented chain-of-thought.

## Verification and delivery

Parallel implementation uses separate worktrees; integration and validation happen against the merged package. Independent adversarial reviews fan out across filesystem/shell policy, lifecycle/authority/races, and classifier/privacy/config/UI. Substantiated findings require repairs, regression tests and independent verification. Run typecheck/build, full offline tests, real host-load/session smoke, package contents checks, and inert adversarial replay. Publish actual evidence and residual limitations, never an unattended/full-harness or semantic-calibration claim unsupported by the tests.

### Repair and verification ledger

The following were genuine pre-repair blockers, not hypothetical static warnings. Repairs are integrated; package-wide cross-version execution and independent post-repair reports remain the delivery gate.

- Pure-core inert reproductions confirmed false Allow for raw `@.env`, macOS `.ENV` aliases, effectful `sort -o` flags and attacker-chosen executable basenames outside the workspace. A hard-link change altered policy eligibility without altering the evidence fingerprint. Initial repairs passed 93 core regressions on Node 22. Two follow-up reproductions also found dropped empty shell operands and a workspace executable alias inheriting a different system program's profile; both require permanent negative checks. Unit-test passes alone are not a release verdict.
- Actual Gate/core/ApprovalManager reproduction confirmed a held workspace write executes after operator Off when the Allow audit append is delayed. Lifecycle, signal, settings and evidence checks must cover every asynchronous boundary, including queued entry, shadow review and post-approval logging, not only the open dialog. Off→On must not revive an old call.
- Pending-call bounds and approval deadlines must include execution-mutex wait; the dialog queue alone does not bound managed calls. Native read operations must reject unreviewed fallback targets at their I/O boundary rather than relying on a pre-execute existence check.
- Strict integration typing, a working compiled-test pipeline, a Pi package extension manifest, real-index host tests, default Pi agent-directory resolution and full-package protection remain required. No weakened production compiler flags or silently skipped gate tests.

Parent replay against the repaired native reviewer verified three concrete fixes using fake registries only: ordinary write-source bodies were omitted; three concurrent calls with a one-request budget dispatched exactly once; and three timeout reviews against an uncooperative classifier with concurrency one retained an underlying peak of one. Strict production typecheck and build pass on the merged tree. A direct Node 22 run also passed all 95 core tests and all 19 real-index host tests; the first full compiled run exposed fake-TUI timer-liveness cancellations and runner integration defects, not a release pass. The revised strict runner must execute every test with zero failures, cancellations or skips.

A subsequent parent real-SDK reload proof exposed a separate launcher blocker: factory-provider construction happened outside the supervised catch, so a provider throw removed the gate without fatal notification and an offline fake model wrote an inert protected agent-directory marker. The first 268-test matrix missed this layer. Provider construction and execution now share the fatal catch, and failed generations reject even partial valid health. Four permanent regressions include a real SDK reload and the default fatal subprocess; fresh parent Node 22/24 matrices pass 272/272 with zero failures, cancellations or skips.

### Remaining gate: independent native review in a fresh session

**Status: closed by operator-requested DeepSeek reviews.** The hold below was
superseded when the operator requested static inspect reviews by DeepSeek
(`opencode-go/deepseek-v4.1-flash`) instead of the fresh Kimi K3-high native
job. Completed reviews covered reviewer/envelope, gate/lifecycle,
policy/evidence, and UI/authority, plus a post-repair delta over the repairs.
Kimi workers repaired the substantiated findings and added regressions,
including canonicalizing both sides of the gate's session-cwd workspace guard
(`realpathNearest`, fail-closed) so a symlinked session cwd pointing outside
the workspace blocks for read/write/bash. The parent `npm run check` passed
**282** tests before that repair and **283** after, zero
failures/cancellations/skips; `npm run pack-check` reports **62 files**.
Residual limits stay honest: this closure is static source review plus the
parent-executed offline matrix — not an unattended or full-harness claim, no
live Jev enforcement or calibration (a 20-case live shadow smoke with 2
classifier requests is recorded in `TESTS.md`), no Linux/Windows matrix, no
semantic calibration, and Jev remains shadow-only. The original hold plan is kept below for the record.

The operator explicitly chose **hold**, not conditional delivery. Use a fresh independent **Kimi K3-high** reviewer (`bedrock-runtime/us.moonshotai.kimi-k3`, thinking `high`) instead of Grok for this remaining review; AWS was rate limiting Grok. The current harness session exhausted its launch budget, and completed jobs cannot be resumed. Do not count any cancelled/provider-failed native job as a pass or commit/push before closing this gate.

Review the current `src/reviewer.ts` and `src/classifier/envelope.ts`: atomic dispatch after async availability/acquire; abort/reset/budget/breaker races; lease retention until uncooperative work settles; generation isolation; metadata whitelist, UTF-8 bounds and provider-reasoning stripping. Constructor defaults are concurrency 4, pending 32, breaker threshold 3. Use source-fed excerpts (`reviewer.ts` lines 194–638 plus full envelope, about 27 KB including a short task) to avoid another retrieval-heavy timeout. Report static versus executed findings separately. Kimi implementation workers must repair substantiated findings and add regressions, then rerun the final parent matrix. No real credentials, paid product-model calls, real user Pi settings/auth changes or destructive targets.

Current main is staged, uncommitted, with fresh parent strict checks and **272/272** on Node **22.23.1** and **24.21.0**, zero failures/cancellations/skips. The final runner isolates each test HOME/agent directory and allowlists environment variables. Packaging is 62 files; actual extracted tarball CLI help/check already passed on both versions. Source-fed Grok reports completed for the critical runtime boundary (`ccd01254-8739-4db3-a0f3-c237c5d43123`), runtime lifecycle/read/CWD closure (`9cddfd43-58a0-4d19-87e3-163df0e4f569`), and repaired launcher (`d1e622b9-e491-4935-b445-efccf9867d17`). Their source-only limits and non-exiting trusted callback caveat are documented. Parent independently replayed native body omission, budget-one dispatch, and uncooperative concurrency fixes; those are not a substitute for the requested remaining independent review.

Run checks from this package with `PI_AUTOMODE_TEST_TMPDIR="$PWD/../.cache/pi-automode-test/parent" npm run check` and `npm run pack-check`, selecting Node 22/24 on PATH. Keep caches, `dist`, `node_modules`, and worktrees out of commits.

Read-only review profiles can inspect but cannot run shell proofs. Executable adversarial reviews therefore use shell-capable profiles constrained to isolated scratch artifacts, with no original-source edits. Broad reviews that reached the harness's 30-minute deadline are cancelled, not passes; replacement checks use bounded scopes. Reports distinguish static findings from executed reproductions; neither is treated as a completed release check by itself.
