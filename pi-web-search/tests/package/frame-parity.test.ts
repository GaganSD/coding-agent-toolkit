import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Slate owns this file. The extension vendors it so the packed extension needs no Slate dependency.
test("the vendored picker frame is byte-identical to Slate", async () => {
	const read = (path: string) => readFile(new URL(path, import.meta.url));
	assert.deepEqual(await read("../../src/ui/frame.ts"), await read("../../../pi-slate/extensions/pi-slate/picker-frame.ts"));
});
