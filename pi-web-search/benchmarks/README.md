# Search benchmarks

Install the package dependencies, then run `npm ci --prefix benchmarks --ignore-scripts` for the pinned `o200k_base` tokenizer. Run the commands below from `pi-web-search` with Node 24.

| Command | Owner inputs | Measurement |
| --- | --- | --- |
| `npm run research:record -- --live --only=context` | `searches.txt` | Pi declaration and prompt delta, median result tokens and total result tokens. Both extensions receive the same recorded keyless Exa evidence for each query. Basic Exa capture sends the query as both query and objective and requests at least eight results. Optional `web:` or `code:` prefixes and tab-separated scope labels are stripped for the shared web comparison. |
| `npm run research:urls -- --live` | `urls.txt`, `url-labels.json` | Live public URL reads, local and Jina contributions and exact owner phrases in readable evidence. Use one URL per line with an optional tab-separated category and a JSON object mapping each URL to one phrase. PDFs are excluded. |
| `npm run research:record -- --live --only=tasks --model=provider/model` | `tasks.jsonl`, `completed.json` after review | Use one JSON object per task with `id`, `prompt` and optional `multiPart` boolean. Repeat `--model` for each pinned model. Reports distinguish attempted calls, including validation failures and calls queued past the cap, from tool executions. The task run uses Pi model authentication and keyless retrieval. Supply `--catalog=<Pi SDK dist/index.js>` if a model is only listed by a different local Pi version. The labels map uses `lane/provider/model/variant/task-id` keys and boolean values. |

Use `--extension=<package-dir>` for a specific revision, `--version=<lane>` to distinguish reports and `--variant=<name>` for the model-facing experiment. Keep measured source checkouts unchanged across recording and replay. `--variant=baseline-fields --baseline=<0.4.0 package-dir>` reuses the 0.4.0 declaration and inserts the new filters. The other variants change query order, give arrays their own field, restore descriptions, restore the exactly-one guideline, or hide filter fields. To measure output formatting, evaluate the same variant on the checkouts immediately before and after the formatting commit.

Add `--competitor=<package-dir>` to compare pi-web-access at `4427fb2044adcd176ced091dc82ff787f3b039ff`. Install its dependencies separately. The comparison pins web search to keyless Exa. Task URL reads use Jina when the extension supports the reader override, so the model run measures declarations and responses with reproducible retrieval. The URL benchmark exercises the regular reader.

After recording, run `npm run research:offline` with the same input, lane, model, scope and variant options. It replays the recorded model turns and retrieval responses, denies network access and fails on a missing recording. Parallel captures omit Pi session and model attribution, so a new session can reuse the same retrieval evidence. To opt into OS-level network denial as well, run the command inside a network namespace on Linux or under a deny-network sandbox on macOS. CI exercises the independent pass/fail provider fault, safety, citation and continuation tests in `npm test`.

Inputs default to `research/inputs/`; override with `--inputs`. Use `--draft` for owner drafts, where URL phrases may be partial in `url-labels.draft.json`. Results, captures and transcripts are private by default under ignored `research/results/` or `research/draft-results/`; override their directory with `--output`. Use `--cassette=<file>` to share a response recording across lanes in serial runs. Each output directory and response cassette records its draft or final provenance. Start with fresh paths when changing provenance or if an old artifact has no provenance. Reports are `<lane>.md` and link to raw outcomes under `raw/<lane>/`. Review transcripts and scrubbed recordings before deciding what can be shared.

## Provider checks

- `npm run research:brave -- --live` verifies both Brave search routes using the configured key.
- `npm run research:offtopic -- --check-fixtures` verifies the calibration and holdout fixtures. `npm run research:offtopic -- --live --model=<provider>/<model>` measures a second classifier against the same sets. See the [calibration report](results/offtopic.md).
