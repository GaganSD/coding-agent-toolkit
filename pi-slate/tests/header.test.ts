import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { piLogoLines, piMinimalLogoLines, piWordmark, renderSlateHeader, supportsPiLogo } from "../extensions/pi-slate/header.ts";
import { logoArgumentCompletions, parseLogoArgs } from "../extensions/pi-slate/layout.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

test("header uses the stock Pi mark and the product stack, not a greeting", () => {
  const lines = renderSlateHeader({
    width: 72, path: "/Users/operator/GitHub/pi-extensions",
    identity: { version: "1.0.4", model: "grok-4.6 (bedrock)", thinking: "medium" },
    logo: true, logoStyle: "original", theme,
  });
  const plain = lines.map(stripVTControlCharacters);
  assert.equal(plain.length, 3);
  assert.match(plain[0]!, /Pi Agent v1\.0\.4/);
  assert.match(plain[1]!, /grok-4\.6 \(bedrock\) · medium/);
  assert.match(plain[2]!, /~\/pi-extensions/);
  assert.doesNotMatch(plain[2]!, /\/Users/);
  assert(!plain.some(line => /^─+$/.test(line)), "no plain hairline under the header");
  assert.doesNotMatch(plain.join("\n"), /Ready when you are|slate \/ /);
  assert(plain[0]!.includes("▀"));
  assert(plain.every(line => visibleWidth(line) <= 72));
});

test("wordmark fallback stays compact", () => {
  const started = renderSlateHeader({ width: 40, path: "/tmp/project", identity: { version: "1.0.4" }, logo: false, theme });
  assert.doesNotMatch(started.join("\n"), /New session started|Ready when/);
  assert.match(stripVTControlCharacters(started[0]!), /Agent v1\.0\.4/);
  assert(started.every(line => visibleWidth(line) <= 40));
});

test("identity truncates safely and strips untrusted terminal controls", () => {
  for (const width of [0, 1, 2, 8, 20, 40, 100]) {
    const lines = renderSlateHeader({
      width, path: "/tmp/verylong长工程名字🙂\n\x1b[2J",
      identity: { version: "1.0.4", model: "long\n\x1b[2Jmodel".repeat(3), thinking: "high" },
      logo: width >= 12, theme,
    });
    assert(lines.every(line => visibleWidth(line) <= width && !line.includes("\n") && !line.includes("\x1b[2J")));
  }
});

test("minimal logo matches the stock mark's 4×2 geometry in white", () => {
  const lines = renderSlateHeader({
    width: 72, path: "/Users/operator/GitHub/pi-extensions",
    identity: { version: "1.0.4", model: "grok-4.6 (bedrock)", thinking: "medium" },
    logo: true, logoStyle: "minimal", theme,
  });
  const plain = lines.map(stripVTControlCharacters);
  assert.equal(plain.length, 3);
  assert.match(plain[0]!, /^█▀█\s+Pi Agent v1\.0\.4/);
  assert.match(plain[1]!, /^█▀ █\s+grok-4\.6 \(bedrock\) · medium/);
  assert.match(plain[2]!, /^ {5}~\/pi-extensions/);
  assert(lines.slice(0, 2).every(line => line.includes("\x1b[")), "mark stays painted white");
  assert(plain.every(line => visibleWidth(line) <= 72));
});

test("minimal is the default logo style", () => {
  const lines = renderSlateHeader({
    width: 72, path: "/tmp/project", identity: { version: "1.0.4" }, logo: true, theme,
  });
  const plain = lines.map(stripVTControlCharacters);
  assert.equal(plain.length, 3);
  assert.match(plain[0]!, /^█▀█/);
});

test("logo command parses original, minimal, and the picker", () => {
  assert.deepEqual(parseLogoArgs(""), { ok: true });
  assert.deepEqual(parseLogoArgs("minimal"), { ok: true, value: "minimal" });
  assert.deepEqual(parseLogoArgs(" ORIGINAL "), { ok: true, value: "original" });
  assert.deepEqual(parseLogoArgs("retro"), { ok: false });
  assert.deepEqual(parseLogoArgs("minimal extra"), { ok: false });
  assert.deepEqual(logoArgumentCompletions("m"), [{ value: "minimal", label: "minimal" }]);
  assert.deepEqual(logoArgumentCompletions(" "), [
    { value: "original", label: "original" },
    { value: "minimal", label: "minimal" },
  ]);
  assert.equal(logoArgumentCompletions("retro"), null);
});

test("logo helpers share the same 4×2 grid", () => {
  const minimal = piMinimalLogoLines(theme);
  const stock = piLogoLines(theme);
  assert.equal(minimal.length, 2);
  assert(minimal.every(line => visibleWidth(line) === 4));
  assert.equal(stock.length, 2);
  assert(stock.every(line => visibleWidth(line) === 4));
  assert.deepEqual(minimal.map(stripVTControlCharacters), ["█▀█ ", "█▀ █"]);
});

test("logo helpers keep the official bitmap and skip Apple Terminal", () => {
  const [top, bottom] = piLogoLines(theme);
  assert.equal(visibleWidth(top), 4);
  assert.equal(visibleWidth(bottom), 4);
  assert.match(piWordmark(theme), /P.*i/);
  assert.equal(supportsPiLogo({ TERM_PROGRAM: "Apple_Terminal" }), false);
  assert.equal(supportsPiLogo({ TERM_PROGRAM: "iTerm.app" }), true);
});
