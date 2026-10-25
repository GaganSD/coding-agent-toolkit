# Retrieval efficiency and context budgets

## URL-only retrieval

`search({ urls: ["https://example.com/docs"] })` performs extraction without a search request. Supply `urls` by itself; `query` and `ref` are mutually exclusive with it. URL-only calls use keyless Jina Reader first; retryable failures use the existing web extraction chain, excluding Brave (which also delegates extraction to Jina). Query calls never combine with URLs in the unified schema. Both paths share the operation deadline and caller cancellation. A URL-only provider failure can trigger the normal retryable fallback chain.

Ordinary search defaults remain anonymous Exa MCP with anonymous Parallel MCP fallback. Brave is optional and key-required; Jina URL-only extraction is keyless. Neither adds a model-facing tool, argument, or instruction. Jina is extraction-only and never joins search/research fan-out.

## Progressive evidence

The tool returns a compact preview and, when available, `resultId`, a per-hit `ref`, and continuation fields such as `cursor`, `more`, and `truncated`. Refs are the model-facing continuation: `search({ ref: "<resultId>" })` lists stored results with pagination, and `search({ ref: "<resultId>:<oneBasedIndex>" })` reads one result. `find` locates a literal passage; `cursor` continues a paginated listing or read. No hidden continuation tool or codemode discovery is required. Direct results include an exact, copyable next call whenever another stored page exists.

- A bare handle lists stored result URLs and titles. Its `cursor`/`more` fields indicate further pages.
- `<resultId>:<oneBasedIndex>` reads that stored result; the first result is `:1`.
- `find` locates the first case-insensitive literal match with nearby context and reports the total match count. It cannot combine with `cursor`, and a miss means only “not found in stored excerpt,” not “absent from the full page.” No fuzzy matching, embeddings, or model call is involved.
- Missing/expired handles and invalid refs return structured errors. Reading never refetches silently.

Ref reads are local: they perform no network request, do not resolve provider settings, and are unaffected by a malformed `web-search.json`. Only post-judgment, admitted evidence enters the store. Suppressed passages cannot be recovered by continuation. Every continuation still passes through Pi's normal tool pipeline. Ordinary searches do not classify evidence; optional classification remains a heuristic, not a security boundary.

Storage is memory-only and session-scoped: no document files or session JSONL copies. Successful reads refresh a 10-minute idle expiry, capped at 60 minutes from creation. The store has 32-entry and 8 MiB aggregate limits, at most 256 results per entry, 64,000 characters per passage and 256,000 passage characters per entry. Non-URL metadata is capped at 1,000 characters per field. Least-recently-used entries are evicted first. `storedClipped` reports local clipping; entries too large to fit are not stored. Shutdown clears that session's entries. Reload, restart and fork do not restore handles. Existing branches within a session share its handle namespace.

**Provider-returned evidence is not necessarily a full page.** For example, Exa URL extraction currently requests at most 3,000 characters per URL. Jina retains at most 64,000 characters per document, fetches at most three documents concurrently, and caps each JSON response at 1 MiB. It requests Markdown without images or link destinations and verifies returned page identity. Individual Jina page failures are reported without discarding successful siblings. Continuation recovers text beyond the preview, not text that the upstream provider never returned.

## Bounded thorough fan-out

`effort: "thorough"` is deliberately bounded. It runs at most **two actual transports per family** in configured order; missing transports do not consume a slot, and `both` therefore runs at most four. Configuration order still wins, but a long fallback list cannot turn one thorough call into an unbounded provider sweep. Fast effort remains a sequential provider chain with fallback, not a fan-out.

## One global preview budget

After optional judgment, exact URL + passage + result-type duplicates are combined with contributing source names. Distinct passages, query strings, fragments/code anchors, and search-versus-extraction evidence are preserved. This is deterministic, not semantic similarity ranking.

`maxResults` limits the returned preview count across all contributing providers and URL extracts. Requested-page extracts are ordered first, then remaining ranked/provider-ordered results. This order is also used by stored indexes. Mixed previews retain both web and code evidence when the cap permits. Refs are assigned in stored order before selection or output budgeting. Overflow remains in the bounded store when a handle is available; otherwise the omission warning recommends another retrieval.

Search excerpts are capped at 400 characters in both direct text and structured results. Each consumption path has an **8,000-character global budget**, including metadata, citations, notices, and continuation instructions. Whole records are packed once; a citation that cannot fit is omitted explicitly, never shortened. Structured results contain useful snippets once, without a second copy of rendered text or duplicate citation lists. Provider prose is retained within a bounded preview unless exact equality proves it duplicates rendered results. Rich diagnostics remain in renderer details, not the compact script payload. Ref reads return bounded passages and exact continuation cursors; JSON escaping must fit the same per-path budget.

## Quota-aware reuse

Direct HTTP providers use a bounded, session-local cache:

- 30-second lifetime, 64 entries, 2 MiB aggregate; no disk writes.
- Identity includes query, URLs, operation, resolved settings, provider and credential fingerprint. Raw credentials are not stored in keys. Rotation or settings changes invalidate reuse.
- Successful results with evidence and no provider warnings can be reused. Errors and partial extraction failures are not cached as successful evidence.
- Identical concurrent requests share work. Each caller can cancel independently; the last departing caller aborts shared work. Shared transport work still has its own bounded deadline.
- HTTP `Retry-After` on 429 is parsed as seconds or an HTTP date, capped at 60 seconds. Without one, a rate-limit error yields a 30-second cooldown. Other failures do not become cooldowns. The fallback chain skips cooling-down providers through a retryable error rather than sleeping or aggressively retrying.
- A cache hit carries a freshness notice. Reuse and cooldowns are cleared at session shutdown; stale entries are pruned on later activity.

Parallel is deliberately excluded from cache/coalescing/cooldowns at this layer: every nested MCP call must run Pi's permission and result hooks. We never replay an old permission decision or replace a denied native call with a private transport. Outer `search` tool hooks also run on every cache hit.

## Parallel MCP decision

Parallel documents anonymous access at `https://search.parallel.ai/mcp`; the REST Search API requires an API key. We retain the native MCP adapter for keyless operation, host-managed connections and nested permission checks. It does not make a nested LLM call or add nested calls to model history. Its tools are not declared directly to the model. The unified `search` tool declares the Parallel namespace with `reachesTools` for calls that can retrieve the web; local ref reads and code-only calls return `[]`, so they never wait for MCP startup. Connection startup, server summaries and codemode discovery still have overhead; this is not a claim that MCP is free.

Removing Pi's registration and using a private MCP client would hide service discovery but would still speak MCP and lose the existing nested permission hook boundary. Switching to REST would remove that protocol only for authenticated users. Neither tradeoff is made silently.

References: [Parallel programmatic use](https://docs.parallel.ai/integrations/mcp/programmatic-use), [Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp), [REST Search](https://docs.parallel.ai/api-reference/search/search).

## Reproducible footprint checks

Run `npm run bench:context`. It creates isolated, offline Pi SDK sessions and measures host-built tool declarations and system-prompt deltas, plus direct-text and programmatic result fixtures. The continuation schema size is zero: continuation is part of the same direct declaration. The benchmark does not start the remote MCP connection or include codemode's discovery/loadout overhead. It uses `ceil(characters / 4)`, **not provider tokenizer billing**.

With Pi 1.3.0, the unified declaration and prompt delta measure **344** estimated tokens in both modes (previously 410 default / 615 research). The 24-document fixture returns eight useful previews: 3,804 direct-text characters and 4,081 structured characters (previously 16,777 structured). These are offline character-proxy measurements, not an end-to-end latency, model-quality, or provider-billing benchmark.

`tests/footprint.test.ts` enforces regression ceilings for the unified declaration in default/research modes, continuation schema, preview count, and direct/structured result size. Live provider reliability and quality require separate, opt-in measurements.
