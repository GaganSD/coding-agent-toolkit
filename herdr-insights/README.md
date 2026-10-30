# Insights

A native [Herdr](https://herdr.dev) dashboard for coding-agent token usage.
See which models you use, how usage changes over time, and your daily activity.
Reads local sessions from **Pi, Codex, Claude Code, and OpenCode**.

<img width="1204" height="538" alt="image" src="https://github.com/user-attachments/assets/c850bf7f-e94f-49f3-829f-bfdb6e4d3260" />

![Insights](preview.png)

## Install

Ask your agent:
```
Read https://github.com/GaganSD/coding-agent-toolkit/blob/main/herdr-insights/INSTALL.md and install Insights following it.
```

Or install from a checkout:

```sh
git clone https://github.com/GaganSD/coding-agent-toolkit.git
cd coding-agent-toolkit
npm run install:local --prefix herdr-insights
```

The installer runs `herdr-app check` without opening a tab or test window.
Follow [INSTALL.md](INSTALL.md) for the installation steps. Add `-- --open` only
if you want it to open one **Insights** tab. It installs owned files only under
`mods/insights/` and writes its install manifest to `data/insights/` in
`~/.config/herdr-app`; your layouts, keys, and terminals are unchanged. Set `HERDR_APP_HOME` to use a different app home.

## Use

- Compare models and providers with period filters and up/down trends.
- Explore a stacked usage chart, daily heatmap, lifetime totals, and streaks.
- Open **Settings** to choose sources, edit paths, toggle cached tokens, or
  change the palette and refresh interval.

## Privacy

No network requests or uploads. The mod runs a local Node helper, reads session
files and OpenCode's SQLite database, and writes usage metadata to
`~/.config/herdr-app/data/insights/insights.json`. It does not store prompt or
response text or modify source transcripts.

## Development

[RECIPE.md](RECIPE.md) is the self-contained rebuild brief required by Herdr.
The distribution folder is `herdr-insights`; its native mod ID is `insights`
and its display name is **Insights**. No layouts or key bindings ship.

Developer tests, fixtures, and release validation live outside this distribution;
see the repo's [development guide](../docs/herdr-insights-development.md). They are
not installation steps.

Uninstall while keeping usage data:

```sh
npm run uninstall:local --prefix herdr-insights
```
