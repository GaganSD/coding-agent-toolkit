import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pi from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import type { Profile, Task } from "./types.ts";
import { keys, modelName, object, text, thinkingLevel } from "./validation.ts";

/** Starter for agent-authored templates. It is a guide to copy, never a launchable role. */
export const STARTER = fileURLToPath(new URL("../skills/pi-subagents/template.md", import.meta.url));
export const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_TEMPLATE_BYTES = 32768;

export interface TemplateFolders { global: string; project?: string }
export interface SkippedTemplate { source: string; error: string }
export interface Templates {
  templates: Map<string, Profile>;
  /** Names whose highest-precedence file failed to load: never silently fall back to another file. */
  broken: Map<string, string>;
  skipped: SkippedTemplate[];
  folders: TemplateFolders;
  /** The project folder exists but could not be read, so no template name can be resolved safely. */
  unreadable?: string;
}

/**
 * Project templates become sub-agent system prompt text, so they need an explicit,
 * saved trust decision for the target directory (or an ancestor) in Pi's trust store.
 * The owning session's trust flag is not enough: Pi treats a project with no
 * trust-requiring resources as trusted without asking, and a task may target any cwd.
 * Fails closed when the host has no trust store API.
 */
export function projectTrusted(agentDir: string, cwd: string): boolean {
  const Store = (pi as { ProjectTrustStore?: new (dir: string) => { get(cwd: string): boolean | null } }).ProjectTrustStore;
  if (typeof Store !== "function") return false;
  try { return new Store(agentDir).get(cwd) === true; } catch { return false; }
}

/** `trusted` must be a positive trust decision for this exact target; see projectTrusted. */
export function templateFolders(agentDir: string, cwd: string, trusted: boolean): TemplateFolders {
  return {
    global: path.join(agentDir, "subagent-templates"),
    ...(trusted ? { project: path.join(cwd, ".pi", "subagent-templates") } : {}),
  };
}

export function parseTemplate(contents: string, source: string): Profile {
  if (Buffer.byteLength(contents) > MAX_TEMPLATE_BYTES) throw new Error(`Template too large: ${source}`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(contents);
  if (!match) throw new Error(`Missing YAML frontmatter: ${source}`);
  let raw: unknown;
  try {
    raw = parse(match[1]!, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter: ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const data = object(raw, source);
  keys(data, ["name", "description", "mode", "model", "thinking"], source);
  const name = text(data.name, "template name", 64);
  if (!NAME.test(name)) throw new Error(`Invalid template name: ${name}`);
  if (path.basename(source, ".md") !== name) throw new Error(`Template name must match filename: ${source}`);
  if (data.mode !== "inspect" && data.mode !== "edit") throw new Error(`Template '${name}' needs mode: inspect or edit`);
  return {
    name, description: text(data.description, "description", 512), mode: data.mode,
    model: data.model === undefined ? undefined : modelName(data.model),
    thinking: data.thinking === undefined ? undefined : thinkingLevel(data.thinking),
    prompt: text(match[2], "role prompt", 30000).trim(), source,
  };
}

/** Flat, regular Markdown files. Project templates override global ones by name. */
export async function loadTemplates(agentDir: string, cwd: string, trusted: boolean): Promise<Templates> {
  const folders = templateFolders(agentDir, cwd, trusted);
  const templates = new Map<string, Profile>();
  const broken = new Map<string, string>();
  const skipped: SkippedTemplate[] = [];
  let unreadable: string | undefined;
  for (const root of [folders.global, ...(folders.project ? [folders.project] : [])]) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      const message = errorMessage(error).slice(0, 512);
      skipped.push({ source: root, error: message });
      // An unchecked higher-precedence folder could hold an override for any name.
      if (root === folders.project) unreadable = message;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const source = path.join(root, entry.name);
      try {
        if ((await stat(source)).size > MAX_TEMPLATE_BYTES) throw new Error(`Template too large: ${source}`);
        const template = parseTemplate(await readFile(source, "utf8"), source);
        templates.set(template.name, template);
        broken.delete(template.name);
      } catch (error) {
        // One broken file must not disable the others; list discloses what was skipped and why.
        // A broken override hides any lower-precedence file with that name instead of falling back to it.
        const message = errorMessage(error).slice(0, 512);
        skipped.push({ source, error: message });
        const name = entry.name.slice(0, -3);
        templates.delete(name);
        broken.set(name, message);
      }
    }
  }
  return { templates, broken, skipped, folders, ...(unreadable ? { unreadable } : {}) };
}

/** A task's effective role: an optional saved template plus optional inline instructions. */
export function resolveRole(task: Task, templates: ReadonlyMap<string, Profile>, broken: ReadonlyMap<string, string> = new Map(), unreadable?: string): Profile {
  if (task.template !== undefined && unreadable) throw new Error(`Template '${task.template}' cannot be resolved: the project template folder is unreadable (${unreadable}). Inline roles still work.`);
  const failure = task.template === undefined ? undefined : broken.get(task.template);
  if (failure) throw new Error(`Template '${task.template}' failed to load: ${failure}`);
  const template = task.template === undefined ? undefined : templates.get(task.template);
  if (task.template !== undefined && !template) throw new Error(`Unknown template '${task.template}'. Use list to see saved templates, or pass inline role instructions.`);
  const mode = task.mode ?? template?.mode;
  if (!mode) throw new Error("Each task needs mode (inspect or edit) unless its template sets one");
  const prompt = [template?.prompt, task.role].filter((part): part is string => Boolean(part)).join("\n\n");
  return {
    name: task.name ?? template?.name ?? (mode === "edit" ? "worker" : "inspector"),
    description: template?.description ?? "Inline role",
    mode, prompt,
    ...(template?.model ? { model: template.model } : {}),
    ...(template?.thinking ? { thinking: template.thinking } : {}),
    source: template?.source ?? "inline",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
