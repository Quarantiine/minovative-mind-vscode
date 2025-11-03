import * as vscode from "vscode";
import * as path from "path";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as sidebarTypes from "../sidebar/common/sidebarTypes";
import {
	ExtensionToWebviewMessages,
	PlanTimelineInitializeMessage,
	PlanTimelineProgressMessage,
} from "../sidebar/common/sidebarTypes";
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
import { GitConflictResolutionService } from "./gitConflictResolutionService";
import { applyAITextEdits, cleanCodeOutput } from "../utils/codeUtils";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { UrlContextService } from "./urlContextService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import { executeCommand, CommandResult } from "../utils/commandExecution";
import * as sidebarConstants from "../sidebar/common/sidebarConstants";
import { DiagnosticService } from "../utils/diagnosticUtils";

export class PlanExecutorService {
	private commandExecutionTerminals: vscode.Terminal[] = [];
	private contextCache = new Map<string, string>();

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
		private urlContextService: UrlContextService,
		private enhancedCodeGenerator: EnhancedCodeGenerator,
		private gitConflictResolutionService: GitConflictResolutionService,
		private readonly MAX_TRANSIENT_STEP_RETRIES: number
	) {}

	public async executePlan(
		plan: ExecutionPlan,
		planContext: sidebarTypes.PlanGenerationContext,
		operationToken: vscode.CancellationToken
	): Promise<void> {
		this.contextCache.clear();
		this.provider.currentExecutionOutcome = undefined;
		this.provider.activeChildProcesses = [];

		const rootUri = this.workspaceRootUri;

		this.postMessageToWebview({
			type: "updateLoadingState",
			value: true,
		});

		// 2.b. Prepare steps and send PlanTimelineInitializeMessage
		const orderedSteps = this._prepareAndOrderSteps(plan.steps!);

		// 1. Filter orderedSteps to create trackableSteps containing only non-RunCommand steps.
		const trackableSteps = orderedSteps.filter(
			(step) => !isRunCommandStep(step)
		);

		const stepDescriptions = trackableSteps.map((step) => {
			// Extract a simplified description for the timeline initialization.
			// Prioritize the basename of the path for FS operations over generic descriptions.
			let description: string;

			if (isModifyFileStep(step)) {
				description = `Modified file: ${path.basename(step.step.path)}`;
			} else if (isCreateFileStep(step)) {
				description = `Created file: ${path.basename(step.step.path)}`;
			} else if (isCreateDirectoryStep(step)) {
				description = `Created directory: ${path.basename(step.step.path)}`;
			} else if (step.step.description && step.step.description.trim() !== "") {
				// Use AI provided description for non-FS steps if available
				description = step.step.description;
			} else {
				description = `Executed action: ${(
					step as PlanStep
				).step.action.replace(/_/g, " ")}`;
			}

			return description;
		});

		this.postMessageToWebview({
			type: "planTimelineInitialize",
			stepDescriptions: stepDescriptions,
		});

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
						combinedTokenSource.cancel()
					);
					const progListener =
						progressNotificationToken.onCancellationRequested(() =>
							combinedTokenSource.cancel()
						);

					try {
						if (combinedToken.isCancellationRequested) {
							this.provider.currentExecutionOutcome = "cancelled";
							return;
						}

						const originalRootInstruction =
							planContext.type === "chat"
								? planContext.originalUserRequest ?? ""
								: planContext.editorContext!.instruction;

						await this._executePlanSteps(
							orderedSteps, // Pass all steps
							trackableSteps, // 3. Pass trackableSteps as new second argument
							rootUri,
							planContext,
							combinedToken,
							progress,
							originalRootInstruction
						);

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
				}
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
			this._disposeExecutionTerminals();

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

			await this.provider.showPlanCompletionNotification(
				plan.planDescription || "Unnamed Plan",
				outcome
			);

			this.postMessageToWebview({
				type: "updateLoadingState",
				value: false,
			});

			this.postMessageToWebview({
				type: "planExecutionEnded",
			});

			await this.provider.endUserOperation(outcome);

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
				this.provider.changeLogger.getCompletedPlanChangeSets()
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
						step
					)}`
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
		trackableSteps: PlanStep[], // Instruction 1 (Signature update)
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		combinedToken: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		originalRootInstruction: string
	): Promise<Set<vscode.Uri>> {
		const affectedFileUris = new Set<vscode.Uri>();
		const { changeLogger } = this.provider;

		// Initialize tracking variables (Instruction 2)
		const totalOrderedSteps = orderedSteps.length;
		const totalTrackableSteps = trackableSteps.length;
		let trackableStepIndex = 0;

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
					combinedToken
				);
				this.contextCache.set(cacheKey, relevantSnippets);
			}
		}

		let index = 0;
		while (index < totalOrderedSteps) {
			const step = orderedSteps[index];
			const isCurrentStepTrackable = !isRunCommandStep(step); // Instruction 3
			let currentStepCompletedSuccessfullyOrSkipped = false;
			let currentTransientAttempt = 0;

			while (!currentStepCompletedSuccessfullyOrSkipped) {
				if (combinedToken.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}

				// Conditional index calculation for descriptions (Instruction 4)
				const currentStepNumberForDescription = isCurrentStepTrackable
					? trackableStepIndex + 1
					: index + 1;
				const totalStepsForDescription = isCurrentStepTrackable
					? totalTrackableSteps
					: totalOrderedSteps;

				const detailedStepDescription = this._getStepDescription(
					step,
					currentStepNumberForDescription - 1,
					totalStepsForDescription,
					currentTransientAttempt
				);

				// Conditional progress logging (Instruction 4)
				if (isCurrentStepTrackable) {
					this._logStepProgress(
						currentStepNumberForDescription,
						totalStepsForDescription,
						detailedStepDescription,
						currentTransientAttempt,
						this.MAX_TRANSIENT_STEP_RETRIES
					);
				} else {
					// Internal logging for non-trackable steps
					console.log(
						`Minovative Mind (Command Step): Starting ${detailedStepDescription}`
					);
				}

				try {
					if (isCreateDirectoryStep(step)) {
						await this._handleCreateDirectoryStep(step, rootUri, changeLogger);
					} else if (isCreateFileStep(step)) {
						await this._handleCreateFileStep(
							step as CreateFileStep,
							trackableStepIndex + 1, // 1-based index (Instruction 7)
							totalTrackableSteps, // (Instruction 7)
							rootUri,
							context,
							relevantSnippets,
							affectedFileUris,
							changeLogger,
							combinedToken
						);
					} else if (isModifyFileStep(step)) {
						await this._handleModifyFileStep(
							step as ModifyFileStep,
							trackableStepIndex + 1,
							totalTrackableSteps,
							rootUri,
							context,
							relevantSnippets,
							affectedFileUris,
							changeLogger,
							combinedToken
						);
					} else if (isRunCommandStep(step)) {
						await this._handleRunCommandStep(
							step,
							index,
							totalOrderedSteps,
							rootUri,
							context,
							progress,
							originalRootInstruction,
							combinedToken
						);
					}
					currentStepCompletedSuccessfullyOrSkipped = true;
				} catch (error: any) {
					let errorMsg = formatUserFacingErrorMessage(
						error,
						"Failed to execute plan step. Please review the details and try again.",
						"Step execution failed: ",
						rootUri
					);

					if (errorMsg.includes(ERROR_OPERATION_CANCELLED)) {
						throw error;
					}

					// If the step is NOT trackable (RunCommandStep) and it fails, immediately throw (Instruction 5)
					if (!isCurrentStepTrackable) {
						console.error(
							`Minovative Mind: RunCommandStep failed, immediately throwing error.`
						);
						throw error;
					}

					const shouldRetry = await this._reportStepError(
						error,
						rootUri,
						detailedStepDescription,
						currentStepNumberForDescription,
						totalStepsForDescription,
						currentTransientAttempt,
						this.MAX_TRANSIENT_STEP_RETRIES
					);

					if (shouldRetry.type === "retry") {
						currentTransientAttempt = shouldRetry.resetTransientCount
							? 0
							: currentTransientAttempt + 1;
						const delayMs = 10000 + currentTransientAttempt * 5000;
						await new Promise<void>((resolve, reject) => {
							if (combinedToken.isCancellationRequested) {
								return reject(new Error(ERROR_OPERATION_CANCELLED));
							}
							let disposable: vscode.Disposable;
							const timeout = setTimeout(() => {
								disposable.dispose();
								resolve();
							}, delayMs);
							disposable = combinedToken.onCancellationRequested(() => {
								clearTimeout(timeout);
								disposable.dispose();
								reject(new Error(ERROR_OPERATION_CANCELLED));
							});
						});
					} else if (shouldRetry.type === "skip") {
						currentStepCompletedSuccessfullyOrSkipped = true;
						this._logStepProgress(
							currentStepNumberForDescription,
							totalStepsForDescription,
							`Step SKIPPED by user.`,
							0,
							0
						);
						console.log(
							`Minovative Mind: User chose to skip Step ${currentStepNumberForDescription}.`
						);
					} else {
						throw new Error(ERROR_OPERATION_CANCELLED);
					}
				}
			}

			// If the step was trackable, update index (Instruction 6)
			if (isCurrentStepTrackable) {
				trackableStepIndex++;
			}

			index++;
		}

		return affectedFileUris;
	}

	private _disposeExecutionTerminals() {
		this.commandExecutionTerminals.forEach((terminal) => terminal.dispose());
		this.commandExecutionTerminals = [];
	}

	private _getStepDescription(
		step: PlanStep,
		index: number,
		totalSteps: number,
		currentTransientAttempt: number
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
							step.step.path
						)}\``;
					} else {
						detailedStepDescription = `Creating directory`;
					}
					break;
				case PlanStepAction.CreateFile:
					if (isCreateFileStep(step)) {
						if (step.step.generate_prompt) {
							detailedStepDescription = `Creating file: \`${path.basename(
								step.step.path
							)}\``;
						} else if (step.step.content) {
							detailedStepDescription = `Creating file: \`${path.basename(
								step.step.path
							)}\` (with predefined content)`;
						} else {
							detailedStepDescription = `Creating file: \`${path.basename(
								step.step.path
							)}\``;
						}
					} else {
						detailedStepDescription = `Creating file`;
					}
					break;
				case PlanStepAction.ModifyFile:
					if (isModifyFileStep(step)) {
						detailedStepDescription = `Modifying file: ${path.basename(
							step.step.path
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

	// 3. Modify _logStepProgress method
	private _logStepProgress(
		currentStepNumber: number,
		totalSteps: number,
		message: string,
		currentTransientAttempt: number,
		maxTransientRetries: number,
		isError: boolean = false,
		diffContent?: string
	): void {
		// Log to console first
		if (isError) {
			console.error(`Minovative Mind: ${message}`);
		} else {
			console.log(`Minovative Mind: ${message}`);
		}

		// Ignore internal batch update logs (currentStepNumber=0)
		if (currentStepNumber === 0) {
			return;
		}

		let status: PlanTimelineProgressMessage["status"];

		if (isError) {
			status = "failed";
		} else if (message.includes("SKIPPED")) {
			status = "skipped";
		} else if (
			message.includes(`Step ${currentStepNumber}/${totalSteps}`) &&
			!diffContent &&
			!message.includes("already has the desired content") &&
			!message.includes("Command completed successfully")
		) {
			// This covers the logging that occurs before execution starts (Line 348), providing the "Running..." message.
			status = "running";
		} else {
			// Successful completion log (e.g., created file, modified file, command success, already desired content).
			status = "success";
		}

		// 3.b. Replace original logic block with PlanTimelineProgressMessage
		this.postMessageToWebview({
			type: "planTimelineProgress",
			stepIndex: currentStepNumber - 1, // 0-based index
			status: status,
			detail: message,
			diffContent: diffContent,
		});
	}

	private async _reportStepError(
		error: any,
		rootUri: vscode.Uri,
		stepDescription: string,
		currentStepNumber: number,
		totalSteps: number,
		currentTransientAttempt: number,
		maxTransientRetries: number
	): Promise<{
		type: "retry" | "skip" | "cancel";
		resetTransientCount?: boolean;
	}> {
		const errorMsg = formatUserFacingErrorMessage(
			error,
			"Failed to execute plan step. Please review the details and try again.",
			"Step execution failed: ",
			rootUri
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
			this._logStepProgress(
				currentStepNumber,
				totalSteps,
				`FAILED (transient, auto-retrying): ${errorMsg}`,
				currentTransientAttempt + 1,
				maxTransientRetries,
				true
			);
			console.warn(
				`Minovative Mind: Step ${currentStepNumber} failed, auto-retrying due to transient error: ${errorMsg}`
			);
			return { type: "retry" };
		} else {
			this._logStepProgress(
				currentStepNumber,
				totalSteps,
				`FAILED: ${errorMsg}. Requires user intervention.`,
				currentTransientAttempt,
				maxTransientRetries,
				true
			);
			const choice = await vscode.window.showErrorMessage(
				`Step ${currentStepNumber}/${totalSteps} failed: ${errorMsg}. What would you like to do?`,
				"Retry Step",
				"Skip Step",
				"Cancel Plan"
			);

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
		relevantFiles: string[],
		workspaceRootUri: vscode.Uri,
		token: vscode.CancellationToken
	): Promise<string> {
		if (!relevantFiles || relevantFiles.length === 0) {
			return "";
		}

		const formattedSnippets: string[] = [];
		const maxFileSizeForSnippet = sidebarConstants.DEFAULT_SIZE;

		for (const relativePath of relevantFiles) {
			if (token.isCancellationRequested) {
				return formattedSnippets.join("\n");
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

				if (fileStat.size > maxFileSizeForSnippet) {
					console.warn(
						`[MinovativeMind] Skipping relevant file '${relativePath}' (size: ${fileStat.size} bytes) due to size limit for prompt inclusion.`
					);
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: too large for context (${(
							fileStat.size / 1024
						).toFixed(2)}KB > ${(maxFileSizeForSnippet / 1024).toFixed(
							2
						)}KB)]\n\`\`\`\n`
					);
					continue;
				}

				const contentBuffer = await vscode.workspace.fs.readFile(fileUri);
				const content = Buffer.from(contentBuffer).toString("utf8");

				if (content.includes("\0")) {
					console.warn(
						`[MinovativeMind] Skipping relevant file '${relativePath}' as it appears to be binary.`
					);
					formattedSnippets.push(
						`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: appears to be binary]\n\`\`\`\n`
					);
					continue;
				}

				fileContent = content;
			} catch (error: any) {
				if (
					error instanceof vscode.FileSystemError &&
					(error.code === "FileNotFound" || error.code === "EntryNotFound")
				) {
					console.warn(
						`[MinovativeMind] Relevant file not found: '${relativePath}'. Skipping.`
					);
				} else if (error.message.includes("is not a file")) {
					console.warn(
						`[MinovativeMind] Skipping directory '${relativePath}' as a relevant file.`
					);
				} else {
					console.error(
						`[MinovativeMind] Error reading relevant file '${relativePath}': ${error.message}. Skipping.`,
						error
					);
				}
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`plaintext\n[File skipped: could not be read or is inaccessible: ${error.message}]\n\`\`\`\n`
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
					}
				);
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`${languageId}\n${fileContent}\n\`\`\`\n${diagnostics}`
				);
			}
		}

		return formattedSnippets.join("\n");
	}

	private _postChatUpdateForPlanExecution(
		message: sidebarTypes.AppendRealtimeModelMessage
	): void {
		// 4. Modify addHistoryEntry call to remove message.isPlanStepUpdate
		this.provider.chatHistoryManager.addHistoryEntry(
			"model",
			message.value.text,
			message.diffContent,
			undefined,
			undefined
		);

		this.provider.chatHistoryManager.restoreChatHistoryToWebview();
	}

	private async _handleCreateDirectoryStep(
		step: CreateDirectoryStep,
		rootUri: vscode.Uri,
		changeLogger: SidebarProvider["changeLogger"]
	): Promise<void> {
		await vscode.workspace.fs.createDirectory(
			vscode.Uri.joinPath(rootUri, step.step.path)
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
		currentStepNumber: number, // Renamed parameter
		totalSteps: number,
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		relevantSnippets: string,
		affectedFileUris: Set<vscode.Uri>,
		changeLogger: SidebarProvider["changeLogger"],
		combinedToken: vscode.CancellationToken
	): Promise<void> {
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
							combinedToken
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
							`AI generation for ${step.step.path} failed, retrying (${attempt}/${this.MAX_TRANSIENT_STEP_RETRIES})... Error: ${errorMsg}`
						);
						await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
					} else {
						throw error;
					}
				}
			}
			if (!generatedResult) {
				throw new Error(
					`AI generation for ${step.step.path} failed after multiple retries.`
				);
			}
			desiredContent = generatedResult.content;
		}

		const cleanedDesiredContent = cleanCodeOutput(desiredContent ?? "");

		this._logStepProgress(
			currentStepNumber,
			totalSteps,
			`Creating file \`${path.basename(step.step.path)}\`...`,
			0,
			0
		);

		try {
			await vscode.workspace.fs.stat(fileUri);
			const existingContent = Buffer.from(
				await vscode.workspace.fs.readFile(fileUri)
			).toString("utf-8");

			if (existingContent === cleanedDesiredContent) {
				this._logStepProgress(
					currentStepNumber,
					totalSteps,
					`File \`${path.basename(
						step.step.path
					)}\` already has the desired content. Skipping.`,
					0,
					0
				);
			} else {
				const document = await vscode.workspace.openTextDocument(fileUri);
				const editor = await vscode.window.showTextDocument(document);

				await applyAITextEdits(
					editor,
					existingContent,
					cleanedDesiredContent,
					combinedToken
				);
				const newContentAfterApply = editor.document.getText();

				const { formattedDiff, summary } = await generateFileChangeSummary(
					existingContent,
					newContentAfterApply,
					step.step.path
				);

				this._logStepProgress(
					currentStepNumber,
					totalSteps,
					`Modified file \`${path.basename(step.step.path)}\``,
					0,
					0,
					false,
					formattedDiff
				);

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
					Buffer.from(cleanedDesiredContent)
				);

				const document = await vscode.workspace.openTextDocument(fileUri);
				await vscode.window.showTextDocument(document);

				const { formattedDiff, summary } = await generateFileChangeSummary(
					"",
					cleanedDesiredContent,
					step.step.path
				);

				this._logStepProgress(
					currentStepNumber,
					totalSteps,
					`Created file \`${path.basename(step.step.path)}\``,
					0,
					0,
					false,
					formattedDiff
				);
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
		combinedToken: vscode.CancellationToken
	): Promise<void> {
		const fileUri = vscode.Uri.joinPath(rootUri, step.step.path);

		const originalContent = Buffer.from(
			await vscode.workspace.fs.readFile(fileUri)
		).toString("utf-8");

		const modificationContext = {
			projectContext: context.projectContext,
			relevantSnippets: relevantSnippets,
			editorContext: context.editorContext,
			activeSymbolInfo: undefined,
		};

		let modifiedResult: { content: string } | undefined;
		let attempt = 0;
		let success = false;
		while (!success && attempt <= this.MAX_TRANSIENT_STEP_RETRIES) {
			if (combinedToken.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			try {
				modifiedResult = await this.enhancedCodeGenerator.modifyFileContent(
					step.step.path,
					step.step.modification_prompt,
					originalContent,
					modificationContext,
					this.provider.settingsManager.getSelectedModelName(),
					combinedToken
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
						`AI modification for ${step.step.path} failed, retrying (${attempt}/${this.MAX_TRANSIENT_STEP_RETRIES})... Error: ${errorMsg}`
					);
					await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
				} else {
					throw error;
				}
			}
		}
		if (!modifiedResult) {
			throw new Error(
				`AI modification for ${step.step.path} failed after multiple retries.`
			);
		}
		const newContent = cleanCodeOutput(modifiedResult.content);

		if (originalContent === newContent) {
			this._logStepProgress(
				currentStepNumber,
				totalSteps,
				`File \`${path.basename(
					step.step.path
				)}\` content is already as desired, no substantial modifications needed.`,
				0,
				0
			);
		} else {
			const document = await vscode.workspace.openTextDocument(fileUri);
			const editor = await vscode.window.showTextDocument(document);
			await applyAITextEdits(
				editor,
				originalContent,
				newContent,
				combinedToken
			);
			const newContentAfterApply = editor.document.getText();

			const { formattedDiff, summary } = await generateFileChangeSummary(
				originalContent,
				newContentAfterApply,
				step.step.path
			);

			this._logStepProgress(
				currentStepNumber,
				totalSteps,
				`Modified file \`${path.basename(step.step.path)}\``,
				0,
				0,
				false,
				formattedDiff
			);

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
		combinedToken: vscode.CancellationToken
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
			}/${totalSteps}] About to display command execution prompt: ${displayCommand}`
		);

		const userChoice = await vscode.window.showInformationMessage(
			promptMessage,
			{ modal: true },
			"Allow",
			"Skip"
		);

		// Remove all calls to this._logStepProgress (Instruction 1)
		console.log(
			`Minovative Mind: [Command Step ${
				index + 1
			}/${totalSteps}] User choice for command: ${displayCommand} is: ${userChoice}`
		);

		// Check for cancellation immediately after capturing userChoice
		if (combinedToken.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		// Handle undefined userChoice (prompt dismissed) (Instruction 2)
		if (userChoice === undefined) {
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] User prompt dismissed without selection; treating as skip.`
			);
			return true;
		}

		if (userChoice === "Allow") {
			commandTerminal.sendText(`${displayCommand}`, true);

			try {
				const commandResult: CommandResult = await executeCommand(
					executable,
					args,
					rootUri.fsPath,
					combinedToken,
					this.provider.activeChildProcesses,
					commandTerminal // Pass the dedicated terminal
				);

				if (commandResult.exitCode === 0) {
					console.log(
						`Minovative Mind: [Command Step ${
							index + 1
						}/${totalSteps}] Command completed successfully: \`${displayCommand}\`.`
					);
					return true;
				} else {
					const errorMessage = `Command failed with exit code ${commandResult.exitCode}: \`${displayCommand}\`.`;
					console.error(
						`Minovative Mind: [Command Step ${
							index + 1
						}/${totalSteps}] ERROR: ${errorMessage}`
					);
					throw new Error("RunCommandStep failed with non-zero exit code.");
				}
			} catch (commandSpawnError: any) {
				const errorMessage = `Failed to execute command '${displayCommand}': ${commandSpawnError.message}`;
				console.error(
					`Minovative Mind: [Command Step ${
						index + 1
					}/${totalSteps}] ERROR: ${errorMessage}`,
					commandSpawnError
				);

				throw new Error("RunCommandStep failed during spawning or execution.");
			}
		} else {
			// userChoice is "Skip"
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] Step SKIPPED by user.`
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
}
