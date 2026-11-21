# Slate benchmarks

Slate draws a lot on top of Pi: a live sidebar, tool cards, diff previews, an animated composer. None of that should cost you a smooth scroll. These benchmarks measure what Slate adds to Pi's renderer, using real Pi in a real pseudo-terminal, so regressions show up as numbers rather than as a bug report that says "my window turns into a slideshow."

Everything here is synthetic and offline: no API keys, no model calls, and no data from your own sessions.

## Headline: scrolling a 3,000-entry session

Fullscreen Pi 1.6.0, 200×50 terminal, every Slate surface on, Slate set to render the full history (`messageLength: "all"`). We sent 400 wheel-up events followed by 400 wheel-down events, one every 5 ms. Values are medians of 3 runs on an Apple M2 (8 GB) with Node 24.

| | Native Pi | Slate 0.3.0 | Slate, this branch |
|---|---:|---:|---:|
| Frames painted for 800 wheel events | 298 | **73** | **297** |
| Slowest frame | 9 ms | **868 ms** | **14 ms** |
| 95th-percentile frame | 5.2 ms | **838 ms** | **9.2 ms** |
| CPU time for both wheel bursts | 1.31 s | **8.39 s** | **2.17 s** |
| CPU time over 5 s of doing nothing | 0.00 s | **4.55 s** | **0.03 s** |
| Full transcript re-renders while idle (5 s) | 0 | 5 | 0 |
| Full transcript re-renders while scrolling | 0 | 8 | 0 |

In 0.3.0, Pi could only paint 73 frames for 800 wheel notches, because each frame waited behind a ~850 ms full re-render of the transcript. That's the slideshow. Now Slate keeps up with native Pi frame-for-frame.

### Why it was slow

Pi 1.6 has two kinds of frame:

- A **view frame** is what scrolling triggers (`requestViewRender`). Pi reuses each component's output from the previous frame, so the cost scales with the screen, not the history.
- A **content frame** is triggered by any `requestRender()`. It re-renders every component in the transcript, so the cost scales with the history.

Slate 0.3.0 asked for content frames when nothing in the transcript had changed:

1. **The 1 Hz sidebar clock** called `requestRender()` every second, even when the sidebar looked identical.
2. Sidebar session/resource updates, the Git branch poller and the composer's working animation (every 120 ms) did the same.
3. Each diff preview finishing its background syntax highlighting triggered its own re-render. On a large session that's dozens of full re-renders right after opening it.
4. Each content frame was also slow: tool cards re-truncated every line of every card on every frame instead of reusing unchanged rows.

The fix makes Slate request only the frame it needs:

- The sidebar compares its painted rows and repaints only itself when they change. It swaps a fresh sidebar leaf into its own split so Pi's view-frame cache misses only the sidebar.
- Pollers stay quiet when nothing visible changed.
- The working animation follows Pi’s working indicator. A hidden or static host indicator supplies no animation clock, so Slate leaves that status unchanged.
- Diff highlighting is lazy and batched.
- Tool cards cache their rows.

On Pi 1.4 and 1.5, which lack the view-frame path, Slate falls back to a full render, and only when something visible changed.

## Full matrix

The same 3,000-entry session at both sidebar tiers: full at 200×50, compact at 120×40. The variants:

- **`native`**: Pi without Slate.
- **`slate`**: Slate's shipped defaults, including the 100-message transcript window.
- **`slate-matched-history`**: all surfaces with `messageLength: "all"`. This renders the same history depth as native Pi, so it's the fair comparison.
- **`slate-no-sidebar`** and **`slate-no-toolcards`**: one surface switched off, to attribute cost to it.

The "Wheel CPU" column is the total for both bursts.

| Terminal | Variant | Idle CPU (5 s) before → after | Wheel CPU before → after | Slowest frame before → after | Full re-renders (idle + scroll) before → after |
|---|---|---:|---:|---:|---:|
| 200×50 | native | 0.00 → 0.00 s | 1.63 → 1.31 s | 15 → 9 ms | 0 → 0 |
| 200×50 | slate | 0.32 → 0.04 s | 2.29 → 2.22 s | 36 → 13 ms | 12 → 0 |
| 200×50 | slate-matched-history | 4.55 → 0.03 s | 8.39 → 2.17 s | 868 → 14 ms | 13 → 0 |
| 200×50 | slate-no-sidebar | 0.04 → 0.01 s | 1.13 → 1.29 s | 25 → 9 ms | 2 → 0 |
| 200×50 | slate-no-toolcards | 0.31 → 0.05 s | 2.07 → 1.92 s | 45 → 13 ms | 13 → 0 |
| 120×40 | native | 0.01 → 0.00 s | 1.22 → 1.28 s | 15 → 11 ms | 0 → 0 |
| 120×40 | slate | 0.32 → 0.04 s | 1.88 → 1.79 s | 70 → 59 ms | 13 → 0 |
| 120×40 | slate-matched-history | 4.28 → 0.03 s | 6.08 → 1.56 s | 701 → 10 ms | 12 → 0 |
| 120×40 | slate-no-sidebar | 0.04 → 0.02 s | 1.19 → 1.09 s | 17 → 12 ms | 2 → 0 |
| 120×40 | slate-no-toolcards | 0.18 → 0.05 s | 1.78 → 1.55 s | 25 → 13 ms | 13 → 0 |

Native rows differ between columns only by run-to-run noise. Expect ±15% on CPU and a few ms on the slowest frame between runs on the same machine. "Before" is Slate 0.3.0 (`06b2a93`). "After" is the same commit plus this branch's uncommitted changes, which is why the results file marks it `slate_extensions_dirty: true`.

The shipped-default `slate` row barely moves on wheel CPU. Its 100-message window already kept content frames cheap, so its win is the idle CPU and the absence of periodic hitches. The more history you render, the bigger the gap was.

## What is still slower than native

With the sidebar showing, an ordinary scroll frame costs about **2× native Pi**: ~6 ms vs ~3 ms at 200×50. This cost is in Pi, not Slate:

- In pi-tui's `paintBox`, the fast path (copy the line as-is) only applies to boxes that span the full terminal width.
- Once the chat sits in a column beside the sidebar, every visible row goes through `compositeTuiLine`, which re-parses ANSI and graphemes to splice the two columns together.
- Turn the sidebar off and Slate scrolls at native speed (`slate-no-sidebar`).

The fix belongs upstream. Pi could add a fast path for a box at column 0 painting an untouched row, and then append the next box when it starts at the row's current visible width. That's on our list to propose to Pi.

Slate also writes about 1.7× more bytes per frame than native Pi at 200×50 (~22 KB vs ~13 KB), mostly the sidebar's colored rows. That doesn't affect Pi's CPU, but terminals that are slow at taking in output, such as Windows Terminal through ConPTY, pay for it.

## Run it yourself

You need macOS or Linux, Python 3.8+, and Pi installed globally (`npm i -g @earendil-works/pi-coding-agent`). Alternatively, point `PI_CLI` at Pi's `dist/bundle/cli.js`. Run these from `pi-slate/`.

The full matrix takes about 8 minutes:

```bash
npm run bench:scroll
```

A quick single case:

```bash
npm run bench:scroll -- --size small --runs 1 --variants native slate --terminals 200x50
```

To compare two runs, for example before and after a change:

```bash
npm run bench:scroll -- --compare benchmarks/results/<old>/results.json benchmarks/results/<new>/results.json
```

To find out who requested full re-renders, and where the CPU goes:

```bash
npm run bench:scroll -- --size medium --runs 1 --variants slate --terminals 200x50 --stacks --cpu-prof
```

| Option | Meaning |
|---|---|
| `--size small\|medium\|large` / `--entries N` | Session size: 200, 1,000 or 3,000 entries, or exactly N |
| `--seed N` | Fixture seed (default 42). Same seed gives the same session, byte for byte |
| `--runs N` | Repeats per case (default 3). Each metric is the median across repeats |
| `--variants …` | Any of `native slate slate-matched-history slate-no-sidebar slate-no-toolcards` |
| `--terminals …` | `200x50` (full sidebar tier) and/or `120x40` (compact tier) |
| `--capture` | Save the raw startup terminal stream for each case's first run |
| `--stacks` | Record call stacks of full re-render requests. Adds overhead, so use it for diagnosis only |
| `--cpu-prof` | Save V8 CPU profiles and print the top functions |

Each run writes `benchmarks/results/scroll-<timestamp>/`, which is git-ignored:

- `results.json`: every metric for every run, plus the workload and attestations.
- `results.md`: detailed tables.
- `summary.md`: aggregates with no local paths, safe to paste into an issue.

## How it works

1. **Fixture.** `scroll/generate.mjs` writes a seeded Pi session. It has user prompts, long Markdown answers, thinking blocks, runs of `bash`/`read`/`grep`/`ls` calls, failed tools, and `edit`/`write` results carrying Slate diff previews, so Shiki highlighting runs as it would in real use.
2. **Isolation.** Each run gets a fresh temp home, agent dir, session dir and cwd. Pi runs offline with version checks, telemetry, MCP and discovery off. The child's `PATH` excludes your real Pi agent directory. Nothing from `~/.pi` is read.
3. **Driver.** `scroll/drive.py` starts fullscreen Pi in a PTY with only the Python standard library. It waits until startup work has settled: first paint, Pi's grammar preload, Slate's diff highlighting, and 750 ms of quiet. Then it measures:
   - 5 s of idle.
   - 400 SGR wheel-up events.
   - 400 wheel-down events.

   Wheel scrolling is pinned to one line per event. Each case must have at least 400 scrollable lines; if a custom fixture is too short, increase `--size` or `--entries`.
4. **Probe.** `scroll/probe/index.ts` is a zero-height Pi widget that times every frame. It classifies frames as view or content by reading Pi's `contentChanged` flag. It also verifies that the expected Slate surfaces are actually mounted and that the transcript really moved 400 lines each way, so the run fails rather than silently benchmarking the wrong thing.
5. **Metrics.** For every phase it records:
   - frame count, and how many were view frames vs content frames;
   - mean, p50, p95 and max frame time;
   - process CPU (`/proc` on Linux, `ps` on macOS);
   - bytes written to the terminal per frame.

[`scroll/NOTES.md`](scroll/NOTES.md) has the full methodology.

### Limits

- **Frame time is Pi's own render time.** It doesn't include how long your terminal emulator takes to draw the output. Windows Terminal isn't measured, and its ConPTY layer adds per-byte cost, which makes Slate's extra bytes per frame matter more there.
- **The probe reads private Pi internals** (`doRender`, `contentChanged`, the primary scroll view). It's written to fail loudly when Pi changes them, and it'll need updating when that happens.
- **CPU attribution at phase boundaries is approximate.** Compare runs from the same machine and the same Pi and Node builds. Absolute numbers on other hardware will differ.

## Micro-benchmarks

Two smaller benchmarks render components directly, without a terminal:

- `tool-groups.ts`: renders grouped tool calls at 100 and 1,000 children.

  ```bash
  node --experimental-strip-types benchmarks/tool-groups.ts
  ```

- `sidebar-cache.ts`: Pi's real renderer plus Slate's sidebar split, checking that the split doesn't thrash the transcript's render cache. See its header for options.
