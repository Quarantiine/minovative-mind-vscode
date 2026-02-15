import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as sidebarTypes from "../sidebar/common/sidebarTypes";
import { ExtensionToWebviewMessages } from "../sidebar/common/sidebarTypes";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import {
	ExecutionPlan,
	isCreateDirectoryStep,
	isCreateFileStep,
	isModifyFileStep,
	isRunCommandStep,
	PlanStep,
	PlanStepAction,
	CreateDirectoryStep,
	CreateFileStep,
	ModifyFileStep,
	RunCommandStep,
} from "../ai/workflowPlanner";
import { generateFileChangeSummary } from "../utils/diffingUtils";
import { applyAITextEdits, cleanCodeOutput } from "../utils/codeUtils";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { UrlContextService } from "./urlContextService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import { executeCommand, CommandResult } from "../utils/commandExecution";
import * as sidebarConstants from "../sidebar/common/sidebarConstants";
import { DiagnosticService } from "../utils/diagnosticUtils";
import { FileSelection } from "../context/smartContextSelector";
import { getSymbolsInDocument } from "./symbolService";
import { SearchReplaceService } from "./searchReplaceService";
import { ExplorationService } from "./ExplorationService";
import { GatekeeperService } from "./GatekeeperService";
import { validateOutputIntegrity } from "../ai/prompts/lightweightPrompts";

export class PlanExecutorService {
	private commandExecutionTerminals: vscode.Terminal[] = [];
	private contextCache = new Map<string, string>();

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
		private urlContextService: UrlContextService,
		private enhancedCodeGenerator: EnhancedCodeGenerator,
		private explorationService: ExplorationService,
		private gatekeeperService: GatekeeperService,
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

		// Populate the provider with all file URIs targeted by this plan.
		// This is used by the self-correction workflow to check for errors in all intended files.
		const verifiedTargetUris: vscode.Uri[] = [];
		for (const s of orderedSteps) {
			if (operationToken.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (
				isCreateFileStep(s) ||
				isModifyFileStep(s) ||
				isCreateDirectoryStep(s)
			) {
				const resolved = await this._resolveTargetFileUri(s.step.path);
				verifiedTargetUris.push(resolved);
			}
		}

		if (planContext.isCorrectionMode) {
			// In correction mode, we want to ACCUMULATE targets.
			// This ensures that if we fix File A but break File B (which was part of the original plan),
			// File B remains in the "watch list" for the next correction cycle.
			const existingUris = this.provider.lastPlanTargetUris || [];

			// Use a Map to deduplicate by fsPath string to avoid duplicates
			const uniqueUris = new Map<string, vscode.Uri>();

			// Add existing
			existingUris.forEach((u) => uniqueUris.set(u.fsPath, u));
			// Add new
			verifiedTargetUris.forEach((u) => uniqueUris.set(u.fsPath, u));

			this.provider.lastPlanTargetUris = Array.from(uniqueUris.values());
			console.log(
				`[PlanExecutor] Correction Mode: Accumulated ${this.provider.lastPlanTargetUris.length} target URIs (Merged ${existingUris.length} existing with ${verifiedTargetUris.length} new).`,
			);
		} else {
			// Normal mode: Overwrite/Reset the list
			this.provider.lastPlanTargetUris = verifiedTargetUris;
		}

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
							if (combinedToken.isCancellationRequested) {
								throw new Error(ERROR_OPERATION_CANCELLED);
							}
							await this._warmUpDiagnostics(affectedUris, combinedToken);
						}

						// --- GATEKEEPER VERIFICATION ---
						let shouldTriggerSelfCorrection = false;

						if (
							!combinedToken.isCancellationRequested &&
							affectedUris.size > 0
						) {
							this.postMessageToWebview({
								type: "statusUpdate",
								value: "Analyzing stability...", // AI Risk Assessment
							});

							// Generate a summary of all changes in the current plan
							const changes = this.provider.changeLogger.getChangeLog();
							const changeSummary = changes
								.map(
									(c) =>
										`[${c.changeType.toUpperCase()}] ${c.filePath}: ${c.summary}`,
								)
								.join("\n");

							// Create an AbortSignal from the CancellationToken
							const abortController = new AbortController();
							if (combinedToken.isCancellationRequested)
								abortController.abort();
							const signalDisposable = combinedToken.onCancellationRequested(
								() => abortController.abort(),
							);

							try {
								const riskDecision =
									await this.gatekeeperService.assessRiskWithAI(
										changeSummary,
										abortController.signal,
									);

								if (
									riskDecision.runVerification &&
									riskDecision.suggestedCommand
								) {
									this.postMessageToWebview({
										type: "statusUpdate",
										value: `Verifying: ${riskDecision.suggestedCommand}`,
									});

									const verificationPassed =
										await this.gatekeeperService.verifyChange(
											riskDecision.suggestedCommand,
											abortController.signal,
										);

									if (!verificationPassed) {
										vscode.window.showWarningMessage(
											`Minovative Mind: Verification failed (${riskDecision.suggestedCommand}). Please review the changes.`,
										);
									} else {
										console.log(
											"[MinovativeMind] Verification passed successfully.",
										);
									}
								} else {
									console.log(
										`[MinovativeMind] Skipping verification. Reason: ${riskDecision.reason}`,
									);
								}

								// CRITICAL CHECK: Run diagnostics post-execution on affected files for potential self-correction
								// We do this EVEN IF automated verification passed, as there might be UI or type errors not caught by the verification command.
								const diagnosticUris =
									await this._checkDiagnosticsForSelfCorrection(
										affectedUris,
										combinedToken,
									);
								if (diagnosticUris.length > 0) {
									shouldTriggerSelfCorrection = true;
								}
							} finally {
								signalDisposable.dispose();
							}
						}
						// --- END GATEKEEPER ---

						if (!combinedToken.isCancellationRequested) {
							if (shouldTriggerSelfCorrection) {
								this.provider.currentExecutionOutcome = "success_with_errors";
								console.log(
									"[PlanExecutorService] Plan execution succeeded but found post-execution errors. Setting outcome to success_with_errors.",
								);
							} else {
								this.provider.currentExecutionOutcome = "success";
							}
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

			this.postMessageToWebview({
				type: "updateLoadingState",
				value: false,
			});

			this.postMessageToWebview({
				type: "reenableInput",
			});

			let outcome: sidebarTypes.ExecutionOutcome | undefined;
			if (this.provider.currentExecutionOutcome === undefined) {
				outcome = "failed";
			} else {
				outcome = this.provider
					.currentExecutionOutcome as sidebarTypes.ExecutionOutcome;
			}

			// Do not await notification as it might wait for user interaction if sidebar is hidden
			this.provider.showPlanCompletionNotification(outcome);

			this.postMessageToWebview({
				type: "planExecutionEnded",
			});

			if (
				(this.provider.currentExecutionOutcome as any) === "success_with_errors"
			) {
				console.log(
					"[PlanExecutorService] Outcome set to success_with_errors. Triggering self-correction workflow.",
				);
				await this.provider.triggerSelfCorrectionWorkflow();
			}

			// Clear plan state
			this.provider.currentPlanSteps = [];
			this.provider.currentPlanStepIndex = -1;

			// Check if the current operation ID matches the one we started with.
			// If it has changed (e.g., because self-correction started and set a new ID),
			// we must NOT clobber the state or call endUserOperation, as that would
			// incorrectly reset the UI while the correction is running.
			const isOperationSuperseded =
				this.provider.currentActiveChatOperationId !== originalOperationId;

			console.log(
				`[PlanExecutorService] Final check: currentActiveChatOperationId=${this.provider.currentActiveChatOperationId}, originalOperationId=${originalOperationId}, isOperationSuperseded=${isOperationSuperseded}`,
			);

			if (!isOperationSuperseded) {
				await this.provider.endUserOperation(outcome);
			} else {
				console.log(
					`[PlanExecutorService] Skipping endUserOperation because operation ID changed. Assumption: Self-correction or new operation started.`,
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
					if (isCreateDirectoryStep(step)) {
						await this._handleCreateDirectoryStep(step, rootUri, changeLogger);
					} else if (isCreateFileStep(step)) {
						await this._handleCreateFileStep(
							step as CreateFileStep,
							currentStepNumber,
							totalSteps,
							rootUri,
							context,
							relevantSnippets,
							affectedFileUris,
							changeLogger,
							combinedToken,
						);
					} else if (isModifyFileStep(step)) {
						await this._handleModifyFileStep(
							step as ModifyFileStep,
							currentStepNumber,
							totalSteps,
							rootUri,
							context,
							relevantSnippets,
							affectedFileUris,
							changeLogger,
							combinedToken,
						);
					} else if (isCommandStep) {
						await this._handleRunCommandStep(
							step,
							index,
							totalSteps,
							rootUri,
							context,
							progress,
							originalRootInstruction,
							combinedToken,
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
					if (isCreateDirectoryStep(step) && step.step.path) {
						detailedStepDescription = `Creating directory: \`${path.basename(
							step.step.path,
						)}\``;
					} else {
						detailedStepDescription = `Creating directory`;
					}
					break;
				case PlanStepAction.CreateFile:
					if (isCreateFileStep(step) && step.step.path) {
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
					if (isModifyFileStep(step) && step.step.path) {
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
			// Replaced _logStepProgress (Line 485)
			console.warn(
				`Minovative Mind: FAILED (transient, auto-retrying): ${stepDescription}. Attempt ${
					currentTransientAttempt + 1
				}/${maxTransientRetries}. Error: ${errorMsg}`,
			);
			return { type: "retry" };
		} else {
			// Replaced _logStepProgress (Line 497)
			console.error(
				`Minovative Mind: FAILED: ${stepDescription}. Requires user intervention. Error: ${errorMsg}`,
			);

			// Use raceWithCancellation to allow terminating the prompt if operation is cancelled
			let choice: string | undefined;
			const showMessagePromise = vscode.window.showErrorMessage(
				`Plan step failed: ${stepDescription} failed with error: ${errorMsg}. What would you like to do?`,
				"Retry Step",
				"Skip Step",
				"Cancel Plan",
			);

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

	private _postChatUpdateForPlanExecution(
		message: sidebarTypes.AppendRealtimeModelMessage,
	): void {
		// 4. Modify addHistoryEntry call to remove message.isPlanStepUpdate
		this.provider.chatHistoryManager.addHistoryEntry(
			"model",
			message.value.text,
			message.diffContent,
			undefined,
			undefined,
		);

		this.provider.chatHistoryManager.restoreChatHistoryToWebview();
	}

	private async _handleCreateDirectoryStep(
		step: CreateDirectoryStep,
		rootUri: vscode.Uri,
		changeLogger: SidebarProvider["changeLogger"],
	): Promise<void> {
		await vscode.workspace.fs.createDirectory(
			vscode.Uri.joinPath(rootUri, step.step.path),
		);
		changeLogger.logChange({
			filePath: step.step.path,
			changeType: "created",
			summary: `Created directory: '${step.step.path}'`,
			timestamp: Date.now(),
		});
	}

	private async _handleCreateFileStep(
		step: CreateFileStep,
		currentStepNumber: number,
		totalSteps: number,
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		relevantSnippets: string,
		affectedFileUris: Set<vscode.Uri>,
		changeLogger: SidebarProvider["changeLogger"],
		combinedToken: vscode.CancellationToken,
	): Promise<void> {
		// Early cancellation check before any async work
		if (combinedToken.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		const fileUri = vscode.Uri.joinPath(rootUri, step.step.path);

		let desiredContent: string | undefined = step.step.content;

		if (step.step.generate_prompt) {
			const generationContext = {
				projectContext: context.projectContext,
				relevantSnippets: relevantSnippets,
				editorContext: context.editorContext,
				activeSymbolInfo: undefined,
			};

			let generatedResult: { content: string } | undefined;
			let attempt = 0;
			let success = false;
			while (!success && attempt <= this.MAX_TRANSIENT_STEP_RETRIES) {
				if (combinedToken.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}
				try {
					generatedResult =
						await this.enhancedCodeGenerator.generateFileContent(
							step.step.path,
							step.step.generate_prompt,
							generationContext,
							this.provider.settingsManager.getSelectedModelName(),
							combinedToken,
							undefined, // generationConfig
							attempt > 0, // isRetry
						);
					success = true;
				} catch (error: any) {
					const errorMsg = formatUserFacingErrorMessage(error, "", "", rootUri);
					const isRetryable =
						errorMsg.includes("quota") ||
						errorMsg.includes("rate limit") ||
						errorMsg.includes("network issue") ||
						errorMsg.includes("service unavailable") ||
						errorMsg.includes("timeout") ||
						errorMsg.includes("parsing failed") ||
						errorMsg.includes("overloaded");

					if (isRetryable && attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
						attempt++;
						console.warn(
							`AI generation for ${step.step.path} failed, retrying (${attempt}/${this.MAX_TRANSIENT_STEP_RETRIES})... Error: ${errorMsg}`,
						);
						await this._delay(2000 * attempt, combinedToken);
					} else {
						throw error;
					}
				}
			}
			if (!generatedResult) {
				throw new Error(
					`AI generation for ${step.step.path} failed after multiple retries.`,
				);
			}
			desiredContent = generatedResult.content;
		}

		const cleanedDesiredContent = cleanCodeOutput(desiredContent ?? "");

		console.log(
			`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Creating file \`${path.basename(
				step.step.path,
			)}\`...`,
		);

		try {
			await vscode.workspace.fs.stat(fileUri);
			const existingContent = Buffer.from(
				await vscode.workspace.fs.readFile(fileUri),
			).toString("utf-8");

			if (step.step.generate_prompt) {
				// Runtime Guard: Check for errors before overwriting
				// Only run this check if we are in correction mode (self-correction workflow)
				if (context.isCorrectionMode) {
					// Ensure diagnostics are fresh
					await DiagnosticService.waitForDiagnosticsToStabilize(
						fileUri,
						combinedToken,
					);
					const diagnostics = DiagnosticService.getDiagnosticsForUri(fileUri);
					const hasErrors = diagnostics.some(
						(d) => d.severity === vscode.DiagnosticSeverity.Error,
					);

					if (!hasErrors) {
						console.log(
							`[Runtime Guard] Skipping overwrite for ${path.basename(
								step.step.path,
							)}: No visible error diagnostics found.`,
						);
						const skipMessage = `Step ${currentStepNumber}/${totalSteps}: Skipped overwrite for \`${path.basename(
							step.step.path,
						)}\` (No visible errors detected).`;
						this._postChatUpdateForPlanExecution({
							type: "appendRealtimeModelMessage",
							value: {
								text: skipMessage,
							},
							diffContent: undefined,
						});
						return;
					}
				}
			}

			if (existingContent === cleanedDesiredContent) {
				console.log(
					`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] File \`${path.basename(
						step.step.path,
					)}\` already has the desired content. Skipping.`,
				);
			} else {
				const resolvedUri = await this._resolveTargetFileUri(step.step.path);
				const document = await vscode.workspace.openTextDocument(resolvedUri);
				const editor = await vscode.window.showTextDocument(document);

				await applyAITextEdits(
					editor,
					existingContent,
					cleanedDesiredContent,
					combinedToken,
				);
				const newContentAfterApply = editor.document.getText();
				await editor.document.save();

				const { formattedDiff, summary } = await generateFileChangeSummary(
					existingContent,
					newContentAfterApply,
					step.step.path,
				);

				// Replaced _logStepProgress (Modification success)
				console.log(
					`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Modified file \`${path.basename(
						step.step.path,
					)}\``,
				);

				// 2. In the existing file modification path (the `try` block), update the `chatMessageText` string to use the format: `Step ${currentStepNumber}/${totalSteps}: Modified file: \`${path.basename(step.step.path)}\`\n\n${summary}`.
				const chatMessageText = `Step ${currentStepNumber}/${totalSteps}: Modified file: \`${path.basename(
					step.step.path,
				)}\`\n\n${summary}`;
				this._postChatUpdateForPlanExecution({
					type: "appendRealtimeModelMessage",
					value: {
						text: chatMessageText,
					},
					diffContent: formattedDiff,
				});

				changeLogger.logChange({
					filePath: step.step.path,
					changeType: "modified",
					summary,
					diffContent: formattedDiff,
					timestamp: Date.now(),
					originalContent: existingContent,
					newContent: newContentAfterApply,
				});
				affectedFileUris.add(fileUri);
			}
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				await vscode.workspace.fs.writeFile(
					fileUri,
					Buffer.from(cleanedDesiredContent),
				);

				const { formattedDiff, summary } = await generateFileChangeSummary(
					"",
					cleanedDesiredContent,
					step.step.path,
				);

				// Replaced _logStepProgress (Creation success)
				console.log(
					`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Created file \`${path.basename(
						step.step.path,
					)}\``,
				);

				const chatMessageText = `Step ${currentStepNumber}/${totalSteps}: Created file: \`${path.basename(
					step.step.path,
				)}\`\n\n${summary}`;
				this._postChatUpdateForPlanExecution({
					type: "appendRealtimeModelMessage",
					value: {
						text: chatMessageText,
					},
					diffContent: formattedDiff,
				});

				changeLogger.logChange({
					filePath: step.step.path,
					changeType: "created",
					summary,
					diffContent: formattedDiff,
					timestamp: Date.now(),
					originalContent: "",
					newContent: cleanedDesiredContent,
				});
				affectedFileUris.add(fileUri);
			} else {
				throw error;
			}
		}
	}

	private async _handleModifyFileStep(
		step: ModifyFileStep,
		currentStepNumber: number,
		totalSteps: number,
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		relevantSnippets: string,
		affectedFileUris: Set<vscode.Uri>,
		changeLogger: SidebarProvider["changeLogger"],
		combinedToken: vscode.CancellationToken,
	): Promise<void> {
		// Early cancellation check before any async work
		if (combinedToken.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		const fileUri = await this._resolveTargetFileUri(step.step.path);
		let originalContent: string;

		try {
			const contentBuffer = await vscode.workspace.fs.readFile(fileUri);
			originalContent = Buffer.from(contentBuffer).toString("utf-8");
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				console.log(
					`Minovative Mind: File ${path.basename(
						fileUri.fsPath,
					)} not found for modification. Falling back to creation.`,
				);

				const createFileStep: CreateFileStep = {
					step: {
						action: PlanStepAction.CreateFile,
						path: step.step.path,
						generate_prompt: step.step.modification_prompt,
						description: `Creating missing file \`${path.basename(
							step.step.path,
						)}\` before modification.`,
					},
				};

				return await this._handleCreateFileStep(
					createFileStep,
					currentStepNumber,
					totalSteps,
					rootUri,
					context,
					relevantSnippets,
					affectedFileUris,
					changeLogger,
					combinedToken,
				);
			} else {
				throw error;
			}
		}

		const modificationContext = {
			projectContext: context.projectContext,
			relevantSnippets: relevantSnippets,
			editorContext: context.editorContext,
			activeSymbolInfo: undefined,
		};

		// Dynamic Context Selection (Context Agent) removed

		// Runtime Guard: Check for errors before modifying
		// Only run this check if we are in correction mode (self-correction workflow)
		// Otherwise, trust the plan execution and avoid unnecessary delays.
		if (context.isCorrectionMode) {
			// Ensure diagnostics are fresh
			await DiagnosticService.waitForDiagnosticsToStabilize(
				fileUri,
				combinedToken,
			);
			const diagnostics = DiagnosticService.getDiagnosticsForUri(fileUri);
			const hasErrors = diagnostics.some(
				(d) => d.severity === vscode.DiagnosticSeverity.Error,
			);

			if (!hasErrors) {
				console.log(
					`[Runtime Guard] Skipping modification for ${path.basename(
						step.step.path,
					)}: No visible error diagnostics found.`,
				);
				const skipMessage = `Step ${currentStepNumber}/${totalSteps}: Skipped modification for \`${path.basename(
					step.step.path,
				)}\` (No visible errors detected).`;
				this._postChatUpdateForPlanExecution({
					type: "appendRealtimeModelMessage",
					value: {
						text: skipMessage,
					},
					diffContent: undefined,
				});
				return;
			}
		}

		let newContent: string = "";
		let attempt = 0;
		let success = false;
		let clarificationContext = "";

		const searchReplaceService = new SearchReplaceService();

		while (!success && attempt <= this.MAX_TRANSIENT_STEP_RETRIES) {
			if (combinedToken.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			let modifiedResult: { content: string; validation?: any } | undefined;
			try {
				modifiedResult = await this.enhancedCodeGenerator.modifyFileContent(
					step.step.path,
					step.step.modification_prompt + clarificationContext,
					originalContent,
					modificationContext,
					this.provider.settingsManager.getSelectedModelName(),
					combinedToken,
					attempt > 0, // isRetry
				);
			} catch (error: any) {
				const errorMsg = formatUserFacingErrorMessage(error, "", "", rootUri);
				const isRetryable =
					errorMsg.includes("quota") ||
					errorMsg.includes("rate limit") ||
					errorMsg.includes("network issue") ||
					errorMsg.includes("service unavailable") ||
					errorMsg.includes("timeout") ||
					errorMsg.includes("parsing failed") ||
					errorMsg.includes("overloaded");

				if (isRetryable && attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
					attempt++;
					console.warn(
						`AI modification for ${step.step.path} failed (Attempt ${attempt}/${this.MAX_TRANSIENT_STEP_RETRIES}). Error: ${errorMsg}`,
					);
					await this._delay(2000 * attempt, combinedToken);
					continue;
				} else {
					throw error;
				}
			}

			if (!modifiedResult) {
				throw new Error(
					`AI modification for ${step.step.path} returned no content.`,
				);
			}

			// If the generator already flagged it as invalid (e.g. old markers used), trigger retry
			if (
				modifiedResult.validation &&
				!modifiedResult.validation.isValid &&
				attempt < this.MAX_TRANSIENT_STEP_RETRIES
			) {
				attempt++;
				const issues = modifiedResult.validation.issues
					.map((i: any) => i.message)
					.join("\n");
				console.warn(
					`[PlanExecutor] Generator reported invalid output for ${step.step.path}: ${issues}. triggering AI retry.`,
				);
				clarificationContext += `\n\n[OUTPUT VALIDATION ERROR]: ${issues}. Please ensure you use the EXACT Search/Replace format (<<<<<<< SEARC#H / ===#=== / >>>>>>> REPLAC#E).`;
				await this._delay(1000, combinedToken);
				continue;
			}

			/* Search and Replace Block Logic */
			const rawOutput = cleanCodeOutput(modifiedResult.content);

			// Check if the output contains search/replace blocks or hints of markers
			const hasSearchReplaceMarkers =
				rawOutput.match(/^<{5,}\s*SEARC#H$/im) ||
				rawOutput.includes("<<<<<<<" + " SEARC#H");

			if (hasSearchReplaceMarkers) {
				try {
					const blocks = searchReplaceService.parseBlocks(rawOutput);
					if (blocks.length === 0) {
						if (attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
							attempt++;
							console.warn(
								`[PlanExecutor] Detected Search/Replace markers but failed to parse any valid blocks for ${step.step.path}. triggering AI retry.`,
							);
							clarificationContext +=
								"\n\n[PARSING ERROR]: I detected Search/Replace markers in your output, but they were malformed and I couldn't parse them. Please ensure you use the exact format:\n<<<<<<<" +
								" SEARC#H\n[existing code]\n===#===\n[new code]\n>>>>>>>" +
								" REPLAC#E";
							await this._delay(1000, combinedToken);
							continue;
						} else {
							throw new Error(
								"Detected Search/Replace markers but failed to parse any valid blocks after multiple attempts.",
							);
						}
					}
					newContent = searchReplaceService.applyBlocks(
						originalContent,
						blocks,
					);
					success = true;
				} catch (error: any) {
					if (error.name === "AmbiguousMatchError") {
						const ambiguousBlock = error.ambiguousBlock;
						const lines = originalContent.split("\n");
						const searchLines = ambiguousBlock.split("\n");
						const matchIndices: number[] = [];

						// Find all occurrences manually to report line numbers
						for (let i = 0; i <= lines.length - searchLines.length; i++) {
							let match = true;
							for (let j = 0; j < searchLines.length; j++) {
								if (lines[i + j].trim() !== searchLines[j].trim()) {
									match = false;
									break;
								}
							}
							if (match) {
								matchIndices.push(i + 1); // 1-based line numbers
							}
						}

						console.warn(
							`[PlanExecutor] Ambiguous match detected for ${step.step.path}. Matches at lines: ${matchIndices.join(", ")}. triggering AI retry.`,
						);

						if (attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
							attempt++;

							// Retrieve symbols to add context
							let symbolContext = "";
							try {
								const symbols = await getSymbolsInDocument(fileUri);
								if (symbols) {
									const matchesWithSymbols = matchIndices.map((line) => {
										const findSymbolForLine = (
											syms: vscode.DocumentSymbol[],
											targetLine: number,
										): string | undefined => {
											for (const sym of syms) {
												if (
													targetLine >= sym.range.start.line + 1 &&
													targetLine <= sym.range.end.line + 1
												) {
													if (sym.children && sym.children.length > 0) {
														const childFound = findSymbolForLine(
															sym.children,
															targetLine,
														);
														if (childFound) {
															return `${sym.name} > ${childFound}`;
														}
													}
													return sym.name;
												}
											}
											return undefined;
										};
										const foundSymbol = findSymbolForLine(symbols, line);
										return foundSymbol
											? `Line ${line} (inside \`${foundSymbol}\`)`
											: `Line ${line}`;
									});
									symbolContext = matchesWithSymbols.join(", ");
								} else {
									symbolContext = matchIndices
										.map((l) => `Line ${l}`)
										.join(", ");
								}
							} catch (e) {
								console.warn(
									"Failed to retrieve symbols for ambiguity context:",
									e,
								);
								symbolContext = matchIndices.map((l) => `Line ${l}`).join(", ");
							}

							clarificationContext += `\n\n[AMBIGUITY ERROR]: The SEARC#H block you provided is ambiguous. It matches multiple locations in the file: ${symbolContext}.\n\nAMBIGUOUS BLOCK:\n\`\`\`\n${ambiguousBlock}\n\`\`\`\nPlease provide a new SEARC#H block that includes more unique surrounding context to uniquely identify the intended location.`;
							await this._delay(1000, combinedToken);
							continue;
						} else {
							throw new Error(
								`Ambiguous match found at lines ${matchIndices.join(", ")} and max retries reached.`,
							);
						}
					} else if (error.name === "SearchBlockNotFoundError") {
						const missingBlock = error.missingBlock;
						console.warn(
							`[PlanExecutor] SEARC#H block not found for ${step.step.path}. triggering AI retry.`,
						);

						if (attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
							attempt++;
							clarificationContext += `\n\n[NOT FOUND ERROR]: The SEARC#H block you provided was NOT FOUND in the file.\n\nMISSING BLOCK:\n\`\`\`\n${missingBlock}\n\`\`\`\nPlease review the file content and provide a SEARC#H block that EXACTLY matches the existing code (including whitespace and comments).`;
							await this._delay(1000, combinedToken);
							continue;
						} else {
							throw new Error(
								`SEARC#H block not found and max retries reached.`,
							);
						}
					} else {
						throw new Error(
							`Failed to apply Search/Replace blocks: ${error.message}`,
						);
					}
				}
			} else {
				// No valid blocks found and no markers detected.
				// Check for malformed markers OR suspicious fragments.
				// We use both heuristics AND a lightweight AI check for better robustness.
				const hasDeformedMarkers =
					searchReplaceService.containsDeformedMarkers(rawOutput);
				const isLikelyFragmentHeuristic =
					searchReplaceService.isLikelyPartialSnippet(
						rawOutput,
						originalContent,
					);

				let isInvalid = hasDeformedMarkers || isLikelyFragmentHeuristic;
				let invalidReason = hasDeformedMarkers
					? "malformed Search/Replace markers"
					: "a partial code snippet without markers";

				// Secondary check using a lightweight AI model (Flash Lite) for edge cases
				if (!isInvalid && attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
					try {
						const integrityResult = await validateOutputIntegrity(
							rawOutput,
							originalContent,
							this.provider.aiRequestService,
							combinedToken,
						);
						if (!integrityResult.isValid) {
							isInvalid = true;
							invalidReason = integrityResult.reason;
						}
					} catch (e) {
						console.warn("[PlanExecutor] AI integrity check failed:", e);
					}
				}

				if (isInvalid && attempt < this.MAX_TRANSIENT_STEP_RETRIES) {
					attempt++;
					console.warn(
						`[PlanExecutor] Detected ${invalidReason} for ${step.step.path}. triggering AI retry.`,
					);

					clarificationContext += `\n\n[OUTPUT INTEGRITY ERROR]: Your previous output was rejected. Reason: ${invalidReason}. Please ensure you use the exact Search/Replace block format or provide the FULL file content if intended.`;
					await this._delay(1000, combinedToken);
					continue;
				}

				// Fallback to full file rewrite if no blocks detected and all sanity checks pass
				console.warn(
					`[PlanExecutor] No Search/Replace blocks detected for ${step.step.path}. Passed heuristics and AI integrity check. Treating as full file rewrite.`,
				);
				newContent = rawOutput;
				success = true;
			}
		}

		if (!success) {
			throw new Error(
				`AI modification for ${step.step.path} failed after maximum autonomous retries.`,
			);
		}

		if (originalContent === newContent) {
			console.log(
				`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] File \`${path.basename(
					step.step.path,
				)}\` content is already as desired, no substantial modifications needed.`,
			);
		} else {
			const resolvedUri = await this._resolveTargetFileUri(step.step.path);
			const document = await vscode.workspace.openTextDocument(resolvedUri);
			const editor = await vscode.window.showTextDocument(document);
			await applyAITextEdits(
				editor,
				originalContent,
				newContent,
				combinedToken,
			);
			const newContentAfterApply = editor.document.getText();
			await editor.document.save();

			const { formattedDiff, summary } = await generateFileChangeSummary(
				originalContent,
				newContentAfterApply,
				step.step.path,
			);

			// Update the _logStepProgress message
			console.log(
				`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Modified file \`${path.basename(
					step.step.path,
				)}\``,
			);

			// Update the chatMessageText string format
			const chatMessageText = `Step ${currentStepNumber}/${totalSteps}: Modified file: \`${path.basename(
				step.step.path,
			)}\`\n\n${summary}`;
			this._postChatUpdateForPlanExecution({
				type: "appendRealtimeModelMessage",
				value: {
					text: chatMessageText,
				},
				diffContent: formattedDiff,
			});

			changeLogger.logChange({
				filePath: step.step.path,
				changeType: "modified",
				summary,
				diffContent: formattedDiff,
				timestamp: Date.now(),
				originalContent: originalContent,
				newContent: newContentAfterApply,
			});
			affectedFileUris.add(fileUri);
		}
	}

	private async _handleRunCommandStep(
		step: RunCommandStep,
		index: number,
		totalSteps: number,
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		originalRootInstruction: string,
		combinedToken: vscode.CancellationToken,
	): Promise<boolean> {
		const commandString = step.step.command.trim();

		const { executable, args } =
			PlanExecutorService._parseCommandArguments(commandString);

		const displayCommand = [
			executable,
			...args.map(PlanExecutorService._sanitizeArgumentForDisplay),
		].join(" ");

		const commandTerminal = vscode.window.createTerminal({
			name: `Minovative Mind: Cmd ${index + 1}/${totalSteps}`,
			cwd: rootUri.fsPath,
		});
		commandTerminal.show(true);
		this.commandExecutionTerminals.push(commandTerminal); // Store the reference

		let promptMessage = `Command:\n[ \`${displayCommand}.\` ]`;
		promptMessage += `\n\n⚠️ WARNING: Please review it carefully. The plan wants to run the command above. Allow?`;

		// Remove all calls to this._logStepProgress (Instruction 1)
		console.log(
			`Minovative Mind: [Command Step ${
				index + 1
			}/${totalSteps}] About to display command execution prompt: ${displayCommand}`,
		);

		// Use raceWithCancellation for the modal prompt
		const userChoicePromise = vscode.window.showInformationMessage(
			promptMessage,
			{ modal: true },
			"Allow",
			"Skip",
		);
		const userChoice = await this._raceWithCancellation(
			userChoicePromise,
			combinedToken,
		);

		// Remove all calls to this._logStepProgress (Instruction 1)
		console.log(
			`Minovative Mind: [Command Step ${
				index + 1
			}/${totalSteps}] User choice for command: ${displayCommand} is: ${userChoice}`,
		);

		// Check for cancellation immediately after capturing userChoice
		if (combinedToken.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		// Handle undefined userChoice (prompt dismissed or cancelled) (Instruction 2)
		if (userChoice === undefined) {
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] User prompt dismissed without selection; treating as skip.`,
			);
			return true;
		}

		if (userChoice === "Allow") {
			let commandResult: CommandResult | undefined;
			try {
				// 1. Send command text and wait for terminal readiness delay
				commandTerminal.sendText(`${displayCommand}`, true);
				await this._delay(100, combinedToken);

				// 2. Execute command
				commandResult = await executeCommand(
					executable,
					args,
					rootUri.fsPath,
					combinedToken,
					this.provider.activeChildProcesses,
					commandTerminal,
				);

				// Instruction 3: Removed logic checking for non-zero exit code and throwing.
				// Instruction 4: Removed call to this._postCommandResultToChat(...)
			} catch (error: any) {
				if (error.message === ERROR_OPERATION_CANCELLED) {
					throw error;
				}

				// Instruction 6: Catch execution/spawn errors (rejected promise from executeCommand)
				const wrappedError = new Error(
					`RunCommandStep failed to spawn/execute command: ${displayCommand}. Error: ${error.message}`,
				);
				console.error(
					`Minovative Mind: [Command Step ${
						index + 1
					}/${totalSteps}] Execution failed (Spawn failure or Promise Rejection): ${
						wrappedError.message
					}`,
					error,
				);
				throw wrappedError;
			}

			// Instruction 5 & 2c: Success (command spawned successfully). Log and return true.
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] Command completed execution (Exit Code: ${
					commandResult?.exitCode
				}). Continuing plan.`,
			);
			return true;
		} else {
			// userChoice is "Skip"
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] Step SKIPPED by user.`,
			);
			return true;
		}
	}

	private static _parseCommandArguments(commandString: string): {
		executable: string;
		args: string[];
	} {
		const parts = [];
		let inQuote = false;
		let currentPart = "";

		for (let i = 0; i < commandString.length; i++) {
			const char = commandString[i];

			if (char === '"' || char === `'`) {
				inQuote = !inQuote;
				if (!inQuote && currentPart !== "") {
					parts.push(currentPart);
					currentPart = "";
				}
			} else if (char === " " && !inQuote) {
				if (currentPart !== "") {
					parts.push(currentPart);
					currentPart = "";
				}
			} else {
				currentPart += char;
			}
		}

		if (currentPart !== "") {
			parts.push(currentPart);
		}

		if (parts.length === 0) {
			return { executable: "", args: [] };
		}

		const [executable, ...args] = parts;
		return { executable, args };
	}

	private static _sanitizeArgumentForDisplay(arg: string): string {
		// For display purposes, we might want to truncate very long arguments
		// or replace sensitive information. For now, we return as is.
		if (arg.length > 100) {
			return `${arg.substring(0, 97)}...`;
		}
		return arg;
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
		// 2. Wait for diagnostics to stabilize in parallel
		// We use Promise.all to allow concurrent waiting, significantly speeding up the process
		const stabilizationPromises = Array.from(uris).map(async (uri) => {
			if (token.isCancellationRequested) {
				return;
			}
			try {
				await DiagnosticService.waitForDiagnosticsToStabilize(uri, token);
			} catch (err: any) {
				console.warn(
					`[PlanExecutorService] Diagnostic warm-up: Stability wait failed for ${uri.fsPath}: ${err.message}`,
				);
			}
		});

		await Promise.all(stabilizationPromises);
	}

	/**
	 * Resolves a requested relative path to its absolute URI, with fallback logic
	 * to handle shorthand paths (e.g., just the filename) often used by AI.
	 *
	 * @param requestedPath The relative path string from the AI plan.
	 * @returns The resolved vscode.Uri.
	 */
	private async _resolveTargetFileUri(
		requestedPath: string,
	): Promise<vscode.Uri> {
		const normalizedRequested = requestedPath.replace(/\\/g, "/");

		// Priority 1: Exact join and check existence
		const exactUri = vscode.Uri.joinPath(
			this.workspaceRootUri,
			normalizedRequested,
		);
		try {
			await vscode.workspace.fs.stat(exactUri);
			return exactUri;
		} catch {
			// Not found, proceed to fallbacks
		}

		// Priority 2: Try to find a match in the provider's target URIs from the last plan history.
		if (this.provider.lastPlanTargetUris.length > 0) {
			const suffixMatch = this.provider.lastPlanTargetUris.find((uri) => {
				const uriPath = path
					.relative(this.workspaceRootUri.fsPath, uri.fsPath)
					.replace(/\\/g, "/");
				return (
					uriPath === normalizedRequested ||
					uriPath.endsWith(`/${normalizedRequested}`)
				);
			});

			if (suffixMatch) {
				console.log(
					`[PlanExecutorService] Resolved shorthand path '${requestedPath}' to '${path.relative(
						this.workspaceRootUri.fsPath,
						suffixMatch.fsPath,
					)}' using lastPlanTargetUris.`,
				);
				return suffixMatch;
			}
		}

		// Priority 3: Search the workspace for a file matching the basename.
		// This helps if the AI provides just the filename in the initial execution.
		const basename = path.basename(normalizedRequested);
		try {
			const foundFiles = await vscode.workspace.findFiles(
				`**/${basename}`,
				"**/node_modules/**",
				2,
			);
			if (foundFiles.length === 1) {
				console.log(
					`[PlanExecutorService] Resolved shorthand path '${requestedPath}' to unique workspace match '${path.relative(
						this.workspaceRootUri.fsPath,
						foundFiles[0].fsPath,
					)}'.`,
				);
				return foundFiles[0];
			} else if (foundFiles.length > 1) {
				console.warn(
					`[PlanExecutorService] Multiple matches found for '${basename}'. Falling back to default path join.`,
				);
			}
		} catch (searchError) {
			console.warn(
				`[PlanExecutorService] Workspace search for ${basename} failed:`,
				searchError,
			);
		}

		// Fallback: Return the exact join (traditional behavior)
		return exactUri;
	}

	private async _checkDiagnosticsForSelfCorrection(
		urisToWatch: Set<vscode.Uri>,
		token: vscode.CancellationToken,
	): Promise<vscode.Uri[]> {
		const rootUri = this.workspaceRootUri;
		if (!rootUri) return [];

		console.log(
			`[PlanExecutorService] Checking diagnostics on ${urisToWatch.size} affected URIs post-plan execution.`,
		);

		// 1. Wait for diagnostics to stabilize on all affected files
		// We use the same _warmUpDiagnostics helper that is already in use for "Finalizing" status.
		if (urisToWatch.size > 0) {
			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Verifying file stability (${urisToWatch.size} files)...`,
			});
			await this._warmUpDiagnostics(urisToWatch, token);
		}

		const errorFiles: vscode.Uri[] = [];

		for (const uri of urisToWatch) {
			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			try {
				const diagnostics = vscode.languages.getDiagnostics(uri);
				const hasErrors = diagnostics.some(
					(d) => d.severity === vscode.DiagnosticSeverity.Error,
				);

				if (hasErrors) {
					errorFiles.push(uri);
				}
			} catch (e) {
				console.warn(
					`[PlanExecutorService] Could not check diagnostics for ${uri.fsPath}: ${e}`,
				);
			}
		}

		if (errorFiles.length > 0) {
			console.log(
				`[PlanExecutorService] Found ${errorFiles.length} files with errors post-execution.`,
			);
			// Notify the sidebar provider to trigger the UI/workflow change
			this.postMessageToWebview({
				type: "statusUpdate",
				value: `Plan execution succeeded but detected ${errorFiles.length} file(s) with errors. Triggering self-correction.`,
				isError: true,
			});
		}

		return errorFiles;
	}
}
