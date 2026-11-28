# pi-web-search

**One search tool for the public web, code, library documentation, URLs, and stored evidence. Works in Pi and over stdio MCP.**

## Why this one

- The single `search` tool and its Pi prompt use an estimated 366 tokens. The four tools in the pinned pi-web-access comparison use 1,267 under the same Pi SDK character estimator. [Declaration comparison](https://github.com/GaganSD/coding-agent-toolkit/blob/main/pi-web-search/benchmarks/results/compare.md)
- Read pages and PDFs directly. Use evidence refs to continue reading in memory without another provider request.
- Choose where queries go. The default routes work without an API key. You can also configure a SearXNG instance or opt into Brave and Context7.

## Installation

Requires Pi **0.99.0 or newer**.

1. Install: `pi install npm:@gagansd/pi-web-search`

2. The first interactive session shows a one-time setup prompt for existing Exa, GitHub, and Parallel credentials. For keys and settings anytime, run `/web-search`.

> Keyless configs have limitations set by Exa and Parallel.

| Command | What it does |
| --- | --- |
| `/web-search` | Menu: status, provider keys, classifier. Headless prints status. |
| `/web-search status` | Providers, credential presence (never keys), and the classifier pin. |
| `/web-search provider [name]` | Add or modify a retrieval key. The picker is color-coded: keyless, optional, or required; present or missing. |
| `/web-search classifier [none\|provider/model]` | Pin a classifier for judgment, pick from the list, or disable with `none`. |

## Use from other agents (MCP)

The standalone server requires Node **22.19 or newer**. It exposes the same `search` arguments and returns text plus structured evidence to MCP clients that support structured results.

**Claude Code**

```bash
claude mcp add --transport stdio pi-web-search -- npx -y @gagansd/pi-web-search
```

**Codex** in `config.toml`

```toml
[mcp_servers.pi-web-search]
command = "npx"
args = ["-y", "@gagansd/pi-web-search"]
```

**Cursor** in `mcp.json`

```json
{
  "mcpServers": {
    "pi-web-search": {
      "command": "npx",
      "args": ["-y", "@gagansd/pi-web-search"]
    }
  }
}
```

The server reads `PI_WEB_SEARCH_CONFIG` first, then `PI_CODING_AGENT_DIR/web-search.json`, then `~/.pi/agent/web-search.json`. It checks environment variables, literal keys in `auth.json` beside that config, and the GitHub CLI login for GitHub. Thorough searches and fast web searches with off-topic fallback enabled still retrieve evidence and warn that classifier judgment requires Pi. Parallel uses its direct client. Evidence refs expire with their server process.

## Classifier API

Optional classification adds judgments to `effort: "thorough"` calls; fast `search` calls never run it.

- **Rank:** favor relevant, self-contained excerpts and penalize off-topic results.
- **Filter:** suppress confidently flagged prompt injection, phishing, or harmful content.
- **Check coverage:** judge whether the retrieved evidence is enough to answer the query.

### Architecture and model support

`Retrieval → Pi classifier API → ranking/filtering policy → cited results`

The classifier receives the query and candidate titles, URLs, and excerpts as state, plus typed boolean and choice questions. It returns probabilities; code applies weights and thresholds. Pi owns the catalog, authentication, and `classify()`. This package pins one exact `provider`/`model`.

| Classifier | Support |
| --- | --- |
| **Jev** via TypeSafe, Vercel AI Gateway, or OpenRouter | Available now; reuses Pi authentication. |
| **Any Pi classifier** including llama.cpp | Pin its exact `provider`/`model`. |
| **OpenAI Decisions and other decision models** | Supported when registered as a classifier in Pi; pin the exact provider/model. |

The provider-independent boundary makes other classifiers possible without rewriting retrieval or ranking. Pin any registered Pi classifier with `/web-search classifier`.

### Try Jev with your existing Pi login

For OpenRouter:

1. Run `/login openrouter` **only if Pi isn't already authenticated**.
2. Run `/web-search classifier` and pick `openrouter/~typesafe/jev-latest`, or `/web-search classifier openrouter/~typesafe/jev-latest`.
3. Run `/reload`.
4. Ask: “Use search with effort thorough to search the web for AbortSignal.timeout.”

| Use | Setup command | Default model |
| --- | --- | --- |
| TypeSafe | `/web-search classifier typesafe/jev-latest` | `jev-latest` |
| Vercel AI Gateway | `/web-search classifier vercel-ai-gateway/typesafe-ai/jev` | `typesafe-ai/jev` |
| OpenRouter | `/web-search classifier openrouter/~typesafe/jev-latest` | `~typesafe/jev-latest` |
| OpenCode | `/web-search classifier opencode/jev-1.13` | `jev-1.13` |
| OpenAI Decisions | `/web-search classifier vercel-ai-gateway/openai/gpt-6-luna-decisions` | `openai/gpt-6-luna-decisions` |
| Cloudflare Workers AI | `/web-search classifier` and pick a listed Clef/Jev model | catalog |

`/web-search classifier` lists every classifier Pi currently registers, plus **None**. Classifiers do not appear in `/model`; this picker is the search-specific pin. Pinning enables multi-source search and judgment in `web-search.json`, preserving your other settings. **No second API key is needed.** Pi reuses its stored, environment, runtime, or model authentication. If needed, use Pi's `/login` for that provider.

`/web-search classifier none` disables judgment; search stays on. Hosted classification is billed to the pinned account.

Classification is off by default. When enabled without an explicit provider/model pair, it uses **Jev** (`vercel-ai-gateway/typesafe-ai/jev`). Other Pi classifiers can be pinned explicitly. Configuration uses `classifier`; old `jev` blocks and `backend` fields are rejected, not migrated. Failures keep retrieved evidence with warnings. Hosted classifiers receive excerpts before output clipping; safety judgments are not a security boundary. See [all settings and limits](docs/research.md).

## Tool and examples

Use `search` for public documentation, current information, literal public-code patterns, known URLs, and stored evidence:

> `search` is the only registered tool. Direct and codemode callers use the same interface.

| Input | Use |
| --- | --- |
| `query` | A string or an array of up to three queries. With `scope: "code"`, use a literal identifier or a library qualifier. |
| `recency` | Web query filter. Choose `day`, `week`, `month`, or `year`. A provider that cannot apply the filter returns a warning. |
| `domains` | Up to 10 hostnames for web queries. Includes subdomains. Prefix a hostname with `-` to exclude it. |
| `urls` | Extract one or more known HTTP(S) pages without a search request. |
| `ref` | Read stored evidence locally. Accepts a handle (list) or `<resultId>:<oneBasedIndex>` (read). |
| `scope` | `web` (default), `code`, or `both`. `both` defaults to `effort: "thorough"`. |
| `effort` | `fast` (default; one provider plus fallback) or `thorough` (concurrent sources, requires `research.enabled` in Pi). |
| `find` / `cursor` | Refine a `ref` read with a literal passage search or continuation cursor. |

Exactly one of `query`, `urls`, or `ref` is required. The tool reports invalid combinations and unknown fields.

Examples:

```json
{ "query": "AbortSignal.timeout", "scope": "web" }
```

```json
{ "query": "useSyncExternalStore repo:vercel/next.js", "scope": "code" }
```

```json
{ "query": "AbortSignal.timeout", "scope": "both", "effort": "thorough" }
```

```json
{ "urls": ["https://example.com/docs"] }
```

Use `repo:<owner/name>` and `language:<name>` for the common code-filter subset; other GitHub qualifiers are provider-dependent. Supply URL strings only when you want extraction; they cannot be combined with `query` or `ref`. `urls` accepts up to 20 strings; blanks are ignored and invalid/non-HTTP(S) URLs generate warnings. URL-only calls require at least one valid URL. Extraction returns provider-selected evidence, not a full browser page. Undeclared tool arguments such as `limit`, `provider`, or `path` are rejected and named in the error.

### Read more without another network request

Searches return bounded previews plus a session-local `resultId` when evidence can be stored. Pass that handle as `ref` to list or read evidence through the same tool:

```js
const index = await tools.search({ ref: "<returned handle>" });
text(index);
const passage = await tools.search({ ref: "<returned handle>:1", find: "timeout" });
text(passage);
```

Refs are one-based on the wire (`<resultId>:1` is the first stored result). Omit `find` and use `cursor` to continue a paginated read. Handles expire after 10 idle minutes (successful reads refresh this, up to a 60-minute maximum), eviction, shutdown, or reload. Nothing is written to disk. Stored evidence is bounded and may already have been truncated by the provider; it is **not guaranteed full-page content**. Direct callers can copy the returned `search({ref, cursor})` continuation call; codemode is not required. See [efficiency and limits](docs/efficiency.md).

### Code qualifiers

`repo:<owner/name>` and `language:<name>` are the documented common subset. On grep.app and Sourcegraph, these are extracted into filters; quote qualifier values containing spaces. The first nonempty `repo:` value is used, and repeated languages are deduplicated. **grep.app language filtering is unreliable** and always adds a warning when used; avoid it for a first search, and treat zero hits as inconclusive.

Other qualifiers are provider-dependent: grep.app leaves `path:`, `filename:`, and similar syntax in the literal pattern, while GitHub receives the original query unchanged and interprets its own syntax. A zero-hit warning suggests possible remedies, not a confirmed cause or proof that code does not exist. grep.app and public Sourcegraph do not index every GitHub repository; `repo:facebook/react` often misses on those sources.

## Full Configuration

The config path is `<agent-dir>/web-search.json`, normally `~/.pi/agent/web-search.json`. `PI_WEB_SEARCH_CONFIG` overrides this path. `PI_CODING_AGENT_DIR` changes Pi's agent directory.

The extension does not automatically read project `.pi/web-search.json` or merge Pi's `settings.json`. Project-local installation does not change the config location.

A missing file uses these defaults:

```json
{
  "web": { "provider": "exa", "fallback": ["parallel"] },
  "code": { "provider": "grep", "fallback": ["sourcegraph", "github"] },
  "research": { "enabled": false },
  "fetch": { "jinaFallback": true },
  "brave": { "mode": "context" },
  "timeoutMs": 20000,
  "maxResults": 8
}
```

All fields are optional. Merge changes into the existing file. Network operations read config each time; ref reads stay local even when config is malformed. Reload after native MCP registration or credential changes.

- `web` accepts `exa`, `parallel`, `brave`, and `searxng`. `code` accepts `grep`, `sourcegraph`, `github`, and `context7`.
- `searxng.url` is the HTTP(S) origin of your SearXNG instance. `brave.mode` selects `context` or `web`. `fetch.jinaFallback` controls fallback from direct URL reading to Jina Reader.
- `maxResults` truncates to an integer, then clamps to **1–20**. It limits provider requests and the returned preview count per query or URL call. Requested URL extracts are prioritized; additional admitted evidence is available through `search({ref})`. Providers may return fewer results or ignore the requested limit.
- `timeoutMs` truncates to integer milliseconds. Positive values have a **1,000 ms minimum**. Nonpositive values use **20,000 ms**. These numeric adjustments emit no warnings.
- Invalid JSON, unknown fields/providers, and malformed blocks produce `invalid_config`. Wrong-family providers trigger warnings and defaults or removal. Some invalid classifier values trigger defaults with warnings. Only literal `true` enables `classifier.enabled`.

See the [configuration resolver](src/providers/config.ts) for validation details.

### Optional off-topic fallback

To let fast web search try the next configured provider when the current response is off-topic, merge these settings into `web-search.json`:

```json
{
  "web": { "fallbackOnOffTopic": true },
  "classifier": { "provider": "vercel-ai-gateway", "model": "typesafe-ai/jev" }
}
```

The feature is off by default. The exact pin is required and uses Pi authentication. A check sends the query and up to ten result titles, URLs, and excerpts to this billed classifier. A classifier failure or timeout keeps the current response with a warning. If fallback yields no usable response, the first off-topic response is returned with warnings. Code searches, URL reads, and ref reads make no off-topic classifier calls. Selecting **None** under `/web-search classifier` or switching to a different classifier disables fast off-topic fallback. [Calibration results](https://github.com/GaganSD/coding-agent-toolkit/blob/main/pi-web-search/benchmarks/results/offtopic.md)

### Optional thorough search and Jev

1. Run `/web-search` to identify the config path.
2. Merge `{"research":{"enabled":true}}` into that file.
3. Run `/reload`.

`effort: "thorough"` sends the same query concurrently to the eligible sources in `scope`. Fan-out is bounded: at most **two actual transports per family** in configured order, and at most four for one query with `both`. A batch runs at most six transports at a time. `fallback: []` keeps a SearXNG-only web route on its configured origin. Other thorough routes may still use eligible defaults. It does not check agreement or initiate further searches. `scope: "both"` defaults to thorough; explicit `effort: "fast"` with `both` is rejected, and `research.enabled` must be true. Fast calls never fan out deliberately.

Jev requires a separate opt-in. Anonymous retrieval needs no classifier credentials. See [classifier setup](docs/research.md#enable-external-judgment), [tuning](docs/research.md#all-classifier-settings), and [failure behavior](docs/research.md#outcomes-and-limits).

## Credentials

Exa MCP, Parallel native MCP, grep.app, and Sourcegraph need no search key. Jina Reader is a keyless fallback for URL extraction. Brave requires its own key. Anonymous Parallel has lower server-controlled rate limits. A Parallel key is optional.

Search credentials use the first nonblank environment alias before `<agent-dir>/auth.json`. GitHub then tries an existing `gh auth login` token.

| Stored ID | Environment aliases, highest precedence first | Behavior |
| --- | --- | --- |
| `exa` | `EXA_API_KEY` | Selects REST instead of keyless MCP. |
| `parallel` | `PARALLEL_API_KEY` | Adds a Bearer header for higher limits. |
| `github` | `GITHUB_TOKEN`, `GH_TOKEN` | Requires a token. Returns only verified public results. |
| `brave` | `BRAVE_API_KEY`, `BRAVE_SEARCH_API_KEY` | Requires a Brave Search key. |
| `context7` | `CONTEXT7_API_KEY` | Optional key for higher Context7 limits. |

- Set environment variables **before starting Pi**. Exports in another shell cannot change a running Pi process. Restart Pi with the changed environment.
- The extension resolves stored retrieval keys on each operation.

Merge this entry into existing `auth.json` without replacing other credentials:

```json
{ "parallel": { "type": "api_key", "key": "<your-api-key>" } }
```

- Replace the placeholder privately.
- Exclude auth files from version control.
- Use narrowly scoped keys/tokens.

The [retrieval credential resolver](src/env.ts) reads literal `.key` strings, not shell commands, embedded environment references, or OAuth refresh credentials. Unreadable/malformed auth means no stored key.

`/web-search provider` adds or modifies a retrieval key in `auth.json` and shows where to create one. Keys are never command arguments, never written to `web-search.json`, and never displayed after you type them. Environment aliases still win over the stored value.

Pi supplies optional host peers. This package does not install another Pi copy. See the [npm advisory notes](docs/release-validation.md#npm-advisory-and-host-dependencies).

Pi alone resolves classifier authentication at judgment time. Jev needs no separate key.

Each provider controls quotas and billing. Keys do not guarantee quota or price changes. Additional sources do not guarantee results or availability.

`/web-search` shows an authentication snapshot, not a live key-validity test. It never displays keys.

### Optional Brave search

Run `/web-search provider brave` to store a key privately, then merge this into `web-search.json`:

```json
{ "web": { "provider": "brave", "fallback": ["exa", "parallel"] } }
```

Brave defaults to LLM Context and returns passages from cited pages. Set `"brave": {"mode":"web"}` to use the standard Web Search endpoint and its shorter snippets. Each mode validates its query length before sending it.

### Self-hosted SearXNG

```json
{ "web": { "provider": "searxng", "fallback": [] }, "searxng": { "url": "http://localhost:8080" } }
```

Enable `json` in your instance's `search.formats`. Web searches with this configuration contact only your SearXNG origin. The instance sends queries to the engines it is configured to use. Day, month, and year recency depend on downstream engine support. The tool warns on week recency.

### Context7 documentation

Select `context7` in `code.provider` or `code.fallback` to resolve library names from queries. To select an exact library and version, use `search({ query: "middleware API library:/vercel/next.js@v15", scope: "code" })`. An explicit library qualifier routes the code portion of the query to Context7.

## Provider behavior and limits

- Default chains: **Exa → Parallel** and **grep.app → Sourcegraph → GitHub**.
- Empty results and retryable failures continue through the configured [provider chain](src/providers/index.ts). An empty provider is named in the warnings.
- Results contain links and excerpts, not guaranteed full pages. Exact duplicate evidence is collapsed, while distinct passages and code anchors remain. Search snippets show up to 400 characters of query-relevant evidence in both outputs. The shared budget is 8,000 characters per output path, including batches. Oversized citations are omitted whole with a notice, never shortened. Stored passages can be read in bounded windows with refs and cursors. See [structured output](src/format.ts).
- Direct HTTP retrieval has bounded 30-second session reuse and in-flight deduplication. Rate-limited providers enter a short cooldown. Parallel nested calls always execute through Pi so permission checks are never reused. See [efficiency and limits](docs/efficiency.md).

## Timeouts, fallback, and errors

Retrieval and judgment share a default **20-second** budget. Cleanup can take longer. Jev failures return unjudged evidence with warnings. If the deadline expires during optional judgment or off-topic fallback, the tool keeps the evidence it already retrieved. Caller cancellation stops the search.

Check warnings and `/web-search`. Use `/mcp` for Parallel connection issues.

## Data handling

Search providers receive the queries routed to them. Optional Jev receives the query and candidate titles, URLs, and excerpts. Fast off-topic fallback sends at most ten excerpts of up to 400 characters each, within the classifier state limit.

URL reading sends requests from your machine to each public URL. The tool reads text, HTML, PDFs, and supported GitHub pages, validates redirect targets, and blocks private and local network addresses. Eligible failures can send the original URL to Jina Reader. Set `fetch.jinaFallback` to `false` to keep URL reading direct. GitHub requests may use GitHub credentials for public repository metadata and limits.

Retrieved content is untrusted. Jev is not a prompt-injection firewall or truth guarantee.

The extension does not send workspace files or session history as search payloads. Pi can retain tool calls in session history.

Queries, URLs, errors, and excerpts can contain sensitive text.

## Development and package checks

1. Run `cd pi-web-search`.
2. Run `npm ci --ignore-scripts --no-audit --no-fund`.
3. Run `npm test`.
4. Run `npm run typecheck`.
5. Run `npm run audit:prod`.
6. Run `npm run pack:check`.
7. Run `npm run bench:context` for offline context-footprint estimates.
8. Run `npm run research:offline` for replay benchmarks and see the [benchmark guide](https://github.com/GaganSD/coding-agent-toolkit/tree/main/pi-web-search/benchmarks).

Optional retrieval check: `npm run smoke:live`. It sends public test queries without your credentials. Optional decision-model check: `npm run smoke:classifier` makes four live calls to the default Jev model using your Pi authentication (billing applies). It verifies ranking, injection suppression, insufficient evidence, and ordinary code. To test another exact pair, use `npm run smoke:classifier -- <provider> <model>`. See [release checks and limits](docs/release-validation.md).

SDK users must load Pi's MCP extension for native Parallel calls and call `bindExtensions()`. Codemode is optional; direct `search` calls support continuation too. See the [SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/14-codemode-mcp.ts).

## License

[MIT](LICENSE) - Gagan Devagiri
