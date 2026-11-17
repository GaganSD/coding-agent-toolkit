# pi-ask

Gives your agent a way to interview you in a structured form — brainstorming, auth, missing requirements. Structured answers keep the thread small.

One skill (~20-token description), built for context minimisation.

![Multi-select](https://raw.githubusercontent.com/GaganSD/coding-agent-toolkit/main/pi-ask/assets/multi.png)

![Single-select](https://raw.githubusercontent.com/GaganSD/coding-agent-toolkit/main/pi-ask/assets/single.png)

![Text](https://raw.githubusercontent.com/GaganSD/coding-agent-toolkit/main/pi-ask/assets/text.png)

## Install

```bash
pi install npm:@gagansd/pi-ask
```

Then `/reload`.

Releases: [CHANGELOG](CHANGELOG.md).

From a clone of this repo: `pi install .` at the repo or package root.

## Everyday use

The agent calls `ask_user`. `/answer` if it asked in prose instead.

| Need | What you do |
| --- | --- |
| Choose one, or several | `single` / `multi` |
| Type freely | `text`, or **Type your own** on a choice question |
| Understand a choice first | Notes |
| The question is the wrong shape | `t` switches `single` ↔ `multi` |

### Commands

| Command | What it does |
| --- | --- |
| `/answer` | Turn the latest completed assistant message into a form |
| `/ask-settings` | Settings overlay. `?` inside a form opens the same overlay |

Hosts without the custom TUI (RPC subagents, ACP clients) get the same interview as sequential select/input cards with back navigation and a review card. Callers with no dialog UI at all get `status: "unavailable"`.

## Contract

Input: `{ title?, background?, timeoutSeconds?, questions: [{ id, label?, prompt, type: single\|multi\|text, options?, fallback? }] }`.

- `text` questions have no options.
- `single` / `multi` need real options. Do not invent filler.
- Recommended options get a `description`. Never preselected.
- Typed text is never merged into option `values`.
- `background: true` queues the form and returns a receipt at once. The answer arrives later as a message.
- `timeoutSeconds` is a time limit, counted from when the form is on screen. Any keypress stops it for good.
- `fallback` is the option `value` applied when the limit lapses. It must match an option. Never on `text`. No `fallback`, no answer.

Output:

- `status`: `submitted` | `cancelled` | `unavailable` | `invalid` | `queued` | `deferred` | `expired`
- `answers[id]`: `{ values, labels, customText?, note?, optionNotes? }`
- `unanswered: id[]`
- `requestId`: ties a receipt to the answer delivered later
- `expired: id[]`: answers that are auto-applied fallbacks

`queued` (background call) and `deferred` (you chose "answer later") are receipts, not answers. `expired` means nobody responded: a fallback is the agent's assumption, never approval. The rules ride in those results, so they cost context only when they happen.

Every form, draft and outcome is journalled in the session. A form left open when Pi quit reopens on startup, resume or fork with its draft, and its answer reaches the agent once. The journal follows the active branch.

Optional config: `~/.pi/agent/extensions/pi-ask.json`. `/answer` uses the current chat model unless `answer.extractionModels` is set. `PI_ASK_LOCALE=zh` localizes the dialog cards and result summaries (Simplified Chinese).

| Key | Default | Effect |
| --- | --- | --- |
| `expiry.enabled` | `true` | `false` drops `timeoutSeconds` and `fallback` from the schema |
| `expiry.minSeconds` | `30` | Shorter limits are raised to this floor |
| `behaviour.background` | `true` | `false` drops `background`; every call blocks |

Schema settings apply on `/reload`, not live. A disabled field is absent from the schema, not ignored.

> Unreleased: `background`, `timeoutSeconds`, `fallback` and the `queued` / `deferred` / `expired` statuses are the 0.2.0 contract and are not registered yet.

## Context footprint

Recurring model-facing contribution of `ask_user`, measured with `npm run tokens` (character proxy: `ceil(chars / 4)`, not provider billing):

| Part | Chars | Est. tokens |
| --- | ---: | ---: |
| description | 148 | 37 |
| prompt snippet | 103 | 26 |
| prompt guidelines | 723 | 181 |
| parameter schema | 528 | 132 |
| **total** | **1,502** | **376** |

Field-level prose lives in the guidelines; the registered schema ships without `description` keys.

A test holds the total to 450 with every optional field registered and 420 with expiry disabled.
