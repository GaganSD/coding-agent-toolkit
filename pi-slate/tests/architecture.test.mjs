import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const directory = new URL("../extensions/pi-slate/", import.meta.url);
const hostPackage = /^@(earendil-works|mariozechner)\/pi-(coding-agent|tui|ai|agent-core)(?:\/|$)/;
const publicEntrypoint = /^@(earendil-works|mariozechner)\/pi-(coding-agent|tui|ai|agent-core)$/;

test("production host imports use public package entrypoints, never computed private module paths", async () => {
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(new URL(file, directory), "utf8");
    // All static module specifiers are string literals. Also reject computed dynamic imports,
    // which were how the private MCP path bypassed normal public-package import review.
    for (const [, specifier] of text.matchAll(/["']([^"'\r\n]*)["']/g)) {
      if (hostPackage.test(specifier)) assert(publicEntrypoint.test(specifier), `${file}: private host import ${specifier}`);
      assert(!/^(?:file:|\/).*\/pi-(?:coding-agent|tui)\//.test(specifier), `${file}: absolute private host import`);
    }
    for (const [, argument] of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
      assert(/^["'][^"']+["']\s*$/.test(argument), `${file}: dynamic imports must be literal, review host coupling before adding one`);
    }
  }
});
