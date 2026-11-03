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

Input: `{ title?, questions: [{ id, label?, prompt, type: single\|multi\|text, options? }] }`.

- `text` questions have no options.
- `single` / `multi` need real options. Do not invent filler.
- Recommended options get a `description`. Never preselected.
- Typed text is never merged into option `values`.

Output:

- `status`: `submitted` | `cancelled` | `unavailable` | `invalid`
- `answers[id]`: `{ values, labels, customText?, note?, optionNotes? }`
- `unanswered: id[]`

Optional config: `~/.pi/agent/extensions/pi-ask.json`. `/answer` uses the current chat model unless `answer.extractionModels` is set. `PI_ASK_LOCALE=zh` localizes the dialog cards and result summaries (Simplified Chinese).

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
