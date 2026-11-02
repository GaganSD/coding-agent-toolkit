# Insights development and release validation

**Not an installation guide.** To install the existing build, use
[`herdr-insights/INSTALL.md`](../herdr-insights/INSTALL.md). The self-contained
[`RECIPE.md`](../herdr-insights/RECIPE.md) remains the Herdr rebuild brief.

## Repository boundaries

- `herdr-insights/`: shareable distribution; docs, preview, mod source, and
  dependency-free install/uninstall scripts. This folder installs by itself.
- `tests/herdr-insights/`: unit/integration tests, fixtures, and native smoke tests.
- `scripts/herdr-insights/`: developer package/distribution checks.

Keeping developer tooling outside the shared folder reduces the files an
installing agent needs to review. Herdr's own `AGENTS.md` still controls security
review; this separation does not exempt the mod source from that review. Moving
files out of the distribution does not remove any test coverage.

## Headless checks

From the repository root, with Node.js 22.15+ (CI uses Node 24):

```sh
npm run test:insights
npm run check:insights
```

No dependency installation is needed. CI runs both commands, including accounting,
deduplication, configuration, incremental recovery, safe install/uninstall,
distribution structure, PNG, recipe, and installation-boundary regressions.
Neither command launches a Herdr window. Installer tests use a fake Herdr runner.

## Native release checks — opt-in, not installation steps

Requires Herdr on a graphical machine. The populated-render harness runs
`herdr-app check` against a temporary mod copy without collecting user transcripts:

```sh
node tests/herdr-insights/native-loaded-check.mjs --rows 10000
node tests/herdr-insights/native-loaded-check.mjs --rows 10000 --mode menu
node tests/herdr-insights/native-loaded-check.mjs --rows 10000 --mode settings
```

**The async harness opens a separate, visible Herdr window.** Tell the operator
before running it. It refuses to run without `--allow-window`; it is deliberately
not invoked by installation, headless tests, or package checks:

```sh
node tests/herdr-insights/native-async-check.mjs --allow-window
node tests/herdr-insights/native-async-check.mjs --allow-window --settings --appearance light
node tests/herdr-insights/native-async-check.mjs --allow-window --menu
```

It uses a temporary app home with fixture data, captures a screenshot and status,
and stops only the process it started. Synthetic rows must never be installed
into a user's app home. Inspect screenshots and logs for rendering errors. Verify
filters, heatmap modes, settings, refresh, and empty/error states before release.

Reinstall validation must preserve source transcripts, layouts, keys, local edits,
and `insights.json`; the automated installer tests cover those boundaries.

## Sharing a build

Keep `herdr-insights/` self-contained, with `RECIPE.md`, `INSTALL.md`, `README.md`,
`preview.png`, and `mods/insights/`. Do not ship layouts, key snippets, developer
tests/fixtures, or smoke-test tooling in that folder. One native mod serves both
views: `props.mode: "toolbar"` renders the button, and ordinary panes render the
dashboard. The installer preflights the mod tree, checks a temporary buffered copy
before replacing live files, generates the dashboard's local Node path, and records
ownership in `install-manifest.json`. Install/uninstall share an exclusive lock;
interrupted operations require confirming the process stopped before removing it.
The toolbar is a personal layout clone wrapping Herdr's original `tabs` block;
no built-in mod source is cloned, patched, or vendored. See
[INSTALL.md](../herdr-insights/INSTALL.md) for the clone, click-state, and
ownership rules. A clone does not inherit future structural changes to its
source layout. A normal install has one `install-manifest.json` and the dashboard
`runtime.json`. Validate the mod with `herdr-app check` and inspect the actual
toolbar in the existing window; do not launch a second instance.

For Herdr Community discovery, publish the folder in a public GitHub repo and
add topic `herdr-mod` after merging to the default branch. Allow up to an hour for
indexing and at least 24 hours for picture screening. Do not republish or change
repository visibility as part of an end-user installation.
