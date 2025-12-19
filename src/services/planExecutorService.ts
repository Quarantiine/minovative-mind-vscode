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

export class PlanExecutorService {
	private commandExecutionTerminals: vscode.Terminal[] = [];
	private contextCache = new Map<string, string>();

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
		private urlContextService: UrlContextService,
		private enhancedCodeGenerator: EnhancedCodeGenerator,
		private readonly MAX_TRANSIENT_STEP_RETRIES: number
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
		token: vscode.CancellationToken
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
				}
			);
		});
	}

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
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		combinedToken: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		originalRootInstruction: string
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
					combinedToken
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
				if (combinedToken.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}

				const detailedStepDescription = this._getStepDescription(
					step,
					index, // 0-based index
					totalSteps,
					currentTransientAttempt
				);

				// Replaced conditional progress logging with console.log
				if (isCommandStep) {
					console.log(
						`Minovative Mind (Command Step ${currentStepNumber}/${totalSteps}): Starting ${detailedStepDescription}`
					);
				} else {
					console.log(
						`Minovative Mind (Execution Step ${currentStepNumber}/${totalSteps}): Starting ${detailedStepDescription}`
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
							combinedToken
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
							combinedToken
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

					// If it's a command step failure, throw immediately (no retries for commands)
					if (isCommandStep) {
						console.error(
							`Minovative Mind: Command Step ${currentStepNumber} failed, immediately throwing error: ${errorMsg}`
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
						combinedToken // Pass token to race UI
					);

					if (shouldRetry.type === "retry") {
						currentTransientAttempt = shouldRetry.resetTransientCount
							? 0
							: currentTransientAttempt + 1;
						const delayMs = 10000 + currentTransientAttempt * 5000;

						console.warn(
							`Minovative Mind: Step ${currentStepNumber} failed, delaying ${delayMs}ms before retrying.`
						);

						// Use _delay which handles cancellation during the wait
						await this._delay(delayMs, combinedToken);
					} else if (shouldRetry.type === "skip") {
						currentStepCompletedSuccessfullyOrSkipped = true;
						console.log(
							`Minovative Mind: User chose to skip Step ${currentStepNumber}.`
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

	private async _reportStepError(
		error: any,
		rootUri: vscode.Uri,
		stepDescription: string,
		currentTransientAttempt: number,
		maxTransientRetries: number,
		token?: vscode.CancellationToken
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
			// Replaced _logStepProgress (Line 485)
			console.warn(
				`Minovative Mind: FAILED (transient, auto-retrying): ${stepDescription}. Attempt ${
					currentTransientAttempt + 1
				}/${maxTransientRetries}. Error: ${errorMsg}`
			);
			return { type: "retry" };
		} else {
			// Replaced _logStepProgress (Line 497)
			console.error(
				`Minovative Mind: FAILED: ${stepDescription}. Requires user intervention. Error: ${errorMsg}`
			);

			// Use raceWithCancellation to allow terminating the prompt if operation is cancelled
			let choice: string | undefined;
			const showMessagePromise = vscode.window.showErrorMessage(
				`Plan step failed: ${stepDescription} failed with error: ${errorMsg}. What would you like to do?`,
				"Retry Step",
				"Skip Step",
				"Cancel Plan"
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
						await this._delay(2000 * attempt, combinedToken);
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

		console.log(
			`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Creating file \`${path.basename(
				step.step.path
			)}\`...`
		);

		try {
			await vscode.workspace.fs.stat(fileUri);
			const existingContent = Buffer.from(
				await vscode.workspace.fs.readFile(fileUri)
			).toString("utf-8");

			if (existingContent === cleanedDesiredContent) {
				console.log(
					`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] File \`${path.basename(
						step.step.path
					)}\` already has the desired content. Skipping.`
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

				// Replaced _logStepProgress (Modification success)
				console.log(
					`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Modified file \`${path.basename(
						step.step.path
					)}\``
				);

				// 2. In the existing file modification path (the `try` block), update the `chatMessageText` string to use the format: `Step ${currentStepNumber}/${totalSteps}: Modified file: \`${path.basename(step.step.path)}\`\n\n${summary}`.
				const chatMessageText = `Step ${currentStepNumber}/${totalSteps}: Modified file: \`${path.basename(
					step.step.path
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
					Buffer.from(cleanedDesiredContent)
				);

				const document = await vscode.workspace.openTextDocument(fileUri);
				await vscode.window.showTextDocument(document);

				const { formattedDiff, summary } = await generateFileChangeSummary(
					"",
					cleanedDesiredContent,
					step.step.path
				);

				// Replaced _logStepProgress (Creation success)
				console.log(
					`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Created file \`${path.basename(
						step.step.path
					)}\``
				);

				// 3. In the new file creation path (the `catch` block), update the `chatMessageText` string to use the format: `Step ${currentStepNumber}/${totalSteps}: Created file: \`${path.basename(step.step.path)}\`\n\n${summary}`.
				const chatMessageText = `Step ${currentStepNumber}/${totalSteps}: Created file: \`${path.basename(
					step.step.path
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
					await this._delay(2000 * attempt, combinedToken);
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
			console.log(
				`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] File \`${path.basename(
					step.step.path
				)}\` content is already as desired, no substantial modifications needed.`
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

			// Update the _logStepProgress message
			console.log(
				`Minovative Mind: [Step ${currentStepNumber}/${totalSteps}] Modified file \`${path.basename(
					step.step.path
				)}\``
			);

			// Update the chatMessageText string format
			const chatMessageText = `Step ${currentStepNumber}/${totalSteps}: Modified file: \`${path.basename(
				step.step.path
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

		// Use raceWithCancellation for the modal prompt
		const userChoicePromise = vscode.window.showInformationMessage(
			promptMessage,
			{ modal: true },
			"Allow",
			"Skip"
		);
		const userChoice = await this._raceWithCancellation(
			userChoicePromise,
			combinedToken
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

		// Handle undefined userChoice (prompt dismissed or cancelled) (Instruction 2)
		if (userChoice === undefined) {
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] User prompt dismissed without selection; treating as skip.`
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
					commandTerminal
				);

				// Instruction 3: Removed logic checking for non-zero exit code and throwing.
				// Instruction 4: Removed call to this._postCommandResultToChat(...)
			} catch (error: any) {
				if (error.message === ERROR_OPERATION_CANCELLED) {
					throw error;
				}

				// Instruction 6: Catch execution/spawn errors (rejected promise from executeCommand)
				const wrappedError = new Error(
					`RunCommandStep failed to spawn/execute command: ${displayCommand}. Error: ${error.message}`
				);
				console.error(
					`Minovative Mind: [Command Step ${
						index + 1
					}/${totalSteps}] Execution failed (Spawn failure or Promise Rejection): ${
						wrappedError.message
					}`,
					error
				);
				throw wrappedError;
			}

			// Instruction 5 & 2c: Success (command spawned successfully). Log and return true.
			console.log(
				`Minovative Mind: [Command Step ${
					index + 1
				}/${totalSteps}] Command completed execution (Exit Code: ${
					commandResult?.exitCode
				}). Continuing plan.`
			);
			return true;
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
