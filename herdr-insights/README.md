# Insights for Herdr

Insights is a local-first Herdr mod for reading coding-agent token usage from the
transcripts already on your machine, then showing the result as a calm native
dashboard. It reads Pi, Claude Code, and Codex session files; it does not call a
service, upload a transcript, or estimate token counts from prompt text.

The package is private, has ZERO dependencies, and runs on Node >=22.15. The
Herdr UI is native gpui-kit, not HTML or a web view.

## Install

Requirements: a current Herdr app and Node >=22.15. No `npm install` is needed;
the package has no dependencies. Node >=22.15 is required for the collector's
zstd support.

```sh
npm test --prefix herdr-insights
npm run check --prefix herdr-insights
npm run install:local --prefix herdr-insights
```

The installer copies the distributable `mods/insights/` tree to
`<HERDR_APP_HOME>/mods/insights/`, where `HERDR_APP_HOME` defaults to
`~/.config/herdr-app`, then generates
`<HERDR_APP_HOME>/mods/insights/runtime.json`. It creates
`<HERDR_APP_HOME>/data/insights/` for the collector's store and installer
manifest. It does not create or edit layouts, keys, settings, shipped mods, or an
existing `data/insights/insights.json`. Transcript source roots are only read by
the collector; neither the installer nor the collector changes them.

The generated runtime file is small JSON:

```json
{ "node": "/absolute/path/to/the/node/that/ran/install" }
```

The UI reads it once and executes the collector with that Node binary, so
Herdr's `exec` PATH may point at an older Node without breaking the collector.
The installer never changes PATH. Any `runtime.json` in the source tree is
ignored and replaced with this generated file; a source symlink is still rejected
by source validation.

If you copy `mods/insights/` manually instead of using the installer, create
`runtime.json` yourself with an absolute Node >=22.15 path, or omit it to use
`node` from PATH (which must then be >=22.15). Do not point runtime at an older
Node; the collector imports Node's zstd support.

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

- A centered profile with an 84px avatar (or initials fallback), name, and
  optional handle. The name, handle, and avatar fields are always editable; a
  dirty profile shows a Save profile action, and settings can save the same
  fields. Avatar paths are app-relative; remote URLs are not fetched.
- A five-metric strip: lifetime tokens, peak-day tokens, longest observed task,
  longest streak, and current streak. A missing or zero task duration displays
  as a dash rather than an invented value. Current streak gives yesterday
  grace: a streak whose last active day was yesterday is still current today.
- A 53-week, seven-row heatmap of local calendar days with month labels and
  daily / weekly / cumulative modes. Weekly mode repeats the full week's total
  on each day of that week. Cumulative mode is the all-time running total
  through each day. Future cells are dimmed and are not clickable.
- Filters for source, provider, model, and project, plus period (week, month,
  year, all) and a year selector for year periods. The project filter lists the
  top 250 projects by tokens; an already selected project remains selected even
  if it falls outside that list.
- A ranked model/provider leaderboard with total tokens, share, and change
  versus the previous calendar period. Grouping switches between models and
  providers. Rows are summary-only; they do not expand.
- A token breakdown and scan status for the selected period, with per-source
  status and warnings. Loading, empty, and error states are explicit.
- Settings with profile fields, source toggles and root editors, palette, week
  start, cache inclusion, refresh interval, and a full JSON config editor.
  Toggles mutate only their own fields and preserve custom source mappings.

Periods are calendar-to-date windows: the current week runs from its configured
start through today, the current month from the first through today, and the
current year from January 1 through today (a past year is complete). The
comparison uses the same calendar portion of the previous week, month, or year.
Month-end clamping applies when the previous month is shorter, so a March 31
month-to-date is compared with February 1 through February 28 (or 29). The All
period has no previous period.

The live UI never uses fabricated demo data. Loading and empty states are
explicit.

## Configuration

`configure` accepts a partial top-level config object. Omitted top-level fields
are filled from defaults, and the normalized config is written to the store.
Unknown fields at any level are rejected. If `sources` is supplied, each source
object must be complete; `enabled` defaults to `true`.

The default normalized shape is:

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

- `profile.name`, `profile.handle`, and `profile.avatar` are strings. The handle
  is stored without a leading `@`. An avatar is an app-relative path such as
  `mods/insights/avatar.png`; URLs, absolute paths, and traversal are rejected.
- `palette`: `blue`, `green`, or `purple`.
- `includeCache`: include cache read/write in displayed totals and heatmap
  intensity. The collector's row totals always include cache; this setting
  controls the UI totals.
- `weekStartsOn`: `0` for Sunday or `1` for Monday.
- `refreshSeconds`: integer 30 through 3600; the UI defaults to 60.
- `sources[].id` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` and be unique.
- `sources[].label` is non-empty; `adapter` is `pi`, `claude`, `codex`, or
  `custom`; `roots` is an array of non-empty paths; `enabled` is boolean.
- `sources[].roots`: transcript directories. A leading `~` is expanded against
  the user's home directory. The collector reads these external directories; it
  does not copy raw transcripts into the store and never writes to them.
- `sources[].mapping` is only valid for the custom adapter. Built-in adapters
  reject it.

The store path is always `<HERDR_APP_HOME>/data/insights/insights.json`; keep a
single store rather than one file per source. The installer manifest is a
separate file at `<HERDR_APP_HOME>/data/insights/install-manifest.json`.

## CLI

The mod invokes the collector as an `exec` child process, off the UI thread:

```sh
node <appHome>/mods/insights/collector.mjs snapshot \
  --store <appHome>/data/insights/insights.json \
  --home <home>

node <appHome>/mods/insights/collector.mjs configure \
  --store <appHome>/data/insights/insights.json \
  --home <home> \
  --config '{"palette":"green"}'
```

Both commands print exactly one compact JSON snapshot to stdout. Diagnostics go
to stderr. Invalid config exits with code 2 and writes nothing; other failures
exit nonzero. The UI displays nonzero errors instead of pretending the data is
zero.

A normal refresh is incremental. `--rebuild` is available for a deliberate
manual repair, not for every refresh. The collector validates a config before
writing it atomically. A change to any source signature (id, adapter, enabled,
roots, or mapping) invalidates collected rows and rescans; profile, palette,
cache, week-start, and refresh-only changes keep the rows. The accepted config
is persisted before scanning, so a scan failure can still leave the new sources
visible in the UI with an error.

Operations on one store are serialized by a lock file. An unchanged scan does
not rewrite the store, so the store's size and mtime stay unchanged. No stdin is
required, and JSON is passed as one argv value, never interpolated through a
shell.

## Snapshot

The snapshot contains `version` (1), `generatedAt`, `lastScanAt`, `config`,
`rows`, `stats`, `sourceStats`, and `warnings`. Rows are aggregated by local day,
session, harness, provider, model, and project. Each row has
`tokens.input`, `tokens.output`, `tokens.cacheRead`, `tokens.cacheWrite`,
`tokens.reasoning`, `tokens.total`, `messages`, `activeMs`, and `longestTaskMs`.
Session identity is stable and opaque to the UI. Unknown provider or model
fields remain the string `unknown` rather than being guessed.

`stats` reports `files`, `filesRead`, `bytesRead`, `unchangedFiles`, and
`errors` for the scan. `sourceStats` is keyed by source id and each entry has
`status`, `files`, `filesRead`, `bytesRead`, and `errors`:

- `disabled`: the source is disabled.
- `missing`: no configured root was available.
- `empty`: at least one root was available but no transcript files were found.
- `ok`: transcript files were found and read without source errors.
- `error`: a source-level read or parse error was recorded.

Scan warnings are source-tagged as `[source-id] ...`. A missing root is a warning
and produces `missing` status; it is not a fatal scan error. A corrupt-store
warning is global because it is not attributable to a source.

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
creator when they differ. The display treats provider and model as separate
facts.

## Scan model and source semantics

The first scan is cold: it may read the discovered transcript data once, which
is O(data). Later scans are warm: they use file metadata and appends, which is
O(metadata) plus new bytes. Snapshot stats expose `files`, `filesRead`,
`bytesRead`, `unchangedFiles`, and `errors`, so the UI can show what happened.

Discovery reads `.jsonl` files, plus `.jsonl.zst` for Codex when Node supports
zstd. Roots may be files or directories. Overlapping roots and duplicate inodes
are scanned once. Invalid JSON lines, unreadable files, and oversized lines are
reported as warnings and skipped rather than guessed.

Removing a transcript file or root does not erase its previously collected rows:
`stats.files` reflects the current discovery, while historical rows remain until
an explicit `--rebuild`. A missing root is reported with `missing` status and a
source-tagged warning. Truncating or replacing a file resets that file's
contribution; normal appends continue from the saved offset. The metadata cache
assumes append-only growth, so a same-size in-place rewrite may not be noticed
until a rebuild.

Source-specific behavior:

- **Pi:** usage records are assistant messages with `message.usage` and
  `message.model` / `message.provider`; the session header supplies `session.cwd`
  and `session.id`. Pi sub-agent transcript artifacts are counted with their own
  stable session. Failed assistant records do not close a task.
- **Claude Code:** duplicate streamed messages with the same `message.id` are
  max-upserted, so revised usage fields count once at their largest values.
  Cache fields are counted once. Tool-result and meta user records do not start
  a new task; failed assistant records do not close one.
- **Codex:** modern `token_usage_record` counters win over
  `event_msg.token_count`; the two views are not double-counted. Legacy
  cumulative counters are converted to deltas, including across restarts.
  `task_complete` supplies exact task durations when present.

Task duration is grounded in task boundaries when the transcript provides them:
Claude `turn_duration`, Codex `task_complete`, or a custom `taskDurationMs`.
Otherwise Insights uses a conservative turn span capped at two hours, never the
whole idle session lifetime. A zero or absent duration is unknown and displays
as a dash. Treat duration as an observed lower bound, not wall-clock time spent
by a person, and do not compare harnesses as if their boundaries were identical.

## Custom source mappings

Custom sources use JSONL and declarative field mappings, not arbitrary executable
JavaScript. A custom source has this shape:

```json
{
  "id": "acme",
  "label": "Acme",
  "adapter": "custom",
  "enabled": true,
  "roots": ["~/logs"],
  "mapping": {
    "session": "session.id",
    "timestamp": "ts",
    "messageId": "messageId",
    "project": "cwd",
    "provider": "vendor",
    "model": "model",
    "role": "actor",
    "roles": ["assistant"],
    "include": [{ "path": "record", "equals": "usage" }],
    "usage": {
      "input": "usage.in",
      "output": "usage.out",
      "cacheRead": "usage.cr",
      "cacheWrite": "usage.cw",
      "reasoning": "usage.think"
    },
    "taskDurationMs": "dur",
    "harness": "acme"
  }
}
```

Required mapping fields are `session`, `timestamp`, and `usage`. `usage` must map
at least one of `input`, `output`, `cacheRead`, `cacheWrite`, or `reasoning`.
The remaining fields are optional. Unknown mapping fields are rejected.

A field is one of:

- `"dot.path"`: read an own object key or a numeric array index. Inherited
  properties are not read.
- `{ "path": "dot.path", "default": primitive }`: use the default when the path
  is missing or null.
- `{ "literal": primitive }`: use a fixed string, number, boolean, or null.

`timestamp` accepts an ISO/date string or epoch seconds, milliseconds, or
microseconds, as a number or numeric string. `messageId` deduplicates a record;
when it is absent, the collector uses a hash of the line. `project`, `model`, and
`provider` become `unknown` when omitted; they are never guessed. `harness`
defaults to the source id. `taskDurationMs` is an exact millisecond duration
when present and positive; otherwise duration is unknown (zero).

`role` plus `roles` is optional. When `roles` is given, `role` is required, and a
record is counted only when its resolved role exactly matches one of the listed
strings. `include` is an optional array of conditions; all must pass. Each
condition has a `path` and exactly one of `equals` (a primitive, compared
strictly) or `exists` (boolean).

The usage fields are canonical: `input` is uncached input, `output` includes
reasoning, `reasoning` is a subset of output, and total is derived as
`input + output + cacheRead + cacheWrite`. Values must be finite numbers to
count; nonnumeric or negative values become zero, and a record with no nonzero
usage produces no row. Snapshot config normalizes every mapping path string to
`{ "path": "..." }`.

Example JSONL using the mapping above:

```jsonl
{"record":"usage","session":{"id":"custom-fixture"},"ts":"2026-03-04T04:00:00Z","cwd":"/repo/custom","vendor":"acme","model":"cm","actor":"assistant","messageId":"cm-1","usage":{"in":10,"out":5,"cr":3,"cw":2,"think":1},"dur":2500}
{"record":"usage","session":{"id":"custom-fixture"},"ts":"2026-03-04T04:00:01Z","cwd":"/repo/custom","vendor":"acme","model":"cm","actor":"assistant","messageId":"cm-1","usage":{"in":10,"out":9,"cr":3,"cw":2,"think":2},"dur":2500}
{"record":"usage","session":{"id":"custom-fixture"},"ts":"2026-03-04T04:00:02Z","cwd":"/repo/custom","vendor":"acme","model":"cm","actor":"user","messageId":"cm-user","usage":{"in":99,"out":99,"cr":99,"cw":99,"think":99}}
```

The two `cm-1` records max-upsert to input 10, output 9, cache read 3, cache
write 2, reasoning 2, for an expected total of **24 tokens** and one message.
The `actor: "user"` record is excluded by `roles: ["assistant"]`. The exact task
duration is 2500ms.

## Privacy and safety

- **Local only:** Insights makes no network requests. It has no telemetry and no
  remote service. Avatar paths are local app-relative files, not remote URLs.
- **Reads transcripts:** the collector reads the transcript directories listed in
  config (for example `~/.pi/agent/sessions`, `~/.claude/projects`, and
  `~/.codex/sessions`). Those paths are outside the Herdr app home and are never
  modified.
- **Node disclosure:** Herdr runs `node .../collector.mjs` as an `exec` child
  process. That process reads local files and writes the single store atomically.
  It is not a sandbox.
- **Metadata-only store:** the store contains the normalized config, file paths
  and scan metadata, aggregated rows (day, session identity, harness, provider,
  model, project, numeric usage, message counts, and task durations), and
  deduplication/task keys. Prompts, assistant text, code, tool calls, tool
  results, credentials, and full raw records are not stored.
- **Errors:** error text is useful for diagnosis but never includes raw
  transcripts or credentials. The UI truncates displayed errors.
- **No shell interpolation:** JSON and paths are passed as argv values.

## Install layout and ownership

```text
<HERDR_APP_HOME>/
  mods/insights/                 # installed owned files (source plus generated runtime)
  mods/insights/runtime.json     # generated installer Node path; owned
  data/insights/insights.json    # collector's single metadata store; preserved
  data/insights/install-manifest.json  # installer ownership proof and hashes
```

The installer writes a manifest of SHA-256 hashes. On reinstall:

- Owned files that still match the manifest may be replaced atomically.
- `runtime.json` is always generated from the Node executable running the
  installer and recorded in the manifest. A source copy is not installed. A
  changed installer Node path updates it on reinstall; a locally edited runtime
  is refused unless `--force`, and an unowned runtime collision is refused even
  with `--force`.
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
reviewed without hiding installer state inside it. The collector never writes
the manifest, and the installer never writes the collector's store.

## Limitations

- Transcript schemas change. A harness update can make some records unreadable
  until its adapter is updated; errors are reported rather than guessed.
- Usage that the harness does not report is not invented. There is no tokenizer
  estimate fallback.
- Provider and model values can be routed differently from the model creator.
- Task durations are conservative; exact task boundaries are not present in every
  transcript. A zero duration is unknown and displays as a dash.
- The heatmap uses local calendar days; timezone changes can move a session
  between adjacent days in the display.
- Removed transcript files or roots retain their historical rows until an
  explicit `--rebuild`. A missing root is a warning/status, not a fatal scan.
- The incremental metadata cache assumes append-only growth; a same-size
  in-place rewrite may require a rebuild to be noticed.
- Concurrent collector operations wait up to 20 seconds for the store lock, then
  fail as busy. A lock older than 10 minutes or owned by a dead same-host process
  is reclaimed. A corrupt store is preserved with a `.corrupt-<timestamp>` name,
  a fresh store is started, and a warning plus error count is reported.
- The project filter shows at most the top 250 projects by tokens. The currently
  selected project is retained even when it is outside that list.
- Custom mappings are declarative only: no arbitrary code, shell commands, or
  network fetches.
- Manual installs that omit `runtime.json` fall back to `node` from PATH. That
  Node, like the generated runtime path, must be >=22.15 or the collector can
  fail to load its zstd support.

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
hash so a future uninstall still recognizes the edit. `data/insights/insights.json`
and unowned local files are never removed. Delete the data folder manually only
if you deliberately want to discard the collected store.

## License

MIT.
