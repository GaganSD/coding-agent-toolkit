# Insights

Insights is a native Herdr dashboard that reads the coding-agent transcripts
already on this machine and shows token usage, streaks, a 53-week heatmap, and a
model/provider leaderboard. It is local-first: no network, no demo rows, no
fabricated usage. The dashboard opens as a tab and leaves existing terminals,
layouts, and keys alone.

![Insights](preview.png)

**What you see:** A restrained near-black/native dashboard built from Herdr
theme colors. At the top, a centered profile block shows the avatar (or its
fallback), name, and optional handle. Below it is a five-metric rounded strip:
lifetime tokens, peak-day tokens, longest observed task, longest streak, and
current streak. The main column holds a GitHub-style 53-week, seven-row heatmap
with local calendar dates, month labels, and empty gray/blue intensity cells.
Below the heatmap are filters for harness, provider, model, project, period
(week, month, year, all), and year, followed by a ranked two-column leaderboard.
Each leaderboard row shows model name and provider label, total tokens, a share
bar, and change against the previous equivalent period; the grouping control
switches between models and providers. Rows expand to show input, output, cache,
and reasoning detail. Source scan status appears near the data views, with
distinct loading, empty, and error states. The profile/source/settings views use
the same native surfaces and are vertically scrollable at narrow widths without
clipping controls. The layout responds to its own size; it is not a fixed
desktop mockup.

**How it behaves:** The header refresh is incremental and guarded against
overlapping runs; while the tab is alive it polls gently at the configured
interval (default 60 seconds, validated 30–3600). The heatmap switches between
Daily, Weekly, and Cumulative with correct aggregation, local dates, and precise
hover counts; clicking a day selects it and updates the detail views. Weekly
mode respects the configured week start. Filters narrow all views, and period
comparisons compare against the immediately previous equivalent period.
Leaderboard change handles new, no-previous-period, and zero-total cases without
dividing by zero; grouping models and providers recalculates rank and share. The
source/settings interface can toggle built-in sources, edit roots, and edit the
full config JSON; invalid config or collector output produces a useful error
state, never fake zeros. Empty and loading states are explicit. The dashboard
opens only through the installed mod tab; it does not bind keys, dock into a
shipped layout, or alter existing terminals. It uses `herdr-app check` as the
completion gate.

**Built from:** A distributable Herdr mod folder, `mods/insights/`, with
`mod.json` that has `"place": "none"`, `main.js` exporting the native gpui-kit
`View`, and pure `analytics.js` helpers that can run under Node without native
imports. The collector lives at `mods/insights/collector.mjs` with declarative
adapters under `core/*.mjs`; it discovers Pi, Claude Code, and Codex transcript
roots from the saved config and writes the single store at
`<HERDR_APP_HOME>/data/insights/insights.json`. Herdr runs
`node .../collector.mjs snapshot --store <store> --home <home>` (and `configure`
with one JSON argv value) through `exec`, off the UI thread. Both print one
compact JSON Snapshot to stdout; diagnostics go to stderr and nonzero results
surface in the UI. The UI assumes `rows`, `stats`, `warnings`, `config`,
`generatedAt`, and `lastScanAt` from the contract. It uses `theme()` colors,
`on_size_change` for responsive layout, and a guarded `cx.timer` poll rather
than `setTimeout` or a spinner timer. The installer copies only `mods/insights/`,
creates `data/insights/`, preserves `insights.json`, and runs `herdr-app check`
with spawn argv before optionally running `herdr-app do tab.new
'{"name":"Insights","mod":"insights"}'`. No HTML, CSS, web view, network request,
shell interpolation, npm dependency, Pi extension registration, or publishing
step is part of the build.

**Watch out:** Do not add a mock collector or demo rows to production; “no data”
must look empty, not invented. The collector is the source of truth for config
validation, deduplication, token arithmetic, and the custom mapping schema; the
UI must not guess provider creators or add reasoning twice. Codex files can
expose both `token_usage_record` and `event_msg.token_count`; count them once and
turn cumulative counters into deltas. Claude streamed duplicates share
`message.id`; count that message once. Tokens are reported/counted usage, not
tokenizer estimates: `input` is uncached, `output` includes `reasoning`,
`reasoning` is a subset, cache fields are counted once, and
`total = input + output + cacheRead + cacheWrite`. A normal refresh is
incremental, not a forced rebuild; cold scans are O(data), warm scans O(metadata)
plus appends, and `--rebuild` is only a manual repair. Task duration must use
exact boundaries when present, otherwise a conservative capped turn span — never
the idle session lifetime. Use local calendar days, not UTC. The custom mapping
schema is not frozen in this package yet; document it from the collector rather
than inventing mapping keys. The installer refuses unowned collisions and
locally edited owned files unless `--force`; it must never follow symlinks, write
`layouts/` or `keys.json`, or replace `insights.json`. The native preview is
captured by the coordinator after the real visual check; do not draw a fake
preview. Sizes, spacing, and colors must follow the actual mod files and theme,
not a static mockup.

**Done when:** `npm test --prefix herdr-insights` passes the synthetic install
tests with a temporary app home and fake `herdr-app`; `npm run check --prefix
herdr-insights` validates the package and, when present, `mods/insights` with
`main.js`, `mod.json` place `none`, and no symlinks. `npm run install:local
--prefix herdr-insights -- --open` installs only the owned tree, runs `herdr-app
check <appHome>/mods/insights` successfully, and opens the Insights tab with
`herdr-app do tab.new` using the exact JSON argument. A reinstall preserves
`data/insights/insights.json`, unknown local files, and unedited layouts/keys; a
locally edited owned file is refused without `--force`; an unowned collision is
refused even with `--force`. The collector snapshot command prints one compact
JSON object with the contract shape, and invalid config exits nonzero. In the
live UI, real data drives the five metrics, heatmap modes, filters, selected-day
detail, and leaderboard comparisons; loading, empty, and error states are
visible, and no fabricated rows appear. `herdr-app shot` captures the final
rendered dashboard for `preview.png`, and the coordinator adds that screenshot
after the native visual check.
