import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CALLOUT_LABELS,
  createAccentPalette,
  decorateQuietCallouts,
  decorateReplyAccents,
  transformReply,
  type AccentPalette,
  type CalloutKind,
} from "../extensions/pi-slate/reply-accents.ts";

function marked(): AccentPalette {
  const wrap = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
  return {
    dim: wrap("dim"),
    success: wrap("success"),
    error: wrap("error"),
    warning: wrap("warning"),
    accent: wrap("accent"),
    note: wrap("note"),
    tip: wrap("tip"),
    important: wrap("important"),
    caution: wrap("caution"),
    boldReopen: "<bold>",
  };
}

const plain: AccentPalette = {
  dim: text => text,
  success: text => text,
  error: text => text,
  warning: text => text,
  accent: text => text,
  note: text => text,
  tip: text => text,
  important: text => text,
  caution: text => text,
};

test("fenced blocks and inline code spans stay untouched", () => {
  const palette = marked();
  const input = [
    "✓ → ✅",
    "```",
    "✓ → ✅",
    "```",
    "~~~",
    "✗ ✘ 🚧",
    "~~~",
    "`✓ → ✅` and ``✗ →`` and `unclosed",
  ].join("\n");
  const out = decorateReplyAccents(input, palette);
  assert.equal(out.split("\n")[0], "<success>✓</success> <accent>→</accent> <success>✓</success>");
  assert.match(out, /```\n✓ → ✅\n```/);
  assert.match(out, /~~~\n✗ ✘ 🚧\n~~~/);
  assert.ok(out.endsWith("`✓ → ✅` and ``✗ →`` and `unclosed"));
  assert.equal(decorateReplyAccents("> ```\n> ✓ →\n> ```", palette), "> ```\n> ✓ →\n> ```");
});

test("escaped and odd input stays safe", () => {
  const palette = marked();
  for (const input of ["", "\\→", "\\**not bold ✓", "`unclosed ✓", "```\nunclosed fence ✓", "**unclosed ✓"]) {
    assert.equal(typeof decorateReplyAccents(input, palette), "string");
    assert.equal(typeof transformReply(input, palette, 10), "string");
  }
  assert.equal(decorateReplyAccents("\\→", palette), "\\→");
  assert.equal(decorateReplyAccents("```\nunclosed fence ✓", palette), "```\nunclosed fence ✓");
});

test("tree connectors, checks, crosses, and arrows take their colors", () => {
  const palette = marked();
  assert.equal(decorateReplyAccents("├── item", palette), "<dim>├──</dim> item");
  assert.equal(decorateReplyAccents("└── item", palette), "<dim>└──</dim> item");
  assert.equal(decorateReplyAccents("│   ├── child", palette), "<dim>│</dim>   <dim>├──</dim> child");
  assert.equal(
    decorateReplyAccents("✓ ✔ ✗ ✘ →", palette),
    "<success>✓</success> <success>✔</success> <error>✗</error> <error>✘</error> <accent>→</accent>",
  );
});

test("only the fixed status emoji swap, including the variation selector", () => {
  const palette = marked();
  assert.equal(
    decorateReplyAccents("✅ ❌ ⚠️ ⚠ 🚧", palette),
    "<success>✓</success> <error>✗</error> <warning>!</warning> <warning>!</warning> <warning>◔</warning>",
  );
  assert.equal(decorateReplyAccents("🎉 🔥 🙂 🚀", palette), "🎉 🔥 🙂 🚀");
});

test("bold keeps its weight and is never recolored", () => {
  const palette = marked();
  const out = decorateReplyAccents("**✓ keep bold** and **✅ done**", palette);
  assert.equal(
    out,
    "**<success>✓</success><bold> keep bold** and **<success>✓</success><bold> done**",
  );
  assert.doesNotMatch(out, /<(?:dim|success|error|warning|accent|note|tip|important|caution)>[^<]*keep/);
});

test("callouts cover all five kinds and ignore case", () => {
  const palette = marked();
  const cases: Array<[CalloutKind, string]> = [
    ["note", "NOTE"],
    ["tip", "TIP"],
    ["important", "IMPORTANT"],
    ["warning", "WARNING"],
    ["caution", "CAUTION"],
  ];
  for (const [kind, upper] of cases) {
    const out = decorateQuietCallouts(`> [!${upper}]\n> body`, palette, 80);
    assert.equal(
      out,
      `<${kind}>│</${kind}> <${kind}>**${CALLOUT_LABELS[kind]}**</${kind}>  \n<${kind}>│</${kind}> body`,
    );
  }
  assert.match(decorateQuietCallouts("> [!wArNiNg]\n> care", palette, 80), /<warning>\*\*Warning\*\*<\/warning>/);
});

test("unknown alerts and ordinary blockquotes are left alone", () => {
  const palette = marked();
  for (const input of ["> [!FOO]\n> keep", "> [!NOTE] trailing\n> keep", "> ordinary quote", "```\n> [!NOTE]\n> keep\n```"]) {
    assert.equal(decorateQuietCallouts(input, palette, 80), input);
  }
});

test("wrapped callout bodies keep the rail on every row", () => {
  const body = "This is a long callout body that must wrap onto several lines at a narrow width without losing its rail.";
  const out = decorateQuietCallouts(`> [!NOTE]\n> ${body}`, plain, 24);
  const lines = out.split("\n").map(line => line.trimEnd());
  assert.ok(lines.length > 3, out);
  for (const line of lines) assert.ok(line.startsWith("│ "), line);
  for (const line of lines) assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)}: ${line}`);
  assert.equal(lines.slice(1).map(line => line.slice(2)).join(" "), body);
});

test("wrapped callout bodies keep inline code spans complete", () => {
  for (const width of [24, 16]) {
    const out = transformReply("> [!NOTE]\n> Use `pnpm test --watch` and `some-very-long-command-name-without-spaces` now.", plain, width);
    const body = out.split("\n").slice(1).map(line => line.trimEnd());
    for (const line of body) assert.equal((line.match(/`/g) ?? []).length % 2, 0, `${width}: ${line}`);
    if (width === 24) assert.ok(body.some(line => line.includes("`pnpm test --watch`")), body.join(" | "));
  }
});

test("callout bodies still receive accents and inline Markdown", () => {
  const palette = marked();
  const out = transformReply("> [!TIP]\n> **✅ done** and `✓ →`", palette, 80);
  assert.match(out, /<tip>│<\/tip> \*\*<success>✓<\/success><bold> done\*\* and `✓ →`/);
});

test("callouts end at the first non-quote line and keep spacing", () => {
  const palette = marked();
  const out = decorateQuietCallouts("> [!NOTE]\n> body\nOutside\n\n> [!TIP]\n> next", palette, 80);
  assert.ok(out.includes("body\n\nOutside\n\n"));
  assert.match(out, /<note>│<\/note> body/);
  assert.match(out, /<tip>│<\/tip> next/);
});

test("markdown without a callout or accent returns the same string", () => {
  const palette = marked();
  for (const input of [
    "",
    "plain text",
    "## ✅ heading\nbody",
    "- list\n> ordinary quote",
    "```\n✓ →\n```",
    "**bold** and *italic*",
    "text with [[pills]] and 🎉",
  ]) {
    assert.equal(transformReply(input, palette, 80), input);
  }
});

test("palette maps callout kinds to existing theme tokens", () => {
  const seen: string[] = [];
  const palette = createAccentPalette({
    fg: (color, text) => {
      seen.push(String(color));
      return text;
    },
  });
  palette.note("n");
  palette.tip("t");
  palette.important("i");
  palette.warning("w");
  palette.caution("c");
  assert.deepEqual(seen, ["accent", "success", "mdLink", "warning", "error"]);
  assert.equal(palette.boldReopen, "\x1b[1m");
});
