# Install Insights

Requires a running Herdr app and **Node.js 22.15+**. Reuse an existing checkout
when available. Follow Herdr's `AGENTS.md`; this guide does not override its review requirements.
`RECIPE.md` describes rebuilding, not installation.

## Install

From the parent of `herdr-insights/`:

```sh
npm run install:local --prefix herdr-insights
```

Only that folder is needed; no `npm install` is required. The installer:

- Buffers both mod trees, generates the local Node path, and runs
  `herdr-app check` on temporary copies before replacing either live mod.
  A failed check preserves the installed build; temporary check files are removed.
- Copies the validated dashboard and toolbar-button mod and records ownership.
- On first installation, uses Herdr's supported `layout.clone` to create and
  select `<current-layout>-insights` (normally `main-insights`, with a numeric
  suffix if that name or its click state is taken). It composes the
  **Insights** button beside Herdr's existing tab bar, after **Files / Changes**.
  Clicking it shows the current space's Insights tab, opening one only when the
  space has none.

Herdr's shipped layouts and mods are never patched or copied into this package.
The personal layout continues using Herdr's original `tabs` mod, so tab-bar code
updates remain available. Existing tabs, terminals, keys, and usage data stay
intact. Herdr's clone command preserves appearance and layout click state.
Reinstalling updates owned mod files without duplicating the button, rewriting
the personal layout, or switching away from the user's current layout.

The current layout must contain the standard native `tabs` block. Unsupported
layouts, unsafe source links, and edited owned mod files are refused. Existing
layout names and click-state files are skipped, never overwritten. Do not force overwrites or rebuild to bypass
errors. If installation fails after creating a layout clone, preserve it and
report the failure instead of retrying over an unowned folder/file.

Install and uninstall share an exclusive `.insights-install.lock` directory in
Herdr's app home. A second operation refuses to run. If an interrupted process
leaves this lock behind, confirm no installer/uninstaller is running before
removing the empty lock directory and retrying. Never remove a live operation's lock.

Finish when both **`herdr-app check passed`** messages appear and installation
exits successfully. Do not run developer tests or change tabs during installation.
Never launch a second Herdr instance.

## Open the dashboard only if requested

The installer adds the button without opening a dashboard tab by default. The
previously documented `--open` flag remains supported for scripts that explicitly
request a new tab after installation. To open one separately:

```sh
herdr-app do tab.new '{"name":"Insights","mod":"insights"}'
```

To select the installed toolbar layout later (normally):

```sh
herdr-app do layout.switch '{"name":"main-insights"}'
```

## Uninstall

Keep Herdr running:

```sh
npm run uninstall:local --prefix herdr-insights
```

The uninstaller returns to the original layout if the owned toolbar layout is
active, removes that layout only if unchanged, and removes unchanged owned mod
files. Usage data and locally edited/unowned files are preserved. An edited
personal toolbar layout blocks removal before any files are deleted; preserve or
move that layout and `data/insights/toolbar-install.json` before retrying.
Herdr-managed click state is left untouched, including on uninstall. A future
installation chooses another free name rather than overwriting that state.
