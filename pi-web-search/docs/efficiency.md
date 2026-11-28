# Retrieval efficiency and context budgets

## URL-only retrieval

`search({ urls: ["https://example.com/docs"] })` reads HTTP(S) URLs directly. HTML is extracted to text, PDFs are parsed locally, and public GitHub pages use purpose-built readers. Connections use a validated address, each redirect is checked, and response bodies have a 5 MiB limit. Eligible HTTP failures or pages without usable text can fall back to Jina Reader. Use `fetch.jinaFallback: false` to disable this fallback.

Query filters apply to web searches. Some providers apply recency on the server. With a domain filter, the tool checks the returned citation URLs against the requested hostnames and their subdomains.

## Progressive evidence

The tool returns a compact preview and, when available, `resultId`, a per-hit `ref`, and continuation fields such as `cursor`, `more`, and `truncated`. Refs are the model-facing continuation: `search({ ref: "<resultId>" })` lists stored results with pagination, and `search({ ref: "<resultId>:<oneBasedIndex>" })` reads one result. `find` locates a literal passage; `cursor` continues a paginated listing or read. No hidden continuation tool or codemode discovery is required. Direct results include an exact, copyable next call whenever another stored page exists.

- A bare handle lists stored result URLs and titles. Its `cursor`/`more` fields indicate further pages.
- `<resultId>:<oneBasedIndex>` reads that stored result; the first result is `:1`.
- `find` locates the first case-insensitive literal match with nearby context and reports the total match count. It cannot combine with `cursor`, and a miss means only “not found in stored excerpt,” not “absent from the full page.” No fuzzy matching, embeddings, or model call is involved.
- Missing/expired handles and invalid refs return structured errors. Reading never refetches silently.

Ref reads are local: they perform no network request, do not resolve provider settings, and are unaffected by a malformed `web-search.json`. Only post-judgment, admitted evidence enters the store. Suppressed passages cannot be recovered by continuation. Every continuation still passes through Pi's normal tool pipeline. Ordinary searches do not classify evidence; optional classification remains a heuristic, not a security boundary.

Storage is memory-only and session-scoped: no document files or session JSONL copies. Successful reads refresh a 10-minute idle expiry, capped at 60 minutes from creation. The store has 32-entry and 8 MiB aggregate limits, at most 256 results per entry, 64,000 characters per passage and 256,000 passage characters per entry. Non-URL metadata is capped at 1,000 characters per field. Least-recently-used entries are evicted first. `storedClipped` reports local clipping; entries too large to fit are not stored. Shutdown clears that session's entries. Reload, restart and fork do not restore handles. Existing branches within a session share its handle namespace.

Stored evidence is bounded by the text each provider returns and the 64,000-character per-document limit. Ref reads recover that stored text beyond the preview.

## Bounded thorough fan-out

`effort: "thorough"` is deliberately bounded. It runs at most **two actual transports per family** in configured order; missing transports do not consume a slot, and `both` therefore runs at most four. Configuration order still wins, but a long fallback list cannot turn one thorough call into an unbounded provider sweep. Each query runs through a sequential chain in fast mode. A batch can run its queries concurrently and limits overall transport concurrency to six.

## One global preview budget

After optional judgment, exact URL + passage + result-type duplicates are combined with contributing source names. Distinct passages, query strings, fragments/code anchors, and search-versus-extraction evidence are preserved. This is deterministic, not semantic similarity ranking.

`maxResults` limits the returned preview count across all contributing providers and URL extracts. Requested-page extracts are ordered first, then remaining ranked/provider-ordered results. This order is also used by stored indexes. Mixed previews retain both web and code evidence when the cap permits. Refs are assigned in stored order before selection or output budgeting. Overflow remains in the bounded store when a handle is available; otherwise the omission warning recommends another retrieval.

Search excerpts show the highest-scoring query-relevant passage up to 400 characters. URL reads preview the start of the extracted document. Each consumption path has an **8,000-character global budget**, including metadata, citations, notices, and continuation instructions. Whole records are packed once; a citation that cannot fit is omitted explicitly, never shortened. Structured results contain useful snippets once, without a second copy of rendered text or duplicate citation lists. Provider prose is retained within a bounded preview unless exact equality proves it duplicates rendered results. Rich diagnostics remain in renderer details, not the compact script payload. Ref reads return bounded passages and exact continuation cursors. A batch groups results by query, shares the budget between groups, and preserves successful groups when one fails.

## Quota-aware reuse

Direct HTTP providers use a bounded, session-local cache:

- 30-second lifetime, 64 entries, 2 MiB aggregate; no disk writes.
- Identity includes query, URLs, operation, resolved settings, provider and credential fingerprint. Raw credentials are not stored in keys. Rotation or settings changes invalidate reuse.
- Successful results with evidence and no provider warnings can be reused. Errors and partial extraction failures are not cached as successful evidence.
- Identical concurrent requests share work. Each caller can cancel independently; the last departing caller aborts shared work. Shared transport work still has its own bounded deadline.
- HTTP `Retry-After` on 429 is parsed as seconds or an HTTP date, capped at 60 seconds. Without one, a rate-limit error yields a 30-second cooldown. Other failures do not become cooldowns. The fallback chain skips cooling-down providers through a retryable error rather than sleeping or aggressively retrying.
- A cache hit carries a freshness notice. Reuse and cooldowns are cleared at session shutdown; stale entries are pruned on later activity.

Parallel requests stay outside the reuse cache. The standalone MCP server uses the same in-memory evidence and provider reuse limits.

## Parallel MCP

Parallel accepts anonymous calls over its documented MCP endpoint. Search sends the original query as the objective and supplies a shorter deterministic keyword query when the original contains more than six relevant terms. The standalone server uses the direct MCP client.

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)

## Reproducible footprint checks

Run `npm run bench:context`. It creates isolated, offline Pi SDK sessions and measures host-built tool declarations and system-prompt deltas, plus direct-text and programmatic result fixtures. The continuation schema size is zero: continuation is part of the same direct declaration. The benchmark does not start the remote MCP connection or include codemode's discovery/loadout overhead. It uses `ceil(characters / 4)`, **not provider tokenizer billing**.

The offline replay reports capture the baseline and release context cost against the same corpus. See the [benchmark guide](https://github.com/GaganSD/coding-agent-toolkit/tree/main/pi-web-search/benchmarks).

`tests/footprint.test.ts` enforces regression ceilings for the unified declaration in default/research modes, continuation schema, preview count, and direct/structured result size. Live provider reliability and quality require separate, opt-in measurements.
