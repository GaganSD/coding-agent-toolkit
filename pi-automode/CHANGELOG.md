# Changelog

## Unreleased

- Replace Details with a clean Settings editor: seven numeric tuning values,
  contextual help, seconds/percent inputs, validation, draft Save/Cancel, and a
  reset-to-defaults action that preserves models, consent, rules, and on/off state.
  Match Pi's native full-width selectors with horizontal separators and a stable
  reserved help area; edit values inline without opening another dialog.
  Tab applies and advances; Ctrl+S saves.

- Render permission prompts, model catalogues, and Inspect details without
  styling the entire body as a title. Add scrollable JSON-highlighted inspection
  and remove its misleading Back option.
- Default approval waits to 60 seconds and model confidence to 0.67. An unanswered
  local approval may run once only with an eligible safe probability > 0.50
  meeting the confidence guard; otherwise decline. Explicit declines, lifecycle
  cancellation, privacy restrictions, hard blocks, and revalidation remain final.

- Replace natural-language/message rules with command allowlist/blocklist rules:
  exact commands, `*` globs, and an explicit safe regex mode. Legacy command
  entries migrate; message entries produce a visible configuration error.
- Add built-in command defaults in a separate source file. All blocklists
  precede allowlists; built-in read-only allows still require verified evidence.
- Index literal command prefixes rather than scanning every command pattern;
  keep matching full-string and resistant to pathological backtracking.
- Activate optional safety decisions for unmatched eligible calls. Only a
  validated `safe` answer meeting the configured threshold may authorize;
  failures and uncertainty fall back to local approval, never a hard-block override.
- Require current-version disclosure consent before command-bearing review;
  old metadata-only/shadow consent cannot silently expand.
- Add **Always Allow** with model-selected generalized command patterns and
  explicit local scope confirmation before persistence. Remove the main
  approval dialog's **Why:** line; retain reasons in details and audit records.

## 0.2.0

Release the current extension updates together.

### Security

- Pin the transitive `undici` dependency to 8.12.2 in every package lock to clear critical and high-severity Snyk findings from the Pi SDK development tree.

### Highlights

- Slate adds the opt-in Claude Code-style tool transcript and focused prompt-layout refinements.
- Automode releases its decision-model panel and safety updates, including the breaking beta configuration rename from classifier settings to `decisionModel`.
- Ask, Subagents, and Web Search receive the dependency security refresh.

- Rename the classifier to **Decision Models** throughout the extension: the
  panel entry, picker title, `automode.json` `decisionModel` key, decision-log
  field, module and type names. Pi's native `classifier` model type is
  unchanged. The state toggle is now **Toggle OFF** / **Toggle ON**, and the
  redundant On/Off subtitle is gone so the panel opens straight to its actions.
  This is a breaking rename with no legacy alias; earlier beta files need the
  `decisionModel` key.
- Consolidate the halted/config-error panel display to the state line plus a
  single reason; the repeated subtitle and duplicate config-error line are gone.
- Apply `/automode on` and `/automode off` in a single step from Pi's
  interactive terminal; the toggle confirmation dialog is gone. The live TUI
  dispatch is the decision, so any extension able to dispatch a command in
  that session can apply it; use a trusted extension stack.
- Color-code the status line and panel header: On green, Off yellow, Halted
  red.
- List every decision model in Pi's registry in the picker, with `login required`
  and `untested` availability markers and the current selection pinned as
  `[current]`. Selecting a decision model is the whole setup—no separate
  disclosure-consent dialog—and **Rules only (no decision model)** clears the
  selection in one step.
- Simplify the panel and footer, move diagnostics into Details, remove trailing
  ellipses, and combine rule type/effect into one step. Empty lists no longer
  contain selectable placeholder rows.
- Show normalized decision model destinations before the single-step disclosure
  decision, without displaying credentials from rejected endpoint URLs.
- Bind rule additions and edits to the settings epoch of the displayed rule
  list, so a configuration change while that list is open cannot be overwritten.
- Keep decision model selection unchanged when the endpoint is invalid. Distinguish
  duplicate log summaries so each opens its own record.
- Escape halt reasons, decision model disclosure fields, and approval reasons before
  terminal display. Keep internal decision sources in approval details.
- Match Pi's PATH ordering when its agent-bin directory is already present,
  including lexical agent-directory aliases; an earlier untrusted executable
  can no longer be mistaken for a trusted system binary.
- Resolve dangling symlink destinations before classifying protected writes.
- Reject oversized settings updates before replacing the readable configuration.
- Rewrite the README around setup, everyday use, and the beta's actual limits.

- Review `read`, `edit`, `write`, and `bash` through Pi's `tool_call` hook
  instead of registering replacement tool definitions. The gate no longer
  conflicts with extensions that customize those tools, and the verified
  launcher checks the hook instead of tool registration.

## 0.1.0

- First public beta of the parent-session permission gate: `/automode` panel,
  on/off, plain-text rules, bounded local decision logs, and the verified SDK
  launcher.
- Deterministic policy: workspace file floor, protected paths, byte-exact
  command rules, unresolved message blocks, and fail-closed coverage for
  unsupported tool routes.
- Native decision model shadow review with consent binding, bounded disclosure,
  deadlines, budgets, and breaker accounting. Shadow receipts never authorize
  an action.
