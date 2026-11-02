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

With Herdr running, the installer checks both mods and adds **Insights** beside
**Files / Changes**; each click opens a new Insights tab. It installs
`mods/insights/` and `mods/insights-launcher/`, records ownership in
`data/insights/`, and creates a personal layout clone for the button. Shipped
files, keys, terminals, and usage data are unchanged. See [INSTALL.md](INSTALL.md)
for the layout and click-state rules. Set `HERDR_APP_HOME` to use a different app home.

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
The distribution folder is `herdr-insights`; its dashboard mod ID is `insights`
and its display name is **Insights**. `insights-launcher` is a separate, native
toolbar button using only `theme()` and `run("tab.new", ...)`; it has no polling,
helper process, or overlays. No layouts or key bindings ship; the button lives in
a personal layout clone composed by the installer (see [INSTALL.md](INSTALL.md)).

Developer tests, fixtures, and release validation live outside this distribution;
see the repo's [development guide](../docs/herdr-insights-development.md). They are
not installation steps.

With Herdr running, uninstall while keeping usage data and returning to the
original layout:

```sh
npm run uninstall:local --prefix herdr-insights
```
