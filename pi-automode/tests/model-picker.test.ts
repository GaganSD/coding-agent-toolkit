import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { showModelPicker } from "../src/model-picker.js";

initTheme("dark", false);

function harness() {
	let component: Component;
	let result: unknown = "pending";
	const terminal = { rows: 20 };
	const custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		component = factory(
			{ terminal, requestRender() {} } as never,
			{ fg: (_color: string, text: string) => text } as never,
			{} as never,
			(value: unknown) => { result = value; },
		) as Component;
	}) as ExtensionUIContext["custom"];
	return { custom, terminal, get component() { return component; }, get result() { return result; } };
}

const items = [
	{ value: "rules", label: "Rules only", description: "Nothing is uploaded." },
	...Array.from({ length: 30 }, (_, i) => ({ value: `model-${i}`, label: `provider/model-${i}`, description: `Endpoint: https://example.org/model-${i}` })),
];

test("catalogue keeps prose neutral, scrolls models and exposes the selected destination", async () => {
	const h = harness();
	await showModelPicker(h, "Selecting a model approves disclosure. Hard blocks remain final.", items);
	const initial = h.component.render(70);
	const prose = initial.find((line) => line.includes("Selecting a model")) ?? "";
	assert.match(prose, /Selecting a model approves disclosure\. Hard blocks remain final\./);
	assert.doesNotMatch(prose, /\x1b\[1m/, "disclosure is not bold title text");
	assert.ok(initial.length <= h.terminal.rows);
	assert.doesNotMatch(initial.join("\n"), /model-29/);
	h.component.handleInput?.("\x1b[B");
	assert.match(h.component.render(70).join("\n"), /Endpoint: https:\/\/example.org\/model-0/);
	for (let i = 0; i < 29; i++) h.component.handleInput?.("\x1b[B");
	assert.match(h.component.render(70).join("\n"), /model-29/);
	h.terminal.rows = 30;
	const narrow = h.component.render(35);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 35));
	h.component.handleInput?.("\r");
	assert.equal(h.result, "model-29", "resize preserves the exact selected value");
});

test("Escape dismisses the catalogue without approving a model", async () => {
	const h = harness();
	await showModelPicker(h, "Disclosure", items);
	h.component.handleInput?.("\x1b");
	assert.equal(h.result, undefined);
});
