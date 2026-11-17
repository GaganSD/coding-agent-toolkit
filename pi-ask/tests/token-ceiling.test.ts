import assert from "node:assert/strict";
import test from "node:test";
import { measureAskToolFootprint } from "../scripts/footprint.ts";
import { registerAskTool } from "../src/ask-tool.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import {
	ALL_ASK_FEATURES,
	type AskFeatures,
	NO_ASK_FEATURES,
	resolveAskFeatures,
	SHIPPED_ASK_FEATURES,
} from "../src/features.ts";

/** Est. tokens, measured exactly as `npm run tokens` does. */
const CEILING_ALL_ENABLED = 450;
const CEILING_EXPIRY_DISABLED = 420;

function schemaKeys(features: AskFeatures) {
	let parameters: any;
	registerAskTool(
		{
			registerTool(tool: { parameters: unknown }) {
				parameters = tool.parameters;
			},
		} as never,
		{ features }
	);
	return {
		call: Object.keys(parameters.properties),
		question: Object.keys(parameters.properties.questions.items.properties),
	};
}

test("ask_user footprint stays under the ceiling with everything enabled", () => {
	const { totalTokens } = measureAskToolFootprint({
		features: ALL_ASK_FEATURES,
	});
	assert.ok(
		totalTokens <= CEILING_ALL_ENABLED,
		`${totalTokens} est. tokens exceeds the ${CEILING_ALL_ENABLED} ceiling`
	);
});

test("ask_user footprint stays under the lower ceiling with expiry disabled", () => {
	for (const features of [
		{ ...ALL_ASK_FEATURES, expiry: false },
		NO_ASK_FEATURES,
		SHIPPED_ASK_FEATURES,
	]) {
		const { totalTokens } = measureAskToolFootprint({ features });
		assert.ok(
			totalTokens <= CEILING_EXPIRY_DISABLED,
			`${totalTokens} est. tokens exceeds the ${CEILING_EXPIRY_DISABLED} ceiling`
		);
	}
});

test("a disabled feature is absent from the registered schema", () => {
	assert.deepEqual(schemaKeys(NO_ASK_FEATURES), {
		call: ["title", "questions"],
		question: ["id", "label", "prompt", "type", "options"],
	});
	const all = schemaKeys(ALL_ASK_FEATURES);
	assert.deepEqual(all.call, [
		"title",
		"questions",
		"background",
		"timeoutSeconds",
	]);
	assert.ok(all.question.includes("fallback"));

	const noExpiry = schemaKeys({ ...ALL_ASK_FEATURES, expiry: false });
	assert.deepEqual(noExpiry.call, ["title", "questions", "background"]);
	assert.ok(!noExpiry.question.includes("fallback"));
});

test("config can only narrow the shipped features", () => {
	assert.deepEqual(
		resolveAskFeatures(DEFAULT_ASK_CONFIG, ALL_ASK_FEATURES),
		ALL_ASK_FEATURES
	);
	assert.deepEqual(
		resolveAskFeatures(
			{
				behaviour: { ...DEFAULT_ASK_CONFIG.behaviour, background: false },
				expiry: { ...DEFAULT_ASK_CONFIG.expiry, enabled: false },
			},
			ALL_ASK_FEATURES
		),
		NO_ASK_FEATURES
	);
	assert.deepEqual(
		resolveAskFeatures(DEFAULT_ASK_CONFIG, NO_ASK_FEATURES),
		NO_ASK_FEATURES
	);
});
