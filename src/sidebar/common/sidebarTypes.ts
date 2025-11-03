import * as vscode from "vscode";
import { Content } from "@google/generative-ai";
import { ActiveSymbolDetailedInfo } from "../../services/contextService";

export interface ImageInlineData {
	mimeType: string;
	data: string; // Base64 encoded string
}

export type HistoryEntryPart =
	| { text: string }
	| { inlineData: ImageInlineData };

export interface HistoryEntry extends Omit<Content, "parts"> {
	parts: HistoryEntryPart[];
	diffContent?: string;
	relevantFiles?: string[];
	isRelevantFilesExpanded?: boolean;
	isPlanExplanation?: boolean;
	isPlanStepUpdate?: boolean;
}

export interface ToggleRelevantFilesDisplayMessage {
	type: "toggleRelevantFilesDisplay";
	messageIndex: number;
	isExpanded: boolean;
}

export interface UpdateRelevantFilesDisplayMessage {
	type: "updateRelevantFilesDisplay";
	messageIndex: number;
	isExpanded: boolean;
}

export interface OpenUrlMessage {
	command: "openUrl";
	url: string;
}

export interface ApiKeyInfo {
	maskedKey: string;
	index: number;
	isActive: boolean;
}

export interface KeyUpdateData {
	keys: ApiKeyInfo[];
	activeIndex: number;
	totalKeys: number;
}

export interface ChatMessage {
	sender: "User" | "Model" | "System";
	text: string;
	className: string;
	diffContent?: string;
	relevantFiles?: string[];
	isRelevantFilesExpanded?: boolean;
	isPlanExplanation?: boolean;
	isPlanStepUpdate?: boolean;
	imageParts?: ImageInlineData[];
}

export interface EditChatMessage {
	type: "editChatMessage";
	messageIndex: number; // The index of the message in the chat history array
	newContent: string; // The new, edited content of the message
}

// Webview to Extension for generating plan prompt from AI message
export interface GeneratePlanPromptFromAIMessage {
	type: "generatePlanPromptFromAIMessage";
	payload: { messageIndex: number };
}

export interface RevertRequestMessage {
	type: "revertRequest";
}

export interface WebviewToExtensionChatMessageType {
	type: "chatMessage";
	value: string;
	groundingEnabled: boolean;
	imageParts?: Array<{ mimeType: string; data: string }>; // Optional array of image data
}

export interface RequestWorkspaceFilesMessage {
	type: "requestWorkspaceFiles";
}

export interface CopyContextMessagePayload {
	messageIndex: number;
	contentToCopy: string;
}

/**
 * Union type for all messages sent from the Webview to the Extension.
 * Each member should have a distinct 'type' literal property.
 */
export type WebviewToExtensionMessages =
	| ToggleRelevantFilesDisplayMessage
	| UpdateRelevantFilesDisplayMessage
	| EditChatMessage
	| GeneratePlanPromptFromAIMessage
	| RevertRequestMessage
	| WebviewToExtensionChatMessageType
	| RequestWorkspaceFilesMessage
	| { type: "copyContextMessage"; payload: CopyContextMessagePayload };

// Extension to Webview for signaling plan timeline initialization
export interface PlanTimelineInitializeMessage {
	type: "planTimelineInitialize";
	stepDescriptions: string[];
}

// Extension to Webview for signaling plan timeline step progress
export interface PlanTimelineProgressMessage {
	type: "planTimelineProgress";
	stepIndex: number;
	status: "running" | "success" | "skipped" | "failed" | "queued";
	detail?: string;
	diffContent?: string;
}

// Extension to Webview for pre-filling chat input
export interface PrefillChatInput {
	type: "PrefillChatInput";
	payload: { text: string };
}

// Extension to Webview for signaling that a file URI has been loaded (e.g., for webview initial setup)
export interface FileUriLoadedMessage {
	type: "fileUriLoaded";
	uri: string;
}

// Placeholder interfaces for other ExtensionToWebviewMessages inferred from usage
// These are not exhaustive but represent common message types.
export interface StatusUpdateMessage {
	type: "statusUpdate";
	value: string;
	isError?: boolean;
	subPlanId?: string;
	showLoadingDots?: boolean;
}

export interface AiResponseStartMessage {
	type: "aiResponseStart";
	value: { modelName: string; relevantFiles: string[]; operationId: string };
}

export interface AiResponseChunkMessage {
	type: "aiResponseChunk";
	value: string;
	operationId: string;
}

export interface AiResponseEndMessage {
	type: "aiResponseEnd";
	success: boolean;
	error: string | null;
	isPlanResponse?: boolean;
	requiresConfirmation?: boolean;
	planData?: any;
	isCommitReviewPending?: boolean;
	commitReviewData?: { commitMessage: string; stagedFiles: string[] } | null;
	statusMessageOverride?: string;
	operationId: string;
}

export interface UpdateLoadingStateMessage {
	type: "updateLoadingState";
	value: boolean;
}

export interface ReenableInputMessage {
	type: "reenableInput";
}

export interface UpdateCancellationStateMessage {
	type: "updateCancellationState";
	value: boolean;
}

export interface ApiKeyStatusMessage {
	type: "apiKeyStatus";
	value: string;
}

export interface ModelInfo {
	name: string;
	description: string;
}

export interface UpdateModelListMessage {
	type: "updateModelList";
	value: { availableModels: ModelInfo[]; selectedModel: string };
}

export interface UpdateOptimizationSettingsMessage {
	type: "updateOptimizationSettings";
	value: any;
}

export interface CodeFileStreamStartMessage {
	type: "codeFileStreamStart";
	value: { streamId: string; filePath: string; languageId: string };
}

export interface CodeFileStreamChunkMessage {
	type: "codeFileStreamChunk";
	value: { streamId: string; filePath: string; chunk: string };
}

export interface CodeFileStreamEndMessage {
	type: "codeFileStreamEnd";
	value: {
		streamId: string;
		filePath: string;
		success: boolean;
		error?: string;
	};
}

export interface AppendRealtimeModelMessage {
	type: "appendRealtimeModelMessage";
	value: { text: string; isError?: boolean };
	diffContent?: string;
	relevantFiles?: string[];
	isPlanStepUpdate?: boolean;
	subPlanId?: string;
}

export interface RestorePendingPlanConfirmationMessage {
	type: "restorePendingPlanConfirmation";
	value: PersistedPlanData;
}

export interface StructuredPlanParseFailedMessage {
	type: "structuredPlanParseFailed";
	value: { error: string; failedJson: string };
}

export interface PlanExecutionStartedMessage {
	type: "planExecutionStarted";
}

export interface PlanExecutionEndedMessage {
	type: "planExecutionEnded";
}

export interface PlanExecutionFinishedMessage {
	type: "planExecutionFinished";
	hasRevertibleChanges: boolean;
}

export interface RevertCompletedMessage {
	type: "revertCompleted";
}

export interface FormattedTokenStatistics {
	totalInput: string;
	totalOutput: string;
	total: string;
	requestCount: string;
	averageInput: string;
	averageOutput: string;
	modelUsagePercentages: Array<[string, number]>;
}

export interface UpdateTokenStatisticsMessage {
	type: "updateTokenStatistics";
	value: FormattedTokenStatistics;
}

export interface UpdateStreamingRelevantFilesMessage {
	type: "updateStreamingRelevantFiles";
	value: string[]; // Array of relative file paths (e.g., "src/foo/bar.ts")
}

export interface RestoreStreamingProgressMessage {
	type: "restoreStreamingProgress";
	value: AiStreamingState | null;
}

export interface RestorePendingCommitReviewMessage {
	type: "restorePendingCommitReview";
	value: { commitMessage: string; stagedFiles: string[] } | null;
}

export interface GitProcessUpdateMessage {
	type: "gitProcessUpdate";
	value: {
		type: "stdout" | "stderr" | "status";
		data: string;
		isError?: boolean;
	};
}

export interface UpdateCurrentTokenEstimatesMessage {
	type: "updateCurrentTokenEstimates";
	value: {
		inputTokens: string;
		outputTokens: string;
		totalTokens: string;
	};
}

export interface RequestClearChatConfirmationMessage {
	type: "requestClearChatConfirmation";
}

export interface ChatClearedMessage {
	type: "chatCleared";
}

export interface ResetCodeStreamingAreaMessage {
	type: "resetCodeStreamingArea";
}

export interface ReceiveWorkspaceFilesMessage {
	type: "receiveWorkspaceFiles";
	value: string[]; // Array of relative file paths
}

/**
 * Message sent from the extension to the webview to indicate the webview is ready
 * and can now receive state updates or initial data.
 */
export interface WebviewReadyMessage {
	type: "webviewReady";
}

/**
 * Message sent from the extension to the webview to update the list of API keys.
 */
export interface UpdateKeyListMessage {
	type: "updateKeyList";
	value: ApiKeyInfo[]; // Expected payload structure
}

/**
 * Message sent from the extension to the webview to restore the chat history.
 */
export interface RestoreHistoryMessage {
	type: "restoreHistory";
	value: HistoryEntry[]; // Expected payload structure
}

/**
 * Message sent from the extension to the webview to confirm a commit operation.
 */
export interface ConfirmCommitMessage {
	type: "confirmCommit";
}

/**
 * Message sent from the extension to the webview to cancel a commit operation.
 */
export interface CancelCommitMessage {
	type: "cancelCommit";
}

/**
 * Message sent from the extension to the webview to update the display of relevant files.
 * (Ensure the properties match the actual data being sent).
 */
export interface UpdateRelevantFilesDisplayMessage {
	type: "updateRelevantFilesDisplay";
	messageIndex: number; // Example property, adjust as needed based on actual usage
	isExpanded: boolean; // Example property, adjust as needed
}

export type ExtensionToWebviewMessages =
	| StatusUpdateMessage
	| AiResponseStartMessage
	| AiResponseChunkMessage
	| AiResponseEndMessage
	| ChatClearedMessage
	| GitProcessUpdateMessage
	| RequestClearChatConfirmationMessage
	| {
			type: "operationCancelledConfirmation";
	  }
	| UpdateLoadingStateMessage
	| ReenableInputMessage
	| UpdateCancellationStateMessage
	| ApiKeyStatusMessage
	| UpdateModelListMessage
	| UpdateOptimizationSettingsMessage
	| RestorePendingPlanConfirmationMessage
	| StructuredPlanParseFailedMessage
	| PlanExecutionStartedMessage
	| PlanExecutionEndedMessage
	| PrefillChatInput
	| UpdateStreamingRelevantFilesMessage
	| PlanExecutionFinishedMessage
	| RevertCompletedMessage
	| AppendRealtimeModelMessage
	| UpdateTokenStatisticsMessage
	| UpdateCurrentTokenEstimatesMessage
	| RestoreStreamingProgressMessage
	| RestorePendingCommitReviewMessage
	| CodeFileStreamStartMessage
	| CodeFileStreamChunkMessage
	| CodeFileStreamEndMessage
	| ResetCodeStreamingAreaMessage
	| ReceiveWorkspaceFilesMessage
	| FileUriLoadedMessage
	| WebviewReadyMessage
	| UpdateKeyListMessage
	| RestoreHistoryMessage
	| ConfirmCommitMessage
	| CancelCommitMessage
	| UpdateRelevantFilesDisplayMessage
	| PlanTimelineInitializeMessage // Added new interface
	| PlanTimelineProgressMessage; // Added new interface

export interface PlanGenerationContext {
	type: "chat" | "editor";
	originalUserRequest?: string;
	editorContext?: EditorContext; // Changed to use the exported EditorContext interface
	projectContext: string;
	diagnosticsString?: string;
	initialApiKey: string;
	modelName: string;
	chatHistory?: HistoryEntry[];
	textualPlanExplanation: string;
	workspaceRootUri: vscode.Uri;
	relevantFiles?: string[];
	isMergeOperation?: boolean;
	activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo;
}

export interface PlanGenerationResult {
	success: boolean;
	textualPlanExplanation?: string;
	context?: PlanGenerationContext;
	error?: string;
}

export interface PersistedPlanData {
	type: "chat" | "editor"; // Indicates if the plan originated from chat or editor context
	originalUserRequest?: string; // Original request for chat-based plans
	originalInstruction?: string; // Original instruction for editor-based plans
	relevantFiles?: string[]; // Files relevant to the plan
	textualPlanExplanation: string; // The full text of the generated plan (crucial for re-display)
}

export type ExecutionOutcome = "success" | "cancelled" | "failed";

export interface EditorContext {
	instruction: string;
	selectedText: string;
	fullText: string;
	languageId: string;
	filePath: string;
	documentUri: import("vscode").Uri;
	selection: import("vscode").Range;
	diagnosticsString?: string;
}

export interface AiStreamingState {
	content: string;
	relevantFiles?: string[];
	isComplete: boolean;
	isError: boolean;
	operationId: string;
}
