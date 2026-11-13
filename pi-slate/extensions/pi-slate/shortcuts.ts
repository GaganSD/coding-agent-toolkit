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

export type PromptShortcut = string | false;
export type SlateShortcuts = { prompts?: PromptShortcut };

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

export function parsePromptShortcut(value: unknown): PromptShortcut | undefined {
  if (value === undefined) return undefined;
  if (value === false || value === "none" || value === "") return false;
  return typeof value === "string" ? parseKeyChord(value) : undefined;
}

export function loadShortcuts(value: unknown): SlateShortcuts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prompts = parsePromptShortcut((value as { prompts?: unknown }).prompts);
  return prompts === undefined ? undefined : { prompts };
}

export function promptShortcutKey(shortcuts: SlateShortcuts | undefined): string | undefined {
  return typeof shortcuts?.prompts === "string" ? shortcuts.prompts : undefined;
}
