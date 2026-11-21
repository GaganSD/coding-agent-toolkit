import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CALLOUT_LABELS,
  createCalloutPalette,
  decorateCallouts,
  type CalloutKind,
  type CalloutPalette,
} from "../extensions/pi-slate/callouts.ts";

function marked(): CalloutPalette {
  const wrap = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
  return {
    note: wrap("note"),
    tip: wrap("tip"),
    important: wrap("important"),
    warning: wrap("warning"),
    caution: wrap("caution"),
  };
}

const plain: CalloutPalette = {
  note: text => text,
  tip: text => text,
  important: text => text,
  warning: text => text,
  caution: text => text,
};

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
    const out = decorateCallouts(`> [!${upper}]\n> body`, palette, 80);
    assert.equal(
      out,
      `<${kind}>│</${kind}> <${kind}>**${CALLOUT_LABELS[kind]}**</${kind}>  \n<${kind}>│</${kind}> body`,
    );
  }
  assert.match(decorateCallouts("> [!wArNiNg]\n> care", palette, 80), /<warning>\*\*Warning\*\*<\/warning>/);
});

test("unknown alerts and ordinary blockquotes are left alone", () => {
  const palette = marked();
  for (const input of ["> [!FOO]\n> keep", "> [!NOTE] trailing\n> keep", "> ordinary quote", "```\n> [!NOTE]\n> keep\n```", "plain text"]) {
    assert.equal(decorateCallouts(input, palette, 80), input);
  }
});

test("fenced code closes only on a bare fence", () => {
  const palette = marked();
  const fence = ["```", "> [!NOTE]", "> inside", "```still-code", "> [!NOTE]", "> still inside", "```"].join("\n");
  const out = decorateCallouts(`${fence}\n> [!TIP]\n> after`, palette, 80);
  assert.ok(out.startsWith(`${fence}\n`), out);
  assert.match(out, /<tip>│<\/tip> <tip>\*\*Tip\*\*<\/tip>/);
});

test("wrapped callout bodies keep the rail on every row", () => {
  const body = "This is a long callout body that must wrap onto several lines at a narrow width without losing its rail.";
  const out = decorateCallouts(`> [!NOTE]\n> ${body}`, plain, 24);
  const lines = out.split("\n").map(line => line.trimEnd());
  assert.ok(lines.length > 3, out);
  for (const line of lines) assert.ok(line.startsWith("│ "), line);
  for (const line of lines) assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)}: ${line}`);
  assert.equal(lines.slice(1).map(line => line.slice(2)).join(" "), body);
});

test("wrapped callout bodies keep inline code spans complete", () => {
  for (const width of [24, 16]) {
    const out = decorateCallouts("> [!NOTE]\n> Use `pnpm test --watch` and `some-very-long-command-name-without-spaces` now.", plain, width);
    const body = out.split("\n").slice(1).map(line => line.trimEnd());
    for (const line of body) assert.equal((line.match(/`/g) ?? []).length % 2, 0, `${width}: ${line}`);
    if (width === 24) assert.ok(body.some(line => line.includes("`pnpm test --watch`")), body.join(" | "));
  }
});

test("wrapped multi-backtick code spans keep their delimiters intact", () => {
  const out = decorateCallouts("> [!NOTE]\n> ``abcdefghijkl``", plain, 12);
  const rows = out.split("\n").slice(1).map(row => row.trimEnd());
  assert.deepEqual(rows, ["│ ``abcdef``", "│ ``ghijkl``"]);
  for (const row of rows) assert.ok(visibleWidth(row) <= 12, row);
});

test("wrapped callout bodies keep links intact", () => {
  const links = [
    "[docs](https://example.com/very/long/path)",
    "<https://example.com/very/long/path>",
    "https://example.com/very/long/path",
  ];
  for (const link of links) {
    const out = decorateCallouts(`> [!NOTE]\n> See ${link} now.`, plain, 24);
    const rows = out.split("\n").slice(1).map(row => row.trimEnd());
    assert.ok(rows.includes(`│ ${link}`), `${link}: ${out}`);
  }
});

test("callouts end at the first non-quote line and keep spacing", () => {
  const palette = marked();
  const out = decorateCallouts("> [!NOTE]\n> body\nOutside\n\n> [!TIP]\n> next", palette, 80);
  assert.ok(out.includes("body\n\nOutside\n\n"));
  assert.match(out, /<note>│<\/note> body/);
  assert.match(out, /<tip>│<\/tip> next/);
});

test("palette maps callout kinds to existing theme tokens", () => {
  const seen: string[] = [];
  const palette = createCalloutPalette({
    fg: (color: string, text: string) => {
      seen.push(String(color));
      return text;
    },
  } as unknown as Theme);
  palette.note("n");
  palette.tip("t");
  palette.important("i");
  palette.warning("w");
  palette.caution("c");
  assert.deepEqual(seen, ["accent", "success", "mdLink", "warning", "error"]);
});
