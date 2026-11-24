import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { askStrings } from "../i18n.ts";

interface ClipboardPasteDeps {
	getClipboard?: typeof getNativeClipboard;
	writeImage?: (path: string, bytes: Uint8Array) => Promise<void>;
}

export async function readClipboardPasteText(
	getCursorLine: () => { text: string; col: number },
	{
		getClipboard = getNativeClipboard,
		writeImage = (path, bytes) => writeFile(path, bytes, { flag: "wx", mode: 0o600 }),
	}: ClipboardPasteDeps = {}
): Promise<string | undefined> {
	const clipboard = getClipboard();
	if (!clipboard) {
		return;
	}
	const paths = await clipboard.getFilePaths?.();
	if (paths?.length) {
		if (paths.some((path) => /\p{Cc}/u.test(path))) {
			throw new Error(askStrings().clipboardPathHasControls);
		}
		const { text, col } = getCursorLine();
		const before = text[col - 1];
		const after = text[col];
		const leadingSpace = before && /\S/u.test(before) ? " " : "";
		const trailingSpace = after && /\S/u.test(after) ? " " : "";
		return `${leadingSpace}${paths.join("\n")}${trailingSpace}`;
	}
	const bytes = await clipboard.getImage();
	if (bytes?.length) {
		const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${imageExtension(bytes)}`);
		await writeImage(path, bytes);
		return path;
	}
	return (await clipboard.getText()) || undefined;
}

function imageExtension(bytes: Uint8Array): string {
	const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		.subarray(0, 12)
		.toString("latin1");
	if (header.startsWith("\xff\xd8\xff")) {
		return "jpg";
	}
	if (header.startsWith("RIFF") && header.slice(8) === "WEBP") {
		return "webp";
	}
	if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
		return "gif";
	}
	// PNG (\x89PNG\r\n\x1a\n) and anything unrecognized use .png.
	return "png";
}
