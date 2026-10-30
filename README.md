<table align="center"><tr><td>

```text
    .--------------------------.
   /                          /|
  +--------------------------+ |
  | .----------------------. | |
  | | /> π_                | | |
  | |                      | | |
  | |                      | | |
  | |                      | | |
  | '----------------------' | |
  |      [====]  (o)  (*)    |/
  +--------------------------+
 /____________________________\
'------------------------------'
```

</td></tr></table>

<p align="center"><strong>Coding Agent Tools For Herdr and <a href="https://pi.dev">Pi</a></strong></p>

<p align="center">
  <a href="https://github.com/GaganSD/pi-extensions/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/GaganSD/pi-extensions/publish.yml?branch=main&style=flat-square&label=CI&color=10b981&labelColor=18181b" alt="CI Status" /></a>
  <a href="https://github.com/GaganSD/pi-extensions/actions/workflows/quickstart.yml"><img src="https://img.shields.io/github/actions/workflow/status/GaganSD/pi-extensions/quickstart.yml?branch=main&style=flat-square&label=Quickstart&color=10b981&labelColor=18181b" alt="Quickstart CI Status" /></a>
  <a href="https://snyk.io"><img src="https://img.shields.io/badge/security-snyk%20monitored-10b981?style=flat-square&labelColor=18181b&logo=snyk&logoColor=white" alt="Security: Snyk" /></a>
  <a href="https://github.com/GaganSD/pi-extensions/actions"><img src="https://img.shields.io/badge/vulnerabilities-0%20reported-10b981?style=flat-square&labelColor=18181b" alt="Vulnerabilities: 0" /></a>
  <br />
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%3E%3D1.0.0-27272a?style=flat-square&labelColor=18181b" alt="Pi >= 1.0.0" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-27272a?style=flat-square&labelColor=18181b" alt="License: MIT" /></a>
</p>

---

A monorepo of modular extensions engineered specifically for the Pi coding agent. Each package adheres to strict context-efficiency principles, zero-bloat architecture, and native Pi integration. Detailed subagent delegation benchmarks live in [`benchmarks/README.md`](./benchmarks/README.md).

## Design Principles

- **Minimal by Design** — Engineered for zero-context bloat and preserve the agent's context window. Prompts and schemas stay minimal while benchmaxxing every tool for effectiveness.
- **Keyless by Default** — Essential utilities like public web and code retrieval work instantly out of the box.
- **Pi-Native** — Built strictly around Pi's extension lifecycle, tools, custom slash commands, themes, and configuration store.

---

## Packages

| Package | Description | Install |
| :--- | :--- | :--- |
| [pi-slate](./pi-slate/) | Minimal full-screen terminal UI with split sidebars and media previews. Zero context bloat. | `pi install npm:pi-slate` |
| [pi-subagents](./pi-subagents/) | Tiny, benchmarked subagent harness with 88% less token overhead ([benchmarks](./benchmarks/README.md)). | `pi install npm:@gagansd/pi-subagents` |
| [pi-web-search](./pi-web-search/) | Cited public web and code search. Keyless by default with optional ranking. | `pi install npm:@gagansd/pi-web-search` |
| [pi-ask](./pi-ask/) | Structured interactive TUI interviews for human-in-the-loop decisions. | `pi install npm:@gagansd/pi-ask` |
| [pi-automode](./pi-automode/) (beta) | Permission gate for Pi: risky calls stop for a local decision, protected paths block, exact rules cut repeated asks. | `pi install npm:@gagansd/pi-automode` |

---

## Herdr mods

[Insights](./herdr-insights/) is a native token-usage dashboard for
[Herdr](https://herdr.dev), with model rankings, usage trends, and an activity
heatmap. It reads local Pi, Codex, Claude Code, and OpenCode sessions. Install it
separately from the Pi extensions; see its [README](./herdr-insights/README.md).

## Installation

### All-in-One Suite (Monorepo)

Point Pi to a clone of this repository to register all 5 extensions, skills, and Slate themes simultaneously:

```bash
git clone https://github.com/GaganSD/pi-extensions.git
cd pi-extensions
pi install .
```

Then reload Pi with `/reload`.

### Standalone (NPM)

Install individual extensions directly:

```bash
pi install npm:pi-slate               # Terminal UI & themes
pi install npm:@gagansd/pi-subagents  # Subagent delegation
pi install npm:@gagansd/pi-web-search # Public web & code search
pi install npm:@gagansd/pi-ask        # Clarification interviews
pi install npm:@gagansd/pi-automode   # Permission gate (opt-in, off by default)
```

---

## Development & Building

**Prerequisites**: Node.js `>=22.19.0`, npm `>=10.0.0`, Pi `>=1.0.0`.

```bash
npm ci --ignore-scripts
npm test              # unit & integration
npm run typecheck
npm run test:tooling
npm run secrets:scan
npm run build --prefix pi-slate       # or pi-subagents, pi-web-search, pi-ask, pi-automode
```

After `pi install .`, local edits apply on `/reload`.

### Token counter

After installing root development dependencies, count literal text locally (no API calls):

```bash
node scripts/tokens.mjs --text "hello world"
node scripts/tokens.mjs --file pi-ask/src/index.ts
printf 'hello world' | node scripts/tokens.mjs
node scripts/tokens.mjs --text "hello world" --encoding cl100k_base
# {"tokens":2,"encoding":"cl100k_base","scope":"text-only"}
```

Shared repository scripts/tests can import `countTokens(text, { encoding })` from
`scripts/tokens.mjs`; the encoding defaults to `o200k_base`. Encoders are cached
for repeated calls. Counts are exact for the selected tokenizer, **not universal
model counts** (e.g. Claude/Gemini), and exclude chat framing, tool schemas not
included in the input, images, and provider overhead. Input whitespace is preserved;
stdin adds no newline of its own. Special-token-looking strings are counted as
literal text. This is development tooling, not a runtime dependency shipped with
individual extensions.

---

## Benchmarks & Performance

`@gagansd/pi-subagents` is continuously benchmarked against standard delegation alternatives on dynamic multi-step workflows (parallel join, bounded repair, conditional fanout):

| Metric | `@gagansd/pi-subagents` | `pi-subagents` | Improvement |
| :--- | :--- | :--- | :--- |
| **Package Size** | **103.35 KB** | 11.60 MB | **99.11% reduction** |
| **Initial Token Overhead** | **718** | 6,158 | **88.34% reduction** |
| **Avg Tokens (5 tasks · Kimi-K3)** | **331,346** | 638,964 | **48.14% fewer tokens** |
| **Avg Tokens (5 tasks · Grok-4.6)** | **256,451** | 979,286 | **73.81% fewer tokens** |

See [`benchmarks/README.md`](./benchmarks/README.md) for full benchmark methodology, runner scripts, and scoring criteria.

---

## Repository Structure

```text
pi-extensions/
├── pi-slate/           # Minimal TUI, custom surfaces, diff viewers & themes
├── pi-subagents/       # High-efficiency subagent delegation harness
├── pi-web-search/      # Multi-provider web & code search with classifier
├── pi-ask/             # Structured TUI interview & clarification modal
├── pi-automode/        # Parent-session permission gate with verified launcher
├── benchmarks/         # Multi-model workflow benchmarking suite
├── docs/               # Architecture, CI/CD, and release guides
└── scripts/            # Build, test, security scanning, and release tools
```

---

## Quality & Security

- **Continuous Integration**: Every change runs type checks, unit/integration suites, clean consumer installations, and secret scans via GitHub Actions.
- **Secret Protection**: Automated pre-commit and CI scans with [Gitleaks](https://github.com/gitleaks/gitleaks) to prevent credential leaks.
- **Dependency Auditing**: Vulnerability scans with Snyk and `npm audit`.

See [CI/CD Documentation](./docs/ci-cd.md) for release workflows and release preparation details.

---

## License

[MIT](./LICENSE) © [Gagan Devagiri](https://github.com/GaganSD)
