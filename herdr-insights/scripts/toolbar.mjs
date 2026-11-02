import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertNoSymlinkComponents, dataDir, ensureDirectory, HASH_RE, herdrFailure,
  lstatOrNull, runHerdr, sha256, writeFileAtomic,
} from "./lib.mjs";

const RECORD = "toolbar-install.json";
const OWNER = "herdr-insights-toolbar";
const BUTTON_ID = "insights-toolbar-button";
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function assertName(name) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`Unsupported layout name: ${JSON.stringify(name)}`);
}

function layoutFile(appHome, name) {
  assertName(name);
  return path.join(appHome, "layouts", `${name}.json`);
}

function stateFile(appHome, name) {
  assertName(name);
  return path.join(appHome, "layouts", ".state", `${name}.json`);
}

async function readRegular(appHome, file) {
  await assertNoSymlinkComponents(appHome, file);
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  return fs.readFile(file, "utf8");
}

async function readRecord(appHome) {
  const file = path.join(dataDir(appHome), RECORD);
  const text = await readRegular(appHome, file);
  if (text === null) return null;
  const record = JSON.parse(text);
  if (record?.version !== 1 || record.owner !== OWNER ||
      typeof record.source !== "string" || !NAME.test(record.source) ||
      typeof record.layout !== "string" || !NAME.test(record.layout) ||
      !record.layout.startsWith(`${record.source}-insights`) ||
      typeof record.hash !== "string" || !HASH_RE.test(record.hash)) {
    throw new Error(`Invalid toolbar ownership record: ${file}`);
  }
  return record;
}

async function command(appHome, args) {
  const result = await runHerdr(args, { env: { HERDR_APP_HOME: appHome } });
  if (result.error || result.code !== 0 || result.signal) {
    throw new Error(herdrFailure(result, `herdr-app ${args.slice(0, 2).join(" ")}`));
  }
  return result.stdout;
}

/** Preserve the original tabs mod and its updates; compose one native button beside it. */
export function withInsightsToolbar(layout) {
  const copy = structuredClone(layout);
  const nodes = [];
  function walk(node) {
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  }
  walk(copy);
  if (nodes.some((node) => node.id === BUTTON_ID || node.id === "insights-original-tabs")) {
    throw new Error("This layout already contains Insights toolbar blocks.");
  }
  const matches = nodes.filter((node) => node.id === "tabs" && node.type === "block" && node.content?.mod === "tabs");
  if (matches.length !== 1) {
    throw new Error('Expected one native "tabs" block. This layout cannot be integrated safely.');
  }
  const tabs = matches[0];
  const content = tabs.content;
  delete tabs.content;
  tabs.type = "row";
  tabs.resizable = false;
  tabs.children = [
    { id: "insights-original-tabs", type: "block", size: { weight: 1 }, content },
    { id: BUTTON_ID, type: "block", size: { px: 104 }, content: { mod: "insights", props: { mode: "toolbar" } } },
  ];
  return copy;
}

export async function prepareToolbar(appHome) {
  const record = await readRecord(appHome);
  if (record) {
    const file = layoutFile(appHome, record.layout);
    if (await readRegular(appHome, file) === null) throw new Error(`Owned toolbar layout is missing: ${file}`);
    // Reinstall never rewrites a personal layout or changes the chosen layout.
    return { appHome, record };
  }
  const status = JSON.parse(await command(appHome, ["status"]));
  const source = status.layout;
  const sourceFile = layoutFile(appHome, source);
  const original = await readRegular(appHome, sourceFile);
  if (original === null) throw new Error(`Layout not found: ${sourceFile}`);
  withInsightsToolbar(JSON.parse(original)); // Validate before cloning or writing mods.
  // Native cloning also copies click state. Never let it follow a state link,
  // overwrite another layout's state, or destroy state left from an uninstall.
  await readRegular(appHome, stateFile(appHome, source));
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const layout = `${source}-insights${suffix === 1 ? "" : `-${suffix}`}`;
    const file = layoutFile(appHome, layout);
    const state = stateFile(appHome, layout);
    await assertNoSymlinkComponents(appHome, path.dirname(state));
    if (await lstatOrNull(file) || await lstatOrNull(state)) continue;
    return { appHome, source, layout, file };
  }
  throw new Error("No free Insights layout name; existing layouts and click state were preserved.");
}

export async function applyToolbar(plan) {
  if (plan.record) return;
  const { appHome, source, layout, file } = plan;
  // Checks may have taken seconds. Revalidate clone inputs immediately before
  // Herdr can copy state (its native clone may overwrite destination state).
  await readRegular(appHome, stateFile(appHome, source));
  const state = stateFile(appHome, layout);
  await assertNoSymlinkComponents(appHome, state);
  await assertNoSymlinkComponents(appHome, file);
  if (await lstatOrNull(file) || await lstatOrNull(state)) {
    throw new Error(`Toolbar destination appeared during install: ${layout}; no layout or click state replaced.`);
  }
  await command(appHome, ["do", "layout.clone", JSON.stringify({ name: source, as: layout })]);
  try {
    // The supported clone command preserves Herdr's click/appearance state.
    const cloned = await readRegular(appHome, file);
    if (cloned === null) throw new Error(`Herdr did not create ${file}`);
    const text = `${JSON.stringify(withInsightsToolbar(JSON.parse(cloned)), null, 2)}\n`;
    await writeFileAtomic(file, text);
    await ensureDirectory(appHome, dataDir(appHome), "Insights data directory");
    await writeFileAtomic(path.join(dataDir(appHome), RECORD), `${JSON.stringify({
      version: 1, owner: OWNER, source, layout, hash: sha256(text),
    }, null, 2)}\n`);
  } catch (error) {
    // Do not leave a failed integration selected; keep the clone for inspection.
    try { await command(appHome, ["do", "layout.switch", JSON.stringify({ name: source })]); } catch { /* retain original failure */ }
    throw error;
  }
  console.log(`Added Insights beside Files/Changes in personal layout ${layout}; Herdr's tabs mod is unchanged.`);
}

export async function prepareToolbarRemoval(appHome) {
  if (!appHome) return null;
  const record = await readRecord(appHome);
  if (!record) return null;
  const file = layoutFile(appHome, record.layout);
  const text = await readRegular(appHome, file);
  if (text !== null && sha256(text) !== record.hash) {
    throw new Error(`Toolbar layout was edited locally: ${file}. No files removed; preserve/move this layout and its ${RECORD} before uninstalling.`);
  }
  const status = JSON.parse(await command(appHome, ["status"]));
  const active = status.layout === record.layout;
  if (active) {
    const original = await readRegular(appHome, layoutFile(appHome, record.source));
    if (original === null) throw new Error(`Original layout ${record.source} is missing. Select another layout before uninstalling.`);
    JSON.parse(original);
  }
  return { appHome, record, file };
}

export async function removeToolbar(plan) {
  if (!plan) return;
  const { appHome, record, file } = plan;
  let current = await readRegular(appHome, file);
  if (current !== null && sha256(current) !== record.hash) throw new Error(`Toolbar layout changed during uninstall: ${file}`);
  // The person can switch layouts while preflight is running. Never trust its
  // earlier active-layout snapshot when deciding whether it is safe to delete.
  const status = JSON.parse(await command(appHome, ["status"]));
  if (status.layout === record.layout) {
    const original = await readRegular(appHome, layoutFile(appHome, record.source));
    if (original === null) throw new Error(`Original layout ${record.source} is missing. Select another layout before uninstalling.`);
    JSON.parse(original);
    await command(appHome, ["do", "layout.switch", JSON.stringify({ name: record.source })]);
    const afterSwitch = JSON.parse(await command(appHome, ["status"]));
    if (afterSwitch.layout !== record.source) throw new Error(`Herdr did not leave ${record.layout}; no files removed.`);
  }
  // Commands yield to the live app; preserve any edits made during that wait.
  current = await readRegular(appHome, file);
  if (current !== null && sha256(current) !== record.hash) throw new Error(`Toolbar layout changed during uninstall: ${file}`);
  if (current !== null) await fs.unlink(file);
  await fs.unlink(path.join(dataDir(appHome), RECORD));
  console.log(`Removed owned toolbar layout ${record.layout}; original layout ${record.source} is unchanged.`);
}
