import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { editTuningSettings, parseTuningValue, TUNING_FIELDS } from "../src/settings-editor.js";
import { DEFAULT_SETTINGS, type AutomodeSettings } from "../src/types.js";
import type { CommandUi } from "../src/ui.js";

initTheme("dark", false);

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

function harness(current = { ...DEFAULT_SETTINGS }) {
	let component: (Component & { focused?: boolean }) | undefined;
	let result: unknown = "pending";
	let opens = 0;
	const terminal = { rows: 28 };
	const custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		opens++;
		component = factory({ terminal, requestRender() {} } as never,
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never, {} as never,
			(value: unknown) => { result = value; }) as typeof component;
	}) as ExtensionUIContext["custom"];
	const ui = { custom, input: async () => assert.fail("inline settings must not open an input dialog"),
		select: async () => assert.fail("inline settings must not open a select dialog") } as unknown as CommandUi;
	return { ui, current, terminal, get component() { assert.ok(component); return component; }, get result() { return result; }, get opens() { return opens; } };
}

test("numeric settings reject invalid/range values and convert seconds/percent without drift", () => {
	for (const field of TUNING_FIELDS) {
		for (const value of ["", " ", "NaN", "Infinity", "1e999", "-1", "0", "0xff", "1;echo bad", "1000000000000000000000000000000000"]) {
			assert.equal(parseTuningValue(field, value), undefined, `${field.key}: ${value}`);
		}
		assert.equal(parseTuningValue(field, String(field.min / field.scale)), field.min);
		assert.equal(parseTuningValue(field, String(field.max / field.scale)), field.max);
	}
	assert.equal(parseTuningValue(TUNING_FIELDS[0]!, "60"), 60_000);
	assert.equal(parseTuningValue(TUNING_FIELDS[2]!, "67"), 0.67);
	assert.equal(parseTuningValue(TUNING_FIELDS[3]!, "0.25"), 250);
	assert.equal(parseTuningValue(TUNING_FIELDS[4]!, "1.5"), undefined);
});

test("Settings matches Pi's full-width selectors and keeps stable height across selections and edits", async () => {
	const h = harness();
	await editTuningSettings(h.ui, h.current, "Pending: 0 managed");
	h.component.focused = true;
	const initial = h.component.render(140);
	assert.equal(visibleWidth(initial[0]!), 140, "use the full available width like native selectors");
	assert.match(plain(initial[0]!), /^─+$/);
	assert.match(plain(initial.at(-1)!), /^─+$/);
	assert.doesNotMatch(initial.join("\n"), /[╭╮╰╯│├┤]/, "no custom enclosing box");
	assert.match(plain(initial.join("\n")), /→ Approval wait/);
	for (let i = 0; i < 10; i++) {
		const lines = h.component.render(140);
		assert.equal(lines.length, initial.length);
		assert.ok(lines.every((line) => visibleWidth(line) === 140));
		h.component.handleInput?.("\x1b[B");
	}
	// Returned to the first field. An invalid inline edit must not resize it.
	h.component.handleInput?.("0");
	h.component.handleInput?.("\r");
	assert.match(plain(h.component.render(140).join("\n")), /Enter 5–3600s/);
	assert.equal(h.component.render(140).length, initial.length);
	h.component.handleInput?.("\x1b"); // cancel just this edit
	assert.equal(h.result, "pending");
	h.component.handleInput?.("3");
	h.component.handleInput?.("0");
	h.component.handleInput?.("\r");
	assert.match(plain(h.component.render(140).join("\n")), /30s \*/);
	assert.equal(h.component.render(140).length, initial.length);
	assert.equal(h.opens, 1, "all edits stay in the original interaction");
	h.component.handleInput?.("\x13"); // Ctrl+S
	assert.equal((h.result as unknown as AutomodeSettings).approvalTimeoutMs, 30_000);
	assert.equal(h.current.approvalTimeoutMs, 60_000, "the original settings are never mutated");
});

test("Tab commits inline edits, Escape cancels an edit before discarding the draft, focus tracks Input", async () => {
	const h = harness();
	await editTuningSettings(h.ui, h.current, "Pending: 0 managed");
	h.component.focused = true;
	h.component.handleInput?.("4");
	h.component.handleInput?.("5");
	h.component.handleInput?.("\t"); // commit 45s and move to next row
	h.component.handleInput?.("9");
	h.component.handleInput?.("5");
	h.component.handleInput?.("\t"); // commit 95% and move to confidence
	h.component.handleInput?.("7");
	h.component.handleInput?.("5");
	h.component.handleInput?.("\x1b"); // abandon 75% edit, keep 67%
	assert.equal(h.result, "pending");
	assert.match(plain(h.component.render(90).join("\n")), /67%/);
	h.component.focused = false;
	h.component.handleInput?.("\x13");
	const result = h.result as unknown as AutomodeSettings;
	assert.equal(result.approvalTimeoutMs, 45_000);
	assert.equal(result.reviewSafeThreshold, 0.95);
	assert.equal(result.reviewConfidenceThreshold, 0.67);
	const discarded = harness();
	await editTuningSettings(discarded.ui, discarded.current, "Pending: 0");
	discarded.component.handleInput?.("\x1b");
	assert.equal(discarded.result, undefined);
});

test("reset remains a draft and Save preserves models, consent, rules, and enabled state", async () => {
	const current = { ...DEFAULT_SETTINGS, enabled: true, approvalTimeoutMs: 600_000, reviewConfidenceThreshold: 0.9,
		decisionModel: { provider: "typesafe", model: "jev" }, disclosureVersion: null, allowlist: [{ text: "git status" }] };
	const h = harness(current);
	await editTuningSettings(h.ui, current, "Pending: 0");
	for (let i = 0; i < 8; i++) h.component.handleInput?.("\x1b[B");
	h.component.handleInput?.("\r"); // Reset to defaults
	assert.equal(h.result, "pending");
	assert.equal(current.approvalTimeoutMs, 600_000);
	h.component.handleInput?.("\x1b[A"); // Save changes
	h.component.handleInput?.("\r");
	const result = h.result as unknown as AutomodeSettings;
	assert.equal(result.approvalTimeoutMs, 60_000);
	assert.equal(result.reviewConfidenceThreshold, 0.67);
	assert.deepEqual(result.decisionModel, current.decisionModel);
	assert.deepEqual(result.allowlist, current.allowlist);
	assert.equal(result.disclosureVersion, null);
	assert.equal(result.enabled, true);
});

test("small terminals scroll rows without changing frame size or exceeding terminal columns", async () => {
	const h = harness();
	await editTuningSettings(h.ui, h.current, "Pending: 0 managed");
	for (const [width, height] of [[40, 16], [65, 20], [100, 28], [24, 12]]) {
		h.terminal.rows = height!;
		const baseline = h.component.render(width!);
		assert.ok(baseline.length <= height!);
		for (let i = 0; i < 10; i++) {
			const lines = h.component.render(width!);
			assert.equal(lines.length, baseline.length);
			assert.ok(lines.every((line) => visibleWidth(line) <= width!));
			h.component.handleInput?.("\x1b[B");
		}
	}
	h.component.handleInput?.("\x03");
	assert.equal(h.result, undefined, "Ctrl+C discards changes");
});
