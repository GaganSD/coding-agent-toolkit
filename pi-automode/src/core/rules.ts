import type { Rule } from "../types.js";

type Atom = { test: (char: string) => boolean; optional: boolean; repeat: boolean; literal?: string };
export interface CompiledPattern { readonly test: (text: string) => boolean; readonly prefix: string; readonly atoms: number }
/** A lookup exceeding this deterministic work bound throws, so the gate blocks
 * rather than interpreting an unfinished blocklist scan as a miss. */
const MAX_MATCH_WORK = 8_000_000;

/** Full-string, non-backtracking matching. Regex deliberately excludes groups,
 * alternation, lookaround, backreferences and counted repeats. Supported atoms:
 * literals, dot, character classes, escaped characters / d s w, and * + ?.
 * Runtime is O(input length × pattern atoms), never exponential backtracking.
 */
export function compilePattern(text: string, mode: Rule["mode"] = "glob"): CompiledPattern {
  if (text.length > 4000) throw new Error("rule pattern exceeds 4000 characters");
  const atoms: Atom[] = [];
  const literal = (char: string): Atom => ({ test: (c) => c === char, literal: char, optional: false, repeat: false });
  if (mode !== "regex") {
    for (const char of text.split("")) {
      if (mode !== "exact" && char === "*") {
        if (atoms.at(-1)?.repeat && atoms.at(-1)?.literal === undefined) continue;
        atoms.push({ test: () => true, optional: true, repeat: true });
      } else atoms.push(literal(char));
    }
  } else {
    let source = text;
    if (source.startsWith("^")) source = source.slice(1);
    // A trailing escaped dollar is a literal, not an anchor.
    let slashes = 0;
    for (let i = source.length - 2; i >= 0 && source[i] === "\\"; i--) slashes++;
    if (source.endsWith("$") && slashes % 2 === 0) source = source.slice(0, -1);
    for (let i = 0; i < source.length; i++) {
      const char = source[i]!;
      let atom: Atom;
      if (char === "\\") {
        const next = source[++i];
        if (next === undefined) throw new Error("regex ends in an escape");
        if (/[dDsSwW]/.test(next)) {
          const regex = new RegExp(`^\\${next}$`);
          atom = { test: (c) => regex.test(c), optional: false, repeat: false };
        } else if (/[^a-zA-Z0-9]/.test(next)) atom = literal(next);
        else throw new Error("unsupported regex escape; use literals or \\d \\s \\w");
      } else if (char === "[") {
        let end = i + 1;
        for (; end < source.length; end++) {
          if (source[end] === "\\") { end++; continue; }
          if (source[end] === "]") break;
        }
        if (end === source.length) throw new Error("unclosed regex character class");
        const part = source.slice(i, end + 1);
        // Only a single character class reaches the JS engine: no repetition.
        const regex = new RegExp(`^(?:${part})$`);
        atom = { test: (c) => regex.test(c), optional: false, repeat: false };
        i = end;
      } else if (char === ".") atom = { test: (c) => !/[\n\r\u2028\u2029]/.test(c), optional: false, repeat: false };
      else if (/[()|{}^$*+?\]]/.test(char)) throw new Error("unsupported regex syntax; groups, alternation and counted repeats are not supported");
      else atom = literal(char);
      const quantifier = source[i + 1];
      if (quantifier === "*" || quantifier === "+" || quantifier === "?") {
        i++;
        if (quantifier === "+") atoms.push(atom);
        atoms.push({ test: atom.test, optional: true, repeat: quantifier !== "?" });
      } else atoms.push(atom);
    }
  }
  let prefix = "";
  for (const atom of atoms) {
    if (atom.literal === undefined || atom.optional || atom.repeat) break;
    prefix += atom.literal;
  }
  const closure = (states: Uint8Array) => {
    for (let i = 0; i < atoms.length; i++) if (states[i] && atoms[i]!.optional) states[i + 1] = 1;
  };
  return { prefix, atoms: atoms.length, test: (value) => {
    if ((value.length + 1) * (atoms.length + 1) > MAX_MATCH_WORK) throw new Error("rule match exceeds bounded work budget");
    let states = new Uint8Array(atoms.length + 1);
    states[0] = 1;
    closure(states);
    for (let pos = 0; pos < value.length; pos++) {
      const next = new Uint8Array(atoms.length + 1);
      for (let i = 0; i < atoms.length; i++) {
        const atom = atoms[i]!;
        if (states[i] && atom.test(value[pos]!)) next[atom.repeat ? i : i + 1] = 1;
      }
      closure(next);
      states = next;
    }
    return states[atoms.length] === 1;
  } };
}

interface Node { children: Map<string, Node>; patterns: { pattern: CompiledPattern; rule: Rule }[] }
export interface RuleIndex { exact: Map<string, Rule>; root: Node }
const node = (): Node => ({ children: new Map(), patterns: [] });
const key = (tool: string, text: string) => `${tool}\0${text}`;

/** Exact hash lookup plus a literal-prefix trie. Only ancestor-prefix patterns
 * are considered; leading-wildcard/regex patterns necessarily share the root.
 * No claim of constant-time arbitrary regex or leading-wildcard lookup.
 */
export function compileRules(rules: readonly Rule[]): RuleIndex {
  const index: RuleIndex = { exact: new Map(), root: node() };
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const tool = rule.tool ?? "bash";
    if (rule.mode === "exact" || (rule.mode !== "regex" && !rule.text.includes("*"))) {
      const exact = key(tool, rule.text);
      if (!index.exact.has(exact)) index.exact.set(exact, rule);
      continue;
    }
    const pattern = compilePattern(rule.text, rule.mode);
    let cursor = index.root;
    for (const char of key(tool, pattern.prefix).split("")) {
      if (!cursor.children.has(char)) cursor.children.set(char, node());
      cursor = cursor.children.get(char)!;
    }
    cursor.patterns.push({ pattern, rule });
  }
  return index;
}
const cache = new WeakMap<readonly Rule[], RuleIndex>();
export function ruleIndex(rules: readonly Rule[]): RuleIndex {
  // Mutable callers must not receive a stale identity-cached index.
  if (!Object.isFrozen(rules)) return compileRules(rules);
  let index = cache.get(rules);
  if (!index) { index = compileRules(rules); cache.set(rules, index); }
  return index;
}
export function matchCompiled(index: RuleIndex, text: string, tool = "bash"): Rule | undefined {
  const exact = index.exact.get(key(tool, text));
  if (exact) return exact;
  let cursor: Node | undefined = index.root;
  let remainingWork = MAX_MATCH_WORK;
  for (const char of key(tool, text).split("")) {
    cursor = cursor.children.get(char);
    if (!cursor) break;
    for (const candidate of cursor.patterns) {
      remainingWork -= (text.length + 1) * (candidate.pattern.atoms + 1);
      if (remainingWork < 0) throw new Error("rule lookup exceeds bounded work budget");
      if (candidate.pattern.test(text)) return candidate.rule;
    }
  }
  return undefined;
}
export function matchCommandRule(rules: readonly Rule[], text: string, tool = "bash"): Rule | undefined {
  return matchCompiled(ruleIndex(rules), text, tool);
}
