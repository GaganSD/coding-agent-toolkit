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

<p align="center"><strong>A Monorepo of Pi Extensions <a href="https://pi.dev">Pi</a> and <a href="https://herdr.dev">Herdr</a></strong> Mods</p>

<p align="center">
  <a href="https://github.com/GaganSD/coding-agent-toolkit/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/GaganSD/coding-agent-toolkit/publish.yml?branch=main&style=flat-square&label=CI&color=10b981&labelColor=18181b" alt="CI Status" /></a>
  <a href="https://github.com/GaganSD/coding-agent-toolkit/actions/workflows/quickstart.yml"><img src="https://img.shields.io/github/actions/workflow/status/GaganSD/coding-agent-toolkit/quickstart.yml?branch=main&style=flat-square&label=Quickstart&color=10b981&labelColor=18181b" alt="Quickstart CI Status" /></a>
  <a href="https://snyk.io"><img src="https://img.shields.io/badge/security-snyk%20monitored-10b981?style=flat-square&labelColor=18181b&logo=snyk&logoColor=white" alt="Security: Snyk" /></a>
  <a href="https://github.com/GaganSD/coding-agent-toolkit/actions"><img src="https://img.shields.io/badge/vulnerabilities-0%20reported-10b981?style=flat-square&labelColor=18181b" alt="Vulnerabilities: 0" /></a>
  <br />
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/pi-%3E%3D1.0.0-27272a?style=flat-square&labelColor=18181b" alt="Pi >= 1.0.0" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-27272a?style=flat-square&labelColor=18181b" alt="License: MIT" /></a>
</p>

---

A monorepo of **Pi coding-agent extensions** and **Herdr mods**. Each integrates natively with its host, with minimal overhead and focused functionality. Pi extensions and Herdr mods are installed separately.

- [Pi extensions](#pi-extensions): terminal UI, subagent delegation, web search, interactive interviews, and permission controls.
- [Herdr mods](#herdr-mods): a local-first token-usage dashboard for Pi, Codex, Claude Code, and OpenCode sessions.

## Design Principles

- **Minimal by Design** — Focused tools with minimal overhead. Pi prompts and schemas stay small to preserve the agent's context window.
- **Keyless by Default** — Public web and code retrieval work without API keys; Insights reads local session data without an account.
- **Native Integration** — Pi extensions use Pi's extension lifecycle, tools, slash commands, and themes. Herdr mods use Herdr's native mod system.

---

## Pi extensions

| Package | Description | Install |
| :--- | :--- | :--- |
| [pi-slate](./pi-slate/) | Minimal full-screen terminal UI with split sidebars and media previews. Zero context bloat. | `pi install npm:pi-slate` |
| [pi-subagents](./pi-subagents/) | Tiny, benchmarked subagent harness with 88% less token overhead ([benchmarks](./benchmarks/README.md)). | `pi install npm:@gagansd/pi-subagents` |
| [pi-web-search](./pi-web-search/) | Cited public web and code search. Keyless by default with optional ranking. | `pi install npm:@gagansd/pi-web-search` |
| [pi-ask](./pi-ask/) | Structured interactive TUI interviews for human-in-the-loop decisions. | `pi install npm:@gagansd/pi-ask` |
| [pi-automode](./pi-automode/) (beta) | Permission gate for Pi: risky calls stop for a local decision, protected paths block, exact rules cut repeated asks. | `pi install npm:@gagansd/pi-automode` |

### Install Pi extensions

#### All-in-one (local checkout)

Requires Node.js `>=22.19.0` and Pi `>=1.0.0`. Point Pi to a clone of this repository to register all five Pi extensions, skills, and Slate themes. This does **not** install Herdr mods:

```bash
git clone https://github.com/GaganSD/coding-agent-toolkit.git
cd coding-agent-toolkit
pi install .
```

Then reload Pi with `/reload`.

#### Individual extensions (npm)

Install individual extensions directly:

```bash
pi install npm:pi-slate               # Terminal UI & themes
pi install npm:@gagansd/pi-subagents  # Subagent delegation
pi install npm:@gagansd/pi-web-search # Public web & code search
pi install npm:@gagansd/pi-ask        # Clarification interviews
pi install npm:@gagansd/pi-automode   # Permission gate (opt-in, off by default)
```

---

## Herdr mods

| Mod | Description | Install |
| :--- | :--- | :--- |
| [Insights](./herdr-insights/) | Local-first token-usage dashboard with model rankings, usage trends, and an activity heatmap. Reads Pi, Codex, Claude Code, and OpenCode sessions. | From a checkout: `npm run install:local --prefix herdr-insights -- --open` |

### Install Insights

Requires [Herdr](https://herdr.dev) and **Node.js 22.15+**. No dependencies or account needed. From this repository's root:

```bash
npm run install:local --prefix herdr-insights -- --open
```

The installer validates the mod with `herdr-app check` and opens an **Insights** tab. It installs only `mods/insights/` under `~/.config/herdr-app`, leaving layouts, keys, and terminals unchanged. No Pi extension installation is required.

See the [Insights README](./herdr-insights/README.md) for standalone checkout instructions, settings, privacy details, and uninstallation, or [RECIPE.md](./herdr-insights/RECIPE.md) for the mod specification.

---

## Development & Building

### Pi extensions

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

### Herdr mods

Insights uses Node.js `22.15+`; its native validation requires Herdr. Run its checks separately from the root Pi extension suite:

```bash
npm test --prefix herdr-insights
npm run check --prefix herdr-insights
```

### Shared token counter

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

## Pi Subagent Benchmarks & Performance

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
coding-agent-toolkit/
├── pi-slate/           # Minimal TUI, custom surfaces, diff viewers & themes
├── pi-subagents/       # High-efficiency subagent delegation harness
├── pi-web-search/      # Multi-provider web & code search with classifier
├── pi-ask/             # Structured TUI interview & clarification modal
├── pi-automode/        # Parent-session permission gate with verified launcher
├── herdr-insights/     # Native Herdr mod: local coding-agent token-usage dashboard
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
