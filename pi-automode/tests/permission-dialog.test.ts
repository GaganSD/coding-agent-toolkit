import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { showPermissionDialog } from "../src/permission-dialog.js";

initTheme("dark", false);

test("permission viewer uses neutral tool text, a separate countdown and Decline by default", async () => {
	let component: (Component & { dispose?(): void }) | undefined;
	let selected: unknown;
	const controller = new AbortController();
	const custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		component = factory({ requestRender() {} } as never,
			{ fg: (_color: string, text: string) => text } as never, {} as never,
			(value: unknown) => { selected = value; }) as typeof component;
	}) as ExtensionUIContext["custom"];
	await showPermissionDialog({ custom }, "edit /workspace/file.ts (3 edits)", ["Decline", "Allow once", "Inspect details"], controller.signal, 60_000);
	try {
		assert.ok(component);
		const lines = component.render(60);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
		const summary = lines.find((line) => line.includes("edit /workspace")) ?? "";
		assert.doesNotMatch(summary, /\x1b\[1m/);
		assert.match(lines.join("\n"), /60s remaining/);
		component.handleInput?.("\r");
		assert.equal(selected, "Decline");
		controller.abort();
		assert.equal(selected, undefined, "lifecycle abort dismisses the viewer");
	} finally { component?.dispose?.(); }
});
