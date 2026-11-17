# Changelog

## Unreleased

`ask_user` can now ask in the background, take an answer later, and time out safely.

- **Background questions.** `background: true` queues the form and returns a `queued` receipt with a `requestId`, so the agent keeps working. The answer arrives as a `pi-ask:answer` message at the next turn boundary, or wakes an idle agent. A cancellation is added as context but never starts a turn.
- **Answer later.** `Ctrl+L` on a blocking form returns `deferred` and moves the form, draft intact, to a panel above the input. `Alt+A` moves the keyboard between panel and input; `Esc` or `Ctrl+L` hides it; a line under the input counts waiting forms. `/ask-panel` reopens it.
- **Expiry with fallback.** A call can set `timeoutSeconds` and each question an optional `fallback` option `value`. On by default with a 30-second floor. The countdown runs only while the form is on screen, after the notification fires; any key, hiding or deferring stops it for good. On lapse the form resolves `expired` with only declared fallbacks applied, and the result says a fallback is the agent's assumption, not approval.
- **Late override.** An expired form stays reopenable for an hour through `/ask-panel`; submitting sends one correction that replaces the timed-out result. Dismissing it without a comment leaves the earlier result standing.
- **Session journal and recovery.** Forms, drafts (including text typed in an editor and not yet submitted), panel state, countdown stops and outcomes are saved in the session. An interrupted form reopens on startup, resume or fork with its draft. Delivery stays exactly-once across reload, resume, compaction and branch moves: the `pi-ask:answer` message on the active branch is the proof, and a wake whose run never started is retried.
- **Cancel with a comment and skip.** `c` on the review tab attaches a short reason to a cancellation. `s` declines one question without cancelling the form; skipped is neither an answer nor approval.
- **Configuration and keys.** New keys `behaviour.background`, `expiry.enabled` and `expiry.minSeconds`, plus keymaps `global.later`, `global.panelFocus`, `main.skip` and `main.cancelComment`. `/ask-settings` exposes the expiry toggles; schema changes apply on `/reload`. `/ask-panel` shows waiting and expired forms.
- **Hosts without the custom TUI** keep the blocking card flow: `background` blocks there and there is no countdown.
- The default `ask_user` context footprint is 1,598 chars (≈ 400 tokens), or 1,534 (≈ 384) with expiry off, within the existing 450/420 token ceilings.

## 0.1.5

- Add RPC dialog interviews with single/multi-select, free-text answers, back navigation, and review before submission.
- Repair common malformed question payloads before validation.
- Add Simplified Chinese dialog strings via `PI_ASK_LOCALE=zh`.
- Reduce recurring tool context by about 44%.
- Prioritize common keyboard hints in the footer.
- Fix RPC cancellation races and unexpected dialog responses.

## 0.1.4

Release the current extension updates together.

### Security

- Pin the transitive `undici` dependency to 8.12.2 in every package lock to clear critical and high-severity Snyk findings from the Pi SDK development tree.

### Highlights

- Slate adds the opt-in Claude Code-style tool transcript and focused prompt-layout refinements.
- Automode releases its decision-model panel and safety updates, including the breaking beta configuration rename from classifier settings to `decisionModel`.
- Ask, Subagents, and Web Search receive the dependency security refresh.

## 0.1.3

Maintenance release: refresh the Pi, TypeScript, and GitHub Actions pins.

- pi-slate: focused mode replaces vertical mode (`/slate focused`); the unused `@earendil-works/pi-ai` and `typebox` peers are dropped
- All packages: Pi dev/peer pins to 1.0.0, TypeScript to 7.0.2, typebox to 1.3.34
- pi-subagents: yaml to 2.9.1
- Actions: setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1

- README screenshots use stable GitHub URLs on GitHub, npm, and the Pi gallery; packing no longer rewrites the README
- Refresh the Pi 1.0.0 and TypeScript 7.0.2 dev pins

## 0.1.2

- README screenshots served from the npm CDN

## 0.1.1

- Document single, multi, and text modes in the README

## 0.1.0

First public release as `@gagansd/pi-ask`.

- `ask_user` interviews: one question at a time
- Single-select, multi-select, and free-text
- `/answer` turns the latest assistant message into a form
- `/ask-settings` for the settings overlay
