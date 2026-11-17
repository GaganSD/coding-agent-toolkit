export type AskQuestionType = "single" | "multi" | "text";

export interface AskOption {
	description?: string;
	label: string;
	recommended?: boolean;
	value: string;
}

export interface AskQuestionInput {
	/** Option `value` applied if the call's time limit lapses. Never on `text`. */
	fallback?: string;
	id: string;
	label?: string;
	options?: AskOption[];
	prompt: string;
	type?: AskQuestionType;
}

export interface AskParams {
	/** Queue the form and return a `queued` receipt at once. */
	background?: boolean;
	questions: AskQuestionInput[];
	/** Time limit in seconds, counted from when the form is on screen. */
	timeoutSeconds?: number;
	title?: string;
}

export interface AskValidationIssue {
	message: string;
	path: string;
}

export interface AskValidationError {
	issues: AskValidationIssue[];
	kind: "invalid_input";
}

export interface AskQuestion
	extends Omit<AskQuestionInput, "type" | "label" | "options"> {
	label: string;
	options: AskOption[];
	presentedType?: AskQuestionType;
	requestedType?: AskQuestionType;
	type: AskQuestionType;
}

export interface AskSelectedOption {
	index: number;
	label: string;
	value: string;
}

export interface AskStateAnswer {
	customSelected?: boolean;
	customText?: string;
	note?: string;
	optionNotes?: Record<string, string>;
	selected: AskSelectedOption[];
}

export interface AskResultAnswer {
	customText?: string;
	labels: string[];
	note?: string;
	optionNotes?: Record<string, string>;
	values: string[];
}

export interface AskQuestionSummary {
	id: string;
	label: string;
	presentedType?: AskQuestionType;
	prompt: string;
	type: AskQuestionType;
}

/**
 * `queued` and `deferred` are receipts, not answers: the form is still open
 * and its answer arrives later. `expired` carries declared fallbacks only.
 */
export type AskResultStatus =
	| "submitted"
	| "cancelled"
	| "unavailable"
	| "invalid"
	| "queued"
	| "deferred"
	| "expired";

export interface AskResult {
	answers: Record<string, AskResultAnswer>;
	/** Why the user cancelled, when they said. */
	comment?: string;
	error?: AskValidationError;
	/** Forms waiting for an answer, this one included (`queued` only). */
	pending?: number;
	/** Question ids whose answer is an auto-applied fallback (`expired` only). */
	expired?: string[];
	questions: AskQuestionSummary[];
	/** Journal id of the form; ties receipts to the answer delivered later. */
	requestId?: string;
	/** Question ids the user explicitly declined. Skipped is not approval. */
	skipped?: string[];
	status: AskResultStatus;
	title?: string;
	unanswered: string[];
}

export type ViewState =
	| { kind: "navigate" }
	| { kind: "submit" }
	| { kind: "input"; questionId: string }
	| { kind: "note"; questionId: string; optionValue?: string };

export interface AskState {
	activeOptionIndex: number;
	activeSubmitActionIndex: number;
	activeTabIndex: number;
	answers: Record<string, AskStateAnswer>;
	cancelled: boolean;
	completed: boolean;
	questions: AskQuestion[];
	title?: string;
	view: ViewState;
}

export interface AskDisplayOption extends AskOption {
	isCustomOption?: boolean;
	isFreeformOnlyOption?: boolean;
}
