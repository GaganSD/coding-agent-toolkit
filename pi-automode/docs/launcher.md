# Verified SDK launcher

`bin/pi-automode.js` starts Pi **1.1.0** through the exported SDK
(`createAgentSessionRuntime` + `InteractiveMode` from
`@earendil-works/pi-coding-agent`) instead of spawning `pi -e` and trusting a
badge. The gate is verified before the TUI starts and after every runtime
replacement.

## Usage

```sh
pi-automode           # verified startup, then the normal Pi TUI
pi-automode --check   # verify gate startup and exit; no TUI, no model calls
pi-automode --help    # usage; loads nothing
```

`--help` and `--check` never make paid model calls. `--check` uses an
in-memory session and binds extensions headlessly so the gate's
`session_start`-time health receipt is validated too.

## What the launcher loads

- Exactly one executable extension: the Automode gate, as a named inline
  extension (`<inline:automode>`), created per generation by
  `createAutomodeExtension({ agentDir, workspace, extensionDir, onHealth })`
  from `./index.js` (injected by the bin entry).
- Exactly four active tools: `read`, `bash`, `edit`, `write` — a plain-name
  allowlist. The gate's wrappers replace the built-ins by name and own the
  final execute boundary.
- `noExtensions: true`: no user (`<agent-dir>/extensions`, settings-declared
  packages) and no project (`.pi/extensions`, project packages) executable
  extensions load. The built-in `mcp`, `codemode`, `tool-search`, and
  `llama.cpp` extensions are disabled as well, so codemode's ungateable
  service calls and MCP servers do not exist in this session.
- `SettingsManager` with `projectTrusted: false`: project settings are never
  merged, so project `defaultTools` widening, project package declarations,
  and project-supplied credential commands never apply. Model/auth still come
  from the operator's own native Pi configuration (`auth.json`,
  `models.json`, environment) via the real `ModelRuntime` — no keys are
  stored in Automode JSON.

Non-executable content resources (skills, prompt templates, themes, context
files such as `AGENTS.md`) load as in stock Pi. They can steer the model but
cannot register tools or handlers.

## Verification checkpoints

1. **Load checkpoint (inside the runtime factory, before any TUI or
   prompt):** the loader recorded zero extension errors, the gate extension
   is present, and it registered wrappers for all four guarded tools. Any
   failure throws `GateVerificationError`; startup exits 1, and runtime
   replacements propagate the error to the caller.
2. **Session-start checkpoint:** the gate reports
   `{ initialized, wrappedTools, enabled, error? }` through `onHealth`, no
   later than its `session_start` handler. The launcher validates the receipt
   from a handler registered after the gate's own. A missing or invalid
   receipt (including during `/reload`) escalates to a fatal: the launcher
   prints the reason, stops the TUI, disposes the runtime, and exits 1 rather
   than running unguarded.
3. **Replacement checkpoint:** `runtime.setRebindSession` re-runs the load
   checkpoint after every `/new`, `/resume`, `/fork`, or import, because each
   replacement re-creates services and re-invokes the gate factory with the
   new effective cwd as `workspace`.

`enabled: false` (Automode Off) is a *healthy* state: wrappers delegate to
the plain Pi tool definitions without policy or logging. Verification never
treats Off as a failure, and failure never silently becomes Off.

## Why both an extension and a launcher

Pi's loader skips a failed extension and continues. Stock Pi with the gate
installed as an ordinary extension is therefore only *supervised*: the
operator watches the panel, but a failed gate load means an unguarded
session with the same UI. The launcher closes that gap for its own process
by checking load results and health receipts itself. The ordinary extension
entry point remains available for experimentation; only the launcher makes
the verified-start claim.

## Limits

- **Not a sandbox.** Approved shell commands run with the full permissions of
  the operator's OS user. Native protected-file enforcement does not contain
  the internals of an operator-approved shell command, which can read or
  change anything the process user can. No absolute store-protection claim is
  made.
- The launcher supervises its own process. Other Pi processes (stock `pi`,
  other extensions) are unaffected and unguarded.
- Model/provider traffic, manual shell usage, and trusted host code are
  outside the permission boundary.
- The exported SDK helpers have trusted test seams (`extraInlineExtensions`
  and `onFatal`). The production bin supplies no extra extensions and uses
  the default terminating fatal policy. A caller injecting a non-terminating
  fatal recorder must not keep using a failed session; this is not a supported
  verified-start production configuration.
