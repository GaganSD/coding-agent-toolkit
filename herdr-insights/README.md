# Insights for Herdr

A native dashboard for coding-agent token usage. Reads local session data from
Pi, Codex, Claude Code, and OpenCode. Zero dependencies; no account required.

![Insights model usage dashboard](preview.png)

*Preview uses synthetic data.*

## What it shows

- Model rankings, provider attribution, and period-over-period trends.
- Stacked usage charts with week, month, year, and all-time filters.
- Daily activity heatmap, lifetime totals, peak usage, and streaks.

## Install

Requires [Herdr](https://herdr.dev) and Node.js 22.15 or newer.
From the repository root:

```sh
npm run install:local --prefix herdr-insights -- --open
```

The installer copies the mod into `~/.config/herdr-app/mods/insights/` and runs
`herdr-app check`. Set `HERDR_APP_HOME` to use a different app home.

## Configuration

Open Settings in the dashboard to choose sources, edit transcript paths,
include or exclude cached tokens, and adjust refresh frequency and colors.
Usage metadata is stored in `~/.config/herdr-app/data/insights/insights.json`.

## Token accounting

Counts come from recorded usage, not estimates. Cached tokens are included by
default and can be excluded. Cumulative counters and forked sessions are
reconciled to avoid counting the same usage twice.

## Privacy and safety

Everything stays on your machine. Source transcripts are read-only; nothing is
uploaded. The local store keeps usage metadata, not prompt or response text.

## Limitations

Only usage recorded by supported sources is available. Missing token counts
or task durations cannot be reconstructed. Period filters use calendar-to-date
windows; the activity heatmap and lifetime metrics remain all-time.

## Custom source mappings

Settings includes a JSON editor for adding sources and configuring field mappings
for custom JSONL transcripts.

## Development

```sh
npm test --prefix herdr-insights
npm run check --prefix herdr-insights
```

To uninstall the mod while keeping usage data:

```sh
npm run uninstall:local --prefix herdr-insights
```
