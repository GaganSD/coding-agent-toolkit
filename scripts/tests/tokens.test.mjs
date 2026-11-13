import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root } from "../lib.mjs";
import { countTokens } from "../tokens.mjs";

const cli = (args = [], input = "") => spawnSync(process.execPath, [join(root, "scripts/tokens.mjs"), ...args], { encoding: "utf8", input });

test("counts empty and known text with explicit tokenizer metadata", () => {
  for (const encoding of ["o200k_base", "cl100k_base"]) {
    assert.deepEqual(countTokens("", { encoding }), { tokens: 0, encoding, scope: "text-only" });
    assert.equal(countTokens("hello world", { encoding }).tokens, 2);
    assert.equal(countTokens("Hello, world!", { encoding }).tokens, 4);
  }
  assert.equal(countTokens("hello").encoding, "o200k_base");
  assert.throws(() => countTokens(null), /string/);
  assert.throws(() => countTokens("hello", { encoding: "claude" }), /Unsupported encoding/);
});

test("counts Unicode, source code, and special-token-looking text as literal content", () => {
  for (const text of ["你好 🌍 café", "const x = 42;\n", "<|endoftext|>", "<|im_start|>system"]) {
    assert(countTokens(text).tokens > 0);
  }
});

test("CLI accepts text, UTF-8 files, empty strings, and piped stdin", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tokens-test-"));
  try {
    const file = join(directory, "input.txt");
    const text = "你好 🌍\nhello world\n";
    writeFileSync(file, text);
    for (const result of [cli(["--text", text]), cli(["--file", file]), cli([], text)]) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), countTokens(text));
      assert.equal(result.stderr, "");
    }
    assert.equal(JSON.parse(cli(["--text", ""]).stdout).tokens, 0);
    assert.equal(JSON.parse(cli(["--text", "hello", "--encoding", "cl100k_base"]).stdout).encoding, "cl100k_base");
    assert.match(cli(["--help"]).stdout, /Usage:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI rejects ambiguous inputs, missing files, unknown flags and encodings", () => {
  for (const args of [
    ["--text", "hello", "--file", "anything"],
    ["--file", join(tmpdir(), "nonexistent-pi-token-file", "missing.txt")],
    ["--text"], ["--unknown"], ["--encoding", "claude"], ["unexpected positional"],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /tokens:/);
  }
});
