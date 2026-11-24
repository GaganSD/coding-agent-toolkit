# Changelog

## Unreleased

- Paste screenshots or files into answer and note editors with `Ctrl+V`; Pi receives their paths as text.

## 0.2.0

Background questions, answer later, and timeouts with safe fallbacks. Questions survive reloads, and every answer reaches the agent once.

- **Supports async background questions:** The agent can ask low-priority questions and keep working! Answer now, or later with `Ctrl+L`; your answer arrives as a message.
- **pi-ask is now durable, with safe timeouts:** Questions and drafts survive reload, resume and fork, each answer reaches the agent once, and a question can expire to a fallback the agent chose.
- **Skip or cancel with a reason, plus fixes:** `s` skips one question, `c` cancels with a comment; safer config saves and Chinese result text.

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
