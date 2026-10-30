# Insights

Insights is a native Herdr dashboard that reads the coding-agent transcripts
already on this machine and shows token usage, streaks, a 53-week heatmap, and a
model/provider leaderboard. It is local-first: no network, no demo rows, no
fabricated usage. The dashboard opens as a tab and leaves existing terminals,
layouts, and keys alone.

![Insights](preview.png)

**What you see:** A restrained, theme-driven native dashboard built from Herdr
theme colors with a shadcn-inspired visual system: paired surface/foreground
tokens, one monochrome primary action, 1px borders, 6px control / 8px card
radii, no decorative shadows, and a 4/8/12/16/24 spacing rhythm. The root is
vertically scrollable, centers content at a maximum width of 1180px, and uses
12px / 16px / 24px page padding below 620px / below 900px / above that. The Model Usage section has a segmented Week / Month / Year / All period
control, a year stepper when Year is active, and Provider / Model menus plus
Clear filters when a dimension is active. Menus show at most 250 values; compact
presentation retains selected values and full totals. The dashboard has no
profile, avatar, name, or handle hero.

Below the filters are five metric cards in a responsive strip (five across at
860px+, then 3+2, then 2+2+1): lifetime tokens, peak day, longest task, longest
streak, and current streak. Values use 22px type; labels are 9.5px uppercase.
The five metrics are all-time, independent of the model usage filters. A zero or
missing task duration displays as a dash, not an invented duration. Current
streak gives yesterday grace: a streak whose last active day was yesterday still
counts today. The main column then holds a GitHub-style 53-week, seven-row
heatmap: each cell is 12px square with a 2px gap (14px week width), the weekday
label column is 30px, month labels sit above the grid, and the legend uses 10px
swatches. Local calendar days are used, future cells are dimmed, and clicking a
day updates the selected-day detail. The heatmap window ends today, independent of the model usage period.

The heatmap switches between Daily, Weekly, and Cumulative. Weekly mode repeats
the full week's total on every day of that week. Cumulative mode is the all-time
running total through each day, including history before the visible window.
The selected-day detail is a flat, aligned data grid separated by a hairline
rather than a filled panel. It shows the mode value, that day's exact token
total, input, output (with reasoning inside output), cache read/write, sessions,
usage events, longest task, and the top model when present. Exact values stay in
tooltips, and an unreported task duration stays a dash.

Below the heatmap is a ranked leaderboard limited to 10 groups, split into two
columns at 960px+ and one column below that. Each row shows rank, a neutral
initial tile, model/provider name and sublabel, compact tokens, share bar, and
change versus the previous calendar portion with New / zero-safe states. Rows are
summary-only; they do not expand. The leaderboard is model-only with provider
attribution. A token breakdown and scan-status card follow; status shows
sourceStats (`disabled`, `missing`, `empty`, `ok`, `error`), file/read/unchanged/
byte counts, and up to six source-tagged warnings. Loading, empty, and error
states are explicit and never show fake rows.

The Settings view uses the same native surfaces and visual language and is
vertically scrollable at narrow widths. It includes palette
(blue/green/purple), week start (Sunday/Monday), include-cache toggle, refresh
interval, source toggles, one-root-per-line/comma root editors, and a JSON editor
with Format, Reset, and one clearly primary Save configuration action.
There are no name, handle, or avatar controls; legacy `config.profile` values can
stay in the full JSON but are not displayed. The full editor and toggles preserve
custom source mappings and other unknown-to-the-toggle fields; saves go through
the collector's `configure` command. The source and settings controls do not clip
at narrow widths.

**How it behaves:** The header refresh is incremental and guarded against
overlapping runs; while the tab is alive it polls at the configured interval
(default 60 seconds, validated 30–3600). A no-op scan does not rewrite the store,
so the store's mtime and size stay unchanged. A palette/cache/week-start/refresh
change, or a legacy profile-only JSON change, keeps collected rows; changing a
source id, adapter, enabled flag, root, or mapping clears collected rows and
rescans. `--rebuild` is the explicit manual reset. Filters scope only the model
chart and leaderboard, not token history or all-time metrics.
Periods are calendar-to-date: the current week runs from its configured start
through today, the current month from the first through today, and the current
year from January 1 through today (a past year is complete). Leaderboard
comparison uses the same calendar portion of the previous week/month/year;
month-end clamping means March 31 month-to-date compares with February 1–28/29,
not a same-day-count window. All has no previous period.
Leaderboard change handles new, no-previous-period, and zero-total cases without
dividing by zero. Project filtering uses the top 250 by tokens while retaining
the selected value. The source/settings interface can toggle built-in sources,
edit roots, and edit the full config JSON; invalid config or collector output
produces a useful error state, never fake zeros. The dashboard opens only through
the installed mod tab; it does not bind keys, dock into a shipped layout, or alter
existing terminals. It uses `herdr-app check` as the completion gate.

The collector's config accepts a partial top-level object, fills omitted top-level
fields from defaults, and rejects unknown fields at every level. Its exact custom
mapping schema is documented in README.md: required `session`, `timestamp`, and
`usage`; optional `messageId`, `project`, `model`, `provider`, `role` + `roles`,
`include`, `taskDurationMs`, and `harness`; fields are path strings, `{path,
default}` objects, or `{literal}` objects. Custom usage is canonical: input is
uncached, output includes reasoning, reasoning is a subset, and total is derived.
`sourceStats` is keyed by source id and reports status/files/filesRead/bytesRead/
errors; scan warnings are source-tagged. A missing root is a warning and `missing`
status, not a fatal scan. Removed transcript history is retained until `--rebuild`.
The store is metadata-only (config, file paths/scan offsets, aggregated numeric
rows, dedupe/task keys), and the installer manifest at
`data/insights/install-manifest.json` is separate from the collector store.
Source roots are read only and never changed.

**Built from:** A distributable Herdr mod folder, `mods/insights/`, with
`mod.json` that has `"place": "none"`, `main.js` exporting the native gpui-kit
`View`, pure `analytics.js` helpers that can run under Node without native
imports, and a Node `presenter.mjs` helper. The collector lives at
`mods/insights/collector.mjs` with declarative adapters under `core/*.mjs`; it
discovers Pi and Codex transcript roots from the saved config by default and
writes the single store at `<HERDR_APP_HOME>/data/insights/insights.json`.
Legacy Claude Code and custom configs remain readable. Herdr
runs `node .../presenter.mjs snapshot --store <store> --home <home> --options
<json>` (and `configure` with one JSON argv value) through `exec`, off the UI
thread. The presenter calls the collector once and prints one compact
presentation payload; `prepare` reads only the existing store and re-derives the
dashboard for filter/period/year/heatmap/group/day changes without scanning or
writing the store. Raw rows stay in Node. Diagnostics go to stderr and nonzero
results surface in the UI. The UI assumes the compact
`kind`/`version`/`command`/`options`/`snapshot`/`dashboard` payload, with
snapshot metadata `version`, `rowCount`, `stats`, `sourceStats`, `warnings`,
`config`, `generatedAt`, and `lastScanAt`. It uses
`theme()` colors, `on_size_change` for responsive layout, and a guarded
`cx.timer` poll rather than `setTimeout` or a spinner timer. The installer installs
only `mods/insights/`, generates `runtime.json` as `{"node": process.execPath}`
(the absolute installer Node path), creates `data/insights/`, preserves
`insights.json`, and runs `herdr-app check` with spawn argv before optionally
running `herdr-app do tab.new '{"name":"Insights","mod":"insights"}'`. The UI
reads runtime.json once and uses that binary for `exec`, so Herdr's older `node`
on PATH is bypassed without changing PATH. The installer writes the ownership
manifest with SHA-256 hashes, treats runtime.json like every other owned file, and
never follows symlinks or writes layouts/keys. Node >=22.15 is required because
the collector imports Node's zstd support, and the installer actively checks the
running Node before creating or writing the app home rather than trusting npm's
advisory engines field. No HTML, CSS, web view, network
request, shell interpolation, npm dependency, Pi extension registration, or
publishing step is part of the build.

**Watch out:** Do not add a mock collector or demo rows to production; “no data”
must look empty, not invented. Do not claim leaderboard expansion: rows are
summary-only. Weekly heatmap cells intentionally repeat the full week's total;
cumulative cells are all-time through the day, not period-only. Period comparison
is calendar-to-date against the same portion of the previous period, with month/
year end clamping. Current streak uses yesterday grace; duration 0 means unknown
and displays as a dash. Legacy `config.profile` is tolerated but not displayed.
The project filter caps options at 250 while retaining the selected project. The
collector is the source of truth for config validation, deduplication, token
arithmetic, and the custom mapping schema; the UI must not guess provider
creators or add reasoning twice. New defaults are Pi and Codex only; Claude
Code is legacy compatibility. Pi usage includes assistant and tool-result `message.usage`,
top-level `type: "usage"` events (cache warming), `compaction.usage`, and
`branch_summary.usage`; count each reported entry once, including copied fork
entries, and treat `row.messages` as usage-event count (UI: Usage events), not
assistant-message count. Codex files can expose both `token_usage_record` and
`event_msg.token_count`; reconcile them at the record level, count a turn once,
and turn cumulative counters into deltas. Forked Codex sessions keep their own
thread identity when reconciling usage. Claude streamed duplicates share
`message.id`; max-upsert the revised fields. Tokens are reported/counted usage,
not tokenizer estimates: `input` is uncached,
`output` includes `reasoning`, `reasoning` is a subset, cache fields are
counted once, and `total = input + output + cacheRead + cacheWrite`. A normal
refresh is incremental, not a forced rebuild; cold scans are O(data), warm scans
O(metadata) plus appends, and `--rebuild` is only a manual repair. Removed files
or roots retain historical rows until rebuild; a missing root is a warning and
`missing` status. The incremental cache assumes append-only growth, so a same-size
in-place rewrite may need a rebuild. Concurrent collector operations use an ownership-marked lock directory
(20s wait, dead same-host owner reclaim; live owners are never age-evicted); a corrupt store is preserved with a
`.corrupt-<timestamp>` backup and replaced with a fresh store plus a warning/error.
Task duration must use exact boundaries when present, otherwise a conservative
capped turn span — never the idle session lifetime. Use local calendar days, not
UTC. The custom mapping schema is the exact README schema; do not invent mapping
keys or add executable code. The installer refuses unowned collisions and locally
edited owned files unless `--force`; it must never follow symlinks, write
`layouts/` or `keys.json`, or replace `insights.json`. It must generate runtime.json
from the running installer Node, replace any source runtime.json with that generated
file, and still reject a source runtime symlink; do not copy a stale source runtime
or change PATH. A manual mod copy without runtime.json falls back to `node` on PATH,
which must be >=22.15. The installer must reject an older Node before creating mod
or data folders and report the actual version; npm's engines field alone is not
enough. The uninstaller should stay usable on older Node. The preview must be a
real `herdr-app shot` of the installed dashboard, not a drawn mockup.

**Done when:** `npm test --prefix herdr-insights` passes the synthetic install
tests with a temporary app home and fake `herdr-app`, including runtime.json
generation from the current installer Node, source-copy replacement and symlink
rejection, runtime collision/local-edit protection, idempotence, and data
preservation; `npm run check --prefix herdr-insights` validates the package
(Node >=22.15) and, when present, `mods/insights` with `main.js`, `mod.json` place
`none`, and no symlinks; eslint passes for the package scripts/tests where
configured. `npm run install:local --prefix herdr-insights -- --open` installs
only the owned tree plus generated runtime.json, runs `herdr-app check
<appHome>/mods/insights` successfully, and opens the Insights tab with `herdr-app
do tab.new` using the exact JSON argument. An older Node is refused before any
mod or data folder is created. A reinstall preserves
`data/insights/insights.json`, unknown local files, and unedited layouts/keys; a
locally edited owned file is refused without `--force`; an unowned collision is
refused even with `--force`. The collector snapshot command prints one compact
JSON object with the contract shape, and invalid config exits nonzero. In the live
UI, real data drives the five metrics, heatmap modes, filters, selected-day
detail, and leaderboard comparisons; loading, empty, and error states are visible,
and no fabricated rows appear.
