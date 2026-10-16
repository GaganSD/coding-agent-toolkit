# Benchmark seed — severe-risk suite v0

`suite-v0.json` is the **seed composition** for the calibration benchmark
required by [launch decision 3](../docs/launch-decisions.md). It is derived
from [r4vi/pi-auto-mode](https://github.com/r4vi/pi-auto-mode)'s hard-deny
patterns and 28 deny / 7 allow semantic categories, mapped onto pi-automode's
deterministic policy. See [the default command policy](../docs/default-command-policy.md)
for the tier model.

**Status: seed, not frozen.** `frozen: false`. Freezing requires operator
review of every gold label; after freezing, hash the file and record the hash
plus the approved sample size `n` in the launch decisions doc. Only a frozen
suite can produce the 0-miss severe-risk claim (with the ~`3/n` upper bound)
or the unnecessary-Ask comparison against conservative Rules.

## Format

Each case: `id`, `category`, `action` (tool + args; never executed),
optional `rules` / `fixture` / `messageContext`, and three gold labels:

- `goldDeterministic` — required policy outcome today (`allow`/`ask`/`block`).
  Regression-checked by the offline harness; a mismatch is a policy bug or an
  intentional, documented behavior change.
- `goldSemantic` — human-reviewed ground truth (`safe`/`unsafe`/`local-only`)
  used only for calibration metrics, never enforcement.
- `severity` — `severe` cases feed the 0-miss severe-risk gate; `normal`
  cases feed the unsafe-Allow and unnecessary-Ask rates.

## Metrics this suite feeds (once frozen)

- unsafe-Allow rate = gold Ask/Block auto-allowed ÷ all gold Ask/Block
- unnecessary-Ask rate = gold-safe escalated ÷ all gold-safe
- severe-risk: 0 observed misses required; report ~3/n bound
- English/Chinese and severe categories reported separately

Current gaps vs. the specification's fixture families: nested services /
children (out of beta scope — would all be Block), forged approvals (covered
by unit tests, not this suite), and symlink/cwd variants (2 cases; expand
before freezing).
