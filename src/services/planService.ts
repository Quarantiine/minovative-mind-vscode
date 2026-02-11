import * as vscode from "vscode";
import * as path from "path";
import { FunctionCall, FunctionCallingMode } from "@google/generative-ai";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as sidebarTypes from "../sidebar/common/sidebarTypes";
import { ExtensionToWebviewMessages } from "../sidebar/common/sidebarTypes";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import {
	ExecutionPlan,
	parseAndValidatePlan,
	ParsedPlanResult,
} from "../ai/workflowPlanner";
import { FileChangeEntry } from "../types/workflow";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { UrlContextService } from "./urlContextService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import {
	createInitialPlanningExplanationPrompt,
	createPlanningPromptForFunctionCall,
	createCorrectionPlanningPrompt,
	createCorrectionExecutionPrompt,
} from "../ai/prompts/planningPrompts";
import { repairJsonEscapeSequences } from "../utils/jsonUtils";
import { PlanExecutorService } from "./planExecutorService";
import { generateExecutionPlanTool } from "../ai/prompts/planFunctions";
import { ActiveSymbolDetailedInfo } from "./contextService";
import {
	DiagnosticService,
	FormatDiagnosticsOptions,
} from "../utils/diagnosticUtils";

export class PlanService {
	private readonly MAX_PLAN_PARSE_RETRIES: number;
	private readonly MAX_TRANSIENT_STEP_RETRIES: number;
	private urlContextService: UrlContextService;
	private enhancedCodeGenerator: EnhancedCodeGenerator;
	private planExecutorService: PlanExecutorService;
	private isGeneratingPlan = false;

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri | undefined,
		enhancedCodeGenerator: EnhancedCodeGenerator,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
	) {
		this.urlContextService = new UrlContextService();
		this.enhancedCodeGenerator = enhancedCodeGenerator;

		const config = vscode.workspace.getConfiguration(
			"minovativeMind.planExecution",
		);
		this.MAX_PLAN_PARSE_RETRIES = config.get("maxPlanParseRetries", 3);
		this.MAX_TRANSIENT_STEP_RETRIES = config.get("maxTransientStepRetries", 3);

		this.planExecutorService = new PlanExecutorService(
			provider,
			this.workspaceRootUri!,
			postMessageToWebview,
			this.urlContextService,
			enhancedCodeGenerator,
			this.MAX_TRANSIENT_STEP_RETRIES,
		);
	}

	private _extractUrisFromChangeSets(changes: FileChangeEntry[]): vscode.Uri[] {
		if (!this.workspaceRootUri) {
			return [];
		}
		return changes.map((c) =>
			vscode.Uri.joinPath(this.workspaceRootUri!, c.filePath),
		);
	}

	private _delay(ms: number, token: vscode.CancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return Promise.reject(new Error(ERROR_OPERATION_CANCELLED));
		}
		return new Promise<void>((resolve, reject) => {
			let disposable: vscode.Disposable | undefined;
			const timeout = setTimeout(() => {
				if (disposable) {
					disposable.dispose();
				}
				resolve();
			}, ms);

			disposable = token.onCancellationRequested(() => {
				clearTimeout(timeout);
				if (disposable) {
					disposable.dispose();
				}
				reject(new Error(ERROR_OPERATION_CANCELLED));
			});
		});
	}

	public async triggerPostTextualPlanUI(
		planContext: sidebarTypes.PlanGenerationContext,
	): Promise<void> {
		return this._handlePostTextualPlanGenerationUI(planContext);
	}

	public async handleInitialPlanRequest(userRequest: string): Promise<void> {
		const result = await this._executePlanExplanationWorkflow({
			type: "chat",
			userRequest,
		});

		if (
			result.success &&
			result.context &&
			this.provider.settingsManager.getOptimizationSettings()
				.skipPlanConfirmation
		) {
			await this.provider.startUserOperation("planExecution");
			this.provider.pendingPlanGenerationContext = null;
			await this.generateStructuredPlanAndExecute(result.context);
		}
	}

	public async triggerSelfCorrectionWorkflow(): Promise<void> {
		const token = this.provider.activeOperationCancellationTokenSource?.token;
		if (!token) {
			return;
		}

		let recentChanges = this.provider.changeLogger.getChangeLog();
		if (recentChanges.length === 0) {
			const lastPlanChanges =
				this.provider.changeLogger.getLastCompletedPlanChanges();
			if (lastPlanChanges && lastPlanChanges.length > 0) {
				recentChanges = lastPlanChanges;
				console.log(
					"[PlanService] Active change log empty. Using changes from last completed plan for self-correction.",
				);
			}
		}

		const changedUris = this._extractUrisFromChangeSets(recentChanges);
		const formattedRecentChanges =
			this._formatRecentChangesForPrompt(recentChanges);

		const modelName = this.provider.settingsManager.getSelectedModelName();
		const apiKey = this.provider.apiKeyManager.getActiveApiKey();

		await this.provider.startUserOperation("self-correction");

		vscode.window.showInformationMessage(
			"Initiating automatic self-correction cycle based on recent changes.",
			{ modal: false },
		);

		const operationId =
			this.provider.currentActiveChatOperationId ?? "unknown-operation";

		// IMPORTANT: Fetch the NEW token after starting the operation.
		// The 'token' variable defined at the start of the method refers to the OLD operation's token,
		// which was just cancelled in SidebarProvider to allow this new operation to start.
		// Using the old token would cause immediate cancellation validation failure.
		const freshToken =
			this.provider.activeOperationCancellationTokenSource?.token;

		if (!freshToken) {
			return;
		}

		try {
			// 1. Combine changed URIs with URIs from the last plan's targets.
			// This ensures we catch files that were supposed to be modified but weren't,
			// AND files that were modified but didn't have errors before.
			const allRelevantUrisSet = new Set<string>();
			changedUris.forEach((u) => allRelevantUrisSet.add(u.toString()));
			this.provider.lastPlanTargetUris.forEach((u) =>
				allRelevantUrisSet.add(u.toString()),
			);
			const finalUrisToCheck = Array.from(allRelevantUrisSet).map((s) =>
				vscode.Uri.parse(s),
			);

			// Diagnostic stabilization: Wait for diagnostics for each relevant file
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: "Waiting for diagnostics to stabilize...",
			});
			for (const uri of finalUrisToCheck) {
				if (freshToken.isCancellationRequested) break;
				await DiagnosticService.waitForDiagnosticsToStabilize(uri, freshToken);
			}

			let diagnosticsString = "";
			const errorFiles: string[] = [];
			const warningFiles: string[] = [];
			const cleanFiles: string[] = [];

			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (workspaceFolders && workspaceFolders.length > 0) {
				const rootUri = workspaceFolders[0].uri;
				const optimizationSettings =
					this.provider.settingsManager.getOptimizationSettings();

				for (const uri of finalUrisToCheck) {
					const relativePath = path.relative(rootUri.fsPath, uri.fsPath);
					const diagnostics = DiagnosticService.getDiagnosticsForUri(uri);
					const hasErrors = diagnostics.some(
						(d) => d.severity === vscode.DiagnosticSeverity.Error,
					);
					const hasWarnings = diagnostics.some(
						(d) => d.severity === vscode.DiagnosticSeverity.Warning,
					);

					if (hasErrors) {
						errorFiles.push(relativePath);
					} else if (hasWarnings) {
						warningFiles.push(relativePath);
					} else {
						cleanFiles.push(relativePath);
					}

					try {
						const fileContentBytes = await vscode.workspace.fs.readFile(uri);
						const fileContent = Buffer.from(fileContentBytes).toString("utf8");

						const options: FormatDiagnosticsOptions = {
							fileContent,
							enableEnhancedDiagnosticContext:
								optimizationSettings.enableEnhancedDiagnosticContext,
							includeSeverities: [
								vscode.DiagnosticSeverity.Error,
								vscode.DiagnosticSeverity.Warning,
							],
							requestType: "full",
							token: freshToken,
						};

						const formatted =
							await DiagnosticService.formatContextualDiagnostics(
								uri,
								rootUri,
								options,
							);

						if (formatted) {
							const status = hasErrors ? "HAS ERRORS" : "HAS WARNINGS";
							diagnosticsString += `\n--- [${status}] ${relativePath} ---\n${formatted}\n`;
						}
					} catch (readError) {
						console.warn(
							`[PlanService] Failed to read file for diagnostics at ${uri.fsPath}:`,
							readError,
						);
					}
				}

				// Build a summary section to explicitly tell the AI which files are clean
				let summarySection = "\n--- Self-Correction Diagnostic Summary ---\n";
				summarySection +=
					"CRITICAL: Prioritize fixing files in the 'FILES WITH ERRORS' list below.\n";
				if (errorFiles.length > 0) {
					summarySection += `FILES WITH ERRORS: ${errorFiles.join(", ")}\n`;
				}
				if (warningFiles.length > 0) {
					summarySection += `FILES WITH WARNINGS: ${warningFiles.join(", ")}\n`;
				}
				if (cleanFiles.length > 0) {
					summarySection += `CLEAN FILES (Verify but no changes expected unless necessary): ${cleanFiles.join(
						", ",
					)}\n`;
				}
				summarySection += "--- End Summary ---\n";
				if (cleanFiles.length > 0) {
					summarySection += `CLEAN FILES (No Errors/Warnings): ${cleanFiles.join(", ")}\n`;
				}
				summarySection += "--- End Summary ---\n";

				diagnosticsString = summarySection + diagnosticsString;
			}

			const { contextString, relevantFiles, activeSymbolDetailedInfo } =
				await this._prepareContextAndStreaming(
					freshToken,
					modelName,
					operationId as string,
					"Applying self-correction based on recent changes.",
					undefined,
					diagnosticsString || undefined,
					{
						changedUris: finalUrisToCheck,
						operationId,
						correctionMode: true,
					},
				);

			const correctionPrompt = createCorrectionPlanningPrompt(
				contextString,
				undefined,
				[...this.provider.chatHistoryManager.getChatHistory()],
				formattedRecentChanges,
			);

			let accumulatedText = "";
			const textualResponse =
				await this.provider.aiRequestService.generateWithRetry(
					[{ text: correctionPrompt }],
					modelName,
					undefined,
					"self-correction strategy",
					undefined,
					{
						onChunk: (chunk: string) => {
							accumulatedText += chunk;
							if (this.provider.currentAiStreamingState) {
								this.provider.updatePersistedAiStreamingState({
									...this.provider.currentAiStreamingState,
									content:
										this.provider.currentAiStreamingState.content + chunk,
								});
							}
							this.provider.postMessageToWebview({
								type: "aiResponseChunk",
								value: chunk,
								operationId: operationId as string,
							});
						},
					},
					freshToken,
				);

			if (freshToken.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			const planContext: sidebarTypes.PlanGenerationContext = {
				type: "chat",
				projectContext: contextString,
				relevantFiles,
				activeSymbolDetailedInfo,
				diagnosticsString: diagnosticsString || undefined,
				initialApiKey: apiKey || "",
				modelName,
				chatHistory: [...this.provider.chatHistoryManager.getChatHistory()],
				textualPlanExplanation: textualResponse,
				workspaceRootUri: this.workspaceRootUri!,
				originalUserRequest: "Self Correction",
				isCorrectionMode: true,
			};

			this.provider.pendingPlanGenerationContext = planContext;
			await this.generateStructuredPlanFromCorrectionAndExecute(
				planContext,
				"Apply self-correction.",
			);
		} catch (error: any) {
			const isCancellation = error.message === ERROR_OPERATION_CANCELLED;
			console.error(
				`[PlanService] Self-correction failed: ${error.message}`,
				error,
			);
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: formatUserFacingErrorMessage(
					error,
					"Self-correction workflow failed.",
					"Error: ",
					this.workspaceRootUri,
				),
				isError: true,
			});
			await this.provider.endUserOperation(
				isCancellation ? "cancelled" : "failed",
			);
		} finally {
			if (this.provider.currentAiStreamingState) {
				await this.provider.updatePersistedAiStreamingState({
					...this.provider.currentAiStreamingState,
					isComplete: true,
				});
			}
			this.provider.clearActiveOperationState();
		}
	}

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
		isMergeOperation: boolean = false,
	): Promise<sidebarTypes.PlanGenerationResult> {
		const rootFolder = vscode.workspace.workspaceFolders?.[0];
		if (!rootFolder) {
			initialProgress?.report({
				message: "Error: No workspace folder open.",
				increment: 100,
			});
			return {
				success: false,
				error: "Action blocked: No VS Code workspace folder is currently open.",
			};
		}

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

		return this._executePlanExplanationWorkflow({
			type: "editor",
			editorContext: editorCtx,
			diagnosticsString,
			initialProgress,
			initialToken,
			isMergeOperation,
		});
	}

	private async _executePlanExplanationWorkflow(config: {
		type: "chat" | "editor";
		userRequest?: string;
		editorContext?: sidebarTypes.EditorContext;
		diagnosticsString?: string;
		initialProgress?: vscode.Progress<{ message?: string; increment?: number }>;
		initialToken?: vscode.CancellationToken;
		isMergeOperation?: boolean;
	}): Promise<sidebarTypes.PlanGenerationResult> {
		const { apiKeyManager, changeLogger } = this.provider;
		const modelName = this.provider.settingsManager.getSelectedModelName();
		const apiKey = apiKeyManager.getActiveApiKey();

		await this.provider.startUserOperation("plan");
		const operationId =
			this.provider.currentActiveChatOperationId ?? "unknown-operation";

		if (!this.provider.activeOperationCancellationTokenSource) {
			const error = "Internal error: Failed to initialize cancellation token.";
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error,
				operationId: operationId as string,
			});
			await this.provider.endUserOperation("failed");
			return { success: false, error };
		}

		const token = this.provider.activeOperationCancellationTokenSource.token;
		const rootFolder = vscode.workspace.workspaceFolders?.[0];
		const disposable = config.initialToken?.onCancellationRequested(() => {
			this.provider.activeOperationCancellationTokenSource?.cancel();
		});

		let success = false;
		let finalError: string | null = null;
		let textualPlanResponse: string | null = null;

		try {
			if (!apiKey) {
				const errorMsg =
					"Action blocked: No active API key found. Please add or select an API key in the sidebar settings.";
				this.provider.postMessageToWebview({
					type: "statusUpdate",
					value: errorMsg,
					isError: true,
				});
				throw new Error(errorMsg);
			}

			if (!rootFolder) {
				const errorMsg =
					"Action blocked: No VS Code workspace folder is currently open. Please open a project folder to proceed.";
				throw new Error(errorMsg);
			}

			changeLogger.clear();
			this.provider.pendingPlanGenerationContext = null;

			const { contextString, relevantFiles, activeSymbolDetailedInfo } =
				await this._prepareContextAndStreaming(
					token,
					modelName,
					operationId as string,
					config.type === "chat"
						? config.userRequest!
						: config.editorContext!.instruction,
					config.editorContext,
					config.diagnosticsString,
					undefined,
				);

			if (contextString.startsWith("[Error")) {
				throw new Error(contextString);
			}

			let urlContextString = "";
			if (config.type === "chat" && config.userRequest) {
				const urlContexts =
					await this.urlContextService.processMessageForUrlContext(
						config.userRequest,
						operationId as string,
					);
				urlContextString =
					this.urlContextService.formatUrlContexts(urlContexts);
			}

			const textualPlanPrompt = createInitialPlanningExplanationPrompt(
				contextString,
				config.userRequest,
				config.editorContext,
				config.diagnosticsString,
				[...this.provider.chatHistoryManager.getChatHistory()],
				urlContextString,
			);

			config.initialProgress?.report({
				message: "Generating textual plan explanation...",
				increment: 20,
			});

			let accumulatedTextualResponse = "";
			textualPlanResponse =
				await this.provider.aiRequestService.generateWithRetry(
					[{ text: textualPlanPrompt }],
					modelName,
					undefined,
					config.type === "chat"
						? "initial plan explanation"
						: "editor action plan explanation",
					undefined,
					{
						onChunk: (chunk: string) => {
							accumulatedTextualResponse += chunk;
							if (this.provider.currentAiStreamingState) {
								this.provider.updatePersistedAiStreamingState({
									...this.provider.currentAiStreamingState,
									content:
										this.provider.currentAiStreamingState.content + chunk,
								});
							}
							this.provider.postMessageToWebview({
								type: "aiResponseChunk",
								value: chunk,
								operationId: operationId as string,
							});
						},
					},
					token,
				);

			if (token.isCancellationRequested) {
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
				true,
			);

			config.initialProgress?.report({
				message: "Textual plan generated.",
				increment: 100,
			});

			const planContext: sidebarTypes.PlanGenerationContext = {
				type: config.type,
				originalUserRequest: config.userRequest,
				editorContext: config.editorContext,
				projectContext: contextString,
				relevantFiles,
				activeSymbolDetailedInfo: activeSymbolDetailedInfo,
				diagnosticsString: config.diagnosticsString,
				initialApiKey: apiKey,
				modelName,
				chatHistory: [...this.provider.chatHistoryManager.getChatHistory()],
				textualPlanExplanation: textualPlanResponse,
				workspaceRootUri: rootFolder.uri,
				isMergeOperation: config.isMergeOperation,
			};

			this.provider.pendingPlanGenerationContext = planContext;
			this.provider.lastPlanGenerationContext = { ...planContext };

			const dataToPersist: sidebarTypes.PersistedPlanData = {
				type: config.type,
				originalUserRequest: config.userRequest,
				originalInstruction: config.editorContext?.instruction,
				relevantFiles: relevantFiles,
				textualPlanExplanation: textualPlanResponse,
			};
			await this.provider.updatePersistedPendingPlanData(dataToPersist);

			success = true;
			return {
				success: true,
				textualPlanExplanation: textualPlanResponse,
				context: planContext,
			};
		} catch (error: any) {
			if (this.provider.currentAiStreamingState) {
				await this.provider.updatePersistedAiStreamingState({
					...this.provider.currentAiStreamingState,
					isError: true,
				});
			}
			finalError = error.message;
			return {
				success: false,
				error:
					finalError === ERROR_OPERATION_CANCELLED
						? "Plan generation cancelled."
						: formatUserFacingErrorMessage(
								error,
								`An unexpected error occurred during ${
									config.type === "chat" ? "initial" : "editor action"
								} plan generation.`,
								"Error: ",
								rootFolder?.uri,
							),
			};
		} finally {
			if (this.provider.currentAiStreamingState) {
				await this.provider.updatePersistedAiStreamingState({
					...this.provider.currentAiStreamingState,
					isComplete: true,
				});
			}

			const isCancellation = finalError === ERROR_OPERATION_CANCELLED;
			const isConfirmablePlanResponse =
				success &&
				!!this.provider.pendingPlanGenerationContext?.textualPlanExplanation;

			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: success,
				operationId: operationId as string,
				error: success
					? null
					: isCancellation
						? "Plan generation cancelled."
						: formatUserFacingErrorMessage(
								finalError
									? new Error(finalError)
									: new Error("Unknown error."),
								`An unexpected error occurred during ${
									config.type === "chat" ? "initial" : "editor action"
								} plan generation.`,
								"Error: ",
								rootFolder?.uri,
							),
				...(isConfirmablePlanResponse &&
					this.provider.pendingPlanGenerationContext && {
						isPlanResponse: true,
						requiresConfirmation:
							!this.provider.settingsManager.getOptimizationSettings()
								.skipPlanConfirmation,
						planData: {
							type: "textualPlanPending",
							originalRequest:
								this.provider.pendingPlanGenerationContext.originalUserRequest,
							originalInstruction:
								this.provider.pendingPlanGenerationContext.editorContext
									?.instruction,
							relevantFiles:
								this.provider.pendingPlanGenerationContext.relevantFiles,
							textualPlanExplanation:
								this.provider.pendingPlanGenerationContext
									.textualPlanExplanation,
						},
					}),
			});

			disposable?.dispose();
			this.provider.chatHistoryManager.restoreChatHistoryToWebview();
			this.provider.clearActiveOperationState();
		}
	}

	private async parseAndValidatePlanWithFix(
		jsonString: string,
		workspaceRootUri: vscode.Uri,
	): Promise<ParsedPlanResult> {
		try {
			let parsedResult = await parseAndValidatePlan(
				jsonString,
				workspaceRootUri,
			);

			if (!parsedResult.plan && parsedResult.error) {
				const repairedJsonString = repairJsonEscapeSequences(jsonString);

				if (repairedJsonString !== jsonString) {
					const reParsedResult = await parseAndValidatePlan(
						repairedJsonString,
						workspaceRootUri,
					);

					if (reParsedResult.plan) {
						return reParsedResult;
					} else {
						return {
							plan: null,
							error: `JSON parsing failed: Original error: "${parsedResult.error}". Repair attempt also failed with: "${reParsedResult.error}".`,
						};
					}
				} else {
					return parsedResult;
				}
			} else {
				return parsedResult;
			}
		} catch (e: any) {
			return {
				plan: null,
				error: `An unexpected error occurred during JSON parsing/validation: ${e.message}`,
			};
		}
	}

	private async _initializeStreamingState(
		modelName: string,
		relevantFiles: string[] | undefined,
		operationId: string,
	): Promise<void> {
		// Filter and deduplicate relevantFiles, and check for existence
		let filteredFiles: string[] = [];
		if (relevantFiles && relevantFiles.length > 0) {
			const uniqueFiles = [...new Set(relevantFiles)];
			const existenceResults = await Promise.all(
				uniqueFiles.map(async (filePath) => {
					try {
						if (!this.workspaceRootUri) {
							return filePath;
						}
						const uri = vscode.Uri.joinPath(this.workspaceRootUri, filePath);
						await vscode.workspace.fs.stat(uri);
						return filePath;
					} catch {
						return null;
					}
				}),
			);
			filteredFiles = existenceResults.filter(
				(f): f is string => f !== null && f.trim() !== "",
			);
		}

		this.provider.updatePersistedAiStreamingState({
			content: "",
			relevantFiles: filteredFiles,
			isComplete: false,
			isError: false,
			operationId: operationId,
		});
		this.provider.postMessageToWebview({
			type: "aiResponseStart",
			value: {
				modelName,
				relevantFiles: filteredFiles,
				operationId: operationId,
			},
		});
		this.provider.postMessageToWebview({
			type: "updateStreamingRelevantFiles",
			value: filteredFiles,
		});
	}

	public async generateStructuredPlanFromCorrectionAndExecute(
		planContext: sidebarTypes.PlanGenerationContext,
		summaryOfLastChanges: string,
	): Promise<void> {
		if (this.isGeneratingPlan) {
			console.warn(
				"[PlanService] generateStructuredPlanFromCorrectionAndExecute called while another generation is in progress. Skipping.",
			);
			return;
		}

		console.log(
			"[PlanService] Starting generateStructuredPlanFromCorrectionAndExecute...",
		);

		const token = this.provider.activeOperationCancellationTokenSource?.token;
		if (!token) {
			console.error(
				"[PlanService] No active operation token found for structured correction.",
			);
			await this.provider.endUserOperation("failed");
			return;
		}

		try {
			this.isGeneratingPlan = true;
			await this.provider.setPlanExecutionActive(true);

			this.provider.postMessageToWebview({
				type: "updateLoadingState",
				value: true,
			});

			const operationId = this.provider.currentActiveChatOperationId;

			const urlContexts =
				await this.urlContextService.processMessageForUrlContext(
					planContext.originalUserRequest || "",
					operationId as string,
				);
			const urlContextString =
				this.urlContextService.formatUrlContexts(urlContexts);

			const prompt = createCorrectionExecutionPrompt(
				planContext.projectContext,
				planContext.editorContext,
				planContext.chatHistory || [],
				planContext.textualPlanExplanation,
				summaryOfLastChanges,
				urlContextString,
			);

			await this._generateAndExecutePlan(
				planContext,
				token,
				prompt,
				operationId as string,
				"structured correction plan",
				true,
			);
		} catch (error: any) {
			this._handlePlanGenerationError(
				error,
				planContext,
				"correction plan generation",
			);
		}
	}

	public async generateStructuredPlanAndExecute(
		planContext: sidebarTypes.PlanGenerationContext,
	): Promise<void> {
		if (this.isGeneratingPlan) {
			console.warn(
				"[PlanService] generateStructuredPlanAndExecute called while another generation is in progress. Skipping.",
			);
			return;
		}

		console.log("[PlanService] Starting generateStructuredPlanAndExecute...");

		const token = this.provider.activeOperationCancellationTokenSource?.token;
		if (!token) {
			console.error(
				"[PlanService] No active operation token found for structured plan generation.",
			);
			await this.provider.endUserOperation("failed");
			return;
		}

		try {
			this.isGeneratingPlan = true;
			await this.provider.setPlanExecutionActive(true);

			this.provider.postMessageToWebview({
				type: "updateLoadingState",
				value: true,
			});

			await this.provider.updatePersistedPendingPlanData(null);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			const recentChanges = this.provider.changeLogger.getChangeLog();
			const formattedRecentChanges =
				this._formatRecentChangesForPrompt(recentChanges);

			const operationId = this.provider.currentActiveChatOperationId;

			const urlContexts =
				await this.urlContextService.processMessageForUrlContext(
					planContext.originalUserRequest || "",
					operationId as string,
				);
			const urlContextString =
				this.urlContextService.formatUrlContexts(urlContexts);

			const promptForAIForFunctionCall = createPlanningPromptForFunctionCall(
				planContext.type === "chat"
					? planContext.originalUserRequest
					: undefined,
				planContext.projectContext,
				planContext.type === "editor" ? planContext.editorContext : undefined,
				planContext.chatHistory,
				planContext.textualPlanExplanation,
				formattedRecentChanges,
				urlContextString,
			);

			await this._generateAndExecutePlan(
				planContext,
				token,
				promptForAIForFunctionCall,
				operationId as string,
				"structured plan",
				false,
			);
		} catch (error: any) {
			this._handlePlanGenerationError(error, planContext, "plan generation");
		}
	}

	private async _generateAndExecutePlan(
		planContext: sidebarTypes.PlanGenerationContext,
		token: vscode.CancellationToken,
		initialPrompt: string,
		operationId: string,
		description: string,
		isCorrection: boolean = false,
	): Promise<void> {
		let executablePlan: ExecutionPlan | null = null;
		let lastError: Error | null = null;
		let currentPrompt = initialPrompt;

		for (let attempt = 1; attempt <= this.MAX_PLAN_PARSE_RETRIES; attempt++) {
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: `Translating strategy (Attempt ${attempt}/${this.MAX_PLAN_PARSE_RETRIES})...`,
				isError: false,
			});

			try {
				this.postMessageToWebview({
					type: "updateJsonLoadingState",
					value: true,
				});
				const { functionCall } =
					await this.provider.aiRequestService.generateFunctionCall(
						planContext.initialApiKey,
						planContext.modelName,
						[{ role: "user", parts: [{ text: currentPrompt }] }],
						[{ functionDeclarations: [generateExecutionPlanTool] }],
						FunctionCallingMode.ANY,
						token,
						description,
					);

				if (token.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}
				if (!functionCall) {
					throw new Error(
						"AI failed to generate a valid function call for the plan.",
					);
				}

				const jsonString = JSON.stringify(functionCall.args);
				const { plan, error } = await this.parseAndValidatePlanWithFix(
					jsonString,
					planContext.workspaceRootUri,
				);

				this.postMessageToWebview({
					type: "updateJsonLoadingState",
					value: false,
				});

				if (error) {
					const jsonSnippet =
						jsonString.length > 500
							? jsonString.substring(0, 500) + "..."
							: jsonString;
					lastError = new Error(
						`Failed to parse or validate generated plan: ${error}. JSON Snippet: ${jsonSnippet}`,
					);
					console.error(
						`[PlanService] Parse/Validation error on attempt ${attempt}:`,
						lastError.message,
					);
					if (attempt < this.MAX_PLAN_PARSE_RETRIES) {
						currentPrompt += `\n\nERROR FROM PREVIOUS ATTEMPT: ${error}\nJSON SNIPPET THAT FAILED VALIDATION: ${jsonSnippet}\nPLEASE FIX THE ISSUES ABOVE AND TRY AGAIN. Ensure you call the 'generateExecutionPlan' function correctly with valid arguments according to the instructions.`;
						continue;
					} else {
						throw lastError;
					}
				}

				if (!plan || plan.steps.length === 0) {
					lastError = new Error(
						"AI generated plan content but it was empty or invalid after parsing.",
					);
					if (attempt < this.MAX_PLAN_PARSE_RETRIES) {
						continue;
					} else {
						throw lastError;
					}
				}

				executablePlan = plan;
				break;
			} catch (error: any) {
				this.postMessageToWebview({
					type: "updateJsonLoadingState",
					value: false,
				});
				if (error.message === ERROR_OPERATION_CANCELLED) {
					throw error;
				}
				lastError = error;
				if (attempt < this.MAX_PLAN_PARSE_RETRIES) {
					await this._delay(15000 + attempt * 2000, token);
					continue;
				} else {
					throw lastError;
				}
			}
		}

		if (!executablePlan) {
			console.error(
				`[PlanService] Failed to generate structured plan after ${this.MAX_PLAN_PARSE_RETRIES} attempts.`,
			);
			throw (
				lastError ||
				new Error(
					"Failed to generate and parse a valid structured plan after multiple retries.",
				)
			);
		}

		console.log(
			`[PlanService] Structured plan generated successfully (${description}). Executing...`,
		);

		if (!isCorrection) {
			this.provider.pendingPlanGenerationContext = null;
		}

		this.isGeneratingPlan = false;
		await this.planExecutorService.executePlan(
			executablePlan,
			planContext,
			token,
		);
	}

	private async _handlePlanGenerationError(
		error: any,
		planContext: sidebarTypes.PlanGenerationContext,
		contextDescription: string,
	): Promise<void> {
		const isCancellation = error.message === ERROR_OPERATION_CANCELLED;

		this.provider.postMessageToWebview({
			type: "updateLoadingState",
			value: false,
		});

		if (isCancellation) {
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: "Plan generation cancelled.",
			});
			await this.provider.endUserOperation("cancelled");
		} else {
			this.provider.postMessageToWebview({
				type: "statusUpdate",
				value: formatUserFacingErrorMessage(
					error,
					`An unexpected error occurred during ${contextDescription}.`,
					"Error: ",
					planContext.workspaceRootUri,
				),
				isError: true,
			});
			await this.provider.endUserOperation("failed");
		}

		this.isGeneratingPlan = false;
		await this.provider.setPlanExecutionActive(false);
		console.log(`[PlanService] Finished ${contextDescription}.`);
	}

	private _handlePostTextualPlanGenerationUI(
		planContext: sidebarTypes.PlanGenerationContext,
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
					}\n\`\`\`\n`,
			)
			.join("\n");
		return formattedString + "--- End Recent Project Changes ---\n";
	}

	/**
	 * Combined helper to build project context and initialize streaming state.
	 */
	private async _prepareContextAndStreaming(
		token: vscode.CancellationToken,
		modelName: string,
		operationId: string,
		instruction: string,
		editorContext?: sidebarTypes.EditorContext,
		diagnosticsString?: string,
		options?: any,
	): Promise<{
		contextString: string;
		relevantFiles: string[];
		activeSymbolDetailedInfo?: ActiveSymbolDetailedInfo;
	}> {
		const buildContextResult =
			await this.provider.contextService.buildProjectContext(
				token,
				instruction,
				editorContext,
				diagnosticsString,
				options,
				false,
				false,
			);

		await this._initializeStreamingState(
			modelName,
			buildContextResult.relevantFiles,
			operationId,
		);

		return {
			contextString: buildContextResult.contextString,
			relevantFiles: buildContextResult.relevantFiles,
			activeSymbolDetailedInfo: buildContextResult.activeSymbolDetailedInfo,
		};
	}
}
