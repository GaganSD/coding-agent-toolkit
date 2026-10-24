# pi-automode

[currently in beta]

A local permission gate for [Pi](https://pi.dev). Let ordinary workspace file
operations run; approve other actions one at a time.

**Beta · macOS and Linux · Node 22.19+ · tested with Pi 1.1.0**

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

When an action needs permission, choose **Allow once**, **Decline**, or
**Inspect details**. Escape cancels without granting permission. An explicit
Decline also suppresses identical retries for the rest of that session.

To stop checking, run `/automode off`; it also applies immediately. Pending
approvals are cancelled, not executed. New calls then run without Automode
checks.

## What happens while on

| Action | Behavior |
|---|---|
| Ordinary `read`, `edit`, or `write` inside the workspace | Runs automatically when its target can be verified |
| Writes to protected locations | Blocked |
| Sensitive reads, outside-workspace files, or uncertain targets | Ask for local approval |
| `bash` commands | Ask, unless a narrowly supported exact allow rule applies; exact block rules block |
| Other tools, including codemode, MCP, custom tools, and nested calls | Blocked |

Protected locations include the Pi agent directory, project `.pi`, Git
metadata, CI configuration, this extension, and secret/key paths. Command
rules do not override these file protections. An enabled message block rule
makes otherwise allowed actions ask too; see [Rules](#rules).

**Not a sandbox.** An approved shell command runs with your full user
permissions, including access to files, network, and child processes.
Automode cannot undo actions already started.

## Commands

| Command | Use |
|---|---|
| `/automode` | Open the compact panel: toggle, rules, logs, optional decision models, details |
| `/automode on` | Enable checks immediately (interactive terminal) |
| `/automode off` | Disable checks immediately (pending approvals cancelled) |
| `/automode rules` | Add or manage rules |
| `/automode logs` | View recorded decisions, newest first |

The status line and panel header are color-coded: **Automode: On** green,
**Automode: Off** yellow, **Automode: Halted** red. **Details** contains
coverage, queue counts, settings location, and log limits.
If configuration changes unexpectedly, checks halt; inspect the settings,
then choose **Re-verify configuration** in the panel. Changes and approvals
require Pi's interactive terminal, not RPC or print mode.

## Rules

You do not need rules to get started. Add them only to reduce repeated
approvals or explicitly block an invocation.

Open `/automode rules`, choose **Add rule**, then choose an effect and type:

- **Allow command** / **Block command** match the entire command exactly,
  including whitespace. Block rules take priority.
- An allow rule only skips approval for a narrowly verified read-only shell
  invocation. Scripts, interpreters, package managers, Git commands, and
  compositions still ask, even with a matching rule.
- **Message rules are experimental.** Allow messages never auto-approve.
  An enabled block message makes **all otherwise allowed actions ask**,
  because local policy cannot interpret the instruction and the optional
  decision model cannot authorize anything.

Verified system executables include Ubuntu 26's distribution-owned coreutils under `/usr/lib/cargo/bin/coreutils`, in addition to the standard system binary directories. User Cargo/PATH binaries and lookalike directories do not inherit that trust; program identity, executable permissions, flags, and operands must still pass verification. Verified system executables may be hard-linked, but their content and link metadata remain fingerprinted; hard-linked workspace operands still require approval.

For example, allowing `ls -la` does not allow `ls -la; rm -rf dist`.
Rules can be edited, disabled, moved between allow/block, or deleted.

## Decision Models

You can skip this entirely. It adds **shadow review**, not automatic approval.

In `/automode`, choose **Decision Models** to open a picker that lists
every decision model in Pi's registry—including models such as
vercel-ai-gateway's Jev (`typesafe-ai/jev`). Entries are marked
`login required` when that provider is not authenticated and `untested` when
availability is unknown; the current selection is pinned at the top with a
`[current]` marker. Selecting a decision model is the whole setup: it applies
immediately, with no separate disclosure dialog. **Rules only (no
decision model)** clears the selection in one step. Your coding model does not
change.

The picker shows each model's normalized destination endpoint before selection
and states that only bounded metadata—tool name, argument key names,
path metadata, and message-rule text, never argument values or file
bodies—may go to the selected endpoint. Provider retention terms apply, and
shadow reviews never approve actions or override a block.

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
  Migration: earlier beta files used a `classifier` key; rename it to
  `decisionModel` or the file is rejected as an unknown-key config error.
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
