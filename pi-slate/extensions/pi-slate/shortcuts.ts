import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKeybindings, isKittyProtocolActive, Key, matchesKey, setKittyProtocolActive, TUI_KEYBINDINGS, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { COMPOSER_SELECTION_KEYS } from "./composer-selection.ts";

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIER_SET = new Set<string>(MODIFIERS);
const SPECIAL = new Map<string, string>([
  ["escape", "escape"], ["esc", "escape"], ["enter", "enter"], ["return", "enter"],
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
  { id: "density", label: "Density", detail: "Toggles comfortable ⇄ compact" },
  { id: "footer", label: "Composer metadata", detail: "Toggles standard ⇄ minimal" },
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
  return special === undefined ? undefined : { key: special, needsModifier: special === "space" };
};

function normalizeChord(value: string, requireModifier: boolean): string | undefined {
  const chord = value.trim().toLowerCase();
  const plus = chord === "+" || /\+\s*\+$/.test(chord);
  const parts = (plus ? chord.slice(0, -1) : chord).split("+").map(part => part.trim());
  const base = baseKey(plus ? "+" : parts.at(-1)!);
  if (!base) return undefined;
  const mods = parts.slice(0, -1);
  if (new Set(mods).size !== mods.length || mods.some(mod => !MODIFIER_SET.has(mod))) return undefined;
  if (requireModifier && base.needsModifier && !mods.some(mod => mod !== "shift")) return undefined;
  return [...MODIFIERS.filter(mod => mods.includes(mod)), base.key].join("+");
}

export function parseKeyChord(value: string): string | undefined {
  return normalizeChord(value, true);
}

// Ask Pi which raw legacy inputs it dispatches to each chord, including terminals
// that send control bytes alongside Kitty events. Check overlap within each mode.
const LEGACY_INPUTS = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).flatMap(raw => [raw, `\x1b${raw}`]);
const legacyCache = new Map<string, Set<string>[]>();
function legacyInputs(key: string): Set<string>[] {
  const cached = legacyCache.get(key);
  if (cached) return cached;
  const previous = isKittyProtocolActive();
  try {
    const inputs = [false, true].map(kitty => {
      setKittyProtocolActive(kitty);
      return new Set(LEGACY_INPUTS.filter(data => matchesKey(data, key as KeyId)));
    });
    legacyCache.set(key, inputs);
    return inputs;
  } finally { setKittyProtocolActive(previous); }
}

function sameChord(a: string, b: string): boolean {
  const left = normalizeChord(a, false), right = normalizeChord(b, false);
  return !!left && !!right && (left === right || legacyInputs(left).some((inputs, mode) =>
    [...inputs].some(data => legacyInputs(right)[mode]!.has(data))));
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
    if (shortcut === undefined) continue;
    if (shortcut && shortcutOwners(shortcut, id, shortcuts).length) continue;
    shortcuts[id] = shortcut;
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

// Mirrors Pi's runner's reserved app bindings. On cold load there may be no
// host manager yet (or Pi and the extension may have separate module copies).
const WINDOWS_KEYS = process.platform === "win32" || (process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP));
type Binding = string | readonly string[] | undefined;
const RESERVED_APP: Record<string, Binding> = {
  "app.interrupt": "escape", "app.clear": "ctrl+c", "app.exit": "ctrl+d",
  "app.suspend": process.platform === "win32" ? [] : "ctrl+z", "app.thinking.cycle": "shift+tab",
  "app.model.cycleForward": "ctrl+p", "app.model.cycleBackward": WINDOWS_KEYS ? "alt+p" : "shift+ctrl+p",
  "app.model.select": "ctrl+l", "app.tools.expand": "ctrl+o", "app.thinking.toggle": "ctrl+t",
  "app.editor.external": "ctrl+g", "app.message.copy": "ctrl+x", "app.message.followUp": WINDOWS_KEYS ? "ctrl+q" : "alt+enter",
};
const RESERVED = new Set([
  ...Object.keys(RESERVED_APP), "tui.input.submit", "tui.select.confirm", "tui.select.cancel", "tui.input.copy", "tui.editor.deleteToLineEnd",
]);
const LEGACY_IDS: Record<string, string> = {
  "app.interrupt": "interrupt", "app.clear": "clear", "app.exit": "exit", "app.suspend": "suspend",
  "app.thinking.cycle": "cycleThinkingLevel", "app.model.cycleForward": "cycleModelForward", "app.model.cycleBackward": "cycleModelBackward",
  "app.model.select": "selectModel", "app.tools.expand": "expandTools", "app.thinking.toggle": "toggleThinking",
  "app.editor.external": "externalEditor", "app.message.followUp": "followUp", "tui.input.submit": "submit",
  "tui.select.confirm": "selectConfirm", "tui.select.cancel": "selectCancel", "tui.input.copy": "copy", "tui.editor.deleteToLineEnd": "deleteToLineEnd",
};
const isViewport = (id: string) => id.startsWith("tui.altScreen.");

export type ShortcutKeys = {
  getResolvedBindings(): Record<string, Binding>;
  getDefinition(id: Keybinding): { description?: string } | undefined;
};

// Pi's file schema requires exact base spelling (including pageUp/pageDown).
const PI_BASE_KEYS = new Set<string>(Object.values(Key).filter(value => typeof value === "string"));
const validPiKey = (value: unknown): value is string => {
  if (typeof value !== "string" || /\s/.test(value) || !normalizeChord(value, false)) return false;
  const base = value.replace(/^(?:(?:ctrl|shift|alt|super)\+)*/, "");
  return PI_BASE_KEYS.has(base) || /^[a-z0-9]$/.test(base);
};

export function loadShortcutKeys(agentDir: string): ShortcutKeys {
  // Read fresh remaps: on /reload, the host updates its manager after loading extensions.
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8").replace(/^\uFEFF/, "")) ?? {}; } catch { /* Pi uses defaults */ }
  const host = getKeybindings();
  const tui: Readonly<Record<string, { defaultKeys: Binding }>> = TUI_KEYBINDINGS;
  const viewport = Object.keys({ ...tui, ...host.getResolvedBindings() }).filter(isViewport);
  const hasHostApp = !!host.getDefinition("app.interrupt" as Keybinding);
  const bindings: Record<string, Binding> = {};
  for (const id of [...RESERVED, ...viewport]) {
    const fallback = id === "tui.altScreen.search" && WINDOWS_KEYS ? "ctrl+f"
      : id === "tui.altScreen.previousPrompt" && WINDOWS_KEYS ? "ctrl+up"
      : id === "tui.altScreen.nextPrompt" && WINDOWS_KEYS ? "ctrl+down"
      : RESERVED_APP[id] ?? tui[id]?.defaultKeys;
    const value = Object.hasOwn(raw, id) ? raw[id] : raw[LEGACY_IDS[id] ?? ""];
    bindings[id] = validPiKey(value) || (Array.isArray(value) && value.every(validPiKey)) ? value
      : (hasHostApp ? host.getDefinition(id as Keybinding)?.defaultKeys : undefined) ?? fallback;
  }
  return {
    getResolvedBindings: () => bindings,
    getDefinition: id => host.getDefinition(id),
  };
}

type BlockedKey = { kind: "reserved"; description: string } | { kind: "viewport" } | { kind: "editor" };
export type KeyClassification = BlockedKey | { kind: "free" } | { kind: "pi"; description: string }
  | { kind: "moved"; from: ShortcutActionId } | { kind: "needs-modifier" | "unsupported" };

export function blockedShortcutText(result: BlockedKey): string {
  if (result.kind === "viewport") return "Used by Pi's viewport";
  if (result.kind === "editor") return "Used by Slate's editor";
  return `Reserved by Pi: ${result.description}`;
}

export function shortcutOwners(key: string, actionId: ShortcutActionId, draft: SlateShortcuts): ShortcutActionId[] {
  return SHORTCUT_ACTIONS.map(({ id }) => id).filter(id => {
    const bound = shortcutKey(draft, id);
    return id !== actionId && bound !== undefined && sameChord(key, bound);
  });
}

export function classifyKey(key: string, actionId: ShortcutActionId, draft: SlateShortcuts, keys: ShortcutKeys, ownsEditor = false): KeyClassification {
  const chord = parseKeyChord(key);
  if (!chord) return { kind: "needs-modifier" };
  let pi: KeyClassification | undefined, viewport = false;
  for (const [id, binding] of Object.entries(keys.getResolvedBindings())) {
    if (binding === undefined || !(Array.isArray(binding) ? binding : [binding]).some(key => sameChord(chord, key))) continue;
    const description = keys.getDefinition(id as Keybinding)?.description ?? id;
    if (RESERVED.has(id)) return { kind: "reserved", description };
    if (isViewport(id)) viewport = true;
    else pi ??= { kind: "pi", description };
  }
  if (viewport) return { kind: "viewport" };
  if (ownsEditor && COMPOSER_SELECTION_KEYS.some(key => sameChord(chord, key))) return { kind: "editor" };
  const [from] = shortcutOwners(chord, actionId, draft);
  return from ? { kind: "moved", from } : pi ?? { kind: "free" };
}
