# pi-automode

[currently in beta]

A local permission gate for [Pi](https://pi.dev). Let workspace operations and
allowlisted commands run, use an optional decision model for unmatched actions,
and ask locally when more permission is needed.

**Beta · macOS and Linux · Node 22.19+ · tested with Pi 1.3.0**

## Quick start

```sh
pi install npm:@gagansd/pi-automode
```

Restart Pi or run `/reload`, then:

```text
/automode on
```

It applies immediately from Pi's interactive terminal—there is no
confirmation step. No API key, decision model, or rules are required. Automode
starts **off** on first install; your choice is saved.

When an action needs permission, choose **Allow once**, **Always Allow**,
**Decline**, or **Inspect details**. **Always Allow** appears when a decision
model and a generalizable command/path are available. It proposes a reusable
scope for a separate local confirmation; it never silently saves model output.
Escape cancels without granting permission. An explicit Decline suppresses
identical retries for the rest of that session, including model auto-approval.

To stop checking, run `/automode off`; it also applies immediately. Pending
approvals are cancelled, not executed. New calls then run without Automode
checks.

## What happens while on

| Action | Behavior |
|---|---|
| Ordinary `read`, `edit`, or `write` inside the workspace | Runs automatically when its target can be verified |
| Writes to protected locations | Blocked |
| Sensitive/protected reads or unverifiable targets | Stay local; ask for approval |
| `bash` commands | Blocklist first; operator allowlist or verified built-in default may allow; otherwise optional safety review, then local approval if unresolved |
| Other tools, including codemode, MCP, custom tools, and nested calls | Blocked |

Protected locations include the Pi agent directory, project `.pi`, Git
metadata, CI configuration, this extension, and secret/key paths. Command
rules and decision models do not override hard blocks. Unsupported tools and
nested calls remain blocked, not delegated to the decision model.

**Not a sandbox.** An approved shell command runs with your full user
permissions, including access to files, network, and child processes.
Automode cannot undo actions already started.

## Commands

| Command | Use |
|---|---|
| `/automode` | Open the compact panel: toggle, rules, logs, optional decision models, settings |
| `/automode on` | Enable checks immediately (interactive terminal) |
| `/automode off` | Disable checks immediately (pending approvals cancelled) |
| `/automode rules` | Add or manage rules |
| `/automode logs` | View recorded decisions, newest first |

The status line and panel header are color-coded: **Automode: On** green,
**Automode: Off** yellow, **Automode: Halted** red. **Settings** opens a compact,
full-width editor styled like Pi's native selectors, with horizontal separators,
for approval wait, immediate safe threshold, confidence
guard, model-review timeout and session budget, and log retention/entry limits.
Navigate with ↑/↓; type a number to replace a value inline, or press Enter to edit
it. Enter applies an edit; Tab applies it and moves to the next setting. Escape
cancels the current edit, or discards the draft when not editing. The layout height and
reserved help area stay stable as you navigate. Times are entered in seconds and
thresholds in percent, with default values and validated bounds shown in place.
Changes stay in a draft until **Save changes** (or Ctrl+S); **Cancel** discards them. **Reset to defaults** resets only those tuning values
and also requires Save. Model selection, disclosure consent, rules, and on/off
state are never changed by this reset. Queue counts remain visible in Settings.
If configuration changes unexpectedly, checks halt; inspect the settings,
then choose **Re-verify configuration** in the panel. Changes and approvals
require Pi's interactive terminal, not RPC or print mode.

## Rules

Open `/automode rules`, choose **Add rule**, then an allowlist/blocklist entry
for a command, `read`, `edit`, or `write`. Choose glob, exact, or regex mode in
that same picker. Rules match commands or canonical absolute paths, not messages.

- A literal command matches the entire string, including whitespace.
- A glob uses `*` for any sequence of characters. Every other character is
  literal. For example, `mv *` matches a command family, while `rm -rf .`
  without a wildcard matches only that exact invocation.
- Regex rules use an explicit mode and a restricted safe syntax; see below.
- Every blocklist outranks every allowlist. Operator allowlist entries are
  explicit permission for their full matching scope, not proof of safety.

**Choose patterns carefully.** `ls -la` does not match
`ls -la; rm -rf dist`, but the glob `ls *` does match that text. Shell
compositions, expansions, sensitive operands, broken executable/target evidence,
and unsupported `sort`/`date`/`diff` invocations still require local approval;
a text match alone does not remove these gates. Simple opaque programs such as
Git or package managers can receive explicit allowlist permission. This is
operator authority, not proof of the effects of scripts, hooks, or dependencies.

Built-in entries live in the separate `src/default-rules.ts` source file
(`dist/default-rules.js` in an installation). Read-only defaults still require
verified executable/flags/operands and complete non-sensitive evidence; they
never authorize an opaque command just because its text starts with `ls`.
Catastrophic-command defaults add hard blocks. They are always active while
On and are not an exhaustive shell security policy.

Operator rules can be edited, disabled, moved between allowlist/blocklist, or
deleted. Exact lookups and literal-prefix indexes avoid scanning unrelated
rules; patterns with no useful literal prefix necessarily cost more. Matching
has a bounded work budget: exceeding it blocks the action, never silently skips
a blocklist rule.

### Pattern syntax and settings

`tool` defaults to `bash`; `mode` defaults to `glob`. `read`/`edit`/`write`
patterns match the canonical absolute target path. `*` crosses directory
separators, so a path glob grants a subtree, not just direct children.

```json
{
  "allowlist": [
    { "text": "git status", "mode": "exact" },
    { "text": "git status[ ]+--short", "mode": "regex" },
    { "tool": "read", "text": "/shared/project/docs/*" }
  ],
  "blocklist": [{ "text": "rm -rf *" }],
  "reviewSafeThreshold": 0.99,
  "reviewConfidenceThreshold": 0.67,
  "approvalTimeoutMs": 60000
}
```

This is a settings fragment, not a complete `automode.json`. Regex mode always
matches the **whole string**. Supported: literals, optional leading `^` and
trailing `$`, `.`, character classes/ranges, `\\d`/`\\s`/`\\w` (and uppercase
negations), escaped punctuation, and `*`/`+`/`?` quantifiers. Groups,
alternation, lookaround, backreferences, counted repeats, and flags are refused
with a configuration error. Matching uses a non-backtracking state machine,
not arbitrary JavaScript regex execution. Exact mode permits a literal `*`.

**Always Allow** asks the selected decision model to choose among conservative,
code-generated generalized command patterns (or no suitable pattern). The
exact proposed scope must be confirmed with **Save and allow** before it becomes
permission. Bash families save a bare-command entry plus a whitespace-delimited
glob; native file tools save one directory/subtree pattern, not one entry per
file. A rejected, unavailable, or insufficient-confidence proposal saves nothing
and does not execute; retry with **Allow once** if appropriate. No chat-model
fallback is used. Ordinary workspace file tools already use the deterministic floor.

Verified system executables include Ubuntu 26's distribution-owned coreutils under `/usr/lib/cargo/bin/coreutils`, in addition to the standard system binary directories. User Cargo/PATH binaries and lookalike directories do not inherit that trust; program identity, executable permissions, flags, and operands must still pass verification. Verified system executables may be hard-linked, but their content and link metadata remain fingerprinted; hard-linked workspace operands still require approval.

## Decision Models

Optional: without a decision model, unresolved calls require local approval.
With fresh disclosure consent, the selected model judges unmatched eligible
calls as **safe**, **unsafe**, or **uncertain**. A validated safe result above
the configured probability/confidence threshold can run without a dialog.
Unsafe, uncertain, malformed, unavailable, over-budget, or timed-out results
never grant permission; unresolved actions take the local approval path.
Hard blocks are never lifted.

In `/automode`, choose **Decision Models** to open a picker that lists
every decision model in Pi's registry—including models such as
vercel-ai-gateway's Jev (`typesafe-ai/jev`). Entries are marked
`login required` when that provider is not authenticated and `untested` when
availability is unknown; the current selection is pinned at the top with a
`[current]` marker. Selecting a decision model is the whole setup: it applies
immediately, with no separate disclosure dialog. **Rules only (no
decision model)** clears the selection in one step. Your coding model does not
change.

The picker shows the normalized destination and disclosure scope. Safety
review may transmit the **exact bounded bash command**, plus tool/path metadata;
Always Allow also transmits proposed command patterns. File bodies, write/edit
payloads, operator rule lists, and conversation history are not sent. Sensitive
or protected evidence stays local; oversized requests are refused rather than
truncated. Provider retention terms apply. Command screening is not a guarantee
that arbitrary command text contains no secret, so enable hosted review only
when this disclosure is acceptable.

Old metadata-only/shadow consent is not sufficient: reselect the model in the
picker to approve the current disclosure version. Consent is bound to the exact
provider, model, credential-free endpoint, workspace, and disclosure version.
Credentials remain in Pi's auth system. There is no provider or chat-model fallback.

Model confidence is not a safety guarantee or a measured false-approval rate.
Immediate auto-approval defaults to `P(safe) >= 0.99` and `confidence >= 0.67`; both settings accept
finite values in `[0.5, 1]`. The same thresholds apply to model-selected reusable
patterns. This is not a calibrated security profile. Review defaults to a
2-second timeout and 100 requests per session; an Always Allow proposal consumes
another request. Evidence, settings, lifecycle, and audit availability are
rechecked before execution. Commands that cannot pass the privacy/integrity
checks stay local even when a decision model is selected.

Permission dialogs default to **60 seconds** (`approvalTimeoutMs`). If unanswered,
an eligible, completed **safe** judgment with `P(safe) > 0.50` and confidence at
or above `reviewConfidenceThreshold` may authorize this action once. Otherwise,
the action is declined and the coding model receives a block result so it can
try another approach. Explicit **Decline** or **Escape** never uses this fallback.
Hard blocks, protected targets, missing consent, failed reviews, cancellation,
settings drift, and changed evidence cannot be overridden. Timeout permissions
are recorded as `approval-timeout-model`; they never save reusable rules.
Existing explicit settings override the new defaults.

## Verified startup

For stronger startup guarantees, use the bundled launcher instead of `pi`:

```sh
pi-automode          # verify the gate, then start Pi
pi-automode --check  # verify only; no TUI or model requests
```

The launcher verifies gate health before startup and after runtime replacement,
and stops if verification fails. It uses an isolated extension stack rather
than loading your other executable extensions; see [launcher details](docs/launcher.md).
A successful check verifies that the gate loaded, **not** that checks are on.

In ordinary Pi, Automode uses the `tool_call` hook alongside other extensions.
A later hook can still change arguments after review, and an extension that
dispatches a command in the interactive session can apply `/automode on` or
`/automode off` in one step, because the live TUI dispatch is the toggle
decision. Use a trusted extension stack or the verified launcher; neither is a
security sandbox.

## Local data

- `<agent-dir>/automode.json`: saved on/off state, rules, decision model selection,
  decision model bindings, and limits. Usually `~/.pi/agent/automode.json`.
  Migration: rename the old `classifier` key to `decisionModel`. Remove or
  replace legacy `type: "message"` rules; they cause a visible configuration
  error and are never silently ignored. Legacy `type: "command"` entries
  normalize to command rules. Re-approve old disclosure consent in the picker.
- `<agent-dir>/automode-logs.json`: bounded newline-delimited JSON decision log.
  It can include exact commands and arguments; treat it as sensitive.
  View or clear it through `/automode logs`. Pre-rename entries carrying the old
  `classifier` field are treated as corrupt lines; clear the log if that noise
  bothers you.

## Development

```sh
npm run check       # typecheck, build/package checks, offline tests
npm run pack:check  # verify tarball contents
```
