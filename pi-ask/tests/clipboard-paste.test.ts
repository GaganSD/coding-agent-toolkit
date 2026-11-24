import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import test from "node:test";
import type { NativeClipboard } from "@earendil-works/pi-tui";
import { askStrings } from "../src/i18n.ts";
import { readClipboardPasteText } from "../src/ui/clipboard-paste.ts";

const unavailableCursor = () => assert.fail("cursor is needed only for file paths");

function clipboard(overrides: Partial<NativeClipboard> = {}): NativeClipboard {
	return {
		getImage: async () => assert.fail("unexpected image read"),
		getText: async () => assert.fail("unexpected text read"),
		...overrides,
	};
}

test("clipboard files take priority and get padding only beside non-whitespace", async () => {
	const getClipboard = () => clipboard({
		getFilePaths: async () => ["/tmp/first.png", "/tmp/second file.png"],
	});
	const paths = "/tmp/first.png\n/tmp/second file.png";
	for (const [text, col, expected] of [
		["ab", 1, ` ${paths} `],
		["a b", 1, ` ${paths}`],
		["a b", 2, `${paths} `],
		["  ", 1, paths],
		["", 0, paths],
	] as const) {
		assert.equal(await readClipboardPasteText(() => ({ text, col }), { getClipboard }), expected);
	}
});

test("clipboard rejects a file list containing any control character without falling back", async () => {
	for (const control of ["\n", "\x1b", "\u0085"]) {
		const getClipboard = () => clipboard({
			getFilePaths: async () => ["/tmp/valid.png", `/tmp/bad${control}.png`],
		});
		await assert.rejects(
			readClipboardPasteText(unavailableCursor, { getClipboard }),
			{ message: askStrings().clipboardPathHasControls }
		);
	}
});

test("clipboard images take priority over text and are written to a typed temp path", async () => {
	for (const [header, ext] of [
		["\x89PNG\r\n\x1a\n", "png"],
		["\xff\xd8\xff", "jpg"],
		["RIFF\x04\0\0\0WEBP", "webp"],
		["GIF87a", "gif"],
		["GIF89a", "gif"],
		["unknown", "png"],
	]) {
		const bytes = Buffer.from(header, "latin1");
		const getClipboard = () => clipboard({
			getFilePaths: async () => [],
			getImage: async () => bytes,
		});
		let written: string | undefined;
		const path = await readClipboardPasteText(unavailableCursor, {
			getClipboard,
			writeImage: async (file, data) => {
				assert.equal(data, bytes);
				written = file;
			},
		});
		assert.ok(path);
		assert.equal(path, written);
		assert.equal(dirname(path), tmpdir());
		assert.match(basename(path), /^pi-clipboard-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.[a-z]+$/u);
		assert.ok(path.endsWith(`.${ext}`));
	}
});

test("clipboard text is the fallback and unavailable clipboard data is a no-op", async () => {
	const paste = (getClipboard: () => NativeClipboard | undefined) =>
		readClipboardPasteText(unavailableCursor, { getClipboard });
	assert.equal(await paste(() => clipboard({
		getImage: async () => null,
		getText: async () => " plain text\n",
	})), " plain text\n");
	assert.equal(await paste(() => clipboard({
		getImage: async () => undefined,
		getText: async () => "",
	})), undefined);
	assert.equal(await paste(() => undefined), undefined);
});
