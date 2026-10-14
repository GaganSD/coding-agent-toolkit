# Changelog

## Unreleased

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
