/**
 * Reports the recurring model-facing context footprint of the ask_user tool.
 * Measuring lives in ./footprint.ts, shared with the token-ceiling test.
 * Run with `npm run tokens`.
 */
import { ALL_ASK_FEATURES } from "../src/features.ts";
import { measureAskToolFootprint } from "./footprint.ts";

const row = (name, chars, tokens) =>
	console.log(`  ${name.padEnd(16)} ${String(chars).padStart(5)} / ${tokens}`);

const all = measureAskToolFootprint({ features: ALL_ASK_FEATURES });
console.log("ask_user context footprint (chars / est. tokens)");
for (const part of all.parts) {
	row(part.name, part.chars, part.tokens);
}
row("total", all.totalChars, all.totalTokens);
const noExpiry = measureAskToolFootprint({
	features: { ...ALL_ASK_FEATURES, expiry: false },
});
console.log("with optional fields (ceilings 450 / 420)");
row("all enabled", all.totalChars, all.totalTokens);
row("expiry disabled", noExpiry.totalChars, noExpiry.totalTokens);
