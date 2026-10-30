# Insights for Herdr

Insights is a local-first Herdr mod for reading coding-agent token usage from the
transcripts already on your machine, then showing the result as a calm native
dashboard. It reads Pi, Claude Code, and Codex session files; it does not call a
service, upload a transcript, or estimate token counts from prompt text.

The package is private, uses zero dependencies, and runs on Node >=22. The Herdr
UI is native gpui-kit, not HTML or a web view.

## Install

Requirements: a current Herdr app and Node >=22. No `npm install` is needed;
the package has no dependencies.

```sh
npm test --prefix herdr-insights
npm run check --prefix herdr-insights
npm run install:local --prefix herdr-insights
```

The installer copies only the distributable `mods/insights/` tree to
`<HERDR_APP_HOME>/mods/insights/`, where `HERDR_APP_HOME` defaults to
`~/.config/herdr-app`. It creates `<HERDR_APP_HOME>/data/insights/` for the
collector's single store and does not create or edit layouts, keys, settings,
shipped mods, or an existing `data/insights/insights.json`.

It then runs, without a shell:

```sh
herdr-app check <HERDR_APP_HOME>/mods/insights
```

After a passing check, open the dashboard in the current space with:

```sh
npm run install:local --prefix herdr-insights -- --open
```

which runs `herdr-app do tab.new` with the JSON argument
`{"name":"Insights","mod":"insights"}`. The mod has `"place": "none"`, so the
installer does not dock it into a shipped layout or bind a key.

Useful installer options:

```sh
node herdr-insights/scripts/install.mjs --help
node herdr-insights/scripts/install.mjs --app-home /path/to/herdr-app
node herdr-insights/scripts/install.mjs --source /path/to/package --force
node herdr-insights/scripts/uninstall.mjs --app-home /path/to/herdr-app
```

`--source` is a development override for a checked-out package folder containing
`mods/insights/`. `--force` replaces owned files that were edited locally; it
never overrides an unowned collision or a symbolic link. Set `HERDR_APP_BIN` only
when the Herdr CLI is not on `PATH` (the default is `herdr-app`).

The optional uninstaller reads `data/insights/install-manifest.json`, removes only
unchanged owned files, and leaves edited files, unowned files, `insights.json`,
and the rest of the app home alone.

## What it shows

- A centered profile (name, optional handle, optional avatar).
- A five-metric strip: lifetime tokens, peak-day tokens, longest observed task,
  longest streak, and current streak.
- A GitHub-style 53-week heatmap with seven local-day rows, month labels, and
  daily / weekly / cumulative modes.
- Filters for harness, provider, model, project, and period (week, month, year,
  all), with a sensible year selector.
- A ranked model/provider leaderboard with total tokens, share, and change
  versus the previous equivalent period. Grouping can switch between models and
  providers, and rows expand to input, output, cache, and reasoning detail.
- Source scan status, empty, loading, and error states. Errors are useful and
  never include raw transcript content.
- Profile, source, and settings views with saved configuration.

The live UI never uses fabricated demo data. Loading and empty states are
explicit.

## Configuration

The collector validates the complete config object before applying it. The
current contract shape is:

```json
{
  "profile": { "name": "Developer", "handle": "", "avatar": "" },
  "palette": "blue",
  "includeCache": true,
  "weekStartsOn": 0,
  "refreshSeconds": 60,
  "sources": [
    {
      "id": "pi",
      "label": "Pi",
      "adapter": "pi",
      "enabled": true,
      "roots": ["~/.pi/agent/sessions"]
    },
    {
      "id": "claude",
      "label": "Claude Code",
      "adapter": "claude",
      "enabled": true,
      "roots": ["~/.claude/projects"]
    },
    {
      "id": "codex",
      "label": "Codex",
      "adapter": "codex",
      "enabled": true,
      "roots": ["~/.codex/sessions", "~/.codex/archived_sessions"]
    }
  ]
}
```

- `palette`: `blue`, `green`, or `purple`.
- `includeCache`: include cache read/write in displayed totals.
- `weekStartsOn`: `0` for Sunday or `1` for Monday.
- `refreshSeconds`: validated 30 through 3600; the UI defaults to 60.
- `sources[].adapter`: the built-in adapter name (`pi`, `claude`, or `codex`).
- `sources[].roots`: transcript directories. A leading `~` is expanded against
  the user's home directory. The collector reads these external directories; it
  does not copy raw transcripts into the store.

The profile, source toggles, roots, and full JSON config can be edited in the
mod. The store path is always
`<HERDR_APP_HOME>/data/insights/insights.json`; keep a single store rather than
one file per source.

## CLI

The mod invokes the collector as an `exec` child process, off the UI thread:

```sh
node <appHome>/mods/insights/collector.mjs snapshot \
  --store <appHome>/data/insights/insights.json \
  --home <home>

node <appHome>/mods/insights/collector.mjs configure \
  --store <appHome>/data/insights/insights.json \
  --home <home> \
  --config '<complete JSON config object>'
```

Both commands print exactly one compact JSON snapshot to stdout. Diagnostics go
to stderr. The UI displays nonzero errors instead of pretending the data is zero.

A normal refresh is incremental. `--rebuild` is available for a deliberate
manual repair, not for every refresh. The collector validates a config before
writing it atomically and invalidates changed adapter or root mappings. No stdin
is required, and JSON is passed as one argv value, never interpolated through a
shell.

The snapshot contains `version`, `generatedAt`, `lastScanAt`, `config`, `rows`,
`stats`, and `warnings`. Rows are aggregated by local day, session, harness,
provider, model, and project; session identity is stable and opaque. Unknown
provider or model fields remain the string `unknown` rather than being guessed.

## Token accounting

Totals are counted usage reported by the harness or provider. Insights does not
tokenize prompts, code, or assistant text and does not estimate tokens from
character counts.

- `tokens.input` is uncached input.
- `tokens.output` includes reasoning tokens.
- `tokens.reasoning` is a subset of output, never added twice.
- `tokens.cacheRead` and `tokens.cacheWrite` are counted once.
- `tokens.total` is `input + output + cacheRead + cacheWrite`.
- A message counts only when the harness reports nonzero usage.
- A source that does not report usage contributes no invented usage.

Some harnesses report provider routing that differs from the model's creator.
Insights keeps the reported routing provider and model; it does not guess the
creator when they differ. The display should treat provider and model as
separate facts.

## Scan model and source semantics

The first scan is cold: it may read the discovered transcript data once, which
is O(data). Later scans are warm: they use file metadata and appends, which is
O(metadata) plus new bytes. Snapshot stats expose `files`, `filesRead`,
`bytesRead`, `unchangedFiles`, and `errors`, so the UI can show what happened.

Source-specific behavior:

- **Pi:** usage records are assistant messages with `message.usage` and
  `message.model` / `message.provider`; the session header supplies `session.cwd`
  and `session.id`.
- **Claude Code:** duplicate streamed messages with the same `message.id` are
  counted once. Cache fields are counted once. Failed or synthetic messages are
  ignored where the transcript marks them that way.
- **Codex:** cumulative counters are converted to deltas. Modern files can
  contain both `token_usage_record` and `event_msg.token_count`; those two views
  must not be double-counted. Legacy records remain supported.

Task duration is grounded in task boundaries when the transcript provides them.
Otherwise Insights uses a conservative, capped turn span, never the whole idle
session lifetime. Treat the duration as an observed lower bound, not wall-clock
time spent by a person, and do not compare harnesses as if their boundaries were
identical.

## Custom source mappings

Custom sources use JSONL and declarative field mappings, not arbitrary
executable JavaScript. The mapping schema, accepted field names, and validation
rules belong to the collector and are validated there. The mod's full JSON config
editor can add a custom source without changing UI code.

The collector's exact custom-mapping schema is not frozen in this package yet.
When it is published, paste the exact schema and examples in this section; do not
invent keys before then. In particular, do not add arbitrary code, shell
commands, or network fetches as a mapping.

## Privacy and safety

- **Local only:** Insights makes no network requests. It has no telemetry and no
  remote service.
- **Reads transcripts:** the collector reads the transcript directories listed in
  config (for example `~/.pi/agent/sessions`, `~/.claude/projects`, and
  `~/.codex/sessions`). Those paths are outside the Herdr app home.
- **Node disclosure:** Herdr runs `node .../collector.mjs` as an `exec` child
  process. That process reads local files and writes the single store atomically.
  It is not a sandbox.
- **No raw content persisted:** prompts, assistant text, code, tool calls, tool
  results, credentials, and full raw records are not stored. Allowed persisted
  data is the stable session identity/hash and numeric usage metadata used for
  deduplication and display.
- **Errors:** error text is useful for diagnosis but never includes raw
  transcripts or credentials.
- **No shell interpolation:** JSON and paths are passed as argv values.

## Install layout and ownership

```text
<HERDR_APP_HOME>/
  mods/insights/                 # copied from this package; owned files
  data/insights/insights.json    # collector's single store; preserved
  data/insights/install-manifest.json  # installer ownership proof and hashes
```

The installer writes a manifest of SHA-256 hashes. On reinstall:

- Owned files that still match the manifest may be replaced atomically.
- Owned files edited locally are refused unless `--force` is explicit.
- Files not recorded in the manifest are unowned collisions and are refused,
  including with `--force`.
- Symbolic links, path traversal, special files, and target directories that are
  links are refused; no write follows a link.
- Files removed from a reviewed source are removed only if they are still
  unchanged; locally edited stale files are kept.
- `data/insights/insights.json` and unrelated data are never replaced.
- No writes go to shipped layouts, `keys.json`, `settings.json`, other mods, or
  the repository root. The package is not registered as a Pi extension and is
  not published.

The ownership manifest lives in the data folder so a clean mod tree can be
reviewed without hiding installer state inside it.

## Limitations

- Transcript schemas change. A harness update can make some records unreadable
  until its adapter is updated; errors are reported rather than guessed.
- Usage that the harness does not report is not invented. There is no tokenizer
  estimate fallback.
- Provider and model values can be routed differently from the model creator.
- Task durations are conservative; exact task boundaries are not present in every
  transcript.
- The heatmap uses local calendar days; timezone changes can move a session
  between adjacent days in the display.
- Custom source mapping documentation is pending the collector schema described
  above.
- The preview image is captured after the native visual check; this package does
  not ship demo rows.

## Development

Tests use temporary synthetic source trees and a fake `herdr-app` executable.
They never read or write the real app home, never install into a user's home, and
do not call the network.

```sh
npm test --prefix herdr-insights
npm run check --prefix herdr-insights
npm run install:local --prefix herdr-insights -- --help
```

The package check validates the private/dependency-free package shape, script
syntax, documentation order, and — when `mods/insights/` is present — the source
tree's `main.js`, `mod.json` with `"place": "none"`, and symlink policy.

## Uninstall

```sh
npm run uninstall:local --prefix herdr-insights
```

This is the safe path: it removes only unchanged files listed in the install
manifest. If an owned file was edited, it stays and the manifest keeps its old
hash so a future install still recognizes the edit. `data/insights/insights.json`
and unowned local files are never removed. Delete the data folder manually only
if you deliberately want to discard the collected store.

## License

MIT.
