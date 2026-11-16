import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { showInspect } from "../src/inspect.js";

initTheme("dark", false);

test("inspect renders neutral detail, JSON tokens, bounded scrolling and no Back option", async () => {
	const controller = new AbortController();
	let closed = false;
	let component: (Component & { dispose?(): void }) | undefined;
	const custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		component = factory(
			{ terminal: { rows: 15 }, requestRender() {} } as never,
			{ fg: (_color: string, text: string) => text } as never,
			{} as never,
			() => { closed = true; },
		) as typeof component;
	}) as ExtensionUIContext["custom"];
	await showInspect({ custom }, 'tool: bash\nargs: {\n  "command": "git status",\n  "timeout": 10\n}\ncwd: /workspace\nworkspace: /workspace\nfingerprint: abc\ndecision: ask', controller.signal);
	assert.ok(component);
	const lines = component.render(40);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.match(lines.join("\n"), /Arguments/);
	assert.match(lines.join("\n"), /\x1b\[/, "JSON has syntax colors");
	assert.doesNotMatch(lines.join("\n"), /Back/);
	component.handleInput?.("\x1b[F");
	assert.match(component.render(80).join("\n"), /decision: ask/);
	component.handleInput?.("\x1b");
	assert.equal(closed, true);
	component.dispose?.();
});

test("inspect closes on abort and removes its lifecycle listener on disposal", async () => {
	const controller = new AbortController();
	let closed = 0;
	let component: { dispose?(): void } | undefined;
	const custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		component = factory({} as never, { fg: (_color: string, text: string) => text } as never, {} as never, () => { closed++; }) as typeof component;
	}) as ExtensionUIContext["custom"];
	await showInspect({ custom }, "tool: bash", controller.signal);
	controller.abort();
	assert.equal(closed, 1);
	component?.dispose?.();
	await showInspect({ custom }, "tool: bash", controller.signal);
	assert.equal(closed, 1, "already aborted signals do not open a viewer");
});
