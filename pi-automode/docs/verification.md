# Verification record

## Executed on the merged package

Environment: macOS, Pi **1.1.0**, inert workspace/agent fixtures inside this
repository's ignored cache. No product-model requests, real credentials,
destructive targets, or real `~/.pi` settings/auth changes were used.

| Parent-run check | Node 22.23.1 | Node 24.21.0 |
|---|---:|---:|
| Strict production typecheck | pass | pass |
| Build | pass | pass |
| Strict compiled test tree; 11 files | pass | pass |
| Full offline suite | **272 / 272** | **272 / 272** |
| Failures / cancellations / skips | **0 / 0 / 0** | **0 / 0 / 0** |
| Tarball manifest/content check | **62 files; pass** | **62 files; pass** |
| Actual packed CLI `--help` / `--check` | both exit 0 | both exit 0 |

The implementation worker also reported a passing Node 26.5.0 matrix before
the final timing and launcher repairs. That is not an independent parent run or
an additional platform result.

The 272-test Node 22/24 matrices above are the pre-repair parent runs. A later
parent run on this tree (macOS, Node on PATH) passed **283 / 283** after the
DeepSeek-review repairs: same 11 files, zero failures/cancellations/skips,
pack-check still **62 files**. The 283 tests comprise 97
filesystem/policy/settings/log tests, 91 approval/gate/tools/UI tests, 64
native-reviewer tests, and 31 launcher/host tests. The 21 host tests use real Pi loader/session pipelines, include the
actual extension index, local package-manifest discovery, post-hook argument
mutation, startup failure, reload/replacement, and isolated resources. Some
failure/control cases deliberately inject test gate factories.

The runner treats every TypeScript diagnostic as fatal, enumerates all
compiled test files explicitly, and uses the production strict flags. Every
test file runs with its own temporary HOME/native agent directory and an
allowlisted child environment: no inherited provider keys/cloud profiles,
PI_OFFLINE enabled, and version checks disabled. This also isolates the SDK's
global session-directory fallback, which caller-supplied agent paths alone
do not redirect. The final parent matrices were rerun with this isolation. A
worker negative control introduced a type error and observed nonzero exit;
the error was reverted. Tests do not use a raw-TypeScript compatibility
loader, compiler-error whitelist, or gate-test skip to become green.

### Reproductions and repairs

Executed pre-repair inert proofs found raw Pi path-expansion/alias false
Allows, effectful shell flags, executable-profile aliasing, dropped empty
operands, missing hard-link identity in fingerprints, an Off-during-Allow-log
execution race, ordinary-source classifier disclosure, request-budget
oversubscription, and early concurrency-lease release after timeout.
Permanent regression cases cover the repaired paths.

A later parent real-SDK replay found an additional launcher release blocker:
a factory **provider-construction** throw on the second generation during
`/reload` bypassed the catch around factory execution. The loader removed the
gate, reported the error, issued zero fatal notifications, and an offline fake
model then wrote an inert protected agent-directory marker. The existing 268
tests did not cover that layer. Provider construction and execution now share
the recorded/fatal catch, and a partial valid receipt cannot make a failed
generation healthy. Four permanent unit/host regressions, including default
fatal exit in a subprocess, passed in fresh parent Node 22/24 runs. The earlier
green matrix was not used as a final verdict.

Independent parent replay against the repaired native reviewer, using fake
registries only, observed:

- Ordinary write content absent from the captured classifier input.
- Three concurrent reviews at budget one dispatched **exactly one** request.
- Concurrency one with uncooperative 100 ms work and 20 ms outer deadlines
  retained an underlying peak of **one**.

The merged runtime regressions also executed the delayed-Allow-log/Off,
Off→On queued-call, disk settings drift during dialog, queue-cap/deadline,
post-hook mutation, literal read fallback, native image, and same-CWD cases.
They use inert files and executors, not destructive production targets.

The first full-run attempts were not passes: the runner initially had an
invalid import/directory target; fake-TUI deadline tests initially lost their
unreferenced timer handle; and a 60 ms holder admission budget flaked on real
filesystem/log latency. The repaired test separates holder admission from
queued expiry, keeps a bounded simulated TUI handle, releases holders in
`finally`, and proves approved execution outlives its pending deadline.
Permission assertions were retained; production checks were not weakened.

### Package and UX checks

An actual npm tarball was extracted into a temporary fixture with the tested
Pi peers supplied. Its CLI verified the genuine gate on Node 22 and 24 with
fresh temporary HOME/agent/workspace directories. No source/tests/cache/maps
were packed. Pi's own SDK created native temporary auth/model-store files;
Automode did not create a separate credential store.

The offline UX page passed **47 variant clicks across eight groups**,
expand/collapse, print, and 1280/768/390/320 px layout checks, with **zero page
errors and zero HTTP requests**. Repository-local Markdown/design links were
checked. Mockups and archived proposal remain design studies, not evidence
that every proposed panel or semantic approval feature shipped.

## Independent review status

The completed pre-repair filesystem/shell review supplied static findings;
parent/Kimi then executed inert proofs and repaired them. Several broader
review jobs reached the harness deadline, and a native post-repair job failed
with a provider server error. **None is a review pass.**

A completed source-fed Grok runtime static review found no blocker in the
supplied epoch-before-mutex, post-Allow-log, and pending-deadline boundary.
It did not claim execution or broader runtime coverage. A completed source-fed launcher static review closed the provider-construction
and partial-health holes in the repaired source. Its non-exiting injected
fatal-callback caveat is outside the production CLI contract: the default
terminating policy was executed in a subprocess, while test recorders must
not continue prompting after fatal. A completed source-fed runtime closure also found no issue in lifecycle
invalidation, intermediate pending checks, frozen CWD, literal read I/O,
images, and Off delegation; unshown helpers and parent execution evidence were
explicitly distinguished.

**Closure via operator-requested DeepSeek reviews.** Static inspect reviews
by DeepSeek (`opencode-go/deepseek-v4.1-flash`) completed for
reviewer/envelope, gate/lifecycle, policy/evidence, and UI/authority, plus a
post-repair delta review covering the repairs. Kimi workers repaired the
substantiated findings and added regressions; the last of these hardened the
session-cwd workspace guard so a session cwd that is a symlink inside the
workspace pointing OUTSIDE is canonicalized (`realpathNearest` on both the
workspace root and the frozen cwd) before the containment check, blocks
fail-closed on canonicalization error, and is covered by a permanent
read/write/bash regression. The parent `npm run check` passed **282** tests
before that repair and **283** after adding the symlink-cwd regression, with
zero failures/cancellations/skips; `npm run pack-check` reports **62 files**.
The previously recorded hold for a fresh Kimi-on-reviewer native review is
superseded by these operator-requested DeepSeek reviews plus the executed
repairs and parent matrix. These remain **static source reviews plus the
parent-executed offline matrix**: no live Jev enforcement or calibration run
(one 20-case live shadow smoke with 2 classifier requests is recorded in
`../TESTS.md` and `live-jev-report.json`), no Linux/Windows matrix, and Jev
remains shadow-only. See the remaining-gate closure in
`../IMPLEMENTATION.md` in the source repository; that plan is not included in
the tarball.

## Limits of this evidence

- No Linux/Windows execution matrix, live-provider integration, semantic
  calibration, false-Allow benchmark, or interruption-rate improvement was
  measured. Windows is unsupported; only macOS was exercised here.
- Jev is shadow-only; moving aliases are not verified provider-resolved pins.
- Ordinary extension loading is supervised; only the isolated launcher
  verifies startup/replacement for its own process.
- No separate child-session/direct-service coverage or OS sandbox. Approved
  opaque shell internals run with the operator's full permissions.
- Filesystem revalidation does not eliminate OS races. Aborting already
  started work is best-effort and cannot undo effects or guarantee termination
  of detached descendants.

## Reproduce the package checks

From `pi-automode/`, with the desired Node version first on PATH:

```sh
npm ci --ignore-scripts
mkdir -p ../.cache/pi-automode-test/parent
PI_AUTOMODE_TEST_TMPDIR="$PWD/../.cache/pi-automode-test/parent" npm run check
npm run pack-check
```

This is an offline dependency-backed test suite; `npm ci` itself fetches
packages when they are not cached. Building/installing this package does not
install it into or change the user's Pi configuration automatically.

## Repository checks (2026-10-16)

The package lives in
[`pi-extensions/pi-automode`](https://github.com/GaganSD/pi-extensions/tree/main/pi-automode)
and is prepared for publication as `@gagansd/pi-automode` (MIT, `0.1.0`).
Monorepo CI runs lint, typecheck, unit and integration suites, and a packed
clean-consumer registration smoke for this package.

Local pre-publication re-run: macOS, Node **24.21.0**, Pi **1.1.0**
devDependency — strict typecheck, build, and **266/266** tests passed (zero
failures, cancellations, or skips). The artifact smoke installed the packed
tarball into a clean consumer and loaded the Pi registration (65 files). The gate now loads alongside tool-providing extensions
(for example Slate's custom `read`/`edit`/`write`) with zero loader errors or
warnings, which the previous tool-override design could not. Publication does
not change the shadow-only status of semantic review.
