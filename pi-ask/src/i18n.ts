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
	/** Receipt returned to the model for a background call. */
	queuedSummary: (requestId: string) => string;
	/** Receipt returned to the model when the user chose "answer later". */
	deferredSummary: (requestId: string) => string;
	/** Trailer returned to the model after the time limit lapsed. */
	expiredSummary: (fallbackLabels: string[]) => string;
	/** Heading of the follow-up message that carries a late answer. */
	answerDelivered: (requestId: string, title?: string) => string;
	/** Follow-up message for a form cancelled after its tool call ended. */
	cancelDelivered: (requestId: string, title?: string) => string;
	/** Shown to the user when an interrupted form reopens. */
	recoveredNotice: string;
	/** Short transcript labels for the non-answer statuses. */
	queuedLabel: string;
	deferredLabel: string;
	expiredLabel: string;
}

const EN_RECEIPT_RULES =
	"This is a receipt, not an answer or approval. Continue only with work that does not depend on it; the answer arrives in a later message. Do not ask again.";
const ZH_RECEIPT_RULES =
	"这只是回执，不是回答，也不是批准。只继续不依赖该回答的工作；回答会在之后的消息中送达。不要重复提问。";

function formRef(requestId: string, title?: string): string {
	return title ? `${requestId} (${title})` : requestId;
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
	queuedSummary: (requestId) =>
		`Queued as ${requestId}. ${EN_RECEIPT_RULES}`,
	deferredSummary: (requestId) =>
		`User will answer later (${requestId}). ${EN_RECEIPT_RULES}`,
	expiredSummary: (fallbackLabels) =>
		[
			"No response within the time limit.",
			fallbackLabels.length > 0
				? `Fallback applied for: ${fallbackLabels.join(", ")}.`
				: "No fallback was applied.",
			"A fallback is your own assumption, not user approval; keep irreversible actions blocked. The user may still correct it.",
		].join(" "),
	answerDelivered: (requestId, title) =>
		`User answered your earlier ask_user form ${formRef(requestId, title)}:`,
	cancelDelivered: (requestId, title) =>
		`User cancelled your earlier ask_user form ${formRef(requestId, title)}. Cancellation is not approval; keep risky actions blocked.`,
	recoveredNotice: "Reopened a question left unanswered when Pi last stopped",
	queuedLabel: "Queued",
	deferredLabel: "Answer later",
	expiredLabel: "Expired",
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
	queuedSummary: (requestId) => `已排队，编号 ${requestId}。${ZH_RECEIPT_RULES}`,
	deferredSummary: (requestId) =>
		`用户稍后回答（${requestId}）。${ZH_RECEIPT_RULES}`,
	expiredSummary: (fallbackLabels) =>
		[
			"用户未在时限内回应。",
			fallbackLabels.length > 0
				? `已对以下问题应用备选项：${fallbackLabels.join("、")}。`
				: "没有应用任何备选项。",
			"备选项只是你自己的假设，不是用户批准；不可逆的操作仍须保持阻止。用户之后仍可更正。",
		].join(""),
	answerDelivered: (requestId, title) =>
		`用户回答了你之前的 ask_user 表单 ${formRef(requestId, title)}：`,
	cancelDelivered: (requestId, title) =>
		`用户取消了你之前的 ask_user 表单 ${formRef(requestId, title)}。取消不代表批准；有风险的操作仍须保持阻止。`,
	recoveredNotice: "已重新打开上次 Pi 停止时未回答的问题",
	queuedLabel: "已排队",
	deferredLabel: "稍后回答",
	expiredLabel: "已超时",
};

/** Strings for PI_ASK_LOCALE; any zh* tag picks Simplified Chinese. */
export function askStrings(): AskStrings {
	return process.env.PI_ASK_LOCALE?.trim().toLowerCase().startsWith("zh")
		? ZH_STRINGS
		: EN_STRINGS;
}
