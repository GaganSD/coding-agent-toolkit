# Insights

A native [Herdr](https://herdr.dev) dashboard for coding-agent token usage.
See which models you use, how usage changes over time, and your daily activity.
Reads local sessions from **Pi, Codex, Claude Code, and OpenCode**.

<img width="1204" height="538" alt="Tokens history" src="preview-history.png" />

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

With Herdr running, the installer checks the `insights` mod and adds an
**Insights** button beside the native tabs; clicking it reuses the current
space's dashboard tab, opening one only when absent. It installs `mods/insights/`
and records ownership in `data/insights/`. Shipped files, tabs, keys, terminals,
and usage data are unchanged. See [INSTALL.md](INSTALL.md) for the layout and
click-state rules. Set `HERDR_APP_HOME` to use a different app home.

## Use

- Compare models and providers with period filters and up/down trends.
- Explore a stacked usage chart, daily heatmap, lifetime totals, and streaks.
- Open **Settings** to choose sources, edit paths, toggle cached tokens, or
  change the palette and refresh interval.

## Long scans and recovery

- A foreground refresh is a bounded slice. When work remains it returns
  committed data, the dashboard keeps rendering, and the view automatically
  continues. Herdr's exec timeout is unchanged.
- A giant non-seekable zstd archive that cannot finish in one slice continues
  in one managed local detached Node worker. Polling never restarts it. There
  is no fabricated compressed-offset resume; after a crash the unfinished
  archive and any uncheckpointed batch are replayed, while completed files stay
  committed.
- `prepare` and status reads use a metadata-only cache plus sanitized live progress
  (current file, decoded bytes, counters). Only a matching live local worker
  claim and writer lock at the same generation may publish it; rows, config,
  and accounting always come from committed state.
- `savedAt`/`lastScanAt` is the last persisted write; `lastCompletedScanAt` is
  the last fully completed scan. A saved partial scan is not a completed scan.
- Locks fail closed. Empty, foreign, or legacy lock state is never age-evicted
  automatically. Clean up manually only after proving no writer is running;
  `lock.acquire-*`/quarantine leftovers are inactive, but recheck before
  deleting anything.
- Node.js 22.15+ is required.

## Privacy

No network requests or uploads. The mod runs a local Node helper, reads session
files and OpenCode's SQLite database, and writes usage metadata to
`~/.config/herdr-app/data/insights/insights.json`. It does not store prompt or
response text or modify source transcripts.

## Development

One native mod, `mods/insights`, provides both views. A pane whose content is
`{mod: "insights", props: {mode: "toolbar"}}` renders only the button; any other
pane shows the dashboard. Toolbar mode starts no Node helper, scans, tasks,
timers, or editors. No layouts or key bindings ship; the button lives in a
personal layout clone composed by the installer, which wraps the native tabs
without modifying them (see [INSTALL.md](INSTALL.md)).

[RECIPE.md](RECIPE.md) is the self-contained rebuild brief required by Herdr.
Developer tests, fixtures, and release validation live outside this distribution;
see the repo's [development guide](../docs/herdr-insights-development.md). They are
not installation steps.

### Reproducible performance benchmark

The opt-in benchmark uses only synthetic sessions and never reads a real home:

```sh
node scripts/herdr-insights/benchmark.mjs
```

It starts three fresh presenter processes per case and records medians plus peak
RSS, source/store/payload bytes, filesRead, bytesRead, structuredClone counts,
and every gate in `research/issue-109/round2-perf-benchmark.json` (gitignored).
Cases cover 1,000 and 10,008 unique compressed Codex sessions cold and warm, a
single 250,000-event session, and 50MiB/500MiB plain and zstd payloads with fixed
usage cardinality. It also checks cached `status` latency while a stream-throttled
worker indexes. The benchmark is a development measurement, not native Herdr
proof and not a Node 22 compatibility certification; see the artifact's pending
gates for that separate work.
