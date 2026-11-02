# Install Insights

Requires **Node.js 22.15+** and a running Herdr. Never launch a second Herdr instance.
Follow Herdr's `AGENTS.md`; this guide does not override its review requirements.
Use the existing build, not `RECIPE.md` (rebuilding).

## Install

From the parent of `herdr-insights/`; no `npm install` needed:

```sh
npm run install:local --prefix herdr-insights
```

App home defaults to `$HERDR_APP_HOME` or `~/.config/herdr-app`.
The installer checks temporary copies of both mods before replacing live files.
First install creates/selects `<current-layout>-insights` (suffixing collisions)
and adds **Insights** beside Files/Changes. Reinstall updates owned mods without
rewriting layouts or changing the selected layout. Shipped files, tabs, terminals,
keys, click state, and usage data are preserved.

Success requires two `herdr-app check passed` messages **and exit code 0**.
Do not run developer tests or change tabs during installation. Open the dashboard
only if requested: click **Insights**, or add `-- --open` to the install command.

## Errors

Stop and report; do not force overwrites or rebuild to bypass errors. The layout
must contain the native `tabs` block. Preserve local edits and any failed layout
clone. Remove the app home's `.insights-install.lock` directory only after
confirming no installer/uninstaller is running.
