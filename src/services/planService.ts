import * as vscode from "vscode";
import * as path from "path";
import { FunctionCall, FunctionCallingMode } from "@google/generative-ai";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as sidebarTypes from "../sidebar/common/sidebarTypes";
import { ExtensionToWebviewMessages } from "../sidebar/common/sidebarTypes";
import * as sidebarConstants from "../sidebar/common/sidebarConstants";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import {
	ExecutionPlan,
	parseAndValidatePlan,
	ParsedPlanResult,
} from "../ai/workflowPlanner";
import { FileChangeEntry } from "../types/workflow";
import { GitConflictResolutionService } from "./gitConflictResolutionService";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { UrlContextService } from "./urlContextService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import {
	createInitialPlanningExplanationPrompt,
	createPlanningPromptForFunctionCall, // Modified: Changed to createPlanningPromptForFunctionCall
} from "../ai/prompts/planningPrompts";
import { repairJsonEscapeSequences } from "../utils/jsonUtils";
import { PlanExecutorService } from "./planExecutorService";
import { generateExecutionPlanTool } from "../ai/prompts/planFunctions"; // Added: Import generateExecutionPlanTool

export class PlanService {
	// Audited retry constants and made configurable via VS Code settings
	private readonly MAX_PLAN_PARSE_RETRIES: number;
	private readonly MAX_TRANSIENT_STEP_RETRIES: number;
	private urlContextService: UrlContextService;
	private enhancedCodeGenerator: EnhancedCodeGenerator;
	private planExecutorService: PlanExecutorService; // Added class member

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri | undefined,
		private gitConflictResolutionService: GitConflictResolutionService,
		enhancedCodeGenerator: EnhancedCodeGenerator,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void
	) {
		// As per instructions, ensure UrlContextService is initialized consistently.
		// And enhancedCodeGenerator parameter is assigned directly.
		this.urlContextService = new UrlContextService();
		this.enhancedCodeGenerator = enhancedCodeGenerator;

		// Read retry constants from VS Code settings, with fallbacks to defaults
		const config = vscode.workspace.getConfiguration(
			"minovativeMind.planExecution"
		);
		this.MAX_PLAN_PARSE_RETRIES = config.get("maxPlanParseRetries", 3);
		this.MAX_TRANSIENT_STEP_RETRIES = config.get("maxTransientStepRetries", 3);

		// Initialize PlanExecutorService
		this.planExecutorService = new PlanExecutorService(
			provider, // Pass the SidebarProvider instance
			this.workspaceRootUri!,
			postMessageToWebview, // Pass the function
			this.urlContextService, // Pass the UrlContextService instance
			enhancedCodeGenerator, // Pass the EnhancedCodeGenerator instance
			this.gitConflictResolutionService, // Pass the GitConflictResolutionService instance
			this.MAX_TRANSIENT_STEP_RETRIES // Pass the retry count
		);
	}

	/**
	 * Triggers the UI to display the textual plan for review.
	 * This public method acts as a wrapper for the private _handlePostTextualPlanGenerationUI.
	 * @param planContext The context containing the generated plan and associated data.
	 */
	public async triggerPostTextualPlanUI(
		planContext: sidebarTypes.PlanGenerationContext
	): Promise<void> {
		return this._handlePostTextualPlanGenerationUI(planContext);
	}

	// --- CHAT-INITIATED PLAN ---
	public async handleInitialPlanRequest(userRequest: string): Promise<void> {
		const { apiKeyManager, changeLogger } = this.provider;
		const modelName = this.provider.settingsManager.getSelectedModelName(); // Use selected model for initial plan generation
		const apiKey = apiKeyManager.getActiveApiKey();

		// Start a new user operation, which creates a new cancellation token source and operation ID
		await this.provider.startUserOperation("plan");
		const operationId =
			this.provider.currentActiveChatOperationId ?? "unknown-operation";

		if (!this.provider.activeOperationCancellationTokenSource) {
			console.error(
				"[PlanService] activeOperationCancellationTokenSource is undefined in handleInitialPlanRequest after startUserOperation."
			);
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error: "Internal error: Failed to initialize cancellation token.",
				operationId: operationId as string,
			});
			await this.provider.endUserOperation("failed");
			return;
		}
		const token = this.provider.activeOperationCancellationTokenSource.token;

		if (!apiKey) {
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value:
					"Action blocked: No active API key found. Please add or select an API key in the sidebar settings.",
				isError: true,
			});
			return;
		}

		changeLogger.clear();

		const rootFolder = vscode.workspace.workspaceFolders?.[0];
		if (!rootFolder) {
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error:
					"Action blocked: No VS Code workspace folder is currently open. Please open a project folder to proceed.",
				operationId: operationId as string,
			});
			return;
		}

		let success = false;
		let textualPlanResponse: string | null = null;
		let finalErrorForDisplay: string | null = null;

		try {
			this.provider.pendingPlanGenerationContext = null;

			const buildContextResult =
				await this.provider.contextService.buildProjectContext(
					token,
					userRequest,
					undefined, // Pass undefined for editorContext
					undefined, // Pass undefined for initialDiagnosticsString
					undefined, // Pass undefined for options
					false, // CRITICAL: Pass false to exclude the AI persona
					false // Add false for includeVerboseHeaders
				);
			const { contextString, relevantFiles } = buildContextResult;

			// Refactored: Call new helper method to initialize streaming state
			this._initializeStreamingState(
				modelName,
				relevantFiles,
				operationId as string
			);

			if (contextString.startsWith("[Error")) {
				throw new Error(contextString);
			}

			// Process URLs in user request for context
			const urlContexts =
				await this.urlContextService.processMessageForUrlContext(
					userRequest,
					operationId
				);
			const urlContextString =
				this.urlContextService.formatUrlContexts(urlContexts);

			const textualPlanPrompt = createInitialPlanningExplanationPrompt(
				contextString,
				userRequest,
				undefined,
				undefined,
				[...this.provider.chatHistoryManager.getChatHistory()],
				urlContextString
			);

			let accumulatedTextualResponse = "";
			// Line 164: Modify first argument to wrap string prompt in HistoryEntryPart array
			textualPlanResponse =
				await this.provider.aiRequestService.generateWithRetry(
					[{ text: textualPlanPrompt }],
					modelName,
					undefined,
					"initial plan explanation",
					undefined,
					{
						onChunk: (chunk: string) => {
							accumulatedTextualResponse += chunk;
							if (this.provider.currentAiStreamingState) {
								this.provider.currentAiStreamingState.content += chunk;
							}
							this.provider.postMessageToWebview({
								type: "aiResponseChunk",
								value: chunk,
								operationId: operationId as string, // Cast as requested
							});
						},
					},
					token
				);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (textualPlanResponse.toLowerCase().startsWith("error:")) {
				throw new Error(
					formatUserFacingErrorMessage(
						new Error(textualPlanResponse),
						"AI failed to generate initial plan explanation.",
						"AI response error: ",
						rootFolder.uri
					)
				);
			}

			this.provider.chatHistoryManager.addHistoryEntry(
				"model",
				textualPlanResponse,
				undefined,
				relevantFiles,
				relevantFiles && relevantFiles.length <= 3,
				true // Added: Mark as plan explanation
			);
			this.provider.chatHistoryManager.restoreChatHistoryToWebview();
			success = true;

			this.provider.pendingPlanGenerationContext = {
				type: "chat",
				originalUserRequest: userRequest,
				projectContext: contextString,
				relevantFiles,
				activeSymbolDetailedInfo: buildContextResult.activeSymbolDetailedInfo,
				initialApiKey: apiKey,
				modelName,
				chatHistory: [...this.provider.chatHistoryManager.getChatHistory()],
				textualPlanExplanation: textualPlanResponse,
				workspaceRootUri: rootFolder.uri,
			};
			this.provider.lastPlanGenerationContext = {
				...this.provider.pendingPlanGenerationContext,
				relevantFiles,
			};

			// Add the following code here
			const dataToPersist: sidebarTypes.PersistedPlanData = {
				type: this.provider.pendingPlanGenerationContext.type,
				originalUserRequest:
					this.provider.pendingPlanGenerationContext.originalUserRequest,
				originalInstruction:
					this.provider.pendingPlanGenerationContext.editorContext?.instruction,
				relevantFiles: this.provider.pendingPlanGenerationContext.relevantFiles,
				textualPlanExplanation: textualPlanResponse, // Pass the full generated text
			};
			await this.provider.updatePersistedPendingPlanData(dataToPersist);
			// End of added code
		} catch (error: any) {
			if (this.provider.currentAiStreamingState) {
				this.provider.currentAiStreamingState.isError = true;
			}
			finalErrorForDisplay = error.message;
		} finally {
			if (this.provider.currentAiStreamingState) {
				this.provider.currentAiStreamingState.isComplete = true;
			}
			const isCancellation = finalErrorForDisplay === ERROR_OPERATION_CANCELLED;

			// Determine if the generated response is a confirmable plan
			const isConfirmablePlanResponse =
				success &&
				!!this.provider.pendingPlanGenerationContext?.textualPlanExplanation;

			// Construct and post the aiResponseEnd message directly
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: success,
				operationId: operationId as string, // Cast as requested
				error: success
					? null
					: isCancellation
					? "Plan generation cancelled."
					: formatUserFacingErrorMessage(
							finalErrorForDisplay
								? new Error(finalErrorForDisplay)
								: new Error("Unknown error during initial plan generation."), // Pass an actual Error instance
							"An unexpected error occurred during initial plan generation.",
							"AI response error: ",
							rootFolder.uri
					  ),
				// Conditionally include plan-related data if it's a confirmable plan response
				...(isConfirmablePlanResponse &&
					this.provider.pendingPlanGenerationContext && {
						isPlanResponse: true,
						requiresConfirmation: true,
						planData: {
							type: "textualPlanPending", // Use "textualPlanPending" for webview message
							originalRequest:
								this.provider.pendingPlanGenerationContext.type === "chat"
									? this.provider.pendingPlanGenerationContext
											.originalUserRequest
									: undefined,
							originalInstruction:
								this.provider.pendingPlanGenerationContext.type === "editor"
									? this.provider.pendingPlanGenerationContext.editorContext
											?.instruction
									: undefined,
							relevantFiles:
								this.provider.pendingPlanGenerationContext.relevantFiles,
							textualPlanExplanation:
								this.provider.pendingPlanGenerationContext
									.textualPlanExplanation,
						},
					}),
			});
		}
	}

	// --- EDITOR-INITIATED PLAN ---
	public async initiatePlanFromEditorAction(
		instruction: string,
		selectedText: string,
		fullText: string,
		languageId: string,
		documentUri: vscode.Uri,
		selection: vscode.Range,
		initialProgress?: vscode.Progress<{ message?: string; increment?: number }>,
		initialToken?: vscode.CancellationToken,
		diagnosticsString?: string,
		isMergeOperation: boolean = false
	): Promise<sidebarTypes.PlanGenerationResult> {
		const { apiKeyManager, changeLogger } = this.provider;
		const modelName = this.provider.settingsManager.getSelectedModelName(); // Use selected model for editor-initiated plan generation
		const apiKey = apiKeyManager.getActiveApiKey();

		// Start a new user operation, which creates a new cancellation token source and operation ID
		await this.provider.startUserOperation("plan");
		const operationId = this.provider.currentActiveChatOperationId;

		if (!this.provider.activeOperationCancellationTokenSource) {
			console.error(
				"[PlanService] activeOperationCancellationTokenSource is undefined in initiatePlanFromEditorAction after startUserOperation."
			);
			await this.provider.endUserOperation("failed");
			return {
				success: false,
				error: "Internal error: Failed to initialize cancellation token.",
			};
		}
		const activeOpToken =
			this.provider.activeOperationCancellationTokenSource.token;

		const rootFolder = vscode.workspace.workspaceFolders?.[0];
		if (!rootFolder) {
			initialProgress?.report({
				message: "Error: No workspace folder open.",
				increment: 100,
			});
			return {
				success: false,
				error:
					"Action blocked: No VS Code workspace folder is currently open. Please open a project folder to proceed.",
			};
		}

		const disposable = initialToken?.onCancellationRequested(() => {
			this.provider.activeOperationCancellationTokenSource?.cancel();
		});

		if (activeOpToken.isCancellationRequested) {
			initialProgress?.report({
				message: "Plan generation cancelled.",
				increment: 100,
			});
			disposable?.dispose();
			return { success: false, error: "Plan generation cancelled." };
		}

		changeLogger.clear();

		let finalResult: sidebarTypes.PlanGenerationResult = {
			success: false,
			error: "An unexpected error occurred during plan generation.",
		};
		let isCancellation: boolean = false; // Declared as let to extend scope

		try {
			this.provider.pendingPlanGenerationContext = null;

			const relativeFilePath = path
				.relative(rootFolder.uri.fsPath, documentUri.fsPath)
				.replace(/\\/g, "/");

			const editorCtx: sidebarTypes.EditorContext = {
				instruction,
				selectedText,
				fullText,
				languageId,
				filePath: relativeFilePath,
				documentUri,
				selection,
			};

			const buildContextResult =
				await this.provider.contextService.buildProjectContext(
					activeOpToken,
					editorCtx.instruction,
					editorCtx,
					diagnosticsString,
					undefined, // Pass undefined for options
					false, // CRITICAL: Pass false to exclude the AI persona
					false // Add false for includeVerboseHeaders
				);
			const { contextString, relevantFiles } = buildContextResult;

			// Refactored: Call new helper method to initialize streaming state
			this._initializeStreamingState(
				modelName,
				relevantFiles,
				operationId as string
			);

			if (contextString.startsWith("[Error")) {
				throw new Error(contextString);
			}

			const textualPlanPrompt = createInitialPlanningExplanationPrompt(
				contextString,
				undefined,
				editorCtx,
				diagnosticsString,
				[...this.provider.chatHistoryManager.getChatHistory()]
			);

			initialProgress?.report({
				message: "Generating textual plan explanation...",
				increment: 20,
			});

			let textualPlanResponse = "";
			// Line 421: Modify first argument to wrap string prompt in HistoryEntryPart array
			textualPlanResponse =
				await this.provider.aiRequestService.generateWithRetry(
					[{ text: textualPlanPrompt }],
					modelName,
					undefined,
					"editor action plan explanation",
					undefined,
					{
						onChunk: (chunk: string) => {
							textualPlanResponse += chunk;
							this.provider.postMessageToWebview({
								type: "aiResponseChunk",
								value: chunk,
								operationId: operationId as string, // Cast as requested
							});
						},
					},
					activeOpToken
				);

			if (activeOpToken.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (textualPlanResponse.toLowerCase().startsWith("error:")) {
				throw new Error(textualPlanResponse);
			}

			this.provider.chatHistoryManager.addHistoryEntry(
				"model",
				textualPlanResponse,
				undefined,
				relevantFiles,
				relevantFiles && relevantFiles.length <= 3,
				true
			);
			initialProgress?.report({
				message: "Textual plan generated.",
				increment: 100,
			});

			this.provider.pendingPlanGenerationContext = {
				type: "editor",
				editorContext: editorCtx,
				projectContext: contextString,
				relevantFiles,
				activeSymbolDetailedInfo: buildContextResult.activeSymbolDetailedInfo,
				diagnosticsString,
				initialApiKey: apiKey!,
				modelName,
				chatHistory: [...this.provider.chatHistoryManager.getChatHistory()],
				textualPlanExplanation: textualPlanResponse,
				workspaceRootUri: rootFolder.uri,
				isMergeOperation: isMergeOperation,
			};
			this.provider.lastPlanGenerationContext = {
				...this.provider.pendingPlanGenerationContext,
				relevantFiles,
			};

			// ADDED: Persist the pending plan data here for editor-initiated plans
			const dataToPersist: sidebarTypes.PersistedPlanData = {
				type: "editor",
				originalInstruction: editorCtx.instruction,
				relevantFiles: relevantFiles,
				textualPlanExplanation: textualPlanResponse,
			};
			await this.provider.updatePersistedPendingPlanData(dataToPersist);

			// Set isGeneratingUserRequest to true for persistence like /plan
			this.provider.isGeneratingUserRequest = true;
			await this.provider.workspaceState.update(
				"minovativeMind.isGeneratingUserRequest",
				true
			);
			// END ADDED

			finalResult = {
				success: true,
				textualPlanExplanation: textualPlanResponse,
				context: this.provider.pendingPlanGenerationContext,
			};
		} catch (genError: any) {
			isCancellation = genError.message === ERROR_OPERATION_CANCELLED; // Assignment to existing let variable
			if (this.provider.currentAiStreamingState) {
				this.provider.currentAiStreamingState.isError = true;
			}
			finalResult = {
				success: false,
				error: isCancellation
					? "Plan generation cancelled."
					: formatUserFacingErrorMessage(
							genError,
							"An unexpected error occurred during editor action plan generation.",
							"Error: ",
							rootFolder.uri
					  ),
			};
		} finally {
			// Mark streaming state as complete
			if (this.provider.currentAiStreamingState) {
				this.provider.currentAiStreamingState.isComplete = true;
			}

			// Determine if the generated response is a confirmable plan
			const isConfirmablePlanResponse =
				finalResult.success &&
				!!this.provider.pendingPlanGenerationContext?.textualPlanExplanation;

			// Construct and post the aiResponseEnd message directly
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: finalResult.success,
				operationId: operationId as string, // Cast as requested
				error: finalResult.success
					? null
					: isCancellation
					? "Plan generation cancelled."
					: finalResult.error || // If finalResult.error already contains formatted message
					  formatUserFacingErrorMessage(
							new Error(
								"Unknown error occurred during editor action plan generation."
							), // Fallback Error
							"An unexpected error occurred during editor action generation.",
							"Error: ",
							rootFolder.uri
					  ),
				// Conditionally include plan-related data if it's a confirmable plan response
				...(isConfirmablePlanResponse &&
					this.provider.pendingPlanGenerationContext && {
						isPlanResponse: true,
						requiresConfirmation: true,
						planData: {
							type: "textualPlanPending",
							originalRequest:
								this.provider.pendingPlanGenerationContext.type === "chat"
									? this.provider.pendingPlanGenerationContext
											.originalUserRequest
									: undefined,
							originalInstruction:
								this.provider.pendingPlanGenerationContext.type === "editor"
									? this.provider.pendingPlanGenerationContext.editorContext
											?.instruction
									: undefined,
							relevantFiles:
								this.provider.pendingPlanGenerationContext.relevantFiles,
							textualPlanExplanation:
								this.provider.pendingPlanGenerationContext
									.textualPlanExplanation,
						},
					}),
			});
			disposable?.dispose();
			this.provider.activeOperationCancellationTokenSource?.dispose();
			this.provider.chatHistoryManager.restoreChatHistoryToWebview();
			this.provider.activeOperationCancellationTokenSource = undefined;
			return finalResult;
		}
	}

	/**
	 * Attempts to parse and validate JSON, applying programmatic repair for escape sequence errors.
	 * @param jsonString The raw JSON string to parse.
	 * @param workspaceRootUri The root URI of the workspace for context.
	 * @returns A promise resolving to the parsed plan or an error.
	 */
	private async parseAndValidatePlanWithFix(
		jsonString: string,
		workspaceRootUri: vscode.Uri
	): Promise<ParsedPlanResult> {
		try {
			// 1. Attempt initial parse and validation.
			let parsedResult = await parseAndValidatePlan(
				jsonString,
				workspaceRootUri
			);

			// 2. If initial parsing failed, attempt repair and re-validation.
			if (!parsedResult.plan && parsedResult.error) {
				console.log(
					"[PlanService] Initial JSON parsing failed. Attempting programmatic repair."
				);

				const repairedJsonString = repairJsonEscapeSequences(jsonString);

				// Only re-parse if the repair function actually changed the string.
				if (repairedJsonString !== jsonString) {
					console.log(
						"[PlanService] JSON string modified by repair function. Re-parsing after programmatic repair."
					);
					const reParsedResult = await parseAndValidatePlan(
						repairedJsonString,
						workspaceRootUri
					);

					if (reParsedResult.plan) {
						// Repair was successful. Return the repaired plan.
						console.log("[PlanService] Programmatic JSON repair successful.");
						return reParsedResult;
					} else {
						// Repair failed. Report a combined error for better diagnostics.
						console.warn(
							"[PlanService] Programmatic JSON repair failed. Original error:",
							parsedResult.error,
							"Repair attempt error:",
							reParsedResult.error
						);
						return {
							plan: null,
							error: `JSON parsing failed: Original error: "${parsedResult.error}". Repair attempt also failed with: "${reParsedResult.error}".`,
						};
					}
				} else {
					// Repair function didn't change the string, so no repair was applied or possible for this specific issue.
					console.log(
						"[PlanService] Repair function did not alter JSON. Proceeding with original parsing error."
					);
					// Fallback to the original error.
					return parsedResult;
				}
			} else {
				// Initial parse was successful.
				return parsedResult;
			}
		} catch (e: any) {
			// Catch any exceptions during the process (e.g., parseAndValidatePlan itself throws).
			console.error(
				"[PlanService] Exception during parseAndValidatePlanWithFix:",
				e
			);
			return {
				plan: null,
				error: `An unexpected error occurred during JSON parsing/validation: ${e.message}`,
			};
		}
	}

	// New private method to encapsulate streaming state initialization
	private _initializeStreamingState(
		modelName: string,
		relevantFiles: string[] | undefined,
		operationId: string
	): void {
		this.provider.currentAiStreamingState = {
			content: "",
			relevantFiles: relevantFiles ?? [], // Ensure relevantFiles is always string[]
			isComplete: false,
			isError: false,
			operationId: operationId,
		};
		this.provider.postMessageToWebview({
			type: "aiResponseStart",
			value: {
				modelName,
				relevantFiles: relevantFiles ?? [],
				operationId: operationId,
			}, // Ensure relevantFiles is always string[]
		});
		this.provider.postMessageToWebview({
			type: "updateStreamingRelevantFiles",
			value: relevantFiles ?? [], // Ensure relevantFiles is always string[]
		});
	}
	// --- PLAN GENERATION & EXECUTION ---
	public async generateStructuredPlanAndExecute(
		planContext: sidebarTypes.PlanGenerationContext
	): Promise<void> {
		const token = this.provider.activeOperationCancellationTokenSource?.token;
		// Add check for token immediately after retrieval
		if (!token) {
			console.error(
				"[PlanService] activeOperationCancellationTokenSource or its token is undefined in generateStructuredPlanAndExecute."
			);
			await this.provider.endUserOperation("failed"); // Signal failure
			return; // Exit early if token is not available
		}

		let executablePlan: ExecutionPlan | null = null;
		let lastError: Error | null = null;

		try {
			await this.provider.setPlanExecutionActive(true);

			// Notify webview that structured plan generation is starting - this will hide the stop button
			this.provider.postMessageToWebview({
				type: "updateLoadingState",
				value: true,
			});

			await this.provider.updatePersistedPendingPlanData(null); // Clear persisted data as it's no longer pending confirmation

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			// Removed: jsonGenerationConfig is no longer needed for function calling.

			const recentChanges = this.provider.changeLogger.getChangeLog();
			const formattedRecentChanges =
				this._formatRecentChangesForPrompt(recentChanges);

			const operationId = this.provider.currentActiveChatOperationId; // Retrieve operationId

			// Process URLs in the original user request for context
			const urlContexts =
				await this.urlContextService.processMessageForUrlContext(
					planContext.originalUserRequest || "",
					operationId as string
				);
			const urlContextString =
				this.urlContextService.formatUrlContexts(urlContexts);

			// Generate a single, standard prompt for the AI for function calling.
			const promptForAIForFunctionCall = createPlanningPromptForFunctionCall(
				planContext.type === "chat"
					? planContext.originalUserRequest
					: undefined,
				planContext.projectContext,
				planContext.type === "editor" ? planContext.editorContext : undefined,
				planContext.chatHistory,
				planContext.textualPlanExplanation,
				formattedRecentChanges,
				urlContextString
			);

			for (let attempt = 1; attempt <= this.MAX_PLAN_PARSE_RETRIES; attempt++) {
				console.log(
					`Generating execution plan - ${attempt}/${this.MAX_PLAN_PARSE_RETRIES}`
				);
				this.provider.postMessageToWebview({
					type: "statusUpdate",
					value: `Generating execution plan - ${attempt}/${this.MAX_PLAN_PARSE_RETRIES} `,
					isError: false,
				});

				try {
					const functionCall: FunctionCall | null =
						await this.provider.aiRequestService.generateFunctionCall(
							planContext.initialApiKey,
							planContext.modelName,
							[{ role: "user", parts: [{ text: promptForAIForFunctionCall }] }],
							[{ functionDeclarations: [generateExecutionPlanTool] }],
							FunctionCallingMode.ANY,
							token,
							"plan generation via function call"
						);

					if (token.isCancellationRequested) {
						throw new Error(ERROR_OPERATION_CANCELLED);
					}
					if (!functionCall) {
						throw new Error(
							"AI failed to generate a valid function call for the plan."
						);
					}

					// Pass functionCall.args (which is an object) to parseAndValidatePlanWithFix
					// It must be stringified because parseAndValidatePlanWithFix expects a JSON string.
					const { plan, error } = await this.parseAndValidatePlanWithFix(
						JSON.stringify(functionCall.args),
						planContext.workspaceRootUri
					);

					if (error) {
						lastError = new Error(
							`Failed to parse or validate generated plan: ${error}`
						);
						console.error(
							`[PlanService] Parse/Validation error on attempt ${attempt}:`,
							lastError.message
						);
						if (attempt < this.MAX_PLAN_PARSE_RETRIES) {
							continue;
						} else {
							throw lastError;
						}
					}

					if (!plan || plan.steps.length === 0) {
						lastError = new Error(
							"AI generated plan content but it was empty or invalid after parsing."
						);
						console.error(
							`[PlanService] Empty/Invalid plan on attempt ${attempt}:`,
							lastError.message
						);
						if (attempt < this.MAX_PLAN_PARSE_RETRIES) {
							continue;
						} else {
							throw lastError;
						}
					}

					executablePlan = plan;
					break; // Successfully generated and parsed, exit loop
				} catch (error: any) {
					if (error.message === ERROR_OPERATION_CANCELLED) {
						throw error; // Re-throw cancellation immediately
					}

					lastError = error;
					console.error(
						`[PlanService] AI generation or processing failed on attempt ${attempt}:`,
						lastError?.message
					);
					// Removed: x;
					if (attempt < this.MAX_PLAN_PARSE_RETRIES) {
						await new Promise((resolve) =>
							setTimeout(resolve, 15000 + attempt * 2000)
						); // Exponential backoff for retries
						continue;
					} else {
						throw lastError; // Re-throw the last error after max retries
					}
				}
			}

			if (!executablePlan) {
				throw (
					lastError ||
					new Error(
						"Failed to generate and parse a valid structured plan after multiple retries."
					)
				);
			}

			// If we reached here, executablePlan is valid. Proceed with execution.
			this.provider.pendingPlanGenerationContext = null;
			await this.planExecutorService.executePlan(
				executablePlan,
				planContext,
				token
			);
		} catch (error: any) {
			const isCancellation = error.message === ERROR_OPERATION_CANCELLED;

			// Notify webview that structured plan generation has ended
			this.provider.postMessageToWebview({
				type: "updateLoadingState",
				value: false,
			});

			if (isCancellation) {
				this.provider.postMessageToWebview({
					type: "statusUpdate",
					value: "Structured plan generation cancelled.",
				});
				await this.provider.endUserOperation("cancelled"); // Signal cancellation and re-enable input
			} else {
				this.provider.postMessageToWebview({
					type: "statusUpdate",
					value: formatUserFacingErrorMessage(
						error,
						"An unexpected error occurred during plan generation.",
						"Error generating plan: ",
						planContext.workspaceRootUri
					),
					isError: true,
				});
				await this.provider.endUserOperation("failed"); // Signal failure and re-enable input
			}
		} finally {
			await this.provider.setPlanExecutionActive(false);
		}
	}

	private _handlePostTextualPlanGenerationUI(
		planContext: sidebarTypes.PlanGenerationContext
	): Promise<void> {
		if (this.provider.isSidebarVisible) {
			const planDataForRestore =
				planContext.type === "chat"
					? {
							type: planContext.type,
							originalRequest: planContext.originalUserRequest,
							relevantFiles: planContext.relevantFiles,
							textualPlanExplanation: planContext.textualPlanExplanation,
					  }
					: {
							type: planContext.type,
							originalInstruction: planContext.editorContext!.instruction,
							relevantFiles: planContext.relevantFiles,
							textualPlanExplanation: planContext.textualPlanExplanation,
					  };

			this.provider.postMessageToWebview({
				type: "restorePendingPlanConfirmation",
				value: planDataForRestore,
			});
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: "Textual plan generated. Review and confirm to proceed.",
			});
		} else {
			// Automatically open the sidebar when a plan is completed
			void vscode.commands.executeCommand("minovative-mind.activitybar.focus");
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: "Plan generated and sidebar opened for review.",
			});
		}
		return Promise.resolve();
	}

	private _formatRecentChangesForPrompt(changes: FileChangeEntry[]): string {
		if (!changes || changes.length === 0) {
			return "";
		}
		let formattedString =
			"--- Recent Project Changes (During Current Workflow) ---\n";
		formattedString += changes
			.map(
				(c) =>
					`--- File ${c.changeType.toUpperCase()}: ${
						c.filePath
					} ---\nSummary: ${c.summary}\nDiff:\n\`\`\`diff\n${
						c.diffContent
					}\n\`\`\`\n`
			)
			.join("\n");
		return formattedString + "--- End Recent Project Changes ---\n";
	}
}
