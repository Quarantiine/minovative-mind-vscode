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
import { GitConflictResolutionService } from "./gitConflictResolutionService";
import { applyAITextEdits, cleanCodeOutput } from "../utils/codeUtils";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { UrlContextService } from "./urlContextService";
import { EnhancedCodeGenerator } from "../ai/enhancedCodeGeneration";
import { executeCommand, CommandResult } from "../utils/commandExecution";
import * as sidebarConstants from "../sidebar/common/sidebarConstants";
import {
	CommandSecurityService,
	ExecutableConfig,
} from "./commandSecurityService"; // Added import

export class PlanExecutorService {
	private minovativeMindTerminal: vscode.Terminal | undefined;
	private commandSecurityService: CommandSecurityService; // Added new property

	constructor(
		private provider: SidebarProvider,
		private workspaceRootUri: vscode.Uri,
		private postMessageToWebview: (message: ExtensionToWebviewMessages) => void,
		private urlContextService: UrlContextService,
		private enhancedCodeGenerator: EnhancedCodeGenerator,
		private gitConflictResolutionService: GitConflictResolutionService,
		private readonly MAX_TRANSIENT_STEP_RETRIES: number
	) {
		this.commandSecurityService = new CommandSecurityService(); // Initialize new property
	}

	private getOrCreateTerminal(): vscode.Terminal {
		if (
			this.minovativeMindTerminal &&
			!this.minovativeMindTerminal.exitStatus
		) {
			return this.minovativeMindTerminal;
		}

		this.minovativeMindTerminal = vscode.window.terminals.find(
			(t) => t.name === "Minovative Mind Commands"
		);

		if (!this.minovativeMindTerminal) {
			this.minovativeMindTerminal = vscode.window.createTerminal({
				name: "Minovative Mind Commands",
				cwd: this.workspaceRootUri.fsPath,
			});
		}

		this.minovativeMindTerminal.show(true);
		return this.minovativeMindTerminal;
	}

	public async executePlan(
		plan: ExecutionPlan,
		planContext: sidebarTypes.PlanGenerationContext,
		operationToken: vscode.CancellationToken
	): Promise<void> {
		this.provider.currentExecutionOutcome = undefined;
		this.provider.activeChildProcesses = [];

		const rootUri = this.workspaceRootUri;

		this.postMessageToWebview({
			type: "updateLoadingState",
			value: true,
		});

		this.postMessageToWebview({
			type: "planExecutionStarted",
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
							plan.steps!,
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

	private async _executePlanSteps(
		steps: PlanStep[],
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		combinedToken: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		originalRootInstruction: string
	): Promise<Set<vscode.Uri>> {
		const affectedFileUris = new Set<vscode.Uri>();
		const { changeLogger } = this.provider;

		// 1. Categorize all incoming PlanSteps
		const createDirectorySteps: CreateDirectoryStep[] = [];
		const createFileSteps: CreateFileStep[] = [];
		const runCommandSteps: RunCommandStep[] = [];
		const modifyFileStepsByPath = new Map<string, ModifyFileStep[]>();
		const modifyFileOrder: string[] = []; // To preserve the order of first appearance

		for (const step of steps) {
			if (combinedToken.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}

			// Input Step Validation: Ensure `step` is a valid object before using type guards.
			// This prevents errors if the steps array contains primitive types or malformed objects.
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
				continue; // Skip this invalid step to prevent further errors
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

		// 2. Aggregate ModifyFileStep actions for each file path
		const consolidatedModifyFileSteps: ModifyFileStep[] = [];
		for (const filePath of modifyFileOrder) {
			const fileModifications = modifyFileStepsByPath.get(filePath)!;
			// Combine all modification prompts into a single comprehensive prompt
			const consolidatedPrompt = fileModifications
				.map((s) => s.step.modification_prompt)
				.join("\n\n---\n\n"); // Use a clear separator for multiple instructions

			// Create a new ModifyFileStep representing the consolidated changes
			consolidatedModifyFileSteps.push({
				step: {
					action: PlanStepAction.ModifyFile,
					path: filePath,
					modification_prompt: consolidatedPrompt,
					// A general description for the consolidated step
					description: `Modifications for file: \`${filePath}\``,
				},
			});
		}

		// 3. Reorder the execution sequence
		const orderedSteps: PlanStep[] = [
			...createDirectorySteps,
			...createFileSteps,
			...consolidatedModifyFileSteps,
			...runCommandSteps,
		];

		const totalOrderedSteps = orderedSteps.length;

		let index = 0;
		while (index < totalOrderedSteps) {
			const step = orderedSteps[index];
			let currentStepCompletedSuccessfullyOrSkipped = false;
			let currentTransientAttempt = 0;

			const relevantSnippets = await this._formatRelevantFilesForPrompt(
				context.relevantFiles ?? [],
				rootUri,
				combinedToken
			);

			while (!currentStepCompletedSuccessfullyOrSkipped) {
				if (combinedToken.isCancellationRequested) {
					throw new Error(ERROR_OPERATION_CANCELLED);
				}

				const detailedStepDescription = this._getStepDescription(
					step,
					index,
					totalOrderedSteps, // Use the new total
					currentTransientAttempt
				);
				this._logStepProgress(
					index + 1,
					totalOrderedSteps, // Use the new total
					detailedStepDescription,
					currentTransientAttempt,
					this.MAX_TRANSIENT_STEP_RETRIES
				);

				try {
					if (isCreateDirectoryStep(step)) {
						await this._handleCreateDirectoryStep(step, rootUri, changeLogger);
					} else if (isCreateFileStep(step)) {
						await this._handleCreateFileStep(
							step,
							index,
							totalOrderedSteps, // Use the new total
							rootUri,
							context,
							relevantSnippets,
							affectedFileUris,
							changeLogger,
							combinedToken
						);
					} else if (isModifyFileStep(step)) {
						// This will now handle the consolidated ModifyFileStep
						await this._handleModifyFileStep(
							step,
							index,
							totalOrderedSteps, // Use the new total
							rootUri,
							context,
							relevantSnippets,
							affectedFileUris,
							changeLogger,
							this.provider.settingsManager,
							combinedToken
						);
					} else if (isRunCommandStep(step)) {
						const commandSuccess = await this._handleRunCommandStep(
							step,
							index,
							totalOrderedSteps, // Use the new total
							rootUri,
							context,
							progress,
							originalRootInstruction,
							combinedToken
						);
						if (!commandSuccess) {
							throw new Error(
								`Command execution failed for '${step.step.command}'.`
							);
						}
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

					const shouldRetry = await this._reportStepError(
						error,
						rootUri,
						detailedStepDescription,
						index + 1,
						totalOrderedSteps, // Use the new total
						currentTransientAttempt,
						this.MAX_TRANSIENT_STEP_RETRIES
					);

					if (shouldRetry.type === "retry") {
						currentTransientAttempt = shouldRetry.resetTransientCount
							? 0
							: currentTransientAttempt + 1;
						await new Promise((resolve) =>
							setTimeout(resolve, 10000 + currentTransientAttempt * 5000)
						);
					} else if (shouldRetry.type === "skip") {
						currentStepCompletedSuccessfullyOrSkipped = true;
						this._logStepProgress(
							index + 1,
							totalOrderedSteps, // Use the new total
							`Step SKIPPED by user.`,
							0,
							0
						);
						console.log(
							`Minovative Mind: User chose to skip Step ${index + 1}.`
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
		if (step.step.description && step.step.description.trim() !== "") {
			detailedStepDescription = step.step.description;
		} else {
			switch (step.step.action) {
				case PlanStepAction.CreateDirectory:
					if (isCreateDirectoryStep(step)) {
						detailedStepDescription = `Creating directory: \`${step.step.path}\``;
					} else {
						detailedStepDescription = `Creating directory`;
					}
					break;
				case PlanStepAction.CreateFile:
					if (isCreateFileStep(step)) {
						if (step.step.generate_prompt) {
							detailedStepDescription = `Creating file: \`${step.step.path}\``;
						} else if (step.step.content) {
							detailedStepDescription = `Creating file: \`${step.step.path}\` (with predefined content)`;
						} else {
							detailedStepDescription = `Creating file: \`${step.step.path}\``;
						}
					} else {
						detailedStepDescription = `Creating file`;
					}
					break;
				case PlanStepAction.ModifyFile:
					if (isModifyFileStep(step)) {
						detailedStepDescription = `Modifying file: \`${step.step.path}\``;
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

	private _logStepProgress(
		currentStepNumber: number,
		totalSteps: number,
		message: string,
		currentTransientAttempt: number,
		maxTransientRetries: number,
		isError: boolean = false,
		diffContent?: string
	): void {
		const appendMessage: sidebarTypes.AppendRealtimeModelMessage = {
			type: "appendRealtimeModelMessage",
			value: {
				text: message,
				isError: isError,
			},
			isPlanStepUpdate: true,
			diffContent: diffContent,
		};

		this._postChatUpdateForPlanExecution(appendMessage);

		if (isError) {
			console.error(`Minovative Mind: ${message}`);
		} else {
			console.log(`Minovative Mind: ${message}`);
		}
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
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\n\`\`\`${languageId}\n${fileContent}\n\`\`\`\n`
				);
			}
		}

		return formattedSnippets.join("\n");
	}

	private _postChatUpdateForPlanExecution(
		message: sidebarTypes.AppendRealtimeModelMessage
	): void {
		this.provider.chatHistoryManager.addHistoryEntry(
			"model",
			message.value.text,
			message.diffContent,
			undefined,
			undefined,
			message.isPlanStepUpdate
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
		index: number,
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

			const generatedResult =
				await this.enhancedCodeGenerator.generateFileContent(
					step.step.path,
					step.step.generate_prompt,
					generationContext,
					this.provider.settingsManager.getSelectedModelName(),
					combinedToken
				);
			desiredContent = generatedResult.content;
		}

		const cleanedDesiredContent = cleanCodeOutput(desiredContent ?? "");

		try {
			await vscode.workspace.fs.stat(fileUri);
			const existingContent = Buffer.from(
				await vscode.workspace.fs.readFile(fileUri)
			).toString("utf-8");

			if (existingContent === cleanedDesiredContent) {
				this._logStepProgress(
					index + 1,
					totalSteps,
					`File \`${step.step.path}\` already has the desired content. Skipping.`,
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
					index + 1,
					totalSteps,
					`Modified file \`${step.step.path}\``,
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
					index + 1,
					totalSteps,
					`Created file \`${step.step.path}\``,
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
		index: number,
		totalSteps: number,
		rootUri: vscode.Uri,
		context: sidebarTypes.PlanGenerationContext,
		relevantSnippets: string,
		affectedFileUris: Set<vscode.Uri>,
		changeLogger: SidebarProvider["changeLogger"],
		settingsManager: SidebarProvider["settingsManager"],
		combinedToken: vscode.CancellationToken
	): Promise<void> {
		const fileUri = vscode.Uri.joinPath(rootUri, step.step.path);
		const existingContent = Buffer.from(
			await vscode.workspace.fs.readFile(fileUri)
		).toString("utf-8");

		const modificationContext = {
			projectContext: context.projectContext,
			relevantSnippets: relevantSnippets,
			editorContext: context.editorContext,
			activeSymbolInfo: undefined,
		};

		// The modification_prompt here will be the consolidated prompt from multiple steps
		let modifiedContent = (
			await this.enhancedCodeGenerator.modifyFileContent(
				step.step.path,
				step.step.modification_prompt,
				existingContent,
				modificationContext,
				settingsManager.getSelectedModelName(),
				combinedToken
			)
		).content;

		let document: vscode.TextDocument;
		let editor: vscode.TextEditor;
		try {
			document = await vscode.workspace.openTextDocument(fileUri);
			editor = await vscode.window.showTextDocument(document);
		} catch (docError: any) {
			throw new Error(
				`Failed to open document ${fileUri.fsPath} for modification: ${docError.message}`
			);
		}

		await applyAITextEdits(
			editor,
			editor.document.getText(),
			modifiedContent,
			combinedToken
		);

		const newContentAfterApply = editor.document.getText();

		const { formattedDiff, summary, addedLines, removedLines } =
			await generateFileChangeSummary(
				existingContent,
				newContentAfterApply,
				step.step.path
			);

		if (addedLines.length > 0 || removedLines.length > 0) {
			affectedFileUris.add(fileUri);

			if (
				context.isMergeOperation &&
				context.editorContext &&
				fileUri.toString() === context.editorContext.documentUri.toString()
			) {
				await this.gitConflictResolutionService.unmarkFileAsResolved(fileUri);
			}

			this._logStepProgress(
				index + 1,
				totalSteps,
				`Modified file \`${step.step.path}\``,
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
		} else {
			this._logStepProgress(
				index + 1,
				totalSteps,
				`File \`${step.step.path}\` content is already as desired, no substantial modifications needed.`,
				0,
				0
			);
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
			CommandSecurityService.parseCommandArguments(commandString); // Refactored

		let effectiveExecConfig: ExecutableConfig;
		try {
			effectiveExecConfig = await this.commandSecurityService.isCommandSafe(
				// Refactored
				executable,
				args,
				commandString
			);
		} catch (validationError: any) {
			this._logStepProgress(
				index + 1,
				totalSteps,
				`Command blocked: ${validationError.message}`,
				0,
				0,
				true
			);
			if (
				this.minovativeMindTerminal &&
				!this.minovativeMindTerminal.exitStatus
			) {
				this.minovativeMindTerminal.sendText(
					`\nERROR: Command Blocked - ${validationError.message}\n`,
					true
				);
			}
			throw new Error(`Command blocked: ${validationError.message}`);
		}

		const displayCommand = [
			executable,
			...args.map(CommandSecurityService.sanitizeArgumentForDisplay), // Refactored
		].join(" ");

		let promptMessage = `Command:\n[ \`${displayCommand}.\` ]`;
		let modalPrompt = true;

		if (
			effectiveExecConfig.requiresExplicitConfirmation ||
			effectiveExecConfig.isHighRisk
		) {
			promptMessage += `\n\n🚨 CRITICAL SECURITY ALERT: Are you absolutely sure you want to allow this?`;
		} else {
			promptMessage += `\n\n⚠️ WARNING: Please review it carefully. The plan wants to run the command above. Allow?`;
		}

		// Add console log before showing the warning message
		console.log(
			"Minovative Mind: About to display command execution prompt..."
		);

		const userChoice = await vscode.window.showInformationMessage(
			promptMessage,
			{ modal: modalPrompt },
			"Allow",
			"Skip"
		);

		// Add console log after capturing user choice
		console.log(`Minovative Mind: User choice for command: 
${displayCommand}
 is: 
${userChoice}`);

		// Check for cancellation immediately after capturing userChoice
		if (combinedToken.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		// Handle undefined userChoice (prompt dismissed)
		if (userChoice === undefined) {
			console.log(
				"Minovative Mind: User prompt dismissed without selection; treating as skip."
			);
			this._logStepProgress(
				index + 1,
				totalSteps,
				`Step SKIPPED by user (prompt dismissed).`,
				0,
				0
			);
			if (
				this.minovativeMindTerminal &&
				!this.minovativeMindTerminal.exitStatus
			) {
				this.minovativeMindTerminal.sendText(
					`\necho --- Command SKIPPED (prompt dismissed) ---\n`,
					true
				);
			}
			return true;
		}

		if (userChoice === "Allow") {
			const terminal = this.getOrCreateTerminal();
			terminal.sendText(`${commandString}\n`);

			try {
				const commandResult: CommandResult = await executeCommand(
					executable,
					args,
					rootUri.fsPath,
					combinedToken,
					this.provider.activeChildProcesses,
					terminal
				);

				if (commandResult.exitCode !== 0) {
					const errorMessage = `Command \`${displayCommand}\` failed with exit code ${commandResult.exitCode}.
                                    \n--- STDOUT ---\n${commandResult.stdout}
                                    \n--- STDERR ---\n${commandResult.stderr}`;

					this._logStepProgress(
						index + 1,
						totalSteps,
						`Command execution error.`,
						0,
						0,
						true,
						errorMessage
					);

					if (
						this.minovativeMindTerminal &&
						!this.minovativeMindTerminal.exitStatus
					) {
						this.minovativeMindTerminal.sendText(
							`\necho --- Command FAILED: ${displayCommand} (Exit Code: ${commandResult.exitCode}) ---\n`,
							false
						);
					}

					throw new Error(
						`Command '${displayCommand}' failed. Output: ${errorMessage}`
					);
				} else {
					const successMessage = `Command \`${displayCommand}\` executed successfully.
                                    \n--- STDOUT ---\n${commandResult.stdout}
                                    \n--- STDERR ---\n${commandResult.stderr}`;

					this._logStepProgress(
						index + 1,
						totalSteps,
						`Command executed.`,
						0,
						0,
						false,
						successMessage
					);
					if (
						this.minovativeMindTerminal &&
						!this.minovativeMindTerminal.exitStatus
					) {
						this.minovativeMindTerminal.sendText(
							`\necho --- Command SUCCEEDED ---\n`,
							false
						);
					}
					return true;
				}
			} catch (commandExecError: any) {
				if (commandExecError.message === ERROR_OPERATION_CANCELLED) {
					throw commandExecError;
				}
				let detailedError = `Error executing command \`${displayCommand}\`: ${commandExecError.message}`;
				this._logStepProgress(index + 1, totalSteps, detailedError, 0, 0, true);

				if (
					this.minovativeMindTerminal &&
					!this.minovativeMindTerminal.exitStatus
				) {
					this.minovativeMindTerminal.sendText(
						`\nERROR: ${detailedError}\n`,
						true
					);
				}
				throw commandExecError;
			}
		} else {
			// userChoice is "Skip"
			this._logStepProgress(
				index + 1,
				totalSteps,
				`Step SKIPPED by user.`,
				0,
				0
			);
			if (
				this.minovativeMindTerminal &&
				!this.minovativeMindTerminal.exitStatus
			) {
				this.minovativeMindTerminal.sendText(
					`\necho --- Command SKIPPED ---\n`,
					true
				);
			}
			return true;
		}
	}
}
