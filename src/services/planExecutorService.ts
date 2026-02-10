import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as sidebarTypes from "../sidebar/common/sidebarTypes";
import { ExtensionToWebviewMessages } from "../sidebar/common/sidebarTypes";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import {
	ExecutionPlan,
	PlanStep,
	PlanStepAction, // Keep this for workflowPlanner types
	isCreateDirectoryStep,
	isCreateFileStep,
	isModifyFileStep,
	isRunCommandStep,
	CreateDirectoryStep,
	CreateFileStep,
	ModifyFileStep,
	RunCommandStep,
} from "../ai/workflowPlanner";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { UrlContextService } from "./urlContextService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import * as sidebarConstants from "../sidebar/common/sidebarConstants";
import { DiagnosticService } from "../utils/diagnosticUtils";
import { FileSelection } from "../context/smartContextSelector";
import { getSymbolsInDocument } from "./symbolService";
import {
	PlanExecutionService,
	PlanStep as ServicePlanStep,
	PlanStepAction as ServicePlanStepAction,
} from "../sidebar/services/planExecutionService";
import { thinkingTool, suggestFixTool } from "../ai/tools/thinkingTool";

export class PlanExecutorService {
	private commandExecutionTerminals: vscode.Terminal[] = [];
	private contextCache = new Map<string, string>();

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
		private urlContextService: UrlContextService,
		private enhancedCodeGenerator: EnhancedCodeGenerator,
		private planExecutionService: PlanExecutionService, // Injected dependency
		private readonly MAX_TRANSIENT_STEP_RETRIES: number,
	) {}

	/**
	 * Delays execution for a specified number of milliseconds, supporting cancellation.
	 */
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

	/**
	 * Helper to race a UI promise (like showInformationMessage) against the cancellation token.
	 * If cancelled, it resolves to undefined immediately, effectively simulating a dismissal.
	 */
	private _raceWithCancellation<T>(
		promise: Thenable<T | undefined>,
		token: vscode.CancellationToken,
	): Promise<T | undefined> {
		if (token.isCancellationRequested) {
			return Promise.resolve(undefined);
		}

		return new Promise<T | undefined>((resolve, reject) => {
			const disposable = token.onCancellationRequested(() => {
				disposable.dispose();
				resolve(undefined);
			});

			promise.then(
				(result) => {
					disposable.dispose();
					resolve(result);
				},
				(error) => {
					disposable.dispose();
					reject(error);
				},
			);
		});
	}

	public async executePlan(
		plan: ExecutionPlan,
		planContext: sidebarTypes.PlanGenerationContext,
		operationToken: vscode.CancellationToken,
	): Promise<void> {
		this.contextCache.clear();
		this.provider.currentExecutionOutcome = undefined;
		this.provider.activeChildProcesses = [];

		// Capture the operation ID at the start of execution.
		// We use this to ensure we don't accidentally close a NEW operation (like a self-correction)
		// if one started while we were finishing up or erroring out.
		const originalOperationId = this.provider.currentActiveChatOperationId;

		const rootUri = this.workspaceRootUri;

		this.postMessageToWebview({
			type: "updateLoadingState",
			value: true,
		});

		// 2.b. Prepare steps and send PlanTimelineInitializeMessage
		const orderedSteps = this._prepareAndOrderSteps(plan.steps!);

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Minovative Mind: Executing Plan`,
					cancellable: true,
				},
				async (progress, progressNotificationToken) => {
					const combinedTokenSource = new vscode.CancellationTokenSource();
					const combinedToken = combinedTokenSource.token;

					const opListener = operationToken.onCancellationRequested(() =>
						combinedTokenSource.cancel(),
					);
					const progListener =
						progressNotificationToken.onCancellationRequested(() =>
							combinedTokenSource.cancel(),
						);

					try {
						if (combinedToken.isCancellationRequested) {
							this.provider.currentExecutionOutcome = "cancelled";
							return;
						}

						// Sync Plan Steps to SidebarProvider
						this.provider.currentPlanSteps = orderedSteps.map((s, idx) =>
							this._getStepDescription(s, idx, orderedSteps.length, 0),
						);
						this.provider.currentPlanStepIndex = -1;

						const originalRootInstruction =
							planContext.type === "chat"
								? (planContext.originalUserRequest ?? "")
								: planContext.editorContext!.instruction;

						const affectedUris = await this._executePlanSteps(
							orderedSteps, // Pass all steps
							rootUri,
							planContext,
							combinedToken,
							progress,
							originalRootInstruction,
						);

						// Diagnostic Warm-up: Programmatically touch modified files and wait for LS
						if (
							affectedUris.size > 0 &&
							!combinedToken.isCancellationRequested
						) {
							this.postMessageToWebview({
								type: "statusUpdate",
								value: `Finalizing`,
							});
							await this._warmUpDiagnostics(affectedUris, combinedToken);
						}

						if (!combinedToken.isCancellationRequested) {
							this.provider.currentExecutionOutcome = "success";
						} else {
							this.provider.currentExecutionOutcome = "cancelled";
						}
					} catch (innerError: any) {
						if (innerError.message === ERROR_OPERATION_CANCELLED) {
							this.provider.currentExecutionOutcome = "cancelled";
						} else {
							this.provider.currentExecutionOutcome = "failed";
						}
						throw innerError;
					} finally {
						opListener.dispose();
						progListener.dispose();
						combinedTokenSource.dispose();
					}
				},
			);
		} catch (error: any) {
			const isCancellation =
				error.message.includes("Operation cancelled by user.") ||
				error.message === ERROR_OPERATION_CANCELLED;
			this.provider.currentExecutionOutcome = isCancellation
				? "cancelled"
				: "failed";
		} finally {
			this.provider.activeChildProcesses.forEach((cp) => cp.kill());
			this.provider.activeChildProcesses = [];
			this.commandExecutionTerminals = [];

			// Dedicated terminals are not disposed automatically here; they persist.
			// This allows users to review command output after the plan completes.

			await this.provider.setPlanExecutionActive(false);

			let outcome: sidebarTypes.ExecutionOutcome;
			if (this.provider.currentExecutionOutcome === undefined) {
				outcome = "failed";
			} else {
				outcome = this.provider
					.currentExecutionOutcome as sidebarTypes.ExecutionOutcome;
			}

			await this.provider.showPlanCompletionNotification(outcome);

			this.postMessageToWebview({
				type: "updateLoadingState",
				value: false,
			});

			this.postMessageToWebview({
				type: "planExecutionEnded",
			});

			// Clear plan state
			this.provider.currentPlanSteps = [];
			this.provider.currentPlanStepIndex = -1;

			// Check if the current operation ID matches the one we started with.
			// If it has changed (e.g., because self-correction started and set a new ID),
			// we must NOT clobber the state or call endUserOperation, as that would
			// incorrectly reset the UI while the correction is running.
			const isOperationSuperseded =
				this.provider.currentActiveChatOperationId !== originalOperationId;

			if (!isOperationSuperseded) {
				await this.provider.endUserOperation(outcome);
			} else {
				console.log(
					`[PlanExecutorService] Skipping endUserOperation because operation ID changed (Original: ${originalOperationId}, Current: ${this.provider.currentActiveChatOperationId}). Assumption: Self-correction triggered.`,
				);
			}

			let planSummary: string;

			const baseDescription = plan.planDescription || "AI Plan Execution";
			if (outcome === "success") {
				planSummary = baseDescription;
			} else if (outcome === "cancelled") {
				planSummary = `${baseDescription} (Cancelled)`;
			} else {
				planSummary = `${baseDescription} (Failed)`;
			}

			this.provider.changeLogger.saveChangesAsLastCompletedPlan(planSummary);

			await this.provider.updatePersistedCompletedPlanChangeSets(
				this.provider.changeLogger.getCompletedPlanChangeSets(),
			);

			this.postMessageToWebview({
				type: "planExecutionFinished",
				hasRevertibleChanges: this.provider.completedPlanChangeSets.length > 0,
			});

			this.provider.changeLogger.clear();

			this.postMessageToWebview({ type: "resetCodeStreamingArea" });
		}
	}

	private _prepareAndOrderSteps(steps: PlanStep[]): PlanStep[] {
		const createDirectorySteps: CreateDirectoryStep[] = [];
		const createFileSteps: CreateFileStep[] = [];
		const runCommandSteps: RunCommandStep[] = [];
		const modifyFileStepsByPath = new Map<string, ModifyFileStep[]>();
		const modifyFileOrder: string[] = [];

		for (const step of steps) {
			if (
				typeof step !== "object" ||
				step === null ||
				typeof step.step !== "object" ||
				step.step === null
			) {
				console.warn(
					`Minovative Mind: Skipping invalid plan step (missing 'step' property or not an object): ${JSON.stringify(
						step,
					)}`,
				);
				continue;
			}

			if (isCreateDirectoryStep(step)) {
				createDirectorySteps.push(step);
			} else if (isCreateFileStep(step)) {
				createFileSteps.push(step);
			} else if (isRunCommandStep(step)) {
				runCommandSteps.push(step);
			} else if (isModifyFileStep(step)) {
				if (!modifyFileStepsByPath.has(step.step.path)) {
					modifyFileStepsByPath.set(step.step.path, []);
					modifyFileOrder.push(step.step.path);
				}
				modifyFileStepsByPath.get(step.step.path)!.push(step);
			}
		}

		const consolidatedModifyFileSteps: ModifyFileStep[] = [];
		for (const filePath of modifyFileOrder) {
			const fileModifications = modifyFileStepsByPath.get(filePath)!;
			const consolidatedPrompt = fileModifications
				.map((s) => s.step.modification_prompt)
				.join("\n\n---\n\n");

			consolidatedModifyFileSteps.push({
				step: {
					action: PlanStepAction.ModifyFile,
					path: filePath,
					modification_prompt: consolidatedPrompt,
					description: `Modify: ${filePath}`,
				},
			});
		}

		return [
			...createDirectorySteps,
			...createFileSteps,
			...consolidatedModifyFileSteps,
			...runCommandSteps,
		];
	}

	private async _executePlanSteps(
		orderedSteps: PlanStep[],
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		combinedToken: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		originalRootInstruction: string,
	): Promise<Set<vscode.Uri>> {
		const affectedFileUris = new Set<vscode.Uri>();
		const { changeLogger } = this.provider;

		const totalOrderedSteps = orderedSteps.length;

		let relevantSnippets = "";
		const relevantFiles = context.relevantFiles ?? [];
		if (relevantFiles.length > 0) {
			const cacheKey = relevantFiles.sort().join("|");
			if (this.contextCache.has(cacheKey)) {
				relevantSnippets = this.contextCache.get(cacheKey)!;
			} else {
				relevantSnippets = await this._formatRelevantFilesForPrompt(
					relevantFiles,
					rootUri,
					combinedToken,
				);
				this.contextCache.set(cacheKey, relevantSnippets);
			}
		}

		let index = 0;
		while (index < totalOrderedSteps) {
			const step = orderedSteps[index];
			const currentStepNumber = index + 1;
			const totalSteps = totalOrderedSteps;
			let currentStepCompletedSuccessfullyOrSkipped = false;
			let currentTransientAttempt = 0;
			const isCommandStep = isRunCommandStep(step);

			while (!currentStepCompletedSuccessfullyOrSkipped) {
				// Sync current plan step index
				this.provider.currentPlanStepIndex = index;

				if (combinedToken.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}

				const detailedStepDescription = this._getStepDescription(
					step,
					index, // 0-based index
					totalSteps,
					currentTransientAttempt,
				);

				// Replaced conditional progress logging with console.log
				if (isCommandStep) {
					console.log(
						`Minovative Mind (Command Step ${currentStepNumber}/${totalSteps}): Starting ${detailedStepDescription}`,
					);
				} else {
					console.log(
						`Minovative Mind (Execution Step ${currentStepNumber}/${totalSteps}): Starting ${detailedStepDescription}`,
					);
				}

				try {
					/* Delegation to PlanExecutionService */
					// Convert nested WorkflowPlanner PlanStep to flat ServicePlanStep
					const serviceStep = this._mapToServiceStep(step);

					const result = await this.planExecutionService.executePlanStep(
						serviceStep,
						combinedToken,
						progress,
						context.projectContext, // context string
						this.provider.activeChildProcesses, // Pass active processes for tracking
					);

					if (!result.success) {
						if (result.errorType === "cancellation") {
							throw new Error(ERROR_OPERATION_CANCELLED);
						}
						throw new Error(
							result.errorMessage || "Unknown step execution error",
						);
					}

					// Update affected files if successful
					if (serviceStep.file) {
						affectedFileUris.add(
							vscode.Uri.joinPath(rootUri, serviceStep.file),
						);
					}

					currentStepCompletedSuccessfullyOrSkipped = true;
				} catch (error: any) {
					let errorMsg = formatUserFacingErrorMessage(
						error,
						"Failed to execute plan step. Please review the details and try again.",
						"Step execution failed: ",
						rootUri,
					);

					if (errorMsg.includes(ERROR_OPERATION_CANCELLED)) {
						throw error;
					}

					// If it's a command step failure, throw immediately (no retries for commands)
					if (isCommandStep) {
						console.error(
							`Minovative Mind: Command Step ${currentStepNumber} failed, immediately throwing error: ${errorMsg}`,
						);
						throw error;
					}

					// For FS steps (non-command steps), proceed to user intervention/retry
					const shouldRetry = await this._reportStepError(
						error,
						rootUri,
						detailedStepDescription,
						currentTransientAttempt,
						this.MAX_TRANSIENT_STEP_RETRIES,
						combinedToken, // Pass token to race UI
					);

					if (shouldRetry.type === "retry") {
						currentTransientAttempt = shouldRetry.resetTransientCount
							? 0
							: currentTransientAttempt + 1;
						const delayMs = 10000 + currentTransientAttempt * 5000;

						console.warn(
							`Minovative Mind: Step ${currentStepNumber} failed, delaying ${delayMs}ms before retrying.`,
						);

						// Use _delay which handles cancellation during the wait
						await this._delay(delayMs, combinedToken);
					} else if (shouldRetry.type === "skip") {
						currentStepCompletedSuccessfullyOrSkipped = true;
						console.log(
							`Minovative Mind: User chose to skip Step ${currentStepNumber}.`,
						);
					} else {
						throw new Error(ERROR_OPERATION_CANCELLED);
					}
				}
			}

			index++;
		}

		return affectedFileUris;
	}

	private _getStepDescription(
		step: PlanStep,
		index: number,
		totalSteps: number,
		currentTransientAttempt: number,
	): string {
		let detailedStepDescription: string;

		// If a description exists, only use it if it's NOT a filesystem action,
		// otherwise we force fall-through to the switch statement to use path.basename().
		if (
			step.step.description &&
			step.step.description.trim() !== "" &&
			!isModifyFileStep(step) &&
			!isCreateFileStep(step) &&
			!isCreateDirectoryStep(step)
		) {
			detailedStepDescription = step.step.description;
		} else {
			switch (step.step.action) {
				case PlanStepAction.CreateDirectory:
					if (isCreateDirectoryStep(step)) {
						detailedStepDescription = `Creating directory: \`${path.basename(
							step.step.path,
						)}\``;
					} else {
						detailedStepDescription = `Creating directory`;
					}
					break;
				case PlanStepAction.CreateFile:
					if (isCreateFileStep(step)) {
						if (step.step.generate_prompt) {
							detailedStepDescription = `Creating file: \`${path.basename(
								step.step.path,
							)}\``;
						} else if (step.step.content) {
							detailedStepDescription = `Creating file: \`${path.basename(
								step.step.path,
							)}\` (with predefined content)`;
						} else {
							detailedStepDescription = `Creating file: \`${path.basename(
								step.step.path,
							)}\``;
						}
					} else {
						detailedStepDescription = `Creating file`;
					}
					break;
				case PlanStepAction.ModifyFile:
					if (isModifyFileStep(step)) {
						detailedStepDescription = `Modifying file: ${path.basename(
							step.step.path,
						)}`;
					} else {
						detailedStepDescription = `Modifying file`;
					}
					break;
				case PlanStepAction.RunCommand:
					if (isRunCommandStep(step)) {
						detailedStepDescription = `Running command: \`${step.step.command}\``;
					} else {
						detailedStepDescription = `Running command`;
					}
					break;
				default:
					detailedStepDescription = `Executing action: ${(
						(step.step as any).action as string
					).replace(/_/g, " ")}`;
					break;
			}
		}
		const retrySuffix =
			currentTransientAttempt > 0
				? ` (Auto-retry ${currentTransientAttempt}/${this.MAX_TRANSIENT_STEP_RETRIES})`
				: "";
		return `Step ${
			index + 1
		}/${totalSteps}: ${detailedStepDescription}${retrySuffix}`;
	}

	private async _reportStepError(
		error: any,
		rootUri: vscode.Uri,
		stepDescription: string,
		currentTransientAttempt: number,
		maxTransientRetries: number,
		token?: vscode.CancellationToken,
	): Promise<{
		type: "retry" | "skip" | "cancel";
		resetTransientCount?: boolean;
	}> {
		const errorMsg = formatUserFacingErrorMessage(
			error,
			"Failed to execute plan step. Please review the details and try again.",
			"Step execution failed: ",
			rootUri,
		);

		let isRetryableTransientError = false;
		if (
			errorMsg.includes("quota exceeded") ||
			errorMsg.includes("rate limit exceeded") ||
			errorMsg.includes("network issue") ||
			errorMsg.includes("AI service unavailable") ||
			errorMsg.includes("timeout") ||
			errorMsg.includes("parsing failed") ||
			errorMsg.includes("overloaded")
		) {
			isRetryableTransientError = true;
		}

		if (
			isRetryableTransientError &&
			currentTransientAttempt < maxTransientRetries
		) {
			console.warn(
				`Minovative Mind: FAILED (transient, auto-retrying): ${stepDescription}. Attempt ${
					currentTransientAttempt + 1
				}/${maxTransientRetries}. Error: ${errorMsg}`,
			);
			return { type: "retry" };
		} else {
			console.error(
				`Minovative Mind: FAILED: ${stepDescription}. Requires user intervention. Error: ${errorMsg}`,
			);

			// --- AI Error Analysis with Thinking ---
			// --- AI Error Analysis with Thinking ---
			let aiSuggestion = "Analysis not available.";
			try {
				this.postMessageToWebview({
					type: "statusUpdate",
					value: "AI is analyzing the error...",
					showLoadingDots: true,
				});

				const prompt = `The plan step '${stepDescription}' failed with error: "${errorMsg}".
Please analyze this error.
1. Use the 'think' tool to reason about the cause.
2. Then, use the 'suggest_fix' tool to provide a user-facing explanation and a suggested course of action (Retry, Skip, or manual fix).`;

				let currentHistory: any[] = [
					{ role: "user", parts: [{ text: prompt }] },
				];
				let turnCount = 0;
				const MAX_TURNS = 4;
				let suggestionFound = false;

				while (turnCount < MAX_TURNS && !suggestionFound) {
					// We need to use the AIRequestService from the provider
					// Assuming this.provider.aiRequestService is available and public
					const aiService = (this.provider as any).aiRequestService;
					if (!aiService) {
						console.warn("AIRequestService not available on provider.");
						break;
					}

					// Get API Key and Model Name
					const apiKey = aiService.getApiKey();
					const modelName = sidebarConstants.DEFAULT_FLASH_MODEL; // Use a fast model

					if (!apiKey) {
						console.warn("No API key available for error analysis.");
						break;
					}

					const functionCall: any = await aiService.generateFunctionCall(
						apiKey,
						modelName,
						currentHistory,
						[{ functionDeclarations: [thinkingTool, suggestFixTool] }],
						"auto",
						token,
						"error analysis",
					);

					if (token?.isCancellationRequested) break;

					if (functionCall) {
						const args = functionCall.args;
						if (functionCall.name === "think") {
							const thought = args["thought"];
							const thoughtLog = `Thinking (Error Analysis): ${thought}`;
							this.postMessageToWebview({
								type: "statusUpdate",
								value: thoughtLog,
							});
							currentHistory.push({
								role: "model",
								parts: [{ functionCall: functionCall }],
							});
							currentHistory.push({
								role: "function",
								parts: [
									{
										functionResponse: {
											name: "think",
											response: { content: "Proceed." },
										},
									},
								],
							});
						} else if (functionCall.name === "suggest_fix") {
							aiSuggestion = `**Analysis:** ${args["analysis"]}\n\n**Suggestion:** ${args["suggestion"]}`;
							suggestionFound = true;
						}
						turnCount++;
					} else {
						break;
					}
				}
			} catch (aiError) {
				console.warn("AI Error Analysis failed:", aiError);
			}
			// --- End AI Analysis ---

			// Use raceWithCancellation to allow terminating the prompt if operation is cancelled
			let choice: string | undefined;

			// If we have a suggestion, add it to chat history
			if (aiSuggestion !== "Analysis not available.") {
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					`### Execution Error Analysis\n\n${aiSuggestion}`,
					undefined,
					undefined,
					undefined,
					false,
					false,
					true, // isContextAgentLog
				);
			}

			const showMessagePromise = vscode.window.showErrorMessage(
				`Plan step failed: ${stepDescription}. See chat for AI analysis.`,
				"Retry Step",
				"Skip Step",
				"Cancel Plan",
			);
			// --- End AI Analysis ---

			if (token) {
				choice = await this._raceWithCancellation(showMessagePromise, token);
			} else {
				choice = await showMessagePromise;
			}

			if (choice === undefined) {
				return { type: "cancel" };
			} else if (choice === "Retry Step") {
				return { type: "retry", resetTransientCount: true };
			} else if (choice === "Skip Step") {
				return { type: "skip" };
			} else {
				return { type: "cancel" };
			}
		}
	}

	private async _formatRelevantFilesForPrompt(
		relevantFiles: (string | FileSelection)[],
		workspaceRootUri: vscode.Uri,
		token: vscode.CancellationToken,
	): Promise<string> {
		if (!relevantFiles || relevantFiles.length === 0) {
			return "";
		}

		const formattedSnippets: string[] = [];
		const maxFileSizeForSnippet = sidebarConstants.DEFAULT_SIZE;

		for (const fileItem of relevantFiles) {
			if (token.isCancellationRequested) {
				return formattedSnippets.join("\n");
			}

			let relativePath: string;
			let startLine: number | undefined;
			let endLine: number | undefined;

			if (typeof fileItem === "string") {
				relativePath = fileItem;
			} else {
				relativePath = path
					.relative(workspaceRootUri.fsPath, fileItem.uri.fsPath)
					.replace(/\\/g, "/");
				startLine = fileItem.startLine;
				endLine = fileItem.endLine;

				// Symbol Resolution
				if (
					fileItem.symbolName &&
					startLine === undefined &&
					endLine === undefined
				) {
					try {
						const symbols = await getSymbolsInDocument(fileItem.uri);
						if (symbols) {
							const findSymbol = (
								symbols: vscode.DocumentSymbol[],
								name: string,
							): vscode.DocumentSymbol | undefined => {
								for (const symbol of symbols) {
									if (symbol.name === name) {
										return symbol;
									}
									if (symbol.children) {
										const found = findSymbol(symbol.children, name);
										if (found) {
											return found;
										}
									}
								}
								return undefined;
							};

							const symbol = findSymbol(symbols, fileItem.symbolName);
							if (symbol) {
								// Found the symbol, use its range!
								startLine = symbol.range.start.line + 1; // 1-indexed
								endLine = symbol.range.end.line + 1; // 1-indexed

								// Optional: Include context (e.g. 5 lines before) if needed
								// But precise range is usually what we want for "Selection"
							} else {
								console.warn(
									`[MinovativeMind] Symbol '${fileItem.symbolName}' not found in '${relativePath}'. Falling back to full file/default.`,
								);
							}
						}
					} catch (e: any) {
						console.error(
							`[MinovativeMind] Error resolving symbol '${fileItem.symbolName}': ${e.message}`,
						);
					}
				}
			}

			const fileUri = vscode.Uri.joinPath(workspaceRootUri, relativePath);
			let fileContent: string | null = null;
			let languageId = path.extname(relativePath).substring(1);
			if (!languageId) {
				languageId = path.basename(relativePath).toLowerCase();
			}
			if (languageId === "makefile") {
				languageId = "makefile";
			} else if (languageId === "dockerfile") {
				languageId = "dockerfile";
			} else if (languageId === "jsonc") {
				languageId = "json";
			} else if (languageId === "eslintignore") {
				languageId = "ignore";
			} else if (languageId === "prettierignore") {
				languageId = "ignore";
			} else if (languageId === "gitignore") {
				languageId = "ignore";
			} else if (languageId === "license") {
				languageId = "plaintext";
			}

			try {
				const fileStat = await vscode.workspace.fs.stat(fileUri);

				if (fileStat.type === vscode.FileType.Directory) {
					continue;
				}

				if (fileStat.size > maxFileSizeForSnippet && !startLine) {
					console.warn(
						`[MinovativeMind] Skipping relevant file '${relativePath}' (size: ${fileStat.size} bytes) due to size limit for prompt inclusion.`,
					);
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: too large for context (${(
							fileStat.size / 1024
						).toFixed(2)}KB > ${(maxFileSizeForSnippet / 1024).toFixed(
							2,
						)}KB)]\n\`\`\`\n`,
					);
					continue;
				}

				const contentBuffer = await vscode.workspace.fs.readFile(fileUri);
				const content = Buffer.from(contentBuffer).toString("utf8");

				if (content.includes("\0")) {
					console.warn(
						`[MinovativeMind] Skipping relevant file '${relativePath}' as it appears to be binary.`,
					);
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: appears to be binary]\n\`\`\`\n`,
					);
					continue;
				}

				if (startLine !== undefined && endLine !== undefined) {
					const lines = content.split(/\r?\n/);
					// 1-indexed to 0-indexed
					const slicedLines = lines.slice(startLine - 1, endLine);
					fileContent = slicedLines.join("\n");
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} (Lines ${startLine}-${endLine}) ---\n\`\`\`${languageId}\n${fileContent}\n\`\`\`\n`,
					);
					continue; // Skip full diagnostic check for snippets to save time/tokens? Or strictly apply?
					// For snippets, we might skip full diagnostics or apply them only to the range.
					// Let's keep it simple and skip diagnostics for partials for now or apply them if easy.
				} else {
					fileContent = content;
				}
			} catch (error: any) {
				if (
					error instanceof vscode.FileSystemError &&
					(error.code === "FileNotFound" || error.code === "EntryNotFound")
				) {
					console.warn(
						`[MinovativeMind] Relevant file not found: '${relativePath}'. Skipping.`,
					);
				} else if (error.message.includes("is not a file")) {
					console.warn(
						`[MinovativeMind] Skipping directory '${relativePath}' as a relevant file.`,
					);
				} else {
					console.error(
						`[MinovativeMind] Error reading relevant file '${relativePath}': ${error.message}. Skipping.`,
						error,
					);
				}
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: could not be read or is inaccessible: ${error.message}]\n\`\`\`\n`,
				);
				continue;
			}

			if (fileContent !== null) {
				const diagnostics = await DiagnosticService.formatContextualDiagnostics(
					fileUri,
					this.workspaceRootUri,
					{
						fileContent: fileContent,
						enableEnhancedDiagnosticContext:
							this.provider.settingsManager.getOptimizationSettings()
								.enableEnhancedDiagnosticContext,
						includeSeverities: [
							vscode.DiagnosticSeverity.Information,
							vscode.DiagnosticSeverity.Hint,
						],
						requestType: "hint_only",
						token: token,
					},
				);
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`${languageId}\n${fileContent}\n\`\`\`\n${diagnostics}`,
				);
			}
		}

		return formattedSnippets.join("\n");
	}

	private _mapToServiceStep(step: PlanStep): ServicePlanStep {
		switch (step.step.action) {
			case PlanStepAction.CreateDirectory:
				return {
					action: ServicePlanStepAction.CreateDirectory,
					file: step.step.path,
					description:
						step.step.description || `Create directory ${step.step.path}`,
				};
			case PlanStepAction.CreateFile:
				return {
					action: ServicePlanStepAction.CreateFile,
					file: step.step.path,
					content: step.step.content,
					generate_prompt: step.step.generate_prompt,
					description: step.step.description || `Create file ${step.step.path}`,
				};
			case PlanStepAction.ModifyFile:
				return {
					action: ServicePlanStepAction.ModifyFile,
					file: step.step.path,
					modificationPrompt: step.step.modification_prompt,
					description: step.step.description || `Modify file ${step.step.path}`,
				};
			case PlanStepAction.RunCommand:
				return {
					action: ServicePlanStepAction.RunCommand,
					command: step.step.command,
					description:
						step.step.description || `Run command ${step.step.command}`,
				};
			default:
				throw new Error(
					`Unsupported plan step action: ${(step as any).step?.action}`,
				);
		}
	}

	/**
	 * Programmatically opens documents and waits for language server diagnostics to stabilize.
	 */
	private async _warmUpDiagnostics(
		uris: Set<vscode.Uri>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (uris.size === 0) {
			return;
		}

		console.log(
			`[PlanExecutorService] Warming up diagnostics for ${uris.size} files...`,
		);

		// 1. Open documents to trigger language server scanning and show them in the viewport
		for (const uri of uris) {
			if (token.isCancellationRequested) {
				break;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, {
					preview: true,
					preserveFocus: true,
				});
			} catch (err: any) {
				console.warn(
					`[PlanExecutorService] Diagnostic warm-up: Failed to open/show ${uri.fsPath}: ${err.message}`,
				);
			}
		}

		// 2. Wait for diagnostics to stabilize
		// We use a simple sequential wait to avoid overwhelming the LS, or we could use Promise.all
		for (const uri of uris) {
			if (token.isCancellationRequested) {
				break;
			}
			try {
				await DiagnosticService.waitForDiagnosticsToStabilize(uri, token);
			} catch (err: any) {
				console.warn(
					`[PlanExecutorService] Diagnostic warm-up: Stability wait failed for ${uri.fsPath}: ${err.message}`,
				);
			}
		}
	}
}
