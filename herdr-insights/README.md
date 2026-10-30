# Insights

A native [Herdr](https://herdr.dev) dashboard for coding-agent token usage.
See which models you use, how usage changes over time, and your daily activity.
Reads local sessions from **Pi, Codex, Claude Code, and OpenCode**.

![Insights](preview.png)

*Preview uses synthetic data. The installed dashboard only shows recorded usage.*

## Install

Requires Herdr and **Node.js 22.15+**. No dependencies or account needed.

Ask your agent:

> Read https://github.com/GaganSD/pi-extensions/tree/main/herdr-insights and install the Insights mod following its RECIPE.md and my Herdr AGENTS.md.

Or install from a checkout:

```sh
git clone https://github.com/GaganSD/pi-extensions.git
cd pi-extensions
npm run install:local --prefix herdr-insights -- --open
```

The installer runs `herdr-app check`, then opens an **Insights** tab. It installs
only `mods/insights/` under `~/.config/herdr-app`; your layouts, keys, and terminals
are unchanged. Set `HERDR_APP_HOME` to use a different app home.

## Use

- Compare models and providers with period filters and up/down trends.
- Explore a stacked usage chart, daily heatmap, lifetime totals, and streaks.
- Open **Settings** to choose sources, edit paths, toggle cached tokens, or
  change the palette and refresh interval.

Periods are calendar-to-date. Model filters affect the chart and leaderboard;
activity history and lifetime metrics stay all-time. Counts come from recorded
usage, not estimates; missing usage or durations cannot be reconstructed.

## Privacy

No network requests or uploads. The mod runs a local Node helper, reads session
files and OpenCode's SQLite database, and writes usage metadata to
`~/.config/herdr-app/data/insights/insights.json`. It does not store prompt or
response text or modify source transcripts.

## Development

[RECIPE.md](RECIPE.md) describes the mod's behavior, architecture, and rebuild
requirements. The distribution folder is `herdr-insights`; its native mod ID is
`insights` and its display name is **Insights**. No layouts or key bindings ship.

```sh
npm test --prefix herdr-insights
npm run check --prefix herdr-insights
```

Uninstall while keeping usage data:

```sh
npm run uninstall:local --prefix herdr-insights
```
