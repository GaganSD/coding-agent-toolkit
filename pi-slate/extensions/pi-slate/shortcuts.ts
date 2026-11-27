import type { Keybinding, KeybindingsManager } from "@earendil-works/pi-tui";

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIER_SET = new Set<string>(MODIFIERS);
const SPECIAL = new Map<string, string>([
  ["escape", "escape"], ["esc", "esc"], ["enter", "enter"], ["return", "return"],
  ["tab", "tab"], ["space", "space"], ["backspace", "backspace"], ["delete", "delete"],
  ["insert", "insert"], ["clear", "clear"], ["home", "home"], ["end", "end"],
  ["pageup", "pageUp"], ["pagedown", "pageDown"], ["up", "up"], ["down", "down"],
  ["left", "left"], ["right", "right"],
  ...Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `f${i + 1}`] as const),
]);
const SYMBOL = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"]);

export type SlateShortcut = string | false;
export type PromptShortcut = SlateShortcut;
export const SHORTCUT_ACTIONS = [
  { id: "sidebar", label: "Toggle sidebar", detail: "Same as /slate focused" },
  { id: "prompts", label: "Prompt picker", detail: "Same as /prompts" },
  { id: "theme", label: "Theme picker", detail: "Same as /theme" },
  { id: "pid", label: "PID display", detail: "Same as /slate pid" },
  { id: "effort-border", label: "Effort border color", detail: "Same as /slate effort-border" },
  { id: "density", label: "Density", detail: "Same as /slate density (comfortable ⇄ compact)" },
  { id: "footer", label: "Composer metadata", detail: "Same as /slate footer (standard ⇄ minimal)" },
] as const;
export type ShortcutActionId = typeof SHORTCUT_ACTIONS[number]["id"];
export type SlateShortcuts = Partial<Record<ShortcutActionId, SlateShortcut>>;

const baseKey = (part: string): { key: string; needsModifier: boolean } | undefined => {
  if (part.length === 1) {
    if ((part >= "a" && part <= "z") || (part >= "0" && part <= "9") || SYMBOL.has(part)) {
      return { key: part, needsModifier: true };
    }
    return undefined;
  }
  const special = SPECIAL.get(part);
  return special === undefined ? undefined : { key: special, needsModifier: false };
};

export function parseKeyChord(value: string): string | undefined {
  const parts = value.trim().toLowerCase().split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return undefined;
  const base = baseKey(parts[parts.length - 1]!);
  if (!base) return undefined;
  const mods = parts.slice(0, -1);
  if (new Set(mods).size !== mods.length || mods.some((mod) => !MODIFIER_SET.has(mod))) return undefined;
  if (base.needsModifier && mods.length === 0) return undefined;
  return [...MODIFIERS.filter((mod) => mods.includes(mod)), base.key].join("+");
}

function parseShortcut(value: unknown): SlateShortcut | undefined {
  if (value === undefined) return undefined;
  if (value === false || value === "none" || value === "") return false;
  return typeof value === "string" ? parseKeyChord(value) : undefined;
}

export function parsePromptShortcut(value: unknown): PromptShortcut | undefined {
  return parseShortcut(value);
}

export function loadShortcuts(value: unknown): SlateShortcuts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const shortcuts: SlateShortcuts = {};
  for (const { id } of SHORTCUT_ACTIONS) {
    const shortcut = parseShortcut((value as Record<string, unknown>)[id]);
    if (shortcut !== undefined) shortcuts[id] = shortcut;
  }
  return Object.keys(shortcuts).length ? shortcuts : undefined;
}

export function shortcutKey(shortcuts: SlateShortcuts | undefined, id: ShortcutActionId): string | undefined {
  const key = shortcuts?.[id];
  return typeof key === "string" ? key : undefined;
}

export function promptShortcutKey(shortcuts: SlateShortcuts | undefined): string | undefined {
  return shortcutKey(shortcuts, "prompts");
}

export function sidebarShortcutKey(shortcuts: SlateShortcuts | undefined): string | undefined {
  return shortcutKey(shortcuts, "sidebar");
}

// Mirrors Pi's extension runner conflict policy; other Pi bindings can be overridden.
const RESERVED = new Set<string>([
  "app.interrupt", "app.clear", "app.exit", "app.suspend", "app.thinking.cycle", "app.model.cycleForward",
  "app.model.cycleBackward", "app.model.select", "app.tools.expand", "app.thinking.toggle", "app.editor.external",
  "app.message.copy", "app.message.followUp", "tui.input.submit", "tui.select.confirm", "tui.select.cancel",
  "tui.input.copy", "tui.editor.deleteToLineEnd",
]);

export type KeyClassification = { kind: "free" } | { kind: "pi" | "reserved"; description: string }
  | { kind: "moved"; from: ShortcutActionId } | { kind: "needs-modifier" };

export type ShortcutKeys = Pick<KeybindingsManager, "getResolvedBindings" | "getDefinition">;

function comparableKey(key: string): string | undefined {
  return parseKeyChord(key)?.toLowerCase().split("+").map(part =>
    part === "esc" ? "escape" : part === "return" ? "enter" : part).join("+");
}

export function classifyKey(key: string, actionId: ShortcutActionId, draft: SlateShortcuts, keys: ShortcutKeys): KeyClassification {
  const chord = comparableKey(key);
  if (!chord) return { kind: "needs-modifier" };
  let pi: KeyClassification | undefined;
  for (const [id, binding] of Object.entries(keys.getResolvedBindings())) {
    if (binding === undefined || !(Array.isArray(binding) ? binding : [binding]).some(key => comparableKey(key) === chord)) continue;
    const description = keys.getDefinition(id as Keybinding)?.description ?? id;
    if (RESERVED.has(id)) return { kind: "reserved", description };
    pi ??= { kind: "pi", description };
  }
  for (const { id } of SHORTCUT_ACTIONS) {
    const bound = shortcutKey(draft, id);
    if (id !== actionId && bound && comparableKey(bound) === chord) return { kind: "moved", from: id };
  }
  return pi ?? { kind: "free" };
}
