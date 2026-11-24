import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, type NativeClipboard } from "@earendil-works/pi-tui";
import { askStrings } from "../i18n.ts";

type ClipboardPaste = { kind: "path" | "image" | "text"; text: string };

export async function readClipboardPaste(
	isCurrent: () => boolean,
	clipboard: NativeClipboard | null | undefined = getNativeClipboard()
): Promise<ClipboardPaste | undefined> {
	if (!clipboard) {
		return;
	}
	const paths = await clipboard.getFilePaths?.();
	if (paths?.length) {
		if (paths.some((path) => /\p{Cc}/u.test(path))) {
			throw new Error(askStrings().clipboardPathHasControls);
		}
		return { kind: "path", text: paths.join("\n") };
	}
	const bytes = await clipboard.getImage();
	if (bytes?.length) {
		let image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const ext = imageExtension(image);
		if (!ext) {
			const png = await convertToPng(image.toString("base64"), "application/octet-stream");
			if (!png) {
				throw new Error(askStrings().clipboardImageUnsupported);
			}
			image = Buffer.from(png.data, "base64");
		}
		if (!isCurrent()) {
			return;
		}
		const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext ?? "png"}`);
		await writeFile(path, image, { flag: "wx", mode: 0o600 });
		return { kind: "image", text: path };
	}
	const text = await clipboard.getText();
	return text ? { kind: "text", text } : undefined;
}

function imageExtension(bytes: Buffer): string | undefined {
	const header = bytes.toString("latin1", 0, 12);
	const signatures = [
		["\x89PNG\r\n\x1a\n", "png"],
		["\xff\xd8\xff", "jpg"],
		["GIF87a", "gif"],
		["GIF89a", "gif"],
	];
	return header.startsWith("RIFF") && header.slice(8) === "WEBP"
		? "webp"
		: signatures.find(([signature]) => header.startsWith(signature))?.[1];
}
