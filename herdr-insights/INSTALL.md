# Install Insights

Requires Herdr and **Node.js 22.15+**. Reuse an existing checkout when available.
Follow Herdr's `AGENTS.md`; this guide does not override its review requirements.
`RECIPE.md` describes rebuilding, not installation.

## Install

From the parent of `herdr-insights/`:

```sh
npm run install:local --prefix herdr-insights
```

Only that folder is needed; no `npm install` is required. The installer copies
the mod, records ownership, configures the local Node path, and runs
`herdr-app check`. Existing usage data, layouts, keys, and terminals stay intact.

Finish when the installer exits successfully with **`herdr-app check passed`**.
Report failures and stop; do not force overwrites or rebuild to bypass errors.
Do not run developer tests or change tabs/focus during installation. Never
launch a second Herdr instance.

## Open only if requested

```sh
herdr-app do tab.new '{"name":"Insights","mod":"insights"}'
```

## Uninstall

Usage data and locally edited/unowned files are preserved:

```sh
npm run uninstall:local --prefix herdr-insights
```
