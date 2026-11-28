<h1 align="center">pi-subagents 👾</h1>

<p align="center">
Tiny yet powerful, benchmarked sub-agents for Pi
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gagansd/pi-subagents"><img src="https://img.shields.io/npm/v/@gagansd/pi-subagents.svg" alt="npm" /></a>
  <a href="https://github.com/GaganSD/coding-agent-toolkit/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
</p>

## Benchmark

| Metric | `@gagansd/pi-subagents` | `nicobailon/pi-subagents` | Reduction |
| --- | --- | --- | --- |
| Package Size | **103.35 KB** | **11.60 MB** | **99.11%** |
| Initial Token Overhead | 718 | 6,158 | **88.34%** |
| Avg Tokens for 5 tasks (Kimi-K3 · k@3) | 331,346 | 638,964 | **48.14%** |
| Avg Tokens for 5 tasks (Grok-4.6 · k@3) | 256,451 | 979,286 | **73.81%** |

These frozen figures are from a prior measured campaign, not measurements or a
rebenchmark of this new release's changed artifact. Both models ran through the
same five dynamic workflow tasks using different subagents packages. See the
[benchmark methodology](https://github.com/GaganSD/coding-agent-toolkit/blob/main/benchmarks/README.md).

## Installation

```bash
pi install npm:@gagansd/pi-subagents
```

Then `/reload`. Supports stable Pi **1.x** (`>=1.0.0 <2.0.0`), including **1.1.x**,
using the local npm installation on Node in interactive mode. Prereleases, Bun,
and print/RPC/standalone hosts are not supported.

## Features

- Delegate bounded work from one agent session to sub-agents whose roles the agent writes
- Fresh native Pi sessions, session-bound, no nested delegation
- `subagent` tool: run (1–4 tasks), list, status, resume, steer, followUp, stop, reply
- `/subagents` to attach, resume, steer, followUp, reply, or stop
- Focusable worker roster and dedicated conversations; settled runs leave the roster
- No fixed roles: inline role instructions per task, or reusable Markdown templates
- A bundled `pi-subagents` skill: parallel dispatch, worktrees for parallel writers, templates, verification
- Local reports and transcripts
- One parent wake-up per `run` batch, not per finished task. Questions wake immediately
  and include buffered results; results also flush while a sibling awaits an answer.
  Resumes notify independently. Pending notices are dropped on shutdown/reload.

### Roles and templates

The package ships no roles. Each task in a `run` gives a `mode` (`inspect`, which is
read-only, or `edit`, which adds shell and write) and its role, as either:

- **inline** `role` instructions for a one-off role, or
- a saved **`template`**, plus optional inline `role` text that is appended after it.

```json
{ "action": "run", "tasks": [
  { "template": "security-reviewer", "task": "Review src/auth for the token refresh change" },
  { "mode": "edit", "name": "test-writer", "role": "Write tests only; never change src/.", "task": "Cover src/parser/escape.ts" }
] }
```

Templates are Markdown files with `name`, `description`, `mode`, and optional
`model`/`thinking` frontmatter. The agent saves them with its ordinary `write` tool:

- **Global**: `~/.pi/agent/subagent-templates/<name>.md`
- **Project**: `<project>/.pi/subagent-templates/<name>.md`. Project templates become
  sub-agent system-prompt text, so they're read only when Pi's trust store holds an
  explicit *Trust* decision for that directory or a parent of it. Session-only trust,
  and Pi's automatic trust for projects with no trust-requiring resources, don't count.
  Project templates override a global template with the same name. If a project
  override fails to load, that name is unavailable rather than silently falling back.

`subagent list` returns the folders it reads (the project folder only when trusted), the loaded templates, any files it `skipped`
with the reason, and the path of the bundled [starter](skills/pi-subagents/template.md).
The starter offers worker archetypes (implementer, bug-fixer, test-writer, refactorer,
migrator, verifier) and reviewer archetypes (code, security, performance, test, api,
researcher), each with exact verification metrics, plus a skeleton to copy.

The task's `mode` wins over a template's. Mode is never implicit: a task with neither
`mode` nor a template is rejected. The roster labels a run by `name`, then the
template name, then `worker`/`inspector`.

### Skill

The package bundles a `pi-subagents` skill for the owning agent. It covers when to
split work, writing briefs, isolating parallel writers in git worktrees (the package
itself never creates them), dispatching one batch, and verifying results before
accepting them. It replaces general "dispatching parallel agents" and "git worktree"
skills for this package.

### Run deadline

Runs default to 30 minutes. Set `minimalSubagents.timeoutMs` in Pi's user or
trusted project settings to allow up to six hours, then `/reload` before
launching new runs:

```json
{
  "minimalSubagents": { "timeoutMs": 21600000 }
}
```

The accepted range is 1 second–6 hours. This is a per-run deadline, not detached
execution: reload, session replacement, or agent exit still cancels live work.
Changing the setting does not extend a run that has already started.

### Model and thinking selection

Model and thinking resolve from the task, then the template, then the owning agent.
Models can support different thinking levels. If a selected level is unsupported,
the batch is rejected before any sub-agent launches and the error lists the valid
levels. Set `tasks[].thinking` or the template's `thinking` explicitly; the package
never silently falls back to a different model or thinking level.

Built-in, `models.json`, and extension-provided physical chat models use the
owning Pi session's live provider services, including custom streaming and
request-time authentication. Provider registration/removal and refreshed catalogs
are visible without reloading this package; credentials are not copied. Virtual
models and aliases remain unsupported. Launch and resume recheck the exact model,
scope, authentication, and thinking level. Model metadata is pinned per attempt;
a catalog change during an active attempt fails explicitly rather than mixing old
metadata with new provider configuration. A resume uses current metadata for the
same exact model and thinking level. Resume preserves the original role text
and capability mode; start a new run to apply template changes. Stopping during
resume validation cancels that admission without spending a resume attempt.
Provider code is trusted; parent tools, hooks, skills, and conversation are not inherited.

### Workspace admission

Inspectors may share a workspace. If either task edits, workspace roots must not
overlap—even between tasks in the same batch. Non-Git directories reserve their
canonical directory; Git directories reserve the whole worktree root, so sibling
subdirectories of one checkout still conflict. Symlink aliases and nested roots
also overlap. Use sequential runs or separate existing directories, clones, or
worktrees with non-overlapping roots. The package does not create them. Conflict
errors identify both task indices (`tasks[0]`, etc.) or exact run IDs, their modes,
cwd paths, and effective workspace roots before allocating any runs.

### Human navigation

Rows use stable names such as `Worker 1 · Implement the parser · Running`.
Ordinals distinguish duplicate roles and never renumber when a sibling finishes.
Run/session UUIDs and PID are not primary navigation labels.

- **Down at the editor boundary** focuses the roster, without opening anything
  (`tui.editor.cursorDown`, Down by default). This works only with this package's
  own editor, which is installed only when no other extension owns the editor. Native movement, history,
  autocomplete and selection run first. If Down still moves your caret or clears
  a selection, press it again after that movement finishes.
- **Up/Down** selects, including the configured `tui.editor.cursorDown` handoff
  key and `tui.select.*` bindings; **PageUp/PageDown** jump a window. **Enter/Space**
  opens. **Esc**, or Up from the first row, returns to the original editor.
  Typing returns there with that input intact.
- Click selects; double-click opens. `/subagents` remains the portable entry point.
- In a thread, Space/arrows edit normally. **Tab/Shift+Tab** moves among message,
  conversation and actions; **PageUp/PageDown** scrolls. **Esc/Back** returns.
- **Details** exposes technical evidence; **Tools** expands tool output;
  **Older/Latest** pages conversation history. **Stop** requires confirmation and
  stays available independently of an in-flight send. **Resume** appears only for
  a transient provider failure with a saved transcript and also requires confirmation.

The thread is this package's own opaque, full-viewport overlay, not a translucent
diagnostic popup. Worker-specific usage and workspace details are under Details.
pi-subagents never asks another extension to lend its editor, chat area or sidebar,
and other extensions don't render sub-agent UI. Parent dialogs take the screen back
without losing focus, and the worker draft is kept. Other custom editors are never
replaced or given global Down interception. The original main editor/chat objects survive switching,
including native undo/paste/cursor state and background parent output.

Per-run drafts and reading positions survive switching. Send failures keep the
text; success clears only the submitted revision. A draft bound to an old question
cannot silently answer a replacement question. Completions never jump focus:
settled runs leave the roster as soon as they finish, fail, or cancel. Live
workers stay in the idle window and page with focused Up/Down navigation.
`/subagents` still opens saved reports. Finished means a saved report, not
verified work.

### Session dashboards

For any compatible dashboard consumer, sub-agents publish optional
`pi:background-tasks` display snapshots and answer matching-owner
`pi:background-tasks:request` events. Settled runs leave that shelf (64 live rows
per source), but their spend remains in the optional v1 `totals` aggregate with
measured/total run coverage. No particular dashboard or display is required.
Snapshots include exact run IDs, state, shared host PID, backward-compatible `label`,
and separate bounded `name` and `task` fields. They do not include native session objects,
private questions, transcript file reads, or run control. Use `/subagents` for authoritative inspection and control. Listener
failures cannot change run outcomes; reload/shutdown clears the source.

Finish notices and `status` include host-measured `usage` (input/output/cache
read/cache write tokens and USD cost) when known, plus `elapsedMs`. Live usage
refreshes only at turn end, settlement and compaction boundaries, never streaming
deltas or paint. Missing live samples retain last-known cumulative usage. If final
collection fails, retained usage is explicitly `usagePartial: true`; totals include
that known spend in `usage`, count it in optional `partialRuns`, and exclude it
from fully `measuredRuns`. The conversation header shows compact input/output/cost; Details retains cache
accounting. Totals cover this manager runtime, including settled runs, not older
artifacts after reload. Missing usage stays unknown, not zero. Resumed runs use
the native transcript cumulative total rather than adding each attempt twice.

### Telemetry and evidence

**Details** shows exact run/session IDs, shared process PID, cwd, model/thinking,
context estimate, usage and artifact paths. `/subagents <run-id-or-prefix>` still
routes by the manager's run UUID, never a native session ID. Exact machine-facing
JSON and saved `run.json`/reports/transcripts are unchanged.

Sub-agents are **in-process native Pi SDK sessions**, not separate worker
processes. Threads render finalized conversation with Pi's native markdown
theme; steer interrupts after the current turn while followUp queues after
pending work, exactly like the owning session. Context occupancy is Pi's estimated current usage divided by the
selected context window, not cumulative billed tokens. Unknown remains unknown;
real zero and values above 100% are preserved. Estimates refresh at finalized
lifecycle/compaction boundaries, never on streamed tokens or paint.

Conversation pages are asynchronous bounded reads of finalized messages. Long
entries/older content disclose omission; original transcript/report paths remain
available in Details. Rendering does no filesystem reads or model calls.
