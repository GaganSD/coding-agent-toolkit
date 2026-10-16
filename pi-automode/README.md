# pi-automode

Formerly pi-autopilot; renamed to pi-automode and published from
[pi-extensions](https://github.com/GaganSD/pi-extensions) as
`@gagansd/pi-automode`.

A **parent-session permission beta for Pi 1.1.0**. Five commands, plain-text
rules, one settings JSON, and local decision logs.

**On** checks the final arguments of `read`, `edit`, `write`, and `bash`.
**Off** deliberately disables Automode checks and logging for new calls;
held calls are cancelled, not released. Neither state is a sandbox.

## Build and start

Requires Node **22.19+** and Pi **1.1.0**. The beta is limited to macOS/Linux;
verification on other operating systems is not claimed.

```sh
cd /absolute/path/to/pi-extensions/pi-automode
npm ci --ignore-scripts
npm run check

node bin/pi-automode.js --check  # verify startup; no TUI or model requests
node bin/pi-automode.js         # verified startup, then the Pi TUI
node bin/pi-automode.js --help
```

The launcher isolates executable resources to Automode and the four supported
tools. It verifies gate loading before starting the TUI and after runtime
replacement. A missing or failed gate stops startup rather than silently
removing checks. See [the launcher contract](docs/launcher.md).

### Ordinary extension: supervised only

Install the published package:

```sh
pi install npm:@gagansd/pi-automode
```

Or, from a local checkout after `npm run build`, either load the extension
explicitly:

```sh
pi --extension /absolute/path/to/pi-extensions/pi-automode/dist/index.js
```

or install the local package:

```sh
pi install /absolute/path/to/pi-extensions/pi-automode
```

Then use Pi's `/reload`. Stock Pi can skip failed extensions and continue;
other executable extensions can also affect the tool stack. This entry point
requires operator supervision and a trusted extension stack. Prefer the
verified launcher when you need startup/replacement verification.

## Five commands

| Command | Purpose |
|---|---|
| `/automode` | Panel: state, coverage, review selection/disclosure, usage |
| `/automode on` | Enable checks after explicit local confirmation |
| `/automode off` | Disable checks; cancel held work |
| `/automode rules` | Add/edit/delete/enable plain-text allow/block rules |
| `/automode logs` | Inspect or clear actual local decisions |

Only a live local TUI plus an explicit host-owned confirmation can change
authority. Command invocation alone is not consent; RPC, print mode, model
text, and model-callable interview answers cannot approve. Decline/Cancel is
the default. Escape, timeout, errors, and queue overflow never grant permission.

## What On permits

- Ordinary workspace **reads, edits, and writes** run quietly on the file
  floor. This is broad workspace-write authority, not an understanding of
  your task or a promise to preserve every uncommitted file.
- Native writes to protected paths block: the Pi agent directory, Automode's
  package, project `.pi`, Git metadata, CI configuration, and recognized
  secret/key names. Protected/sensitive reads require local approval and are
  not sent to the classifier. Name checks are a floor, not a complete secret
  detector.
- Command rules preserve every byte. Exact block matches block; exact allow
  matches automate only the narrowly checked read-only invocation subset.
  Opaque scripts, interpreters, package managers, Git commands, compositions,
  and unresolved executable/configuration evidence still ask.
- Message allow rules **do not auto-approve** in this beta. An enabled message
  block remains unresolved and takes local Ask before any automatic floor or
  command Allow; a classifier answer cannot clear it.
- Exposed unknown/custom/child/codemode/MCP tools block at the parent tool-call
  hook while On. There is no separate child-session or direct-service coverage.
  This does **not** contain subprocesses launched inside an operator-approved
  opaque shell command.

**Important:** an approved shell command runs with your OS user's full
permissions. It can access protected files, use the network, spawn children,
or leave background processes. Native protected-file checks do not constrain
those internals. Manual shell, coding-provider traffic, and trusted host code
are outside the boundary. Cancellation is best-effort after execution starts;
it cannot undo effects. Filesystem revalidation narrows but does not eliminate
OS-level races. No unattended/full-harness or damage guarantee is made.

## Native classifier: shadow only

The picker uses classifier-typed entries in Pi's native registry, separately
from the coding model. Pi owns credentials and transport; there is no separate
provider SDK, auth file, provider cascade, chat self-review, or local fallback.

A stored key is not upload consent. Consent binds to the exact selected
provider/model pair, the normalized endpoint origin/path, and the canonical
workspace; an approved value missing any binding is not consent. Changing any
binding requires fresh confirmation. Requests omit argument values
and source bodies; eligible metadata (the tool name, argument key names and
path metadata) and message-rule text are disclosed only with bound consent.
Retention follows the provider's current terms; no zero-retention claim is
made. Consent can be withdrawn at any time from `/automode`, and withholding
or withdrawing it never weakens deterministic rule enforcement. Do not put
credentials in rules or endpoint URLs. The final provider-specific disclosure
wording is recorded in [the launch decisions](docs/launch-decisions.md).

Receipts contain actual typed answers and usage when reported. They **never
create Allow or relax a block**. No measured/calibrated profile or verified
provider-resolved model pin exists; moving aliases remain shadow-only.

## One settings file

`<agent-dir>/automode.json`, normally `~/.pi/agent/automode.json`:

```json
{
  "version": 1,
  "enabled": false,
  "classifier": null,
  "disclosureConsent": "none",
  "disclosureProvider": null,
  "disclosureModel": null,
  "disclosureEndpoint": null,
  "disclosureWorkspace": null,
  "allowlist": [],
  "blocklist": [],
  "logRetentionDays": 7,
  "logMaxEntries": 500,
  "reviewTimeoutMs": 2000,
  "reviewMaxRequests": 100,
  "approvalTimeoutMs": 600000
}
```

Missing settings start Off; the file is persisted on an operator change.
Invalid or unexpected external changes halt checks until re-verified, never
silently turn On into Off. Rules are `{ "type": "message" | "command",
"text": "...", "enabled": true }`; omitted rule `enabled` means true.
Credentials and unknown fields are rejected.

`<agent-dir>/automode-logs.json` is **NDJSON**, despite its filename, and is
an operational log, not another settings store. Entries record actual action
text, decisions, sources, rules, times, and captured classifier metadata—not
invented reasoning or proof that an allowed operation completed. Exact local
action text can contain secrets. Storage uses restrictive permissions and
age/entry/byte bounds; clearing requires local confirmation.

## Verification and design

```sh
npm run check       # strict typecheck, build, all offline tests
npm run pack-check  # package manifest and tarball contents
```

Tests use inert fixtures, fake classifier registries, and real Pi
loader/session pipelines with an offline coding provider. They must not use
real credentials, paid model requests, or destructive targets. Successful
unit tests are not a calibration or benchmark result. See the
[verification record](docs/verification.md) for commands, observed results,
review status, and residual limits.

[Two offline UX alternatives](ux-mockups.html) preserve the accepted Control
Room and Just-in-Time designs; the beta uses focused native dialogs.
[Archived specification](docs/specification.md) preserves future goals, not
shipped coverage. [Implementation plan](IMPLEMENTATION.md) records the
boundary and verification work. [Launch decisions](docs/launch-decisions.md)
close the specification's remaining launch decisions; [TESTS.md](TESTS.md)
records the 20-case live shadow run evidence. The separate local-model
research handoff remains a different project and is unchanged.
