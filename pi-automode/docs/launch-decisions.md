# Launch decisions

Closes the "Remaining launch decisions" list in `docs/specification.md`.
Each decision records: the decision, the evidence behind it, and what it
permits the beta to claim. Decisions here do not authorize claims beyond the
recorded evidence. Approved by the operator (project owner) on 2026-10-14 in
the launch-decisions session; items marked "gated" additionally require the
recorded evidence before the corresponding claim is made.

## 1. Verified host/SDK mechanism and minimum Pi version

**Decision:** The beta claims compatibility with **Pi 1.1.0 exactly** — the
version exercised by the real host-load/session smoke tests and the launcher
verification. No `>=1.0.0` range badge; other versions are unverified, not
known-broken. The guarded-startup and final-action mechanism is the verified
SDK launcher (`bin/pi-automode.js`), which checks gate loading before the
TUI and after every runtime replacement; the ordinary extension entry point
is supervised-only.

**Evidence:** `tests/host-smoke.test.ts`, `tests/launcher.test.ts` against
installed Pi 1.1.0; `npm run check` passed 272/272 on Node 22.23.1 and
24.21.0 (pre-repair dual-Node matrix), and 283/283 post-repair on macOS
(a later parent run, Node on PATH; a fresh dual-Node 283 run has not been
executed and is not claimed).

## 2. Service interception (children, codemode, MCP)

**Decision:** Unsupported by design in this beta. Exposed unknown, custom,
child-session, codemode and MCP tool routes **Block** at the parent tool-call
hook while On. There is no separate child-session or direct-service
interception, and an approved opaque shell command's internals are outside
the boundary. Any future nested/child coverage requires the shared-broker
milestone from the specification, with end-to-end bypass tests, before the
beta label can drop.

**Evidence:** `IMPLEMENTATION.md` scope and invariant 2; README "What On
permits".

## 3. Jev model pin and risk budget

**Decision:** Semantic enforcement stays **off**; Jev remains **shadow-only**.
`vercel-ai-gateway/typesafe-ai/jev` is the shadow classifier of record, but it
is a provider alias, not a fixed provider-resolved version pin. The 20-case
live shadow run (2 live classifier requests, 18 correctly resolved locally;
`TESTS.md`, `docs/live-jev-report.json`) is a smoke/liveness check — not a
calibration benchmark. No measured unsafe-Allow rate exists, no operating
threshold is approved, and no fixed evaluation sample size (`n`) is
authorized; the `3/n` bound below is therefore conditional until evaluation
capacity is approved.

**Approved risk budget for any future enforcement claim** (approved by the
operator, 2026-10-14; the evidence itself is gated):

- Absolute unsafe-Allow tolerance: **0 observed misses** on the designated
  severe-risk regression suite, with reviewed labels and published sample
  sizes; approximately `3/n` is the one-sided 95% upper bound for zero
  failures in `n` independent trials and must be reported alongside any zero.
  The suite is **not yet frozen**; before any enforcement claim it must be
  fixed to cover the specification's fixture families — script-write→execute
  chains, symlinks/cwd changes, secret egress, force-push/deployment, forged
  approvals, prompt injection, multilingual negation, unknown tools, nested
  services and children — marking which categories are deterministic-only
  (blocked by policy) versus classifier-scored, with severe-risk categories
  reported separately.
- Unnecessary-Ask target: **≥ 50% fewer** than conservative Rules on
  representative authorized flows, reported with confidence intervals.
- Latency: deterministic gate p95 < 10 ms; semantic gate p95 < 1 s with a
  2 s hard deadline (human response time excluded).
- Cost/shape constraint: **no new model-facing tools or always-on prompt
  tokens**; bounded per-decision reviewer input and recorded reviewer spend.
  The current envelope already satisfies this (metadata-only whitelist,
  per-session request budget); any future profile must preserve it.
- Any model/profile/threshold change invalidates calibration and requires a
  fresh frozen evaluation; moving aliases (`jev-latest`-style) can never
  enforce.

**Evidence:** live shadow receipts in `docs/live-jev-report.json`;
specification "How we decide this deserves to ship".

## 4. Platform and language coverage

**Decision:** The beta is **macOS/Linux only**; only macOS was exercised in
verification. Windows/PowerShell is unsupported (the On gate blocks
unsupported routes rather than guessing). No Chinese-script rule-matching
parity claim is made; byte-exact rule matching is script-agnostic by
construction, but no multilingual adversarial suite has been run, so this
remains unverified, not assumed.

**Evidence:** `docs/verification.md` "Limits of this evidence".

## 5. npm publication

**Decision:** Publish name **`@gagansd/pi-automode`** (matching the
`@gagansd/pi-ask`, `@gagansd/pi-subagents`, `@gagansd/pi-web-search`
convention). The package is published from `pi-extensions` under **MIT** as
`0.1.0`. Publication covers the keyless/deterministic beta only:
**semantic enforcement stays off** and Jev remains shadow-only until the
risk-budget evidence in decision 3 exists. Publishing does not authorize a
semantic-enforcement claim.

## 6. Provider-specific disclosure/retention wording

**Final wording** (now carried by the consent dialog in `src/ui.ts` and
consistent with README "Native classifier: shadow only"):

> Shadow review sends only bounded metadata — the tool name, argument key
> names, path metadata and your message-rule text, never argument values or
> file bodies — to the selected classifier endpoint. For
> `vercel-ai-gateway/typesafe-ai/jev`, requests leave this machine to Vercel
> AI Gateway (`https://ai-gateway.vercel.sh/typesafe/v1`) and its upstream
> provider; retention follows the provider's current terms and no
> zero-retention claim is made. Consent binds this exact provider/model pair,
> the endpoint, and this workspace, and can be withdrawn at any time from
> `/automode`; any change resets it. Withholding or withdrawing consent
> never weakens deterministic Rules enforcement.

## Status ledger

| Decision | Status | Blocking release claim |
|---|---|---|
| 1. Pi version / guarded mechanism | Closed (1.1.0 only, launcher-verified) | Any broader version range |
| 2. Service interception | Closed: unsupported by design, routes Block | Any child/codemode/MCP coverage claim |
| 3. Jev pin / risk budget | Closed: shadow-only; budget approved by operator 2026-10-14, evidence gated | Any semantic-enforcement claim |
| 4. Platforms/languages | Closed: macOS/Linux beta, no Windows, no multilingual parity claim | Windows or multilingual claims |
| 5. npm name | Closed: `@gagansd/pi-automode`, MIT `0.1.0`; semantic enforcement remains gated on decision 3 evidence | Semantic-enforcement claim |
| 6. Disclosure wording | Closed (text above; dialog and README aligned) | — |
