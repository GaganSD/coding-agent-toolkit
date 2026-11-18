export const UI_DIMENSIONS = {
	callLabelTruncateWidth: 50,
	editorContentPadding: 5,
	editorIndentedPadding: 7,
	editorMinWidth: 8,
	submitWideMinWidth: 64,
	submitMinReviewWidth: 24,
} as const;

export const UI_TEXT = {
	recommendedMarker: "(recommended)",
	questionNoteTitle: "Note:",
	reviewTitle: "Review answers",
	unanswered: "→ unanswered",
	skipped: "→ skipped (declined, not unanswered)",
	skippedQuestion: "⊘ Skipped. Answer it to take the skip back.",
	commentTitle: "Why are you cancelling? The agent will see this.",
	editorPlaceholderComment: "Add a comment (optional)...",
	editorPlaceholderInput: "Type answer...",
	editorPlaceholderNote: "Add a note...",
} as const;
