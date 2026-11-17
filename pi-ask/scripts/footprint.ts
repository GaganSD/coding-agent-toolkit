/**
 * Recurring model-facing context footprint of a registered tool: description,
 * prompt snippet/guidelines, and the JSON parameter schema. Tokens are a fixed
 * character-proxy estimate (ceil(chars / 4)), not provider tokenizer billing.
 * Shared by `npm run tokens` and the token-ceiling test.
 */
import { type AskToolOptions, registerAskTool } from "../src/ask-tool.ts";

export interface FootprintPart {
	chars: number;
	name: string;
	tokens: number;
}

export interface Footprint {
	parts: FootprintPart[];
	totalChars: number;
	totalTokens: number;
}

interface RegisteredTool {
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	promptSnippet?: string;
}

export function measureAskToolFootprint(options?: AskToolOptions): Footprint {
	let tool: RegisteredTool | undefined;
	registerAskTool(
		{
			registerTool(registered: RegisteredTool) {
				tool = registered;
			},
		} as never,
		options
	);
	if (!tool) {
		throw new Error("ask_user was not registered");
	}
	return measureToolFootprint(tool);
}

export function measureToolFootprint(tool: RegisteredTool): Footprint {
	const texts = {
		description: tool.description,
		promptSnippet: tool.promptSnippet ?? "",
		promptGuidelines: (tool.promptGuidelines ?? []).join("\n"),
		parameters: JSON.stringify(tool.parameters),
	};
	const parts = Object.entries(texts).map(([name, text]) => ({
		name,
		chars: text.length,
		tokens: Math.ceil(text.length / 4),
	}));
	return {
		parts,
		totalChars: parts.reduce((sum, part) => sum + part.chars, 0),
		totalTokens: parts.reduce((sum, part) => sum + part.tokens, 0),
	};
}
