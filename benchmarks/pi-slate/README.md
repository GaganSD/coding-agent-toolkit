# Slate performance benchmarks

Use this benchmark to compare Slate with native Pi. It measures frame time, CPU time, and wheel input in a pseudo-terminal (PTY). It uses synthetic data and does not call a model over the network.

## Idle scrolling

These results use Pi 1.6.0, Node.js 24, and an Apple M2 with 8 GB of memory. The fullscreen PTY has 200 columns and 50 rows. The session contains 3,000 entries. Slate enables all surfaces and shows the full history.

The driver sends 400 wheel events in each direction, with 5 ms between events. Each value is the median of three runs.

| Metric | Native Pi | Slate 0.3.0 | Slate at `4276ce3` |
|---|---:|---:|---:|
| Frames painted for 800 wheel events | 307 | **76** | **305** |
| Slowest frame | 9 ms | **753 ms** | **14 ms** |
| 95th-percentile frame | 5.1 ms | **751 ms** | **7.4 ms** |
| CPU time for both wheel bursts | 1.56 s | **7.73 s** | **2.30 s** |
| CPU time during 5 s of idle time | 0.00 s | **4.36 s** | **0.03 s** |
| Full transcript re-renders while idle (5 s) | 0 | 5 | 0 |
| Full transcript re-renders while scrolling | 0 | 8 | 0 |

Slate 0.3.0 rendered the full transcript when sidebar, composer, or tool updates did not change it. The fix updates only the parts that change and reuses cached tool rows. Slate drops no wheel input in the recorded runs with the fix.

Pi uses a view frame for scrolling. A view frame can reuse component output. A content frame can render the transcript again. On Pi 1.4 and 1.5, Slate requests a full render only when visible output changes.

### All idle configurations

- `native`: Run Pi without Slate.
- `slate`: Enable all Slate surfaces and show up to 100 transcript messages.
- `slate-matched-history`: Enable all Slate surfaces and show the full history, as native Pi does.
- `slate-no-sidebar`: Disable the sidebar and keep the 100-message transcript window.
- `slate-no-toolcards`: Disable tool cards and the transcript window.

The table compares Slate 0.3.0 (`6386556`) with the fix (`4276ce3`). Frame counts and wheel CPU time cover both directions. Native Pi is the control.

| Terminal | Variant | Frames painted before → after | Idle CPU (5 s) before → after | Wheel CPU before → after | Slowest frame before → after | Full re-renders (idle + scroll) before → after |
|---|---|---:|---:|---:|---:|---:|
| 200×50 | native | 307 → 307 | 0.01 → 0.00 s | 1.56 → 1.56 s | 8 → 9 ms | 0 → 0 |
| 200×50 | slate | 302 → 305 | 0.32 → 0.04 s | 2.49 → 2.43 s | 47 → 16 ms | 12 → 0 |
| 200×50 | slate-matched-history | **76 → 305** | 4.36 → 0.03 s | 7.73 → 2.30 s | **753 → 14 ms** | 13 → 0 |
| 200×50 | slate-no-sidebar | 306 → 306 | 0.03 → 0.01 s | 1.45 → 1.46 s | 25 → 7 ms | 2 → 0 |
| 200×50 | slate-no-toolcards | 307 → 304 | 0.18 → 0.05 s | 2.22 → 2.15 s | 33 → 14 ms | 12 → 0 |
| 120×40 | native | 305 → 308 | 0.01 → 0.00 s | 1.52 → 1.52 s | 6 → 5 ms | 0 → 0 |
| 120×40 | slate | 299 → 303 | 0.31 → 0.03 s | 2.14 → 2.05 s | 56 → 11 ms | 12 → 0 |
| 120×40 | slate-matched-history | **118 → 303** | 3.81 → 0.02 s | 6.10 → 1.99 s | **626 → 9 ms** | 13 → 0 |
| 120×40 | slate-no-sidebar | 305 → 307 | 0.03 → 0.01 s | 1.32 → 1.33 s | 22 → 6 ms | 2 → 0 |
| 120×40 | slate-no-toolcards | 303 → 304 | 0.18 → 0.03 s | 2.00 → 1.93 s | 28 → 10 ms | 12 → 0 |

At 200×50 with the sidebar visible, a scroll frame took about 6.4 ms in Slate and 3.5 ms in native Pi. Pi must combine the transcript and sidebar columns. Slate also wrote about 22 KB per frame, compared with 13 KB for native Pi.

## Scrolling during a reply

These results use Pi 1.6.0, Node.js 24.22.1, and a macOS PTY on an Apple M2. The session contains 3,000 entries. Each value is the median of three runs.

The driver scrolls up during hidden thinking. It scrolls down during a local tool call and streamed text. All runs deliver all 800 wheel events. Frame counts and CPU time cover both directions. The maximum frame time is the median of the slowest frame in each run.

| Terminal | Build | Frames | View / content | p95 ms ↑ / ↓ | Max ms | CPU s |
|---|---|---:|---:|---:|---:|---:|
| 200×50 | Native Pi | 388 | 121 / 266 | 9.1 / 10.2 | 13.9 | 3.10 |
| 200×50 | Slate 0.4.0 | 98 | 1 / 97 | 64.3 / 141.9 | 257.9 | 7.27 |
| 200×50 | Slate fixed | 387 | 122 / 264 | 8.2 / 8.4 | 39.3 | 3.21 |
| 200×50 | 0.4.0, no sidebar | 227 | 34 / 193 | 32.2 / 33.0 | 203.8 | 6.79 |
| 200×50 | Fixed, no sidebar | 385 | 121 / 268 | 6.8 / 6.4 | 37.4 | 2.24 |
| 120×40 | Native Pi | 385 | 121 / 267 | 8.4 / 9.4 | 53.8 | 2.98 |
| 120×40 | Slate 0.4.0 | 106 | 1 / 105 | 59.2 / 78.1 | 202.1 | 7.28 |
| 120×40 | Slate fixed | 385 | 120 / 265 | 7.3 / 7.0 | 25.6 | 2.84 |
| 120×40 | 0.4.0, no sidebar | 259 | 43 / 217 | 25.4 / 28.9 | 165.2 | 6.82 |
| 120×40 | Fixed, no sidebar | 386 | 116 / 270 | 5.7 / 6.6 | 19.6 | 2.23 |

Native Pi shows the full history. Slate with the fix (`2a982cd`) uses its configured transcript window while a reply streams. Slate 0.4.0 (`8d56b31`) removed that limit during a reply, which increased frame time.

## Run the benchmark

Use macOS or Linux, Python 3.8 or later, and Node.js that Pi supports. Install Pi 1.6.0 globally, or set `PI_CLI` to its bundled `cli.js`. Install the pi-slate dependencies before you run the benchmark.

From the repository root, run the full matrix. Allow approximately eight minutes:

```sh
npm run bench:scroll --prefix pi-slate
```

For a quick test, select one terminal size and one run:

```sh
npm run bench:scroll --prefix pi-slate -- --size small --runs 1 --variants native slate --terminals 200x50
```

To scroll during a reply, select the busy scenario:

```sh
npm run bench:scroll --prefix pi-slate -- --scenario busy --variants native slate slate-no-sidebar
```

To compare completed runs, give the driver the two JSON reports:

```sh
npm run bench:scroll --prefix pi-slate -- --compare path/to/old/results.json path/to/new/results.json
```

| Option | Function |
|---|---|
| `--size small\|medium\|large` or `--entries N` | Use 200, 1,000, or 3,000 entries, or set the count to N. |
| `--seed N` | Set the seed. Use the same seed to make the same session. The default is 42. |
| `--runs N` | Set the number of runs per case. The default is 3. |
| `--scenario idle\|busy` | Scroll when Pi is idle or during an offline reply. The default is idle. |
| `--variants …` | Select one or more configurations from the list above. |
| `--terminals …` | Select `200x50`, `120x40`, or both. |
| `--capture` | Save startup output for the first run of each case. |
| `--stacks` | Record call stacks for full render requests. Use this option only to find the cause of a fault. |
| `--cpu-prof` | Save V8 CPU profiles and show the functions that use the most CPU time. |
| `--allow-dropped-input` | Record missing wheel events without stopping the run. Use this option in both runs that you compare. |

The driver writes reports to `benchmarks/pi-slate/results/scroll-<timestamp>/`:

- `results.json`: Per-run measurements, medians, and test configuration.
- `results.md`: Full result tables.
- `summary.md`: Summary without local paths.

## Method and limits

1. The driver makes the same synthetic session for each case. It uses separate temporary settings, session, and home directories.
2. The driver starts fullscreen Pi in a PTY. It waits for the first transcript paint, grammar preload, and pending diff highlights.
3. The driver measures five seconds of idle time. Then it sends 400 wheel events in each direction.
4. The probe checks the mounted Slate surfaces, counts wheel input, and records frame time. The driver measures CPU time and the bytes that Pi writes.

Frame time measures Pi rendering only. It does not include input latency or the time a terminal emulator takes to draw the output. Compare runs on the same hardware, with the same Pi and Node.js versions. See the [scroll benchmark notes](scroll/NOTES.md) for more details.

## Component benchmarks

Run these commands from the repository root after you install the pi-slate dependencies:

```sh
node --experimental-strip-types benchmarks/pi-slate/tool-groups.ts
NODE_PATH="$PWD/pi-slate/node_modules" bun benchmarks/pi-slate/sidebar-cache.ts
```

The tool benchmark renders groups with 100 and 1,000 children. The sidebar benchmark uses Pi's renderer to check if the sidebar causes unnecessary transcript renders.
