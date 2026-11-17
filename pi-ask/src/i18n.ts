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
	queuedSummary: (requestId: string, pending?: number) => string;
	/** Receipt returned to the model when the user chose "answer later". */
	deferredSummary: (requestId: string) => string;
	/** Appended to an answer the tool applied itself after the limit lapsed. */
	fallbackMark: string;
	/** Trailer returned to the model after the time limit lapsed. */
	expiredSummary: (fallbackLabels: string[]) => string;
	/** Heading of the follow-up message that carries a late answer. */
	answerDelivered: (requestId: string, title?: string) => string;
	/** Follow-up message for a form cancelled after its tool call ended. */
	cancelDelivered: (requestId: string, title?: string) => string;
	/** Heading of the follow-up message for a form that timed out while queued. */
	expiredDelivered: (requestId: string, title?: string) => string;
	/** Heading when the user answers a form that had timed out (late override). */
	correctionDelivered: (requestId: string, title?: string) => string;
	/** Heading when the user cancels a form that had timed out. */
	correctionCancelDelivered: (requestId: string, title?: string) => string;
	/** Form header while the limit counts down. */
	countdownRunning: (remaining: string, hasFallback: boolean) => string;
	/** Form header after the user stopped the countdown. */
	countdownStopped: string;
	/** Marks the option the agent declared as its fallback. */
	fallbackOptionMarker: string;
	/** Form header when an expired form is reopened for a correction. */
	lateOverrideBanner: string;
	/** Under the editor: expired forms that can still be answered. */
	expiredIndicator: (count: number) => string;
	/** Shown to the user when an interrupted form reopens. */
	recoveredNotice: string;
	/** Line under the editor while forms wait in the queue. */
	pendingIndicator: (info: {
		focused: boolean;
		forms: number;
		key: string;
		questions: number;
	}) => string;
	/** A background question arrived while the panel is hidden. */
	queuedHiddenNotice: string;
	/** `/ask-panel` with nothing in the queue. */
	nothingPending: string;
	/** `/ask-panel` outside the interactive TUI. */
	panelNeedsTui: string;
	/** This Pi cannot move the keyboard into the panel. */
	panelFocusUnsupported: string;
	/** Transcript card headings for a delivered answer or cancellation. */
	answeredCardLabel: string;
	cancelledCardLabel: string;
	correctedCardLabel: string;
	expiredCardLabel: string;
	/** Short transcript labels for the non-answer statuses. */
	queuedLabel: string;
	deferredLabel: string;
	expiredLabel: string;
}

const EN_RECEIPT_RULES =
	"This is a receipt, not an answer or approval. Continue only with work that does not depend on it; the answer arrives in a later message. Do not ask again.";
const ZH_RECEIPT_RULES =
	"这只是回执，不是回答，也不是批准。只继续不依赖该回答的工作；回答会在之后的消息中送达。不要重复提问。";

function count(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

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
	queuedSummary: (requestId, pending) =>
		`Queued as ${requestId}${
			pending && pending > 1 ? ` (${pending} forms waiting)` : ""
		}. ${EN_RECEIPT_RULES}`,
	deferredSummary: (requestId) =>
		`User will answer later (${requestId}). ${EN_RECEIPT_RULES}`,
	fallbackMark: "[fallback: not chosen by the user]",
	expiredSummary: (fallbackLabels) =>
		[
			"The user did not respond within the time limit.",
			fallbackLabels.length > 0
				? `Fallback applied for: ${fallbackLabels.join(", ")}.`
				: "No fallback was applied.",
			"A fallback is your own assumption, not user approval; keep irreversible and risky actions blocked. The user may still correct it.",
		].join(" "),
	answerDelivered: (requestId, title) =>
		`User answered your earlier ask_user form ${formRef(requestId, title)}:`,
	cancelDelivered: (requestId, title) =>
		`User cancelled your earlier ask_user form ${formRef(requestId, title)}. Cancellation is not approval; keep risky actions blocked.`,
	expiredDelivered: (requestId, title) =>
		`Your earlier ask_user form ${formRef(requestId, title)} timed out.`,
	correctionDelivered: (requestId, title) =>
		`CORRECTION: the user answered your earlier ask_user form ${formRef(requestId, title)} after it timed out. This replaces the timed-out result, fallbacks included. A question marked (no answer) has none: do not rely on a fallback for it.`,
	correctionCancelDelivered: (requestId, title) =>
		`CORRECTION: the user cancelled your earlier ask_user form ${formRef(requestId, title)} after it timed out. Any fallback you applied is withdrawn. Cancellation is not approval; keep risky actions blocked.`,
	countdownRunning: (remaining, hasFallback) =>
		hasFallback
			? `⏱ No reply in ${remaining}: the marked fallback will be applied. Press any key to stop the countdown.`
			: `⏱ Times out in ${remaining} with no answer applied. Press any key to stop the countdown.`,
	countdownStopped: "Countdown stopped; this form now waits for you.",
	fallbackOptionMarker: "(fallback)",
	lateOverrideBanner:
		"This form timed out. Your answer is sent to the agent as a correction.",
	expiredIndicator: (count) =>
		`↺ ${count === 1 ? "1 timed-out form" : `${count} timed-out forms`} can still be answered · /ask-panel`,
	recoveredNotice: "Reopened a question left unanswered when Pi last stopped",
	pendingIndicator: ({ focused, forms, key, questions }) =>
		[
			questions > 0
				? `? ${count(questions, "unanswered question")} in ${count(forms, "form")}`
				: `? ${count(forms, "form")} ready to submit`,
			key ? `${key} ${focused ? "back to input" : "answer"}` : "",
			"/ask-panel",
		]
			.filter(Boolean)
			.join(" · "),
	queuedHiddenNotice: "New question queued. /ask-panel to open it",
	nothingPending: "No questions are waiting",
	panelNeedsTui: "/ask-panel requires interactive TUI mode.",
	panelFocusUnsupported:
		"This Pi version cannot focus the question panel; update Pi to answer queued questions",
	answeredCardLabel: "answered",
	cancelledCardLabel: "cancelled",
	correctedCardLabel: "corrected",
	expiredCardLabel: "timed out",
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
	queuedSummary: (requestId, pending) =>
		`已排队，编号 ${requestId}${
			pending && pending > 1 ? `（共 ${pending} 个表单待回答）` : ""
		}。${ZH_RECEIPT_RULES}`,
	deferredSummary: (requestId) =>
		`用户稍后回答（${requestId}）。${ZH_RECEIPT_RULES}`,
	fallbackMark: "[备选项：并非用户所选]",
	expiredSummary: (fallbackLabels) =>
		[
			"用户未在时限内回应。",
			fallbackLabels.length > 0
				? `已对以下问题应用备选项：${fallbackLabels.join("、")}。`
				: "没有应用任何备选项。",
			"备选项只是你自己的假设，不是用户批准；不可逆和有风险的操作仍须保持阻止。用户之后仍可更正。",
		].join(""),
	answerDelivered: (requestId, title) =>
		`用户回答了你之前的 ask_user 表单 ${formRef(requestId, title)}：`,
	cancelDelivered: (requestId, title) =>
		`用户取消了你之前的 ask_user 表单 ${formRef(requestId, title)}。取消不代表批准；有风险的操作仍须保持阻止。`,
	expiredDelivered: (requestId, title) =>
		`你之前的 ask_user 表单 ${formRef(requestId, title)} 已超时。`,
	correctionDelivered: (requestId, title) =>
		`更正：用户在你之前的 ask_user 表单 ${formRef(requestId, title)} 超时后作出了回答。此回答取代超时结果（包括备选项）。标为（无回答）的问题没有回答，不要依赖其备选项。`,
	correctionCancelDelivered: (requestId, title) =>
		`更正：用户在你之前的 ask_user 表单 ${formRef(requestId, title)} 超时后取消了它。你应用过的备选项一律撤回。取消不代表批准；有风险的操作仍须保持阻止。`,
	countdownRunning: (remaining, hasFallback) =>
		hasFallback
			? `⏱ ${remaining} 内无回复：将应用标记的备选项。按任意键停止倒计时。`
			: `⏱ ${remaining} 后超时，不会应用任何答案。按任意键停止倒计时。`,
	countdownStopped: "倒计时已停止；此表单现在等你回答。",
	fallbackOptionMarker: "（备选项）",
	lateOverrideBanner: "此表单已超时。你的回答会作为更正发送给代理。",
	expiredIndicator: (count) =>
		`↺ ${count} 个已超时的表单仍可回答 · /ask-panel`,
	recoveredNotice: "已重新打开上次 Pi 停止时未回答的问题",
	pendingIndicator: ({ focused, forms, key, questions }) =>
		[
			questions > 0
				? `? ${forms} 个表单中有 ${questions} 个问题待回答`
				: `? ${forms} 个表单可以提交`,
			key ? `${key} ${focused ? "返回输入框" : "回答"}` : "",
			"/ask-panel",
		]
			.filter(Boolean)
			.join(" · "),
	queuedHiddenNotice: "有新问题已排队。输入 /ask-panel 打开",
	nothingPending: "没有待回答的问题",
	panelNeedsTui: "/ask-panel 需要交互式 TUI 模式。",
	panelFocusUnsupported: "当前 Pi 版本无法聚焦问题面板；请更新 Pi 以回答排队的问题",
	answeredCardLabel: "已回答",
	cancelledCardLabel: "已取消",
	correctedCardLabel: "已更正",
	expiredCardLabel: "已超时",
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
