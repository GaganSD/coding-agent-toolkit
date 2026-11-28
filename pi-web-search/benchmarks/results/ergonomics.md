# Live search wrapper ergonomics

Run started 2026-11-28 14:11 UTC. Baseline completed 120/120 trials and the feature completed 120/120. Paired results cover 120 trials per arm.

- Baseline starting commit `772ca57f235333a9c2fb7ae12b6b6a6fc58250d3`, corpus and source fingerprint `783a7342de6ef75fb318ebc311cc519cb8c35648b8f45c50da95bcfbe65e3870`.
- Feature starting commit `266417a29711044c0035386efb08be5e1595b8ef`, corpus and source fingerprint `f567c215e8347d39e66633ff495151396df48fbda639aa99485eff8eefa71fc2`.
- Shared 40-task corpus and replay excerpt fingerprint `a2d1e3e8a6d8310b37bf505be2aa3285051e0e7d7a7e84c43c245b2efacd1186`.
- DeepSeek V4.1 Flash via OpenCode Go, `opencode-go/deepseek-v4.1-flash`.

Each arm used Pi 1.3.0, 3 trials per task and model, thinking off, a limit of 800 output tokens per model request, a budget of 8 tool calls and a 90-second trial deadline. Pi dispatched tool calls sequentially. Both arms used synthetic retrieval fixtures, including Jina replay for URL evidence. The separate local reader suite exercises direct URL handling.

OpenCode Go intermittently returned HTTP 429. The runs resumed from their checkpoints with one worker per arm and retried transient responses with bounded backoff. The metrics use completed attempts. The paired runs measure the pinned DeepSeek model.

Replay-qualified first-call success is the fraction of trials whose first tool call returned without an error. A trial without a tool call contributes zero. URL requests need a task fixture, so a schema-valid URL can count as a failure when the fixture is absent.

Synthetic excerpts illustrate each task category. They can prompt reformulation or another search even after a successful tool call. These metrics measure observed tool interaction under replay. Answer accuracy, topic coverage and completion were unscored. A fall in ref reads can therefore reflect skipped evidence as well as shorter workflows.

Intervals are percentile bootstrap intervals over task means, with all available matched model trials for each task kept together. Recovery turns count successful calls on a later turn after the first failed call. Recovery changes include only trials with a recovery in both arms.

## Verification thresholds

### Overall first-call validity

Fail. Change -5.83 percentage points against the −2-point floor. Documentation tasks had 18/18 first-call successes at baseline and 12/18 in the feature arm.

### Multipart tool calls

Fail. Calls fell 13.64% (-0.75 per trial). First-call validity changed +16.67 percentage points. The threshold requires at least 25% fewer calls with no decrease in first-call validity.

### Beyond-preview ref reads

Fewer observed. Change -0.80 successful ref follow-ups per trial. This check is advisory.

## Documentation-task diagnostic

An additional first-call-only probe repeated calibration task `cal-05` 3 times in the feature arm. 2/3 first calls succeeded, and 0/3 requested a URL outside the replay allowlist. 1/3 made no tool call. The scored trial records capture outcomes without per-call failure reasons.

## DeepSeek V4.1 Flash

| Tasks | Metric | Pairs | Baseline, 95% interval | Feature, 95% interval | Paired change, 95% interval |
| --- | --- | ---: | ---: | ---: | ---: |
| All tasks | Replay-qualified first-call success | 120 | 85.83% [76.67, 94.17] | 80.00% [70.83, 88.33] | -5.83 pp [-13.33, +1.67] |
| All tasks | Tool calls per trial | 120 | 4.73 [4.26, 5.22] | 5.27 [4.74, 5.79] | +0.53 [+0.02, +1.05] |
| All tasks | Successful ref follow-ups per trial | 120 | 0.93 [0.64, 1.27] | 0.56 [0.31, 0.86] | -0.38 [-0.54, -0.22] |
| All tasks | Repeated invalid calls per trial | 120 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | +0.00 [+0.00, +0.00] |
| All tasks | Turns to recover | 120 | 1.08 [1.03, 1.14] | 1.31 [1.16, 1.49] | +0.23 [+0.04, +0.46] |
| All tasks | Tool call cap reached | 120 | 14.17% [5.83, 23.33] | 21.67% [12.50, 31.67] | +7.50 pp [-2.50, +17.50] |
| Multipart | Tool calls per trial | 12 | 5.50 [3.67, 7.33] | 4.75 [2.42, 6.33] | -0.75 [-1.83, +0.33] |
| Multipart | Replay-qualified first-call success | 12 | 66.67% [41.67, 91.67] | 83.33% [66.67, 100.00] | +16.67 pp [+0.00, +33.33] |
| Beyond preview | Successful ref follow-ups per trial | 15 | 3.27 [2.87, 3.73] | 2.47 [1.60, 3.13] | -0.80 [-1.47, -0.13] |
| Beyond preview | Tool calls per trial | 15 | 7.27 [6.60, 7.80] | 7.53 [7.07, 7.93] | +0.27 [-0.67, +1.13] |
| Beyond preview | Replay-qualified first-call success | 15 | 100.00% [100.00, 100.00] | 80.00% [66.67, 93.33] | -20.00 pp [-33.33, -6.67] |

The accompanying JSON contains the per-trial counts, including trials that reached the tool-call cap.
