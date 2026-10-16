# pi-automode

A permission gate for Pi. While On, it checks the final arguments of `read`,
`edit`, `write`, and `bash` before they run, so risky actions stop for a local
decision instead of executing silently.

## Why use it

- Quiet workspace, loud risks. Ordinary reads, edits, and writes inside the
  workspace run on the file floor. Writes to the Pi agent directory, project
  `.pi`, Git metadata, CI config, and secret or key names block. Unknown,
  custom, child, codemode, and MCP tools block at the parent tool call.
- Exact rules cut repeated asks. A command rule for `ls -la` lets that exact
  invocation run; `ls -la; rm -rf dist` still asks because matching preserves
  every byte.
- Every decision is recorded locally. `/automode logs` shows the action,
  outcome, source, matched rule, and time.
- Optional classifier review. Select a classifier-typed model such as Jev from
  Pi's own registry. Reviews are shadow-only and never approve an action.

## Demo

```text
$ pi-automode --check
pi-automode gate verified (generation 1)
state: OFF
tools: bash, edit, read, write (wrapped)
workspace: /path/to/project
```

The launcher verifies the gate before starting the TUI and after every runtime
replacement. A missing or failed gate stops startup.

## Install

```sh
pi install npm:@gagansd/pi-automode
```

Restart Pi or run `/reload`. The gate starts Off and checks nothing until you
enable it.

For verified startup, run the bundled launcher instead of `pi`:

```sh
pi-automode          # verified startup, then the Pi TUI
pi-automode --check  # startup check only, no TUI and no model requests
pi-automode --help
```

Requires Node 22.19+ and Pi 1.1.0 on macOS or Linux.

## Usage

| Command | Result |
|---|---|
| `/automode` | Panel with state, coverage, classifier selection, and usage |
| `/automode on` | Enable checks after a local confirmation |
| `/automode off` | Disable checks and cancel held calls |
| `/automode rules` | Add, edit, delete, or disable allow and block rules |
| `/automode logs` | Inspect or clear recorded decisions |

```sh
/automode on      # enable after a local confirmation
/automode rules   # add an exact command allow rule, for example ls -la
/automode logs    # inspect what the gate decided
```

A command rule matches the exact command text. The allow side automates only
the narrowly checked read-only invocation subset. Opaque scripts,
interpreters, package managers, Git commands, and compositions still ask.

Classifier review is optional. Open `/automode`, choose `Review (classifier)`,
and select a classifier-typed model. A request goes out only after you approve
consent for that exact model, endpoint, and workspace, and requests omit
argument values and file bodies. Message allow rules never auto-approve, and a
classifier answer cannot clear an enabled message block.

## Settings and logs

- `<agent-dir>/automode.json`, normally `~/.pi/agent/automode.json`, holds the
  on/off state, classifier selection, consent binding, rules, and limits. A
  missing file starts Off. Invalid external edits halt checks until verified.
- `<agent-dir>/automode-logs.json` is a bounded NDJSON record of actual
  decisions. It can contain exact action text, so treat it as sensitive.

## Limits

- Not a sandbox. An approved shell command runs with your full user
  permissions and can reach protected files, the network, or child processes.
  Off cancels held calls but does not sandbox the session.
- Classifier receipts are shadow-only. They never create an Allow or clear an
  enabled message block.
- macOS and Linux only. Windows is unsupported.

## Verification

```sh
npm run check       # strict typecheck, build, and the offline test suite
npm run pack-check  # tarball contents
```
