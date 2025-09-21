import * as vscode from "vscode";
import * as sidebarConstants from "./common/sidebarConstants";
import * as sidebarTypes from "./common/sidebarTypes";

import { ChildProcess } from "child_process";
import { ApiKeyManager } from "./managers/apiKeyManager";
import { SettingsManager } from "./managers/settingsManager";
import { ChatHistoryManager } from "./managers/chatHistoryManager";
import { ProjectChangeLogger } from "../workflow/ProjectChangeLogger";
import { RevertService } from "../services/RevertService";
import { RevertibleChangeSet } from "../types/workflow";
import { getHtmlForWebview } from "./ui/webviewHelper";
import { AIRequestService } from "../services/aiRequestService";
import { ContextService } from "../services/contextService";
import { handleWebviewMessage } from "../services/webviewMessageHandler";
import { PlanService } from "../services/planService";
import { ChatService } from "../services/chatService";
import { CommitService } from "../services/commitService";
import { TokenTrackingService } from "../services/tokenTrackingService";
import {
	showInfoNotification,
	showWarningNotification,
	showErrorNotification,
} from "../utils/notificationUtils";
import { GitConflictResolutionService } from "../services/gitConflictResolutionService";

import { CodeValidationService } from "../services/codeValidationService";
import { DiagnosticService } from "../utils/diagnosticUtils";
import { ContextRefresherService } from "../services/contextRefresherService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import * as crypto from "crypto"; // Import crypto for UUID generation
import { z } from "zod";
import { commitReviewSchema } from "../services/messageSchemas";

type PendingCommitReviewDataType = z.infer<typeof commitReviewSchema>["value"];

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "minovativeMindSidebarView";

	// --- PUBLIC STATE (for services to access) ---
	public _view?: vscode.WebviewView;
	public readonly extensionUri: vscode.Uri;
	public readonly secretStorage: vscode.SecretStorage;
	public readonly workspaceState: vscode.Memento;
	public readonly workspaceRootUri: vscode.Uri | undefined;

	public get isSidebarVisible(): boolean {
		return !!this._view && this._view.visible;
	}

	public activeOperationCancellationTokenSource:
		| vscode.CancellationTokenSource
		| undefined;
	public activeChildProcesses: ChildProcess[] = [];
	public pendingPlanGenerationContext: sidebarTypes.PlanGenerationContext | null =
		null;
	public lastPlanGenerationContext: sidebarTypes.PlanGenerationContext | null =
		null;
	public currentExecutionOutcome: sidebarTypes.ExecutionOutcome | undefined;
	public currentAiStreamingState: sidebarTypes.AiStreamingState | null = null;
	public pendingCommitReviewData: PendingCommitReviewDataType | null = null;
	public isGeneratingUserRequest: boolean = false;
	public isCancellingOperation: boolean = false;
	public isEditingMessageActive: boolean = false;
	private _persistedPendingPlanData: sidebarTypes.PersistedPlanData | null =
		null;
	public completedPlanChangeSets: RevertibleChangeSet[] = [];
	public isPlanExecutionActive: boolean = false;
	public currentActiveChatOperationId: string | null = null; // New property added

	// --- MANAGERS & SERVICES ---
	public apiKeyManager: ApiKeyManager;
	public settingsManager: SettingsManager;
	public chatHistoryManager: ChatHistoryManager;
	public changeLogger: ProjectChangeLogger;

	// Services
	public aiRequestService: AIRequestService;
	public contextService: ContextService;
	public planService: PlanService;
	public chatService: ChatService;
	public commitService: CommitService;
	public gitConflictResolutionService: GitConflictResolutionService;
	public tokenTrackingService: TokenTrackingService;
	public revertService!: RevertService; // Added as per instructions
	private enhancedCodeGenerator: EnhancedCodeGenerator;
	private codeValidationService: CodeValidationService;
	private contextRefresherService: ContextRefresherService;

	// --- State for Throttling Messages ---
	private _postMessageThrottledQueue: {
		message: sidebarTypes.ExtensionToWebviewMessages;
	}[] = [];
	private _isThrottledQueueProcessing: boolean = false;
	private _lastThrottledMessageTime: number = 0;
	private readonly THROTTLE_INTERVAL_MS = 50; // Default throttle interval for frequent updates

	// A flag to indicate if the webview is fully loaded and ready to receive messages.
	private _isWebviewReadyForMessages: boolean = false;

	private _windowStateChangeListener: vscode.Disposable | undefined;

	constructor(
		extensionUri: vscode.Uri,
		context: vscode.ExtensionContext,
		workspaceRootUri: vscode.Uri | undefined
	) {
		this.extensionUri = extensionUri;
		this.secretStorage = context.secrets;
		this.workspaceState = context.workspaceState;
		this.workspaceRootUri = workspaceRootUri;

		this._persistedPendingPlanData =
			context.workspaceState.get<sidebarTypes.PersistedPlanData | null>(
				"minovativeMind.persistedPendingPlanData",
				null
			);

		this.completedPlanChangeSets = context.workspaceState.get<
			RevertibleChangeSet[]
		>("minovativeMind.completedPlanChangeSets", []);

		this.isPlanExecutionActive = context.workspaceState.get<boolean>(
			"minovativeMind.isPlanExecutionActive",
			false
		);
		console.log(
			`[SidebarProvider] isPlanExecutionActive initialized to: ${this.isPlanExecutionActive}`
		);

		// Instantiate managers
		this.apiKeyManager = new ApiKeyManager(
			this.secretStorage,
			this.postMessageToWebview.bind(this)
		);
		this.settingsManager = new SettingsManager(
			this.workspaceState,
			this.postMessageToWebview.bind(this)
		);
		this.chatHistoryManager = new ChatHistoryManager(
			this.workspaceState,
			this.postMessageToWebview.bind(this)
		);
		this.changeLogger = new ProjectChangeLogger();

		// Initialize token tracking service
		this.tokenTrackingService = new TokenTrackingService();

		// Register for real-time token updates
		this.tokenTrackingService.onTokenUpdate((stats) => {
			this.postMessageToWebview({
				type: "updateTokenStatistics",
				value: this.tokenTrackingService.getFormattedStatistics(),
			});
		});

		// Load persistent state for isGeneratingUserRequest
		this.isGeneratingUserRequest = context.workspaceState.get<boolean>(
			"minovativeMind.isGeneratingUserRequest",
			false
		);

		// Instantiate services, passing dependencies
		this.aiRequestService = new AIRequestService(
			this.apiKeyManager,
			this.postMessageToWebview.bind(this),
			this.tokenTrackingService
		);

		this.gitConflictResolutionService = new GitConflictResolutionService(
			context
		);

		this.contextService = new ContextService(
			this.settingsManager,
			this.chatHistoryManager,
			this.changeLogger,
			this.aiRequestService,
			this.postMessageToWebview.bind(this)
		);

		this.codeValidationService = new CodeValidationService(
			new DiagnosticService()
		);
		this.contextRefresherService = new ContextRefresherService(
			this.contextService,
			this.changeLogger,
			this.workspaceRootUri || vscode.Uri.file("/")
		);

		this.enhancedCodeGenerator = new EnhancedCodeGenerator(
			this.aiRequestService,
			this.postMessageToWebview.bind(this),
			this.changeLogger,
			this.codeValidationService,
			this.contextRefresherService
		);

		this.revertService = new RevertService(
			this.workspaceRootUri || vscode.Uri.file("/"),
			this.changeLogger
		);

		this.planService = new PlanService(
			this,
			this.workspaceRootUri,
			this.gitConflictResolutionService,
			this.enhancedCodeGenerator,
			this.postMessageToWebview.bind(this)
		);
		this.chatService = new ChatService(this);
		this.commitService = new CommitService(this);

		// Listen for secret changes to reload API keys
		context.secrets.onDidChange((e) => {
			if (e.key === sidebarConstants.GEMINI_API_KEY_SECRET_KEY) {
				this.apiKeyManager.loadKeysFromStorage();
			}
		});

		// Register a listener for VS Code window state changes
		this._windowStateChangeListener = vscode.window.onDidChangeWindowState(
			(event) => {
				if (event.focused === false) {
					// VS Code window lost focus
					if (
						this.pendingPlanGenerationContext !== null ||
						this.pendingCommitReviewData !== null
					) {
						console.log(
							"[SidebarProvider] VS Code window lost focus, but user review (plan/commit) is pending. " +
								"Not resetting UI to avoid premature input re-enabling."
						);
						// DO NOT send updateLoadingState({ value: false }) or reenableInput()
						// in this specific scenario as per instructions.
					} else {
						// No user review is pending.
						// The instruction is to *not* send specific messages *if* a review is pending.
						// It does not instruct to send them if no review is pending.
						// The current application logic should handle UI resets when operations genuinely complete.
						console.log(
							"[SidebarProvider] VS Code window lost focus, no user review pending. UI state remains as is."
						);
					}
				}
			},
			this,
			context.subscriptions
		); // `this` ensures correct context for callback, `context.subscriptions` manages cleanup
	}

	/**
	 * Initializes essential services like API key manager and settings manager.
	 * This method is called early in the extension's lifecycle to ensure critical dependencies are loaded.
	 * @returns A Promise that resolves when initialization is complete.
	 */
	public async initialize(): Promise<void> {
		// Load API keys and settings from storage. These are crucial for any AI operations.
		await this.apiKeyManager.initialize();
		this.settingsManager.initialize();
		// Any other non-UI-blocking, critical initializations can go here.
	}

	/**
	 * Resolves the webview view, setting up its HTML, options, and message listeners.
	 * This method is called by VS Code when the sidebar becomes visible.
	 * @param webviewView The WebviewView instance provided by VS Code.
	 * @returns A Promise that resolves when the webview is set up.
	 */
	public async resolveWebviewView(
		webviewView: vscode.WebviewView
	): Promise<void> {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "dist"),
				vscode.Uri.joinPath(this.extensionUri, "media"),
				vscode.Uri.joinPath(this.extensionUri, "src", "sidebar", "webview"),
			],
		};

		const logoUri = webviewView.webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.extensionUri,
				"media",
				"minovative-logo-192x192.png"
			)
		);
		webviewView.webview.html = await getHtmlForWebview(
			webviewView.webview,
			this.extensionUri,
			sidebarConstants.MODEL_DETAILS, // Changed from AVAILABLE_GEMINI_MODELS to MODEL_DETAILS
			this.settingsManager.getSelectedModelName(),
			logoUri
		);

		const fileUri = vscode.Uri.parse("file://"); // This seems like a placeholder URI for the webview's internal loading
		this.postMessageToWebview({
			type: "fileUriLoaded",
			uri: fileUri.toString(),
		}); // Signal to webview that initial files are loaded

		webviewView.webview.onDidReceiveMessage(async (data) => {
			// Delegating to external message handler for separation of concerns
			await handleWebviewMessage(data, this);
		});

		// The webview will send a "webviewReady" message after it's fully initialized and rendered.
		// We handle actual UI state restoration in response to that message to ensure webview is ready.
		this._isWebviewReadyForMessages = true; // Mark as ready after basic setup
	}

	/**
	 * Sends a message to the webview, applying throttling for high-frequency updates.
	 * @param message The message to send.
	 * @remarks Messages are categorized into immediate (critical) and throttled (frequent UI updates) for performance.
	 */
	public postMessageToWebview(
		message: sidebarTypes.ExtensionToWebviewMessages
	): void {
		// Messages that should bypass throttling (immediate delivery)
		const immediateTypes = new Set<
			sidebarTypes.ExtensionToWebviewMessages["type"]
		>([
			"webviewReady", // Crucial for initial handshake
			"updateKeyList", // API key updates (infrequent)
			"restoreHistory", // Full chat history restoration (infrequent after initial load)
			"confirmCommit", // Part of commit review flow
			"cancelCommit", // Part of commit review flow
			"fileUriLoaded", // Internal signal for webview readiness
			"aiResponseStart", // Marks the beginning of an AI streaming response
			"aiResponseChunk", // <<< Add this line
			"reenableInput", // Critical for restoring user interaction
			"aiResponseEnd", // Marks the end of an AI streaming response or operation result
			"PrefillChatInput", // Prefilling chat input (critical for user workflow)
			"operationCancelledConfirmation", // Confirmation of cancellation (critical)
			"chatCleared", // Confirmation of chat clearing
			"planExecutionStarted", // Marks the start of a plan execution
			"planExecutionEnded", // Marks the end of a plan execution
			"requestClearChatConfirmation", // Initiates user confirmation flow for chat clearing
			"receiveWorkspaceFiles", // Result of a file scan request
			"restorePendingPlanConfirmation", // Restores UI for pending plan review
			"updateModelList", // Model selection changes (infrequent)
			"updateLoadingState",
			"apiKeyStatus",
			"updateOptimizationSettings",
			"structuredPlanParseFailed",
			"planExecutionFinished",
			"revertCompleted",
			"restoreStreamingProgress",
			"restorePendingCommitReview",
			"resetCodeStreamingArea",
			"updateCancellationState", // Add this line
		]);

		// Messages that are typically frequent and should be throttled to prevent UI overwhelming
		const throttledTypes = new Set<
			sidebarTypes.ExtensionToWebviewMessages["type"]
		>([
			"updateRelevantFilesDisplay", // Toggling relevant files display
			"appendRealtimeModelMessage", // Used for plan step updates/logs and other non-AI-streaming status messages
			"statusUpdate", // General progress updates (can be frequent)
			"updateTokenStatistics", // Real-time token statistics updates
			"updateCurrentTokenEstimates", // Real-time token estimates during streaming
			"codeFileStreamStart", // Signals the start of code file streaming
			"codeFileStreamChunk", // Individual chunks of streamed code content (very frequent)
			"codeFileStreamEnd", // Signals the end of code file streaming
			"gitProcessUpdate", // Updates from git command execution
			"updateStreamingRelevantFiles",
		]);

		if (immediateTypes.has(message.type)) {
			this._postMessageImmediateInternal(message);
		} else if (throttledTypes.has(message.type)) {
			// Special handling for statusUpdate: if it explicitly indicates an error, send it immediately.
			if (message.type === "statusUpdate" && message.isError) {
				this._postMessageImmediateInternal(message);
			} else {
				this._queueThrottledMessage(message);
			}
		} else {
			// For any other message type not explicitly categorized, default to immediate sending
			console.warn(
				`[SidebarProvider] Message type '${message.type}' not categorized for throttling; sending immediately.`
			);
			this._postMessageImmediateInternal(message);
		}
	}

	/**
	 * Internal method to send messages to the webview immediately without throttling.
	 * It handles the actual `webview.postMessage` call and basic error logging.
	 * @param message The message to send.
	 */
	private async _postMessageImmediateInternal(
		message: sidebarTypes.ExtensionToWebviewMessages
	): Promise<void> {
		if (this._view && this._view.visible) {
			try {
				await this._view.webview.postMessage(message);
			} catch (err) {
				console.warn(
					`[SidebarProvider] Failed to post message to webview: ${message.type}`,
					err
				);
			}
		} else {
			console.log(
				`[SidebarProvider] Webview not visible or not ready, skipping message: ${message.type}`
			);
		}
	}

	/**
	 * Queues a message for throttled sending to the webview.
	 * Messages in this queue are processed at a controlled rate to prevent UI overload.
	 * @param message The message to queue.
	 */
	private _queueThrottledMessage(
		message: sidebarTypes.ExtensionToWebviewMessages
	): void {
		this._postMessageThrottledQueue.push({ message });
		this._processThrottledQueue(); // Attempt to process the queue
	}

	/**
	 * Processes the throttled message queue, ensuring messages are sent at a controlled rate.
	 * Only one queue processing loop runs at a time.
	 */
	private async _processThrottledQueue(): Promise<void> {
		if (this._isThrottledQueueProcessing) {
			return; // A loop is already running
		}

		this._isThrottledQueueProcessing = true;
		while (this._postMessageThrottledQueue.length > 0) {
			const now = Date.now();
			const timeSinceLastMessage = now - this._lastThrottledMessageTime;

			if (timeSinceLastMessage < this.THROTTLE_INTERVAL_MS) {
				// Wait for the remaining throttle time before sending the next message
				await new Promise((r) =>
					setTimeout(r, this.THROTTLE_INTERVAL_MS - timeSinceLastMessage)
				);
			}

			const { message } = this._postMessageThrottledQueue.shift()!;
			try {
				// Send the message using the immediate sender
				await this._postMessageImmediateInternal(message);
			} catch (err) {
				// Error already logged by _postMessageImmediateInternal
			}
			this._lastThrottledMessageTime = Date.now();
		}
		this._isThrottledQueueProcessing = false;
	}

	/**
	 * Updates the persisted pending plan data in workspace state.
	 * @param data The plan data to persist, or `null` to clear.
	 */
	public async updatePersistedPendingPlanData(
		data: sidebarTypes.PersistedPlanData | null
	): Promise<void> {
		this._persistedPendingPlanData = data;
		await this.workspaceState.update(
			"minovativeMind.persistedPendingPlanData",
			data
		);
		console.log(
			`[SidebarProvider] Persisted pending plan data updated to: ${
				data ? "present" : "null"
			}`
		);
	}

	/**
	 * Updates the persisted completed plan change sets in workspace state.
	 * @param data An array of `RevertibleChangeSet` or `null` to clear.
	 */
	public async updatePersistedCompletedPlanChangeSets(
		data: RevertibleChangeSet[] | null
	): Promise<void> {
		this.completedPlanChangeSets = data || [];
		await this.workspaceState.update(
			"minovativeMind.completedPlanChangeSets",
			this.completedPlanChangeSets
		);
		console.log(
			`[SidebarProvider] Persisted completed plan change sets updated to: ${
				this.completedPlanChangeSets.length > 0 ? "present" : "null"
			}`
		);
	}

	/**
	 * Sets the `isPlanExecutionActive` flag and persists its state.
	 * @param isActive `true` if a plan execution is active, `false` otherwise.
	 */
	public async setPlanExecutionActive(isActive: boolean): Promise<void> {
		this.isPlanExecutionActive = isActive;
		await this.workspaceState.update(
			"minovativeMind.isPlanExecutionActive",
			isActive
		);
		console.log(`[SidebarProvider] isPlanExecutionActive set to: ${isActive}`);
	}

	/**
	 * Handles the `webviewReady` message, restoring the UI state based on active/pending operations.
	 * This method is decomposed into smaller helpers for clarity.
	 */
	public async handleWebviewReady(): Promise<void> {
		// Always load essential data first, regardless of active operations
		this.apiKeyManager.loadKeysFromStorage();
		this.settingsManager.updateWebviewModelList();
		this.chatHistoryManager.restoreChatHistoryToWebview();

		// Restore UI state based on potential ongoing operations
		if (this.isPlanExecutionActive) {
			await this._restorePlanExecutionState();
		} else if (this._persistedPendingPlanData) {
			await this._restorePendingPlanConfirmationState(
				this._persistedPendingPlanData
			);
		} else if (
			this.currentAiStreamingState &&
			!this.currentAiStreamingState.isComplete
		) {
			// Check for active token source when restoring streaming state
			if (this.activeOperationCancellationTokenSource) {
				await this._restoreAiStreamingState(this.currentAiStreamingState);
			} else {
				// Stale streaming state: streaming state is active but no cancellation token source
				console.warn(
					"[SidebarProvider] Detected stale AI streaming state: currentAiStreamingState is active but activeOperationCancellationTokenSource is undefined. Resetting."
				);
				await this._resetStaleLoadingState();
			}
		} else if (this.pendingCommitReviewData) {
			await this._restorePendingCommitReviewState(this.pendingCommitReviewData);
		} else if (
			this.isGeneratingUserRequest &&
			!this.activeOperationCancellationTokenSource
		) {
			// Explicitly handle the case where isGeneratingUserRequest is true but token source is undefined.
			console.warn(
				"[SidebarProvider] Detected stale generic loading state: isGeneratingUserRequest is true but activeOperationCancellationTokenSource is undefined. Resetting."
			);
			await this._resetStaleLoadingState();
		} else if (this.isGeneratingUserRequest) {
			// isGeneratingUserRequest is true AND activeOperationCancellationTokenSource IS defined,
			// but it wasn't caught by planExecutionActive, persistedPlanData, currentAiStreamingState, or pendingCommitReviewData.
			// This means there's an active, but unidentified or generic operation.
			// For robustness, we should also treat this as stale or at least re-enable inputs.
			// `_resetStaleLoadingState` calls `endUserOperation` which will clear active state and re-enable inputs.
			console.warn(
				"[SidebarProvider] Detected generic active operation (isGeneratingUserRequest true, token source defined) without specific context. Assuming stale and resetting."
			);
			await this._resetStaleLoadingState();
		} else {
			// No active or pending operations detected. Ensure UI is fully re-enabled.
			await this._resetQuiescentUIState();
		}

		// Send final message about revertible changes
		const hasRevertibleChanges = this.completedPlanChangeSets.length > 0;
		this.postMessageToWebview({
			type: "planExecutionFinished",
			hasRevertibleChanges: hasRevertibleChanges,
		});
	}

	/**
	 * Restores UI state for an actively running plan execution.
	 */
	private async _restorePlanExecutionState(): Promise<void> {
		console.log(
			"[SidebarProvider] Detected active plan execution. Restoring UI state."
		);
		this.postMessageToWebview({ type: "updateLoadingState", value: true });
		this.postMessageToWebview({ type: "planExecutionStarted" });
		this.postMessageToWebview({
			type: "statusUpdate",
			value: "A plan execution is currently in progress. Please wait.",
		});
	}

	/**
	 * Restores UI state for a pending plan confirmation.
	 * @param persistedData The persisted plan data.
	 */
	private async _restorePendingPlanConfirmationState(
		persistedData: sidebarTypes.PersistedPlanData
	): Promise<void> {
		console.log(
			"[SidebarProvider] Restoring pending plan confirmation to webview from persisted data."
		);
		const planCtx = persistedData;
		const planDataForRestore = {
			originalRequest: planCtx.originalUserRequest,
			originalInstruction: planCtx.originalInstruction,
			type: planCtx.type,
			relevantFiles: planCtx.relevantFiles,
			textualPlanExplanation: planCtx.textualPlanExplanation,
		};

		this.postMessageToWebview({
			type: "restorePendingPlanConfirmation",
			value: planDataForRestore,
		});
		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.isGeneratingUserRequest = false;
		await this.workspaceState.update(
			"minovativeMind.isGeneratingUserRequest",
			false
		);
	}

	/**
	 * Restores UI state for an active AI streaming operation.
	 * @param streamingState The current AI streaming state.
	 */
	private async _restoreAiStreamingState(
		streamingState: sidebarTypes.AiStreamingState
	): Promise<void> {
		console.log(
			"[SidebarProvider] Restoring active AI streaming progress to webview."
		);
		// The operationId will be passed within streamingState once AiStreamingState is updated.
		this.postMessageToWebview({
			type: "restoreStreamingProgress",
			value: streamingState,
		});
		this.postMessageToWebview({ type: "updateLoadingState", value: true });
	}

	/**
	 * Restores UI state for a pending commit review.
	 * @param commitReviewData The pending commit review data.
	 */
	private async _restorePendingCommitReviewState(
		commitReviewData: PendingCommitReviewDataType
	): Promise<void> {
		console.log(
			"[SidebarProvider] Restoring pending commit review to webview."
		);
		this.postMessageToWebview({
			type: "restorePendingCommitReview",
			value: commitReviewData,
		});
		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.isGeneratingUserRequest = false;
		await this.workspaceState.update(
			"minovativeMind.isGeneratingUserRequest",
			false
		);
	}

	/**
	 * Resets stale loading state indicators if no specific active operation is found.
	 */
	private async _resetStaleLoadingState(): Promise<void> {
		console.log(
			"[SidebarProvider] Detected stale generic loading state. Resetting."
		);
		await this.endUserOperation("success", "Inputs re-enabled.");
	}

	/**
	 * Resets the UI to a quiescent state when no operations are active or pending.
	 */
	private async _resetQuiescentUIState(): Promise<void> {
		console.log("[SidebarProvider] No active operations, re-enabling inputs.");
		this.postMessageToWebview({ type: "reenableInput" });
		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.postMessageToWebview({ type: "statusUpdate", value: "" }); // Clear any stale status message
		this.clearActiveOperationState(); // Ensure cancellation token and streaming state are null
	}

	// --- OPERATION & STATE HELPERS ---

	public async startUserOperation(operationType: string): Promise<void> {
		// Generate a new unique operationId at the very beginning
		const newOperationId = crypto.randomUUID();

		// Stale state check: If `isGeneratingUserRequest` is true but `currentActiveChatOperationId` is null,
		// it indicates a previous operation might have crashed or not cleaned up properly.
		// In this case, we reset the state and allow the new operation to proceed.
		if (
			this.isGeneratingUserRequest &&
			this.currentActiveChatOperationId === null
		) {
			console.warn(
				`[SidebarProvider] Detected stale 'isGeneratingUserRequest' state (true) with no active operation ID. ` +
					`Resetting state for new operation '${operationType}' (ID: ${newOperationId}).`
			);
			this.clearActiveOperationState(); // Clears token source and operation ID
			this.isGeneratingUserRequest = false; // Explicitly set to false
			await this.workspaceState.update(
				"minovativeMind.isGeneratingUserRequest",
				false
			);
			// After resetting, the method will continue to the normal concurrency check
			// and then start the new operation.
		}

		// Immediate concurrency check: If an operation is truly in progress (i.e., isGeneratingUserRequest is true
		// AND currentActiveChatOperationId is NOT null, or the stale state check above wasn't triggered and
		// isGeneratingUserRequest is still true from a legitimately ongoing operation), warn and exit.
		if (this.isGeneratingUserRequest) {
			console.warn(
				`[SidebarProvider] Attempted to start operation '${operationType}' (new ID: ${newOperationId}) while an operation ` +
					`(current ID: ${this.currentActiveChatOperationId}) is already in progress. Ignoring duplicate request.`
			);
			return;
		}

		console.log(
			`[SidebarProvider] Starting user operation of type '${operationType}' with ID: ${newOperationId}`
		);

		// Post an initial loading state message early
		this.postMessageToWebview({ type: "updateLoadingState", value: true });

		// Dispose of any existing activeOperationCancellationTokenSource unconditionally.
		// This is important even if currentActiveChatOperationId was null (stale state)
		// but the cancellation token source somehow remained.
		if (this.activeOperationCancellationTokenSource) {
			console.log(
				"[SidebarProvider] Disposing existing activeOperationCancellationTokenSource."
			);
			this.activeOperationCancellationTokenSource.cancel(); // Cancel any lingering tasks associated with the old token
			this.activeOperationCancellationTokenSource.dispose();
			this.activeOperationCancellationTokenSource = undefined;
		}

		// Create a new vscode.CancellationTokenSource instance
		this.activeOperationCancellationTokenSource =
			new vscode.CancellationTokenSource();

		// Assign the new operation ID
		this.currentActiveChatOperationId = newOperationId;

		// Set isGeneratingUserRequest and persist it.
		this.isGeneratingUserRequest = true;
		await this.workspaceState.update(
			"minovativeMind.isGeneratingUserRequest",
			true
		);

		console.log(
			"[SidebarProvider] Created new CancellationTokenSource and updated generation state for the operation."
		);
	}

	public isOperationInProgress(): boolean {
		return (
			!!this.activeOperationCancellationTokenSource ||
			this.activeChildProcesses.length > 0
		);
	}

	public clearActiveOperationState(): void {
		if (this.activeOperationCancellationTokenSource) {
			console.log(
				"[SidebarProvider] Disposing activeOperationCancellationTokenSource."
			);
			this.activeOperationCancellationTokenSource.dispose();
			this.activeOperationCancellationTokenSource = undefined;
		}
		this.currentAiStreamingState = null;
		this.currentActiveChatOperationId = null; // Clear the operation ID
	}

	public async endCancellationOperation(): Promise<void> {
		this.isCancellingOperation = false;
		this.postMessageToWebview({
			type: "updateCancellationState",
			value: false,
		});
		this.clearActiveOperationState();
	}

	public async endUserOperation(
		outcome: sidebarTypes.ExecutionOutcome | "review",
		customStatusMessage?: string,
		shouldReenableInputs: boolean = true
	): Promise<void> {
		console.log(
			`[SidebarProvider] Ending user operation with outcome: ${outcome}`
		);

		this.isGeneratingUserRequest = false;
		await this.workspaceState.update(
			"minovativeMind.isGeneratingUserRequest",
			false
		);

		if (outcome === "cancelled") {
			this.endCancellationOperation();
		} else {
			this.clearActiveOperationState();
		}

		this.pendingPlanGenerationContext = null;
		this.lastPlanGenerationContext = null;
		if (outcome !== "review") {
			this.pendingCommitReviewData = null;
		}

		if (!this.isEditingMessageActive) {
			this.chatHistoryManager.restoreChatHistoryToWebview();
		} else {
			console.log(
				"[SidebarProvider] Skipping restoreChatHistoryToWebview during active message edit."
			);
		}

		if (shouldReenableInputs) {
			this.postMessageToWebview({ type: "reenableInput" });
		}
		if (outcome !== "review") {
			this.postMessageToWebview({ type: "updateLoadingState", value: false });
		}

		let statusMessage = "";
		let isError = false;

		if (customStatusMessage) {
			statusMessage = customStatusMessage;
			isError = outcome === "cancelled" || outcome === "failed";
		} else {
			switch (outcome) {
				case "success":
					statusMessage = "Operation completed successfully.";
					break;
				case "cancelled":
					statusMessage = "Operation cancelled."; // More explicit message
					isError = true;
					break;
				case "failed":
					statusMessage = "Operation failed. Check sidebar for details.";
					isError = true;
					break;
				case "review":
					statusMessage =
						"Operation paused for user review. Please review the proposed changes.";
					break;
				default:
					statusMessage = `Operation ended with unknown outcome: ${outcome}.`;
					isError = true;
					break;
			}
		}

		if (statusMessage) {
			if (
				outcome !== "cancelled" &&
				statusMessage !== "Operation completed successfully."
			) {
				this.chatHistoryManager.addHistoryEntry("model", statusMessage);
			}
			this.postMessageToWebview({
				type: "statusUpdate",
				value: statusMessage,
				isError: isError,
			});
		}
	}

	public async triggerUniversalCancellation(): Promise<void> {
		console.log("[SidebarProvider] Triggering universal cancellation...");

		// Set `isGeneratingUserRequest` to false first, and persist it.
		this.isGeneratingUserRequest = false;
		await this.workspaceState.update(
			"minovativeMind.isGeneratingUserRequest",
			false
		);

		this.isCancellingOperation = true;

		// Cancel the active operation token source if it exists.
		if (this.activeOperationCancellationTokenSource) {
			this.activeOperationCancellationTokenSource.cancel();
		}

		// Now, dispose and clear the token source, which is safe to do after `isGeneratingUserRequest` is false.
		// This also ensures `activeOperationCancellationTokenSource` is set to `undefined`.
		this.clearActiveOperationState();

		this.activeChildProcesses.forEach((cp) => {
			console.log(
				`[SidebarProvider] Killing child process with PID: ${cp.pid}`
			);
			cp.kill();
		});
		this.activeChildProcesses = [];

		await this.setPlanExecutionActive(false);

		this.pendingPlanGenerationContext = null;
		await this.updatePersistedPendingPlanData(null);
		this.lastPlanGenerationContext = null;
		this.pendingCommitReviewData = null;
		this.currentActiveChatOperationId = null; // Clear the operation ID on universal cancellation

		// this.isEditingMessageActive = false; // Removed as per instructions

		// Ensure these messages are always sent to re-enable UI regardless of active token source
		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.postMessageToWebview({ type: "reenableInput" });
		this.postMessageToWebview({ type: "updateCancellationState", value: true });
		this.postMessageToWebview({
			type: "operationCancelledConfirmation",
		});
	}

	public async cancelActiveOperation(): Promise<void> {
		await this.triggerUniversalCancellation();
	}

	public async cancelPendingPlan(): Promise<void> {
		await this.triggerUniversalCancellation();
	}

	public async revertLastPlanChanges(): Promise<void> {
		if (this.completedPlanChangeSets.length === 0) {
			vscode.window.showWarningMessage(
				"No completed workflow changes to revert."
			);
			return;
		}

		const mostRecentChangeSet = this.completedPlanChangeSets.pop();
		if (!mostRecentChangeSet) {
			vscode.window.showWarningMessage(
				"No completed workflow changes to revert."
			);
			return;
		}

		let revertSuccessful: boolean = false;
		let revertErrorMessage: string = "";
		let finalStatusMessage: string = "";
		let isErrorStatus: boolean = false;

		const confirmation = await vscode.window.showWarningMessage(
			"Are you sure you want to revert the changes from the most recent workflow?",
			{ modal: true },
			"Yes, Revert Changes",
			"No, Cancel"
		);

		if (confirmation === "Yes, Revert Changes") {
			try {
				this.postMessageToWebview({ type: "updateLoadingState", value: true });
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "Reverting most recent workflow changes...",
				});
				console.log(
					"[SidebarProvider] Starting revert of most recent workflow changes..."
				);

				await this.revertService.revertChanges(mostRecentChangeSet.changes);

				revertSuccessful = true;
				console.log(
					"[SidebarProvider] Most recent workflow changes reverted successfully."
				);
			} catch (error: any) {
				revertSuccessful = false;
				revertErrorMessage = formatUserFacingErrorMessage(
					error,
					"Failed to revert most recent workflow changes.",
					"Revert Error: ",
					this.workspaceRootUri
				);
				finalStatusMessage = revertErrorMessage;
				isErrorStatus = true;
				showErrorNotification(
					error,
					"Failed to revert most recent workflow changes.",
					"Revert Error: ",
					this.workspaceRootUri
				);
				console.error(
					"[SidebarProvider] Error reverting most recent workflow changes:",
					error
				);
				this.completedPlanChangeSets.push(mostRecentChangeSet);
			}
		} else {
			revertSuccessful = false;
			revertErrorMessage = "Revert operation cancelled by user.";
			finalStatusMessage = "Revert operation cancelled.";
			isErrorStatus = false;
			vscode.window.showInformationMessage(finalStatusMessage);
			console.log("[SidebarProvider] Revert operation cancelled by user.");

			this.completedPlanChangeSets.push(mostRecentChangeSet);
		}

		await this.updatePersistedCompletedPlanChangeSets(
			this.completedPlanChangeSets
		);

		const stillHasRevertibleChanges = this.completedPlanChangeSets.length > 0;

		this.postMessageToWebview({
			type: "planExecutionFinished",
			hasRevertibleChanges: stillHasRevertibleChanges,
		});

		this.postMessageToWebview({
			type: "statusUpdate",
			value: finalStatusMessage,
			isError: isErrorStatus,
		});

		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.postMessageToWebview({ type: "reenableInput" });
	}

	public async showPlanCompletionNotification(
		description: string,
		outcome: sidebarTypes.ExecutionOutcome
	): Promise<void> {
		let message: string;
		let isError: boolean;

		switch (outcome) {
			case "success":
				message = `Plan completed successfully!`;
				isError = false;
				break;
			case "cancelled":
				message = `Plan was cancelled.`;
				isError = true;
				break;
			case "failed":
				message = `Plan failed. Check sidebar for details.`;
				isError = true;
				break;
		}

		if (outcome !== "cancelled") {
			this.chatHistoryManager.addHistoryEntry("model", message);
		}
		this.chatHistoryManager.restoreChatHistoryToWebview();

		if (this.isSidebarVisible === true) {
			if (outcome !== "cancelled") {
				this.postMessageToWebview({
					type: "statusUpdate",
					value: message,
					isError: isError,
				});
			}
		} else {
			let notificationFunction: (
				message: string,
				...items: string[]
			) => Thenable<string | undefined>;

			switch (outcome) {
				case "success":
					notificationFunction = showInfoNotification;
					break;
				case "cancelled":
					notificationFunction = showWarningNotification;
					break;
				case "failed":
					this.postMessageToWebview({
						type: "statusUpdate",
						value: message,
						isError: true,
					});
					return;
			}

			const result = await notificationFunction(
				message,
				"Open Sidebar",
				"Cancel Plan"
			);

			if (result === "Open Sidebar") {
				vscode.commands.executeCommand("minovative-mind.activitybar.focus");
			} else if (result === "Cancel Plan") {
				console.log(
					"[SidebarProvider] Native notification 'Cancel Plan' clicked. Triggering universal cancellation."
				);
				await this.triggerUniversalCancellation();
				return;
			}
		}
	}
}
