# Scroll benchmark notes

Run the commands on this page from `pi-slate/`. See the [benchmark guide](../README.md) for requirements and results.

## Compare extension builds

To test released packages, unpack them in a local cache. Do not install them in your Pi agent directory.

```sh
cache=../benchmarks/pi-slate/.cache
mkdir -p "$cache/slate-0.4.0" "$cache/starline"
(
  cd "$cache"
  npm pack pi-slate@0.4.0 pi-starline@0.13.0
  tar -xzf pi-slate-0.4.0.tgz -C slate-0.4.0 --strip-components=1
  tar -xzf pi-starline-0.13.0.tgz -C starline --strip-components=1
  (cd slate-0.4.0 && npm install --omit=dev --ignore-scripts)
  (cd starline && npm install --omit=dev --ignore-scripts)
)
npm run bench:scroll -- --scenario busy --size large --runs 3 --allow-dropped-input \
  --slate-fresh --terminals 200x50 120x40 --variants native slate-0.4.0 slate starline \
  --extension-path slate-0.4.0 "$cache/slate-0.4.0" \
  --extension-path starline "$cache/starline"
```

Use `--scenario idle` to test scrolling when Pi is idle. Use one `--extension-path VARIANT DIR` option for each build that needs a custom path. The variants `slate-0.4.0`, `slate-main-before`, and `starline` require paths.

The driver records the extension path, package name, version, and SHA-256 fingerprint. Pi supplies the Pi dependencies for Starline. The probe checks that Starline uses its editor and installs no Slate surfaces.

## Session and settings

- The fixture is a seeded Pi v3 JSONL session. It contains tool calls, diffs, thinking rows, and Markdown. The hash excludes the temporary path in the header.
- Each run uses a new working directory, home directory, agent directory, and session directory. The child does not use the real agent directory.
- The driver starts Pi offline. It disables version checks, telemetry, discovery, and MCP. Pi does not run tool calls recorded in the fixture.
- Pi uses fullscreen mode, truecolor, a fixed theme, and one line of scroll per wheel event.
- The standard Slate variants enable the transcript surface and use the package's default message limit. Use `slate-matched-history` to compare full history with native Pi.
- Use `--slate-fresh` to leave `pi-slate.json` absent for `slate`, `slate-0.4.0`, and `slate-main-before`. In this mode, the transcript window is off and the sidebar starts hidden.
- The report records transcript ownership and the configured limit separately from the active chat adapter and its output.
- The sidebar uses the full layout at `200x50` and the compact layout at `120x40`. The `slate-no-toolcards` variant disables tool cards and the transcript window.

## Startup and readiness

1. The driver measures time, CPU use, and PTY bytes through the first complete synchronized paint. This paint can occur before the transcript and probe are ready.
2. The driver waits for the transcript paint, Markdown grammar preload, and pending diff highlights. It then waits for 750 ms with no new startup render or diff work.
3. The probe checks the mounted Slate surfaces and the history limit at the current layout width. It does not start diff highlighting.
4. The run stops if Pi is not ready before `--readiness-timeout`. The default is 30 seconds.

Startup measurements do not use a cold cache. Use `--capture` to save terminal output through the first complete transcript paint in mouse mode.

## Scroll measurements

- The transcript starts at the bottom and must have at least 400 scrollable lines. The driver measures idle time for five seconds.
- The driver sends 400 wheel-up events, then 400 wheel-down events. It uses column 40, row 20, with a nominal 5 ms between events and 1 second to settle after each burst.
- The probe counts lines that reach the primary scroll view, including lines clipped at a boundary. The driver reports lost wheel input separately from viewport displacement.
- The run stops if a burst loses input. Use `--allow-dropped-input` to record the loss instead. The idle scenario rejects changes to the scroll range even with this option.
- The measured burst time includes input delays when the PTY cannot accept more data.
- The probe reads Pi render state to classify view and content frames. It measures render time with `performance.now()`. It does not measure terminal emulator drawing or input latency.
- The driver assigns CPU and PTY bytes to phases approximately. It uses the nearest-rank method for p95. The report calculates medians across repeats, excluding missing values.

## Busy scenario

Use `--scenario busy` to start an offline reply before the first wheel event. The provider emits hidden thinking during wheel-up. During wheel-down, it finishes thinking, calls a local test tool, and streams the answer.

The provider targets one update every 30 ms. The driver checks that thinking ends and the tool starts during wheel-down. It also checks tool completion and updates in both directions. The scroll range can change while new text arrives. The probe checks movement against the bounds at each event.

## Compare results

Reports are in `benchmarks/pi-slate/results/scroll-*/`. Use `--compare old.json new.json` to compare matching terminal, variant, history mode, and workload settings. Use reports with the same readiness policy, extension paths and fingerprints, and `--slate-fresh` setting.

To compare different extension builds, use different variants and run them together. Use the same Pi, Node.js, and hardware. Do not use `--stacks` or `--cpu-prof` for timing comparisons. These options add work and can record local paths.

## Test wheel input

From the repository root, run:

```sh
python3 -m unittest discover -s benchmarks/pi-slate/scroll
```

Set `SLATE_BENCH_TEST_PTY=1` to include a real Pi run that omits four events in each direction. The probe checks Pi and Slate internals. Update the probe if its checks fail after those internals change.

If the PTY write times out during a busy run, try the compact matched-history case first:

```sh
npm run bench:scroll -- --size large --capture --terminals 120x40 200x50 \
  --variants slate-matched-history native slate slate-no-sidebar slate-no-toolcards
```
