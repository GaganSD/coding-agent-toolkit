import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASK_CONFIG, normalizeAskConfig } from "../src/config/defaults.ts";
import {
	DEFAULT_ASK_KEYMAPS,
	normalizeConfiguredKeymaps,
	renderFooterKeymaps,
} from "../src/constants/keymaps.ts";

/** Keymaps as a config file written before the panel keys existed. */
function legacyKeymaps() {
	const keymaps = structuredClone(DEFAULT_ASK_KEYMAPS) as any;
	delete keymaps.global.later;
	delete keymaps.global.panelFocus;
	return keymaps;
}

test("the panel keys default to ctrl+l and alt+a", () => {
	assert.deepEqual(DEFAULT_ASK_KEYMAPS.global.later, ["ctrl+l"]);
	assert.deepEqual(DEFAULT_ASK_KEYMAPS.global.panelFocus, ["alt+a"]);
});

test("a config from before the panel keys keeps its bindings and gains the defaults", () => {
	const keymaps = legacyKeymaps();
	keymaps.main.confirm = ["ctrl+y"];
	const config = normalizeAskConfig({ keymaps });
	assert.deepEqual(config.keymaps.main.confirm, ["ctrl+y"], "custom keys survive");
	assert.deepEqual(config.keymaps.global.later, ["ctrl+l"]);
	assert.deepEqual(config.keymaps.global.panelFocus, ["alt+a"]);
});

test("a new default never takes a key the user already bound", () => {
	const keymaps = legacyKeymaps();
	keymaps.main.optionNote = ["ctrl+l"];
	const result = normalizeConfiguredKeymaps(keymaps);
	assert.ok(result.ok);
	assert.deepEqual(result.keymaps.main.optionNote, ["ctrl+l"]);
	assert.deepEqual(result.keymaps.global.later, [], "left unbound instead");
	assert.deepEqual(result.keymaps.global.panelFocus, ["alt+a"]);
	// The unbound action round-trips and shows no footer hint.
	const again = normalizeConfiguredKeymaps(result.keymaps);
	assert.ok(again.ok);
	assert.deepEqual(again.keymaps.global.later, []);
	const config = { ...DEFAULT_ASK_CONFIG, keymaps: again.keymaps };
	assert.doesNotMatch(
		renderFooterKeymaps(config, "default", { defer: true }),
		/answer later/
	);
});

test("the panel keys are configurable and still checked for conflicts", () => {
	const keymaps = structuredClone(DEFAULT_ASK_KEYMAPS);
	keymaps.global.panelFocus = ["f6"];
	keymaps.global.later = ["ctrl+b"];
	const result = normalizeConfiguredKeymaps(keymaps);
	assert.ok(result.ok);
	assert.deepEqual(result.keymaps.global.panelFocus, ["f6"]);

	keymaps.global.later = ["enter"];
	const conflict = normalizeConfiguredKeymaps(keymaps);
	assert.equal(conflict.ok, false);
});

test("footer hints follow the surface the form is drawn on", () => {
	const modal = renderFooterKeymaps(DEFAULT_ASK_CONFIG, "default");
	assert.match(modal, /Esc dismiss/);
	assert.doesNotMatch(modal, /later|Alt\+A/);

	const deferrable = renderFooterKeymaps(DEFAULT_ASK_CONFIG, "default", { defer: true });
	assert.match(deferrable, /Esc dismiss/);
	assert.match(deferrable, /Ctrl\+L answer later/);

	const panel = { panel: { focused: true } };
	for (const context of ["default", "multi", "submit"] as const) {
		const hints = renderFooterKeymaps(DEFAULT_ASK_CONFIG, context, panel);
		assert.match(hints, /Esc hide/);
		assert.doesNotMatch(hints, /Esc (dismiss|cancel)/);
		assert.match(hints, /Ctrl\+C cancel form/);
		assert.match(hints, /Alt\+A input/);
	}
	const editing = renderFooterKeymaps(DEFAULT_ASK_CONFIG, "input", panel);
	assert.match(editing, /Esc close/);
	assert.match(editing, /Ctrl\+L hide/);

	assert.equal(
		renderFooterKeymaps(DEFAULT_ASK_CONFIG, "default", { panel: { focused: false } }),
		" Alt+A answer here · typing goes to the input below"
	);
});
