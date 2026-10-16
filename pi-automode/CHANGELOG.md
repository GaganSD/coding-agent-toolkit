# Changelog

## Unreleased

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
- Native classifier shadow review with consent binding, bounded disclosure,
  deadlines, budgets, and breaker accounting. Shadow receipts never authorize
  an action.
