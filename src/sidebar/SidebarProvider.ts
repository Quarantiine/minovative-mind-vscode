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

import { CodeValidationService } from "../services/codeValidationService";
import { DiagnosticService } from "../utils/diagnosticUtils";
import { ContextRefresherService } from "../services/contextRefresherService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import * as crypto from "crypto"; // Import crypto for UUID generation
import { z } from "zod";
import { commitReviewSchema } from "../services/messageSchemas";

type PendingCommitReviewDataType = z.infer<typeof commitReviewSchema>["value"];

/**
 * Configuration for message throttling between the Extension Host and the Webview.
 * Messages are categorized into IMMEDIATE_TYPES (sent instantly) and THROTTLED_TYPES
 * (queued and sent at a controlled rate to prevent UI overwhelming).
 */
const MESSAGE_THROTTLING_CONFIG = {
	IMMEDIATE_TYPES: [
		"webviewReady", // Crucial for initial handshake
		"updateKeyList", // API key updates (infrequent)
		"restoreHistory", // Full chat history restoration (infrequent after initial load)
		"confirmCommit", // Part of commit review flow
		"cancelCommit", // Part of commit review flow
		"fileUriLoaded",
		"aiResponseStart", // Marks the beginning of an AI streaming response
		"aiResponseChunk",
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
		"updateCancellationState",
	] as const,
	THROTTLED_TYPES: [
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
	] as const,
};

/**
 * Manages the Minovative Mind chat sidebar view in VS Code.
 *
 * This class is responsible for:
 * 1. Providing the HTML content for the webview.
 * 2. Handling all bidirectional communication between the extension host and the webview UI.
 * 3. Managing the persistent state of active, pending, or recently completed operations (e.g., plans, streaming).
 * 4. Serving as the central coordinator (Service Locator/Facade) for all domain managers and services (API keys, history, settings, AI requests).
 * 5. Implementing concurrency control to ensure only one major user operation (chat, plan generation, plan execution, commit) is active at a time.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "minovativeMindSidebarView";

	// --- PUBLIC STATE (for services to access) ---
	/** The WebviewView instance provided by VS Code when the sidebar is opened. */
	public _view?: vscode.WebviewView;
	/** The root URI of the extension installation. */
	public readonly extensionUri: vscode.Uri;
	/** VS Code's SecretStorage used for securely storing API keys. */
	public readonly secretStorage: vscode.SecretStorage;
	/** VS Code's Memento used for persisting non-sensitive, workspace-specific state (e.g., plan data). */
	public readonly workspaceState: vscode.Memento;
	/** The root URI of the current VS Code workspace, if one is open. */
	public readonly workspaceRootUri: vscode.Uri | undefined;

	/** Checks if the sidebar is currently visible to the user. */
	public get isSidebarVisible(): boolean {
		return !!this._view && this._view.visible;
	}

	/** Cancellation token source used to cancel the currently active AI operation (chat, plan generation, execution). */
	public activeOperationCancellationTokenSource:
		| vscode.CancellationTokenSource
		| undefined;
	/** A list of active child processes (e.g., Git commands) that should be killed upon cancellation. */
	public activeChildProcesses: ChildProcess[] = [];
	/** Context data for a plan that is currently being reviewed by the user (pending confirmation or rejection). */
	public pendingPlanGenerationContext: sidebarTypes.PlanGenerationContext | null =
		null;
	/** The context data for the last plan generated, used primarily for plan retry logic. */
	public lastPlanGenerationContext: sidebarTypes.PlanGenerationContext | null =
		null;
	/** The final outcome of the most recent execution attempt (success, failed, cancelled). */
	public currentExecutionOutcome: sidebarTypes.ExecutionOutcome | undefined;
	/** State tracking for an ongoing streamed AI response. */
	public currentAiStreamingState: sidebarTypes.AiStreamingState | null = null;
	/** Data required for displaying and confirming a pending Git commit review. */
	public pendingCommitReviewData: PendingCommitReviewDataType | null = null;
	/** Flag indicating if the user is currently editing a prior chat message, blocking new chat requests. */
	public isEditingMessageActive: boolean = false;
	/** Internal, private copy of the persisted plan data used for restoring state across reloads. */
	private _persistedPendingPlanData: sidebarTypes.PersistedPlanData | null =
		null;
	/** List of completed change sets, allowing users to revert the last workflow execution. */
	public completedPlanChangeSets: RevertibleChangeSet[] = [];
	/** Flag indicating if a multi-step execution plan is currently running (e.g., modifying files, running commands). */
	public isPlanExecutionActive: boolean = false;
	/** Unique ID for the current user operation (chat, plan generation, commit generation). Used for concurrency control and tracking streaming responses. */
	public currentActiveChatOperationId: string | null = null;

	/**
	 * Determines if a user operation is currently active, based on the presence of an operation ID
	 * and an un-canceled cancellation token.
	 */
	private get _isOperationActive(): boolean {
		return (
			!!this.currentActiveChatOperationId &&
			!!this.activeOperationCancellationTokenSource &&
			!this.activeOperationCancellationTokenSource.token.isCancellationRequested
		);
	}

	// --- MANAGERS & SERVICES ---
	/** Manages API keys, including storage, retrieval, and active key selection. */
	public apiKeyManager: ApiKeyManager;
	/** Manages extension settings and configuration options. */
	public settingsManager: SettingsManager;
	/** Manages the persistent history of the chat conversation. */
	public chatHistoryManager: ChatHistoryManager;
	/** Logs and tracks all file system changes made by the AI workflow engine. */
	public changeLogger: ProjectChangeLogger;

	// Services
	/** Handles interactions with the Gemini API for chat and planning. */
	public aiRequestService: AIRequestService;
	/** Manages context gathering (files, symbols, diagnostics) for AI prompts. */
	public contextService: ContextService;
	/** Orchestrates the generation, confirmation, and execution of AI-generated plans. */
	public planService: PlanService;
	/** Handles simple, conversational chat interactions. */
	public chatService: ChatService;
	/** Handles AI-driven Git commit message generation and confirmation. */
	public commitService: CommitService;
	/** Tracks and reports token usage statistics. */
	public tokenTrackingService: TokenTrackingService;
	/** Service responsible for reverting project changes made by the AI. */
	public revertService!: RevertService;
	/** Core service for generating and streaming code, ensuring validation. */
	private enhancedCodeGenerator: EnhancedCodeGenerator;
	/** Service for validating generated code snippets against workspace context. */
	private codeValidationService: CodeValidationService;
	/** Service for watching workspace changes and refreshing context caches. */
	private contextRefresherService: ContextRefresherService;

	// --- State for Throttling Messages ---
	/** Queue holding messages waiting to be sent to the webview, subject to throttling. */
	private _postMessageThrottledQueue: {
		message: sidebarTypes.ExtensionToWebviewMessages;
	}[] = [];
	/** Flag indicating if the throttling queue processing loop is currently running. */
	private _isThrottledQueueProcessing: boolean = false;
	/** Timestamp of the last time a throttled message was successfully sent. */
	private _lastThrottledMessageTime: number = 0;
	/** The minimum time interval (in ms) between sending throttled messages. */
	private readonly THROTTLE_INTERVAL_MS = 50; // Default throttle interval for frequent updates

	/** A flag to indicate if the webview is fully loaded and ready to receive messages. */
	private _isWebviewReadyForMessages: boolean = false;

	/** Disposable listener for VS Code window state changes. */
	private _windowStateChangeListener: vscode.Disposable | undefined;

	/**
	 * Initializes the SidebarProvider, loading persistent state and setting up core managers and services.
	 * @param extensionUri The URI representing the root of the extension installation.
	 * @param context The VS Code extension context, providing access to workspace state and secrets.
	 * @param workspaceRootUri The URI of the current workspace root.
	 */
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
		this.tokenTrackingService.onTokenUpdate(() => {
			this.postMessageToWebview({
				type: "updateTokenStatistics",
				value: this.tokenTrackingService.getFormattedStatistics(),
			});
		});

		// Instantiate services, passing dependencies
		this.aiRequestService = new AIRequestService(
			this.apiKeyManager,
			this.postMessageToWebview.bind(this),
			this.tokenTrackingService
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
	 * Resolves the webview view, setting up its HTML content, options, and attaching message listeners.
	 * This method is called by VS Code when the sidebar is first revealed or restored.
	 * @param webviewView The WebviewView instance provided by VS Code's view container API.
	 * @returns A Promise that resolves when the webview is fully set up and ready to receive messages.
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
			sidebarConstants.MODEL_DETAILS,
			this.settingsManager.getSelectedModelName(),
			logoUri,
			this.workspaceRootUri
		);

		const fileUri = vscode.Uri.parse("file://"); // This seems like a placeholder URI for the webview's internal loading
		this.postMessageToWebview({
			type: "fileUriLoaded",
			uri: fileUri.toString(),
		});

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
	 *
	 * Messages are categorized:
	 * 1. IMMEDIATE_TYPES: Sent instantly (critical updates, handshake, operation start/end).
	 * 2. THROTTLED_TYPES: Queued and sent at a controlled rate (frequent UI/status updates, streaming chunks).
	 *
	 * @param message The message object conforming to `ExtensionToWebviewMessages`.
	 */
	public postMessageToWebview(
		message: sidebarTypes.ExtensionToWebviewMessages
	): void {
		// Messages that should bypass throttling (immediate delivery)
		const immediateTypes = new Set<
			sidebarTypes.ExtensionToWebviewMessages["type"]
		>(MESSAGE_THROTTLING_CONFIG.IMMEDIATE_TYPES);

		// Messages that are typically frequent and should be throttled to prevent UI overwhelming
		const throttledTypes = new Set<
			sidebarTypes.ExtensionToWebviewMessages["type"]
		>(MESSAGE_THROTTLING_CONFIG.THROTTLED_TYPES);

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
	 * It handles the actual `webview.postMessage` call and basic error logging, ensuring the view is visible.
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
	 * Processes the throttled message queue, ensuring messages are sent at a controlled rate defined by `THROTTLE_INTERVAL_MS`.
	 * Only one queue processing loop runs at a time (`_isThrottledQueueProcessing`).
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
	 * Updates the persisted pending plan data in VS Code workspace state.
	 * This data is used to restore the "Plan Review" UI state after an extension restart.
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
	 * Updates the persisted completed plan change sets (revert history) in workspace state.
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
	 * This flag is critical for restoring UI state to show an active execution across reloads.
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
	 * Handles the `webviewReady` message, triggering the restoration of the UI state
	 * based on persistent flags (active execution, pending review, ongoing streaming)
	 * read from `workspaceState`.
	 */
	public async handleWebviewReady(): Promise<void> {
		// Always load essential data first, regardless of active operations
		this.apiKeyManager.loadKeysFromStorage();
		this.settingsManager.updateWebviewModelList();
		this.settingsManager.updateWebviewOptimizationSettings();
		this.chatHistoryManager.restoreChatHistoryToWebview();

		// Restore UI state based on potential ongoing operations
		// 1) isPlanExecutionActive (Highest priority)
		if (this.isPlanExecutionActive) {
			await this._restorePlanExecutionState();
			// 2) _persistedPendingPlanData (Plan Review)
		} else if (this._persistedPendingPlanData) {
			await this._restorePendingPlanConfirmationState(
				this._persistedPendingPlanData
			);
			// 3) pendingCommitReviewData (Commit Review)
		} else if (this.pendingCommitReviewData) {
			await this._restorePendingCommitReviewState(this.pendingCommitReviewData);
			// 4) currentAiStreamingState AND this._isOperationActive
		} else if (
			this.currentAiStreamingState &&
			!this.currentAiStreamingState.isComplete &&
			this._isOperationActive
		) {
			await this._restoreAiStreamingState(this.currentAiStreamingState);
			// 5) this._isOperationActive (Stale/Generic check for operations not explicitly captured)
		} else if (this._isOperationActive) {
			console.warn(
				"[SidebarProvider] Detected active operation (currentActiveChatOperationId set) without specific plan, review, or streaming context. Assuming stale and resetting."
			);
			await this._resetStaleLoadingState();
			// 6) _resetQuiescentUIState (Default)
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
	 * Restores UI state for an actively running plan execution that was interrupted by a reload.
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
	 * Restores UI state for a pending plan confirmation (user review) that was interrupted by a reload.
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
	}

	/**
	 * Restores UI state for an active AI streaming operation (e.g., chat response) that was interrupted by a reload.
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
	 * Restores UI state for a pending commit review that was interrupted by a reload.
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
	}

	/**
	 * Detects and resets stale loading state indicators if an operation ID is present but no specific context (plan, review, streaming) is associated.
	 * This ensures the UI is correctly unblocked after a potentially failed or ungracefully ended operation.
	 */
	private async _resetStaleLoadingState(): Promise<void> {
		console.log(
			"[SidebarProvider] Detected stale generic loading state. Resetting."
		);
		await this.endUserOperation("success", "Inputs re-enabled.");
	}

	/**
	 * Resets the UI to a quiescent state (inputs enabled, loading indicators off) when no operations are active or pending.
	 */
	private async _resetQuiescentUIState(): Promise<void> {
		console.log("[SidebarProvider] No active operations, re-enabling inputs.");
		this.postMessageToWebview({ type: "reenableInput" });
		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.postMessageToWebview({ type: "statusUpdate", value: "" }); // Clear any stale status message
		this.clearActiveOperationState(); // Ensure cancellation token and streaming state are null
	}

	// --- OPERATION & STATE HELPERS ---

	/**
	 * Initiates a new user operation (chat, plan, commit), ensuring concurrency control.
	 * If an operation is already running, it warns and exits.
	 * It creates a new `CancellationTokenSource` and sets a unique `currentActiveChatOperationId`.
	 * @param operationType Descriptive type of the operation (e.g., "plan", "chat", "commit").
	 */
	public async startUserOperation(operationType: string): Promise<void> {
		// Generate a new unique operationId at the very beginning
		const newOperationId = crypto.randomUUID();

		// Concurrency check: If an operation is truly in progress (ID set and token active), warn and exit.
		if (this._isOperationActive) {
			console.warn(
				`[SidebarProvider] Attempted to start operation '${operationType}' (new ID: ${newOperationId}) while an operation ` +
					`(current ID: ${this.currentActiveChatOperationId}) is already active. Ignoring duplicate request.`
			);
			return;
		}

		// If operation is inactive, but a stale operation ID exists (e.g., failed to clear ID on crash), clear it now
		if (this.currentActiveChatOperationId !== null) {
			console.warn(
				`[SidebarProvider] Detected stale active operation ID (${this.currentActiveChatOperationId}) while no token was active. Resetting state for new operation.`
			);
			this.clearActiveOperationState();
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

		this.currentActiveChatOperationId = newOperationId;

		console.log(
			"[SidebarProvider] Created new CancellationTokenSource and updated generation state for the operation."
		);
	}

	/**
	 * Checks if any user operation (AI generation or child process execution) is currently in progress.
	 * @returns True if an operation or active child process exists.
	 */
	public isOperationInProgress(): boolean {
		return this._isOperationActive || this.activeChildProcesses.length > 0;
	}

	/**
	 * Clears all state variables associated with the currently active operation:
	 * Disposes the cancellation token source, clears streaming state, and resets the operation ID.
	 */
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

	/**
	 * Cleans up specific state when the cancellation flow itself ends.
	 */
	public async endCancellationOperation(): Promise<void> {
		this.postMessageToWebview({
			type: "updateCancellationState",
			value: false,
		});
		this.clearActiveOperationState();
	}

	/**
	 * Concludes the current user operation, resetting operation flags and re-enabling the chat input.
	 * It sends a final status update to the webview.
	 * @param outcome The final outcome of the operation ("success", "cancelled", "failed", or "review").
	 * @param customStatusMessage Optional custom message to display as the final status.
	 * @param shouldReenableInputs If true (default), re-enables chat input and updates loading state.
	 */
	public async endUserOperation(
		outcome: sidebarTypes.ExecutionOutcome | "review",
		customStatusMessage?: string,
		shouldReenableInputs: boolean = true
	): Promise<void> {
		console.log(
			`[SidebarProvider] Ending user operation with outcome: ${outcome}`
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
					statusMessage = "Operation failed.";
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

	/**
	 * Immediately cancels any and all ongoing AI operations, background processes, and clears all pending state.
	 * This is the robust method used for user-initiated cancellation or internal fatal error interrupts.
	 */
	public async triggerUniversalCancellation(): Promise<void> {
		console.log("[SidebarProvider] Triggering universal cancellation...");

		// Cancel the active operation token source if it exists.
		if (this.activeOperationCancellationTokenSource) {
			this.activeOperationCancellationTokenSource.cancel();
		}

		// Dispose and clear the token source and operation ID.
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

		// Ensure these messages are always sent to re-enable UI regardless of active token source
		this.postMessageToWebview({ type: "updateLoadingState", value: false });
		this.postMessageToWebview({ type: "reenableInput" });
		this.postMessageToWebview({ type: "updateCancellationState", value: true });
		this.postMessageToWebview({
			type: "operationCancelledConfirmation",
		});
	}

	/**
	 * Wrapper for triggering universal cancellation from external commands.
	 */
	public async cancelActiveOperation(): Promise<void> {
		await this.triggerUniversalCancellation();
	}

	/**
	 * Wrapper for triggering universal cancellation when a pending plan is cancelled.
	 */
	public async cancelPendingPlan(): Promise<void> {
		await this.triggerUniversalCancellation();
	}

	/**
	 * Reverts the file system changes made by the most recently completed successful plan execution.
	 * This removes the last `RevertibleChangeSet` from the history and uses the RevertService.
	 */
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

				console.log(
					"[SidebarProvider] Most recent workflow changes reverted successfully."
				);
			} catch (error: any) {
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
				// If revert fails, push the change set back so the user can try again
				this.completedPlanChangeSets.push(mostRecentChangeSet);
			}
		} else {
			revertErrorMessage = "Revert operation cancelled by user.";
			finalStatusMessage = "Revert operation cancelled.";
			isErrorStatus = false;
			vscode.window.showInformationMessage(finalStatusMessage);
			console.log("[SidebarProvider] Revert operation cancelled by user.");

			// If cancelled, push the change set back as it was never acted upon
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

	/**
	 * Handles notifications and UI updates upon the completion of a plan execution (success, failure, or cancellation).
	 * If the sidebar is not visible, it shows a VS Code native notification.
	 * @param outcome The final outcome of the plan execution.
	 */
	public async showPlanCompletionNotification(
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
				message = `Plan execution failed.`;
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
