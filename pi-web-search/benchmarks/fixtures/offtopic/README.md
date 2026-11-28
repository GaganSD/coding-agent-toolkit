# Off-topic classifier fixtures

Each split has 30 synthetic search responses, with 15 labeled `addresses` and 15 labeled `off_topic`. Both splits cover homonyms, sibling products, wrong versions, keyword-heavy SEO results, and non-English queries. The candidate excerpts are authored for this experiment, and their URLs use reserved domains. The driver does not fetch them.

The query implementation agent wrote the calibration set. The coordinating agent wrote the holdout separately without seeing the calibration examples or classifier output.

An `addresses` response contains at least one candidate offering substantive evidence under the query's stated constraints. An `off_topic` response contains no such candidate. A response can address a query even if it also contains a distractor.

Run `npm run research:offtopic -- --check-fixtures` to verify the corpus locally. The documented live command bills one Pi classifier call per fixture per pinned model and writes `research/offtopic.md`. The driver records both split hashes, calculates each model's threshold on calibration, then measures the unchanged threshold on holdout.
