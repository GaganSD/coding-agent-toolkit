/**
 * Locale-aware UI strings. English is the default; `PI_ASK_LOCALE=zh`
 * (or any zh-* tag) switches the dialog fallback and result summaries to
 * Simplified Chinese. Unknown tags fall back to English.
 */

export interface AskStrings {
	/** Row that navigates to the previous question, carrying its tab label. */
	backTo: (label: string) => string;
	/** Row that leaves a multi-question card, carrying the picked count. */
	done: (count: number) => string;
	/** Row that advances a single-choice card without answering. */
	skip: string;
	/** Row that opens a freeform answer prompt. */
	typeYourOwn: string;
	/** Title of the freeform answer prompt. */
	customAnswerTitle: string;
	/** Heading of the pre-submit review card. */
	reviewHeading: string;
	/** Row that submits the whole flow from the review card. */
	submitAnswers: string;
	/** Row that cancels the flow from the review card. */
	cancel: string;
	/** Placeholder for an unanswered question in the review card. */
	noAnswer: string;
	/** Marker appended to a recommended option's row. */
	recommendedMarker: string;
	/** One-line summary returned to the model when the user cancels. */
	cancelledSummary: string;
	/** One-line summary returned to the model when the user submits. */
	submittedSummary: string;
}

const EN_STRINGS: AskStrings = {
	backTo: (label) => `← Back to ${label}`,
	done: (count) => `✔ Done (${count} selected)`,
	skip: "→ Skip for now",
	typeYourOwn: "✎ Type your own",
	customAnswerTitle: "Type your answer:",
	reviewHeading: "Review your answers",
	submitAnswers: "✔ Submit answers",
	cancel: "✕ Cancel",
	noAnswer: "—",
	recommendedMarker: "(Recommended)",
	cancelledSummary: "User cancelled the ask flow",
	submittedSummary: "User submitted the ask flow",
};

const ZH_STRINGS: AskStrings = {
	backTo: (label) => `← 返回${label}`,
	done: (count) => `✔ 完成（已选 ${count} 项）`,
	skip: "→ 暂时跳过",
	typeYourOwn: "✎ 自己输入",
	customAnswerTitle: "请输入你的回答：",
	reviewHeading: "检查你的回答",
	submitAnswers: "✔ 提交答案",
	cancel: "✕ 取消",
	noAnswer: "—",
	recommendedMarker: "（推荐）",
	cancelledSummary: "用户取消了提问流程",
	submittedSummary: "用户提交了提问流程",
};

/** Strings for PI_ASK_LOCALE; any zh* tag picks Simplified Chinese. */
export function askStrings(): AskStrings {
	return process.env.PI_ASK_LOCALE?.trim().toLowerCase().startsWith("zh")
		? ZH_STRINGS
		: EN_STRINGS;
}
