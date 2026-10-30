# Install Insights

For installing the existing build, not rebuilding or releasing it. Follow the
user's Herdr `AGENTS.md`; this guide does not override its review requirements.
`RECIPE.md` is the rebuild brief, not an installation test plan.

## Before installing

1. Read `~/.config/herdr-app/AGENTS.md` (or the selected `HERDR_APP_HOME`),
   `RECIPE.md`, and the files required by those instructions. Keep the review
   scoped to this distribution; developer tooling outside `herdr-insights/` is
   not part of the install. Reuse an existing local checkout when available.
2. Check that Herdr and **Node.js 22.15+** are available. If a prerequisite is
   missing, report it rather than installing unrelated software automatically.
3. Tell the user: Insights runs a local Node helper via Herdr `exec`, reads local
   session files and OpenCode's SQLite database, and writes usage metadata under
   `<HERDR_APP_HOME>/data/insights/`. It makes no network requests or uploads,
   stores no prompt/response text, and does not modify source transcripts.

Default read roots: `~/.pi/agent/sessions`, `~/.codex/sessions`,
`~/.codex/archived_sessions`, `~/.claude/projects`, and `~/.local/share/opencode`.
The default app home is `~/.config/herdr-app`.

## Install

From the checkout's parent of `herdr-insights/`:

```sh
npm run install:local --prefix herdr-insights
```

No `npm install`, dependencies, account, or API key is needed. A copy of just the
`herdr-insights/` folder is sufficient; the rest of the repo is not required.

The installer copies only `mods/insights/`, generates `runtime.json` with this
machine's Node path, writes an ownership manifest under `data/insights/`, and runs
`herdr-app check` on the installed mod. It does not write layouts, keys, settings,
source transcripts, or existing `insights.json` usage data.

If installation or the native check fails, report the exact error and stop. Do
not use `--force`, overwrite unowned files, or rebuild the mod to bypass a failure.
Herdr's no-overwrite/name-clash rules still apply; the installer refuses collisions.

## Finish without interrupting the user

A successful installer exit, including **`herdr-app check passed`**, is the normal
installation completion criterion. Report the installed path and how to open it.
Do not run developer tests, release checks, screenshots, or smoke-test app instances
during routine installation. Do not change tabs, focus, or windows just to verify
success. Those are development activities, not installation requirements.

Only when the user explicitly asks to open Insights, add `-- --open` to the install
command, or open one tab after installation:

```sh
herdr-app do tab.new '{"name":"Insights","mod":"insights"}'
```

Opening the tab starts collection and the configured periodic refresh. Never
launch a second Herdr instance as part of installation.

## Uninstall

From the same checkout, preserving usage data and locally edited/unowned files:

```sh
npm run uninstall:local --prefix herdr-insights
```
