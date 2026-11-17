import {
	CANCELLED_RESULT_TEXT,
	SUBMITTED_RESULT_TEXT,
} from "./constants/text.ts";
import { askStrings } from "./i18n.ts";
import { formatResultLines } from "./result-format.ts";
import type { AskResult } from "./types.ts";

export function renderResultText(result: AskResult): string {
	if (result.status === "invalid" || result.error) {
		return "Invalid tool payload";
	}
	if (result.status === "cancelled") {
		return CANCELLED_RESULT_TEXT;
	}
	if (result.status === "unavailable") {
		return "Needs user input";
	}

	if (result.status === "queued") {
		return askStrings().queuedLabel;
	}
	if (result.status === "deferred") {
		return askStrings().deferredLabel;
	}

	const lines = formatResultLines(result, { mode: "render" });
	if (result.status === "expired") {
		return [askStrings().expiredLabel, ...lines].join("\n");
	}
	return lines.join("\n") || SUBMITTED_RESULT_TEXT;
}
