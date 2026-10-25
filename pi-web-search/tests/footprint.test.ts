import assert from "node:assert/strict";
import test from "node:test";
import { measureFootprint } from "../scripts/footprint.ts";

test("host-built declarations and result payloads stay within context budgets", async () => {
	const prior = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("Footprint measurement must be offline"); };
	try {
		const sample = await measureFootprint();
		assert.deepEqual(sample.modes.default.tools, ["search"]);
		assert.deepEqual(sample.modes.research.tools, ["search"]);
		assert.ok(sample.modes.default.estimatedTokens <= 380, JSON.stringify(sample.modes.default));
		assert.ok(sample.modes.research.estimatedTokens <= 380, JSON.stringify(sample.modes.research));
		assert.equal(sample.modes.default.continuationSchemaChars, 0);
		assert.equal(sample.result.previewCount, 8);
		assert.ok(sample.result.directChars <= 4500);
		assert.ok(sample.result.structuredChars <= 6000);
	} finally { globalThis.fetch = prior; }
});
