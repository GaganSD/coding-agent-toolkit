import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKeybindings, isKittyProtocolActive, Key, matchesKey, setKittyProtocolActive, TUI_KEYBINDINGS, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { COMPOSER_SELECTION_KEYS } from "./composer-selection.ts";
import { IMAGE_EDITOR_BINDINGS } from "./image-placeholders.ts";

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
const UNSHIFTED = "`1234567890-=[]\\;'.,/";
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
const SYMBOL = new Set(UNSHIFTED + SHIFTED);
const isFunctionKey = (key: string) => /^f\d+$/.test(key);
const EDITING_KEYS = [...SPECIAL.values()].filter(key => !isFunctionKey(key));

export type SlateShortcut = string | false;
export const SHORTCUT_ACTIONS = [
  { id: "sidebar", section: "Layout", label: "Toggle sidebar", detail: "Shows or hides the sidebar.", command: "/slate focused" },
  { id: "prompts", section: "Pickers", label: "Prompt picker", detail: "Opens the prompt picker.", command: "/prompts" },
  { id: "theme", section: "Pickers", label: "Theme picker", detail: "Opens the theme picker.", command: "/theme" },
  { id: "pid", section: "Display", label: "Process ID", detail: "Shows or hides the process ID.", command: "/slate pid" },
  { id: "effort-border", section: "Display", label: "Effort border", detail: "Colors the composer border by effort.", command: "/slate effort-border" },
  { id: "density", section: "Display", label: "Spacing", detail: "Switches comfortable or compact spacing.", command: "/slate density" },
  { id: "footer", section: "Display", label: "Composer details", detail: "Switches standard or minimal composer details.", command: "/slate footer" },
] as const;
export type ShortcutActionId = typeof SHORTCUT_ACTIONS[number]["id"];
export type SlateShortcuts = Partial<Record<ShortcutActionId, SlateShortcut>>;

export const shortcutLabel = (key: string) =>
  key.replace(/(^|\+)super(?=\+)/gi, "$1Cmd/Win").replace(/(^|\+)[a-z]/g, part => part.toUpperCase());

function chordParts(value: string, aliases = false) {
  const chord = value.trim().toLowerCase();
  const plus = chord === "+" || /\+\s*\+$/.test(chord);
  const parts = (plus ? chord.slice(0, -1) : chord).split("+").map(part => part.trim());
  const part = plus ? "+" : parts.at(-1)!;
  const base = /^[a-z0-9]$/.test(part) || SYMBOL.has(part) ? part : SPECIAL.get(part);
  const mods = parts.slice(0, -1).map(mod => aliases && /^(cmd|command|win|windows)$/.test(mod) ? "super" : mod);
  if (!base || new Set(mods).size !== mods.length || mods.some(mod => !MODIFIER_SET.has(mod))) return undefined;
  return { base, mods, key: [...MODIFIERS.filter(mod => mods.includes(mod)), base].join("+") as KeyId };
}

type Chord = NonNullable<ReturnType<typeof chordParts>>;
const FUNCTION_KEYS = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24];
const KITTY_KEYS: Record<string, number> = {
  escape: 27, tab: 9, enter: 13, space: 32, backspace: 127,
  left: 57417, right: 57418, up: 57419, down: 57420, pageUp: 57421, pageDown: 57422,
  home: 57423, end: 57424, insert: 57425, delete: 57426,
};

// Probe Kitty physical/logical pairs and xterm modifyOtherKeys, which can
// report a shifted symbol directly while still carrying the Shift modifier.
function chordInputs({ base, mods }: Chord): string[] {
  const modifier = 1 + (mods.includes("shift") ? 1 : 0) + (mods.includes("alt") ? 2 : 0)
    + (mods.includes("ctrl") ? 4 : 0) + (mods.includes("super") ? 8 : 0);
  if (isFunctionKey(base)) return [`\x1b[${FUNCTION_KEYS[Number(base.slice(1)) - 1]}${mods.length ? `;${modifier}` : ""}~`];
  if (base === "clear") return modifier === 5 ? ["\x1bOe"] : modifier === 2 ? ["\x1b[e"] : ["\x1b[E"];
  const shifted = mods.includes("shift") ? SHIFTED[UNSHIFTED.indexOf(base)]?.charCodeAt(0) : undefined;
  const code = KITTY_KEYS[base] ?? base.charCodeAt(0);
  return [`\x1b[${code}${shifted ? `:${shifted}` : ""};${modifier}u`, `\x1b[27;${modifier};${shifted ?? code}~`];
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

/** Whether two Pi key names resolve to overlapping input events. */
export function keysOverlap(a: string, b: string): boolean {
  const chord = chordParts(a);
  return chord ? sameChord(chord, b) : false;
}

function sameChord(chord: Chord, value: string, data?: string): boolean {
  const other = chordParts(value);
  if (!other) return false;
  return chord.key === other.key || (data !== undefined && matchesKey(data, other.key))
    || [...chordInputs(chord), ...chordInputs(other)].some(raw => matchesKey(raw, chord.key) && matchesKey(raw, other.key))
    || legacyInputs(chord.key).some((inputs, mode) => [...inputs].some(raw => legacyInputs(other.key)[mode]!.has(raw)));
}

export function parseShortcut(value: unknown): SlateShortcut | undefined {
  if (value === false || value === "none" || value === "") return false;
  return typeof value === "string" ? chordParts(value, true)?.key : undefined;
}

const shortcutObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Keep recognizable but blocked bindings for the panel and startup diagnostics.
export function loadShortcuts(value: unknown): SlateShortcuts | undefined {
  const raw = shortcutObject(value), shortcuts: SlateShortcuts = {};
  for (const { id } of SHORTCUT_ACTIONS) {
    const shortcut = parseShortcut(raw[id]);
    if (shortcut !== undefined) shortcuts[id] = shortcut && shortcutOwners(shortcut, id, shortcuts).length ? false : shortcut;
  }
  return Object.keys(shortcuts).length ? shortcuts : undefined;
}

export const changedShortcuts = (initial: SlateShortcuts | undefined, draft: SlateShortcuts) =>
  SHORTCUT_ACTIONS.filter(({ id }) => shortcutKey(initial, id) !== shortcutKey(draft, id)).map(({ id }) => id);

function clearDuplicateShortcuts(raw: Record<string, unknown>): SlateShortcuts | undefined {
  const unique = loadShortcuts(raw);
  for (const { id } of SHORTCUT_ACTIONS) if (unique?.[id] === false && raw[id] && raw[id] !== "none") raw[id] = false;
  return unique;
}

export type RecordedShortcut = { id: ShortcutActionId; key: string; data: string };

export function mergeShortcuts(value: unknown, initial: SlateShortcuts | undefined, draft: SlateShortcuts, recorded?: RecordedShortcut) {
  const raw = { ...shortcutObject(value) }, changed = changedShortcuts(initial, draft);
  const disk = clearDuplicateShortcuts(raw); // Hidden duplicates must not inherit an unbound key.
  const refuse = (reason: string) => ({ error: `Shortcuts not saved: ${reason}. Reopen /shortcuts.` } as const);
  for (const id of changed) {
    const current = shortcutKey(disk, id), wanted = parseShortcut(draft[id]) || undefined;
    // Refuse divergent edits to the same action; identical edits can merge.
    if (current !== shortcutKey(initial, id) && current !== wanted) {
      return refuse(`${SHORTCUT_ACTIONS.find(action => action.id === id)!.label} changed in another session`);
    }
    if (draft[id] === undefined) delete raw[id];
    else raw[id] = draft[id];
  }
  const shortcuts = clearDuplicateShortcuts(raw);
  for (const { id, label } of SHORTCUT_ACTIONS) {
    if (!changed.includes(id)) {
      const current = shortcutKey(disk, id);
      if (current && current !== shortcutKey(shortcuts, id)) return refuse(`${shortcutLabel(current)} is now used by ${label}`);
      continue;
    }
    const wanted = parseShortcut(draft[id]) || undefined;
    if (wanted === shortcutKey(shortcuts, id)) continue;
    const [owner] = wanted ? shortcutOwners(wanted, id, shortcuts ?? {}) : [];
    const holder = SHORTCUT_ACTIONS.find(action => action.id === owner)?.label;
    return refuse(holder ? `${shortcutLabel(wanted!)} is now used by ${holder}` : "the draft conflicts with current bindings");
  }
  if (recorded) {
    // A Kitty physical alias may only be observable in the actual press.
    const [owner] = shortcutOwners(recorded.key, recorded.id, shortcuts ?? {}, recorded.data);
    const holder = SHORTCUT_ACTIONS.find(action => action.id === owner);
    if (holder) return refuse(`${shortcutLabel(recorded.key)} is now used by ${holder.label}`);
  }
  return { raw } as const;
}

export function shortcutKey(shortcuts: SlateShortcuts | undefined, id: ShortcutActionId): string | undefined {
  const key = shortcuts?.[id];
  return typeof key === "string" ? key : undefined;
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
  ...Object.fromEntries(IMAGE_EDITOR_BINDINGS.map(id => [id, id.slice("tui.editor.".length)])),
};
const isViewport = (id: string) => id.startsWith("tui.altScreen.");

export type ShortcutKeys = {
  getResolvedBindings(): Record<string, Binding>;
  getDefinition(id: Keybinding): { description?: string } | undefined;
};

// Pi's file schema requires exact base spelling (including pageUp/pageDown).
const PI_BASE_KEYS = new Set<string>(Object.values(Key).filter(value => typeof value === "string"));
const validPiKey = (value: unknown): value is string => {
  if (typeof value !== "string" || /\s/.test(value) || !chordParts(value)) return false;
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
  for (const id of [...RESERVED, ...viewport, ...IMAGE_EDITOR_BINDINGS]) {
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

export type KeyClassification = { kind: "reserved"; description: string }
  | { kind: "viewport" | "editor" | "global" | "editing" | "needs-modifier" | "unsupported" }
  | { kind: "free"; key: KeyId } | { kind: "pi"; key: KeyId; description: string }
  | { kind: "moved"; key: KeyId; owners: ShortcutActionId[] };

export function shortcutStatus(result: KeyClassification): string {
  switch (result.kind) {
    case "free": return "Ready";
    case "pi": return `Also bound in Pi: ${result.description}`;
    case "reserved": return `Reserved by Pi: ${result.description}`;
    case "viewport": return "Used by Pi's viewport";
    case "editor": return "Used by Slate's editor";
    case "global": return "Used by Pi";
    case "editing": return "Used for editing — add ctrl or alt";
    case "needs-modifier": return "Add Ctrl, Alt or Cmd/Win";
    case "unsupported": return "Not supported by Pi";
    case "moved": return `Moved from ${SHORTCUT_ACTIONS.find(({ id }) => id === result.owners[0])!.label}`;
  }
}

function shortcutOwners(key: string, actionId: ShortcutActionId | undefined, draft: SlateShortcuts, data?: string): ShortcutActionId[] {
  const chord = chordParts(key);
  if (!chord) return [];
  return SHORTCUT_ACTIONS.map(({ id }) => id).filter(id => {
    const bound = shortcutKey(draft, id);
    return id !== actionId && bound !== undefined && sameChord(chord, bound, data);
  });
}

function matchingPiBindings(chord: Chord, keys?: ShortcutKeys, data?: string): string[] {
  return Object.entries(keys?.getResolvedBindings() ?? {}).filter(([, binding]) =>
    binding !== undefined && (Array.isArray(binding) ? binding : [binding]).some(key => sameChord(chord, key, data))).map(([id]) => id);
}

// Pi's InteractiveMode installs onDebug; TuiBase dispatches it before editor/overlays.
type KeyContext = { id?: ShortcutActionId; draft?: SlateShortcuts; keys?: ShortcutKeys; ownsEditor?: boolean; data?: string };
export function classifyKey(value: string, { id, draft, keys, ownsEditor, data }: KeyContext = {}): KeyClassification {
  const chord = chordParts(value);
  if (!chord) return { kind: "unsupported" };
  if (!chord.mods.some(mod => mod !== "shift") && !isFunctionKey(chord.base)) {
    return { kind: chord.base.length > 1 ? "editing" : "needs-modifier" };
  }
  if (!(data === undefined ? chordInputs(chord) : [data]).some(raw => matchesKey(raw, chord.key))) return { kind: "unsupported" };
  if (sameChord(chord, "shift+ctrl+d", data)) return { kind: "global" };
  const bindings = matchingPiBindings(chord, keys, data);
  const description = (id: string) => keys?.getDefinition(id as Keybinding)?.description ?? id;
  const reserved = bindings.find(id => RESERVED.has(id));
  if (reserved) return { kind: "reserved", description: description(reserved) };
  if (EDITING_KEYS.some(key => sameChord(chord, key, data))) return { kind: "editing" };
  if (bindings.some(isViewport)) return { kind: "viewport" };
  if (ownsEditor && (IMAGE_EDITOR_BINDINGS.some(id => bindings.includes(id))
    || COMPOSER_SELECTION_KEYS.some(key => sameChord(chord, key, data)))) return { kind: "editor" };
  const owners = draft ? shortcutOwners(chord.key, id, draft, data) : [];
  const key = chord.key;
  return owners.length ? { kind: "moved", key, owners } : bindings.length
    ? { kind: "pi", key, description: description(bindings[0]!) } : { kind: "free", key };
}
