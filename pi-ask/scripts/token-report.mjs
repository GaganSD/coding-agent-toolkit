/**
 * Reports the recurring model-facing context footprint of the ask_user tool:
 * description, prompt snippet/guidelines, and the JSON parameter schema.
 * Tokens are a fixed character-proxy estimate (ceil(chars / 4)), not provider
 * tokenizer billing. Run with `npm run tokens`.
 */
import { registerAskTool } from "../src/ask-tool.ts";

let tool;
registerAskTool({
	registerTool(registered) {
		tool = registered;
	},
});

const parts = {
	description: tool.description,
	promptSnippet: tool.promptSnippet,
	promptGuidelines: tool.promptGuidelines.join("\n"),
	parameters: JSON.stringify(tool.parameters),
};

const estimate = (text) => Math.ceil(text.length / 4);
let totalChars = 0;
let totalTokens = 0;

console.log("ask_user context footprint (chars / est. tokens)");
for (const [name, text] of Object.entries(parts)) {
	const tokens = estimate(text);
	totalChars += text.length;
	totalTokens += tokens;
	console.log(`  ${name.padEnd(16)} ${String(text.length).padStart(5)} / ${tokens}`);
}
console.log(`  ${"total".padEnd(16)} ${String(totalChars).padStart(5)} / ${totalTokens}`);
