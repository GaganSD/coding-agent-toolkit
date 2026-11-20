---
name: ask-user
description: Use to interview user to clarify gaps in context, requirements, get missing authorization, or brainstorming with the user.
---

# Ask user

Use `ask_user`. Check relevant context first; do not reconfirm settled decisions or ask just because alternatives exist. Continue authorized routine work.

Ask one decision per question. Cancellation or ambiguity is not approval; keep risky actions blocked.

`single` one choice, `multi` several, `text` free input. Unique `id`s. Recommended options get a `description`; never preselect. Typed text is not an option value.

If the schema has `background`, set it when you can keep working without the answer. The result is then a receipt, not an answer; the answer arrives later as a message. Do not ask again.

If the schema has `timeoutSeconds`, set it only when the user may be away; a `fallback` must be safe and reversible, and an expired result is not approval.

Settings: `/ask-settings` or `?` in a form. Optional file: `~/.pi/agent/extensions/pi-ask.json`. `/answer` uses the current chat model unless `answer.extractionModels` is set.
