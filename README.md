# pi-extensions

Extensions, skills, and themes for the [Pi](https://pi.dev) coding agent. Five npm packages that share one goal: add capability without spending the agent's context window.

## Why use it

- **Small context footprint.** Prompts and tool schemas stay minimal. `@gagansd/pi-subagents` delegates a task in 718 tokens of overhead where the stock alternative spends 6,158 ([methodology](./benchmarks/README.md)).
- **Keyless by default.** Public web and code search work with no API keys. Ranking and classification are opt-in.
- **Pi-native.** Each package uses Pi's extension lifecycle, tools, slash commands, themes, and config store. No sidecar processes.
- **One install for everything.** `pi install .` from a clone registers all 5 extensions, the skills, and the Slate themes.

## What it looks like

pi-slate replaces the default UI with a split layout: conversation left, session rail right.

```text
▀▀█   Pi Agent v1.3.0                      │ SESSION
█▀ █  grok-4.6 (bedrock) · medium          │ pi-slate refactor
      /pi-slate                            │ 01a14a53 · PID 47392
                                           │
› │                                        │ Context ▓▓▓░░░░░░░░ │ 16%
                                           │ 31.6k / 200k · $0.12 · ~82/s
                                           │
                                           │ CACHED 48k        61.4k IN
                                           │ UNCACHED 7.3k       876 OUT
                                           │
                                           │ › MCP · 2 Enabled
                                           │ › Skills · 0 Loaded
                                           │ › Prompts · 10
```

## Packages

| Package | What it does | Install |
| :--- | :--- | :--- |
| [pi-slate](./pi-slate/) | Full-screen terminal UI: split sidebars, session rail, diff viewers, media previews, themes. | `pi install npm:pi-slate` |
| [pi-subagents](./pi-subagents/) | Benchmarked subagent delegation with 88% less token overhead. | `pi install npm:@gagansd/pi-subagents` |
| [pi-web-search](./pi-web-search/) | Public web and code search with citations. Keyless by default. | `pi install npm:@gagansd/pi-web-search` |
| [pi-ask](./pi-ask/) | Structured TUI interviews for human-in-the-loop decisions. | `pi install npm:@gagansd/pi-ask` |
| [pi-automode](./pi-automode/) | Permission gate. Risky calls stop for a local decision; protected paths block; exact rules cut repeated asks. Off by default. | `pi install npm:@gagansd/pi-automode` |

## Install

Everything at once, from a clone:

```bash
git clone https://github.com/GaganSD/pi-extensions.git
cd pi-extensions
pi install .
```

Or single packages from npm, per the table above. Reload Pi with `/reload` after installing.

## Usage

Delegate independent work to subagents and watch the cost stay flat:

```text
/run tests, lint, and typecheck in parallel, one agent each
```

Turn on the permission gate when the agent touches production-shaped paths:

```text
/automode on
```

## Development

Prerequisites: Node.js >=22.19.0, npm >=10.0.0, Pi >=1.0.0.

```bash
npm ci --ignore-scripts
npm test              # all 5 packages
npm run typecheck
npm run test:tooling  # repo scripts
npm run secrets:scan
```

Local edits apply on `/reload` when installed from a clone.

## Repository layout

```text
pi-slate/       Terminal UI, diff viewers, themes
pi-subagents/   Subagent delegation harness
pi-web-search/  Web and code search
pi-ask/         TUI interview modal
pi-automode/    Permission gate
benchmarks/     Delegation benchmark suite
docs/           Architecture, CI/CD, release guides
scripts/        Build, test, security, release tooling
```

## Quality

Every pull request runs type checks, unit and integration suites, clean consumer installs, dependency audits, and a [Gitleaks](https://github.com/gitleaks/gitleaks) scan. Releases publish to npm from CI with provenance; see [docs/ci-cd.md](./docs/ci-cd.md).

## License

[MIT](./LICENSE)
