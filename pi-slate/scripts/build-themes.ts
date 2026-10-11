import { writeFileSync } from "node:fs";
import { allSlateThemes } from "../extensions/pi-slate/themes.ts";

/** Regenerates themes/*.json from the single registry in extensions/pi-slate/themes.ts. */
for (const theme of allSlateThemes()) {
  const path = new URL(`../themes/${theme.name}.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(theme, null, 2)}\n`);
  console.log(`wrote ${theme.name}.json`);
}
