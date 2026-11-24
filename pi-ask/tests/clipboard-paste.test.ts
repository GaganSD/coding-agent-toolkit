import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname } from "node:path";
import test from "node:test";
import type { NativeClipboard } from "@earendil-works/pi-tui";
import { askStrings } from "../src/i18n.ts";
import { readClipboardPaste } from "../src/ui/clipboard-paste.ts";

const current = () => true;
const PNG_HEADER = "\x89PNG\r\n\x1a\n";

function clipboard(overrides: Partial<NativeClipboard>): NativeClipboard {
	return {
		getImage: async () => assert.fail("unexpected image read"),
		getText: async () => assert.fail("unexpected text read"),
		...overrides,
	};
}

function pasteImage(bytes: Uint8Array, isCurrent = current) {
	return readClipboardPaste(isCurrent, clipboard({
		getFilePaths: async () => [],
		getImage: async () => bytes,
	}));
}

test("clipboard files take priority and are joined one per line", async () => {
	const files = clipboard({ getFilePaths: async () => ["/tmp/first.png", "/tmp/second file.png"] });
	assert.deepEqual(await readClipboardPaste(current, files), {
		kind: "path", text: "/tmp/first.png\n/tmp/second file.png",
	});
});

test("clipboard rejects a file list containing any control character without falling back", async () => {
	for (const control of ["\n", "\x1b", "\u0085"]) {
		const files = clipboard({ getFilePaths: async () => ["/tmp/valid.png", `/tmp/bad${control}.png`] });
		await assert.rejects(readClipboardPaste(current, files), {
			message: askStrings().clipboardPathHasControls,
		});
	}
});

test("supported clipboard images take priority over text and are written as-is", async (t) => {
	for (const [header, ext] of [
		[PNG_HEADER, "png"],
		["\xff\xd8\xff", "jpg"],
		["RIFF\x04\0\0\0WEBP", "webp"],
		["GIF87a", "gif"],
		["GIF89a", "gif"],
	]) {
		const bytes = Buffer.from(header, "latin1");
		const paste = await pasteImage(bytes);
		assert.ok(paste?.kind === "image");
		t.after(() => unlink(paste.text));
		assert.equal(dirname(paste.text), tmpdir());
		assert.match(basename(paste.text), /^pi-clipboard-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.[a-z]+$/u);
		assert.equal(extname(paste.text), `.${ext}`);
		assert.deepEqual(await readFile(paste.text), bytes);
	}
});

test("other clipboard image formats are converted to PNG or rejected", async (t) => {
	// A 1x1 24-bit BMP.
	const bmp = Buffer.from("424d3a0000000000000036000000280000000100000001000000010018000000000004000000000000000000000000000000000000000000ff00", "hex");
	const paste = await pasteImage(bmp);
	assert.ok(paste?.kind === "image");
	t.after(() => unlink(paste.text));
	assert.equal(extname(paste.text), ".png");
	assert.ok((await readFile(paste.text)).toString("latin1").startsWith(PNG_HEADER));
	await assert.rejects(pasteImage(Buffer.from("unknown")), { message: askStrings().clipboardImageUnsupported });
});

test("a screenshot is not written if the editor is no longer current", async () => {
	assert.equal(await pasteImage(Buffer.from(PNG_HEADER, "latin1"), () => false), undefined);
});

test("clipboard text is the fallback and unavailable clipboard data is a no-op", async () => {
	const paste = (value: NativeClipboard | null) => readClipboardPaste(current, value);
	assert.deepEqual(await paste(clipboard({
		getImage: async () => null,
		getText: async () => " plain text\n",
	})), { kind: "text", text: " plain text\n" });
	assert.equal(await paste(clipboard({ getImage: async () => undefined, getText: async () => "" })), undefined);
	assert.equal(await paste(null), undefined);
});
