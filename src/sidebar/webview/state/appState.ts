import { WebviewAppState } from "../types/webviewTypes";

/**
 * Centralized State Manager for the Webview UI.
 *
 * This singleton object serves as the single source of truth for all transient,
 * reactive state variables required by the webview components (e.g., UI flags,
 * DOM element references, active operation IDs, current streaming buffers, and pending user actions).
 * It ensures consistent state synchronization across the UI layer.
 */
export const appState: WebviewAppState = {
	/**
	 * Reference to the DOM element containing the currently streaming AI message content.
	 */
	currentAiMessageContentElement: null,

	/**
	 * The full text accumulated during the current streaming AI response.
	 */
	currentAccumulatedText: "",

	/**
	 * Buffer holding the text waiting to be typed out during the streaming animation.
	 */
	typingBuffer: "",

	/**
	 * Timer ID used for managing the typing animation interval.
	 */
	typingTimer: null,

	/**
	 * Speed of the typing animation in milliseconds per interval.
	 */
	TYPING_SPEED_MS: 50,

	/**
	 * Number of characters to append in each typing interval.
	 */
	CHARS_PER_INTERVAL: 1,

	/**
	 * Index of the currently active (highlighted) command suggestion in the list.
	 */
	activeCommandIndex: -1,

	/**
	 * List of commands matching the user's current input for suggestion display.
	 */
	filteredCommands: [],

	/**
	 * Flag indicating whether the command suggestion dropdown is visible.
	 */
	isCommandSuggestionsVisible: false,

	/**
	 * Flag indicating whether heuristic context inclusion is currently enabled.
	 */
	isHeuristicContextEnabled: true,

	/**
	 * Reference to the DOM element for the plan confirmation container.
	 */
	planConfirmationContainer: null,

	/**
	 * Reference to the DOM element for the confirm plan button.
	 */
	confirmPlanButton: null,

	/**
	 * Reference to the DOM element for the cancel plan button.
	 */
	cancelPlanButton: null,

	/**
	 * Data payload for the plan currently awaiting user confirmation.
	 */
	pendingPlanData: null,

	/**
	 * Data payload for Git commit messages currently awaiting user review.
	 */
	pendingCommitReviewData: null,

	/**
	 * Flag indicating if the Gemini API key has been successfully set by the user.
	 */
	isApiKeySet: false,

	/**
	 * Flag indicating if a general request is currently being processed by the backend (e.g., waiting for initial response).
	 */
	isLoading: false,

	/**
	 * Flag indicating if the user is required to review or confirm an action (e.g., plan or commit review).
	 */
	isAwaitingUserReview: false,

	/**
	 * Flag indicating if a cancellation request has been sent to the backend.
	 */
	isCancelling: false,

	/**
	 * Flag indicating if the Git commit review and application process is in progress.
	 */
	isCommitActionInProgress: false,

	/**
	 * Flag indicating if a task is currently undergoing cancellation processing.
	 */
	isCancellationInProgress: false,

	/**
	 * Flag indicating if an autonomous plan execution is currently running.
	 */
	isPlanExecutionInProgress: false,

	/**
	 * List of steps in the currently executing plan.
	 */
	currentPlanSteps: [],

	/**
	 * Index of the currently executing step within the current plan.
	 */
	currentPlanStepIndex: -1,

	/**
	 * Flag indicating if there are changes logged by the AI that can be reverted.
	 */
	hasRevertibleChanges: false,

	/**
	 * Total number of API keys configured in the extension.
	 */
	totalKeys: 0,

	/**
	 * Currently selected index for file or command suggestions (shared index).
	 */
	activeIndex: -1,

	/**
	 * Flag indicating whether the token usage statistics should be displayed.
	 */
	isTokenUsageVisible: false,

	/**
	 * The index to assign to the next incoming message for continuity.
	 */
	nextMessageIndex: 0,

	/**
	 * List of base64 encoded images selected by the user to be sent with the next message.
	 */
	selectedImages: [],

	/**
	 * Cached list of all files in the workspace for file selection features.
	 */
	allWorkspaceFiles: [],

	/**
	 * Flag indicating if the workspace file list is currently being fetched from the extension host.
	 */
	isRequestingWorkspaceFiles: false,

	/**
	 * Type of the current suggestion overlay active ("command", "file", or "none").
	 */
	currentSuggestionType: "none",

	/**
	 * Current search query used when filtering workspace files for inclusion.
	 */
	currentFileSearchQuery: "",

	/**
	 * Index of the message being edited by the user, or null if no message is being edited.
	 */
	editingMessageIndex: null,

	/**
	 * Flag indicating if the user is currently editing a previous message.
	 */
	isEditingMessage: false,

	/**
	 * The unique ID of the currently active operation (e.g., plan generation, chat response).
	 */
	currentActiveOperationId: null,

	/**
	 * The most recently received and formatted token usage statistics.
	 */
	lastFormattedTokenStats: null,
};