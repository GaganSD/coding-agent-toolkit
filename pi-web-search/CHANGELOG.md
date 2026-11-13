# Changelog

## Unreleased

## 0.4.0

Search the web, public code, and URLs through one tool, with less context overhead and easier follow-up reading.

### Highlights

- **One search tool:** search the web, find public code, read URLs, and revisit results through `search`. Choose fast searches or opt into multi-source thorough searches.
- **Less context overhead:** approximately 16% smaller tool/prompt footprint by default, 44% smaller with research enabled, and a 76% smaller representative result preview.
- **Read more without searching again:** open saved results, find passages, and continue reading locally. Results stay in session memory and expire; reloading clears them.
- **More retrieval options:** read URLs without a key through Jina Reader, or add a Brave API key for web search. Repeated searches can reuse recent results to reduce duplicate requests.
- **Optional result ranking:** Jev is now the default decision model when classification is enabled. Select another available model or disable classification through `/web-search classifier`.

*Offline character-based measurements: 344 estimated tokens for the tool/prompt footprint (previously 410 by default or 615 with research enabled), and 4,081 characters for the result preview (previously 16,777). These are not measured billing savings.*

### Upgrading to 0.4.0

- Replace `web_search`, `code_search`, and `multi_search` in custom prompts, tool permissions, and scripts with `search`. Use `scope: "code"` for code or `effort: "thorough"` for multi-source search; thorough search requires `research.enabled`.
- Supply one of `query`, `urls`, or `ref` per call. Use returned refs to revisit results; previous `search_read` arguments are not supported.
- Rename the `jev` block in `web-search.json` to `classifier` and remove `backend`. Old settings are rejected rather than migrated. Explicit provider/model selections are preserved. Reload Pi after updating.

## 0.3.1

Release the current extension updates together.

### Security

- Pin the transitive `undici` dependency to 8.12.2 in every package lock to clear critical and high-severity Snyk findings from the Pi SDK development tree.

### Highlights

- Slate adds the opt-in Claude Code-style tool transcript and focused prompt-layout refinements.
- Automode releases its decision-model panel and safety updates, including the breaking beta configuration rename from classifier settings to `decisionModel`.
- Ask, Subagents, and Web Search receive the dependency security refresh.

## 0.3.0

Replace /web-search-settings with /web-search: a Status / Providers / Classifier menu. Color-coded provider key picker; classifier picker lists available classifiers first with the current pin highlighted; actionable /login guidance; one-line save confirmation.

- Replace `/web-search-settings` with `/web-search`. Empty invocation opens a Status / Providers / Classifier menu.
- `/web-search provider` adds or modifies a retrieval API key and links to the provider's key page. The picker is color-coded: present, missing, or keyless.
- `/web-search classifier` lists Pi's registered classifiers plus None, available first, with the current pin highlighted on top. Pins require the `classifier` keyword so pasted secrets are not written to `web-search.json`.
- Pinning a classifier without Pi credentials says how to log in; a failed classifier discovery no longer mislabels every model as login required.
- Selecting a classifier confirms in one line instead of reprinting the full status report.

## 0.2.1

Maintenance release: refresh the Pi, TypeScript, and GitHub Actions pins.

- pi-slate: focused mode replaces vertical mode (`/slate focused`); the unused `@earendil-works/pi-ai` and `typebox` peers are dropped
- All packages: Pi dev/peer pins to 1.0.0, TypeScript to 7.0.2, typebox to 1.3.34
- pi-subagents: yaml to 2.9.1
- Actions: setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1

- Refresh the Pi 1.0.0 and TypeScript 7.0.2 dev pins and validate packaged imports with the TypeScript 7 scanner

## 0.2.0

Improve code fallbacks and first-run setup.

- Keyless Sourcegraph search for public code
- Continue when one code source is empty instead of failing the tool
- Reuse `gh` auth for GitHub, pinned to github.com
- One-time TUI setup prompt for existing Exa, GitHub, and Parallel credentials
- Pin one Pi classifier (`provider`/`model`); drop gateway ladders and remapped Jev IDs
- Production audit on publish; host Pi peers are optional so install stays audit-clean

## 0.1.0

First public release as `@gagansd/pi-web-search`.

- `web_search`, `code_search`, and opt-in `multi_search`
- Keyless Exa web, Parallel MCP fallback, and grep.app code
- Optional Jev ranking, filtering, and coverage checks
