import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { EnhancedCodeGenerator } from "../../ai/enhancedCodeGeneration";
import { _performModification } from "./aiInteractionService";
import { AIRequestService } from "../../services/aiRequestService";
import { applyAITextEdits, cleanCodeOutput } from "../../utils/codeUtils";
import { ProjectChangeLogger } from "../../workflow/ProjectChangeLogger";
import { generateFileChangeSummary } from "../../utils/diffingUtils";
import { FileChangeEntry } from "../../types/workflow";
import { ExtensionToWebviewMessages } from "../../sidebar/common/sidebarTypes";
import { DEFAULT_FLASH_MODEL } from "../common/sidebarConstants";
import { getLanguageId } from "../../utils/codeAnalysisUtils";
import {
	EnhancedGenerationContext,
	EditorContext,
} from "../../types/codeGenerationTypes";
import { formatSuccessfulChangesForPrompt } from "../../workflow/changeHistoryFormatter";
import { formatUserFacingErrorMessage } from "../../utils/errorFormatter";
import { ERROR_OPERATION_CANCELLED } from "../../ai/gemini";

// Define enums and interfaces for plan execution
export enum PlanStepAction {
	ModifyFile = "modifyFile",
	CreateFile = "createFile",
	DeleteFile = "deleteFile",
	ViewFile = "viewFile",
	TypeContent = "typeContent",
	ExecuteCommand = "executeCommand",
	ShowMessage = "showMessage",
	RunCommand = "runCommand",
}

export interface PlanStep {
	action: PlanStepAction;
	file?: string; // Path to the file for file-related actions
	content?: string; // Content for actions like CreateFile, TypeContent
	modificationPrompt?: string; // Prompt for ModifyFile action
	description: string; // User-friendly description of the step
	generate_prompt?: string; // ADDED: Prompt for AI-driven content generation for CreateFile
	// other properties as needed for different actions
	command?: string; // For executeCommand, runCommand
	args?: string[]; // For executeCommand, runCommand
	message?: string; // For showMessage
}

/**
 * Represents the outcome of executing a single plan step,
 * signaling success/failure and the type of error for retry/skip decisions.
 */
export interface PlanStepExecutionResult {
	success: boolean;
	errorType?: "cancellation" | "transient" | "non-transient";
	errorMessage?: string;
	diffContent?: string;
}

export class PlanExecutionService {
	constructor(
		private readonly changeLogger: ProjectChangeLogger,
		private readonly aiRequestService: AIRequestService,
		private readonly postChatUpdate: (message: {
			type: string;
			value: { text: string; isError?: boolean };
			diffContent?: string;
		}) => void,
		private readonly postMessageToWebview: (
			message: ExtensionToWebviewMessages
		) => void,
		private readonly enhancedCodeGenerator: EnhancedCodeGenerator
	) {}

	private _reportErrorAndReturnResult(
		error: any,
		defaultMessage: string,
		filePath: string | undefined,
		actionType: PlanStepAction,
		workspaceRootUri: vscode.Uri | undefined
	): PlanStepExecutionResult {
		let errorType: PlanStepExecutionResult["errorType"] = "non-transient";
		const errorMessage = formatUserFacingErrorMessage(
			error,
			defaultMessage,
			`[PlanExecutionService:${actionType}] `,
			workspaceRootUri
		);

		if (errorMessage.includes(ERROR_OPERATION_CANCELLED)) {
			errorType = "cancellation";
		} else if (
			errorMessage.includes("quota exceeded") ||
			errorMessage.includes("rate limit exceeded") ||
			errorMessage.includes("network issue") ||
			errorMessage.includes("AI service unavailable") ||
			errorMessage.includes("timeout")
		) {
			errorType = "transient";
		}

		this.postChatUpdate({
			type: "appendRealtimeModelMessage",
			value: {
				text: filePath
					? `Error processing file \`${path.basename(
							filePath
					  )}\`: ${errorMessage}`
					: `Error: ${errorMessage}`,
				isError: true,
			},
		});

		return {
			success: false,
			errorType: errorType,
			errorMessage: errorMessage,
		};
	}

	private async _typeContentIntoEditor(
		editor: vscode.TextEditor,
		content: string,
		token: vscode.CancellationToken,
		progress?: vscode.Progress<{ message?: string; increment?: number }>
	): Promise<void> {
		const chunkSize = 5; // Characters per chunk
		const delayMs = 0; // Delay between chunks

		for (let i = 0; i < content.length; i += chunkSize) {
			if (token.isCancellationRequested) {
				console.log("Typing animation cancelled.");
				throw new Error("Operation cancelled by user."); // Standard cancellation error
			}
			const chunk = content.substring(
				i,
				Math.min(i + chunkSize, content.length)
			);

			await editor.edit((editBuilder) => {
				const endPosition = editor.document.positionAt(
					editor.document.getText().length
				);
				editBuilder.insert(endPosition, chunk);
			});

			const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
			editor.revealRange(lastLine.range, vscode.TextEditorRevealType.Default);

			if (progress) {
				progress.report({
					message: `Typing content into ${path.basename(
						editor.document.fileName
					)}...`,
				});
			}
			if (!token.isCancellationRequested) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}

	private async _handleTypeContentAction(
		step: PlanStep,
		token: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		workspaceRootUri: vscode.Uri
	): Promise<PlanStepExecutionResult> {
		if (token.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}
		if (!step.file || !step.content) {
			const errMsg = "Missing file path or content for TypeContent action.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				step.file,
				PlanStepAction.TypeContent,
				workspaceRootUri
			);
		}
		const docToTypeUri = vscode.Uri.file(step.file);
		try {
			const docToType = await vscode.workspace.openTextDocument(docToTypeUri);
			const editorToType = await vscode.window.showTextDocument(docToType);
			await this._typeContentIntoEditor(
				editorToType,
				step.content,
				token,
				progress
			);
			return { success: true };
		} catch (error: any) {
			return this._reportErrorAndReturnResult(
				error,
				`Failed to type content into editor for ${path.basename(
					docToTypeUri.fsPath
				)}.`,
				step.file,
				PlanStepAction.TypeContent,
				workspaceRootUri
			);
		}
	}

	private async _handleDeleteFileAction(
		step: PlanStep,
		token: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		workspaceRootUri: vscode.Uri
	): Promise<PlanStepExecutionResult> {
		if (token.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}
		if (!step.file) {
			const errMsg = "Missing file path for DeleteFile action.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				step.file,
				PlanStepAction.DeleteFile,
				workspaceRootUri
			);
		}
		const targetFileUri = vscode.Uri.joinPath(workspaceRootUri, step.file);
		const fileName = path.basename(targetFileUri.fsPath);

		let fileContentBeforeDelete: string = "";

		try {
			progress.report({
				message: `Reading content of ${fileName} before deletion...`,
			});
			const contentBuffer = await vscode.workspace.fs.readFile(targetFileUri);
			fileContentBeforeDelete = contentBuffer.toString();
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				console.warn(
					`[PlanExecutionService] File ${fileName} not found for reading before deletion. Assuming empty content for logging.`
				);
				fileContentBeforeDelete = "";
			} else {
				return this._reportErrorAndReturnResult(
					error,
					`Failed to read file ${fileName} before deletion.`,
					step.file,
					PlanStepAction.DeleteFile,
					workspaceRootUri
				);
			}
		}

		try {
			progress.report({ message: `Deleting file: ${fileName}...` });
			await vscode.workspace.fs.delete(targetFileUri, { useTrash: true });
			console.log(
				`[PlanExecutionService] Successfully deleted file: ${fileName}`
			);
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				console.warn(
					`[PlanExecutionService] File ${fileName} already not found. No deletion needed.`
				);
			} else {
				return this._reportErrorAndReturnResult(
					error,
					`Failed to delete file ${fileName}.`,
					step.file,
					PlanStepAction.DeleteFile,
					workspaceRootUri
				);
			}
		}

		const { summary, removedLines, formattedDiff } =
			await generateFileChangeSummary(fileContentBeforeDelete, "", step.file);

		const deleteChangeEntry: FileChangeEntry = {
			filePath: step.file,
			changeType: "deleted",
			originalContent: fileContentBeforeDelete,
			newContent: "",
			summary: summary,
			removedLines: removedLines,
			addedLines: [],
			timestamp: Date.now(),
			diffContent: formattedDiff,
		};

		this.changeLogger.logChange(deleteChangeEntry);

		this.postChatUpdate({
			type: "appendRealtimeModelMessage",
			value: {
				text: `Successfully deleted \`${fileName}\`.`,
				isError: false,
			},
			diffContent: formattedDiff,
		});

		progress.report({
			message: `Successfully deleted ${fileName}.`,
		});
		return { success: true, diffContent: formattedDiff };
	}

	private async _handleCreateFileAction(
		step: PlanStep,
		token: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		workspaceRootUri: vscode.Uri,
		modelName: string
	): Promise<PlanStepExecutionResult> {
		if (token.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}
		if (!step.file) {
			const errMsg = "Missing file path for CreateFile action.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				step.file,
				PlanStepAction.CreateFile,
				workspaceRootUri
			);
		}
		const targetFileUri = vscode.Uri.joinPath(workspaceRootUri, step.file);

		let contentToProcess: string | undefined = step.content;

		if (step.generate_prompt && !step.content) {
			progress.report({
				message: `Generating content for new file: ${path.basename(
					targetFileUri.fsPath
				)}...`,
			});

			const streamId = crypto.randomUUID();

			const editorContext: EditorContext = {
				filePath: step.file,
				documentUri: targetFileUri,
				fullText: "",
				selection: new vscode.Range(0, 0, 0, 0),
				selectedText: "",
				instruction: step.generate_prompt ?? "",
				languageId: getLanguageId(path.extname(step.file)),
			};

			const generationContext: EnhancedGenerationContext = {
				editorContext: editorContext,
				successfulChangeHistory: formatSuccessfulChangesForPrompt(
					this.changeLogger.getCompletedPlanChangeSets()
				),
				projectContext: "",
				activeSymbolInfo: undefined,
				relevantSnippets: "",
			};

			try {
				const languageId = getLanguageId(path.extname(step.file));
				this.postMessageToWebview({
					type: "codeFileStreamStart",
					value: { streamId, filePath: step.file, languageId },
				});

				const generatedContentResult =
					await this.enhancedCodeGenerator.generateFileContent(
						step.file,
						step.generate_prompt,
						generationContext,
						modelName,
						token
					);

				contentToProcess = cleanCodeOutput(generatedContentResult.content);

				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: { streamId, filePath: step.file, success: true },
				});
			} catch (aiError: any) {
				this.postMessageToWebview({
					type: "codeFileStreamEnd",
					value: {
						streamId,
						filePath: step.file,
						success: false,
						error: aiError instanceof Error ? aiError.message : String(aiError),
					},
				});
				return this._reportErrorAndReturnResult(
					aiError,
					`Failed to generate content for ${path.basename(
						targetFileUri.fsPath
					)}.`,
					step.file,
					PlanStepAction.CreateFile,
					workspaceRootUri
				);
			}
		} else if (!step.content) {
			const errMsg =
				"Missing content for CreateFile action. Either 'content' or 'generate_prompt' must be provided.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				step.file,
				PlanStepAction.CreateFile,
				workspaceRootUri
			);
		} else {
			contentToProcess = cleanCodeOutput(step.content);
		}

		if (contentToProcess === undefined) {
			const errMsg =
				"Content to process is undefined after AI generation or content check.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				step.file,
				PlanStepAction.CreateFile,
				workspaceRootUri
			);
		}

		try {
			await vscode.workspace.fs.stat(targetFileUri);

			const existingContentBuffer = await vscode.workspace.fs.readFile(
				targetFileUri
			);
			const existingContent = existingContentBuffer.toString();

			if (existingContent === contentToProcess) {
				progress.report({
					message: `File ${path.basename(
						targetFileUri.fsPath
					)} already has the target content. Skipping update.`,
				});
				return { success: true };
			} else {
				progress.report({
					message: `Updating content of ${path.basename(
						targetFileUri.fsPath
					)}...`,
				});

				let documentToUpdate: vscode.TextDocument;
				try {
					documentToUpdate = await vscode.workspace.openTextDocument(
						targetFileUri
					);
				} catch (error: any) {
					return this._reportErrorAndReturnResult(
						error,
						`Failed to open document ${targetFileUri.fsPath} for update.`,
						step.file,
						PlanStepAction.CreateFile,
						workspaceRootUri
					);
				}

				const editorToUpdate = await vscode.window.showTextDocument(
					documentToUpdate
				);

				try {
					await applyAITextEdits(
						editorToUpdate,
						existingContent,
						contentToProcess,
						token
					);
				} catch (editError: any) {
					return this._reportErrorAndReturnResult(
						editError,
						`Failed to apply AI text edits to ${path.basename(
							targetFileUri.fsPath
						)}.`,
						step.file,
						PlanStepAction.CreateFile,
						workspaceRootUri
					);
				}

				const { summary, addedLines, removedLines, formattedDiff } =
					await generateFileChangeSummary(
						existingContent,
						contentToProcess,
						step.file
					);

				const updateChangeEntry: FileChangeEntry = {
					changeType: "modified",
					filePath: step.file,
					summary: summary,
					addedLines: addedLines,
					removedLines: removedLines,
					timestamp: Date.now(),
					diffContent: formattedDiff,
					originalContent: existingContent,
					newContent: contentToProcess,
				};
				this.changeLogger.logChange(updateChangeEntry);

				this.postChatUpdate({
					type: "appendRealtimeModelMessage",
					value: {
						text: `Successfully updated file \`${path.basename(
							targetFileUri.fsPath
						)}\`.`,
						isError: false,
					},
					diffContent: formattedDiff,
				});

				progress.report({
					message: `Successfully updated file ${path.basename(
						targetFileUri.fsPath
					)}.`,
				});
				return { success: true, diffContent: formattedDiff };
			}
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				progress.report({
					message: `Creating new file: ${path.basename(
						targetFileUri.fsPath
					)}...`,
				});
				try {
					await vscode.workspace.fs.writeFile(
						targetFileUri,
						Buffer.from(contentToProcess)
					);
				} catch (writeError: any) {
					return this._reportErrorAndReturnResult(
						writeError,
						`Failed to write content to new file ${targetFileUri.fsPath}.`,
						step.file,
						PlanStepAction.CreateFile,
						workspaceRootUri
					);
				}

				const {
					summary: createSummary,
					addedLines: createAddedLines,
					formattedDiff: createFormattedDiff,
				} = await generateFileChangeSummary("", contentToProcess, step.file);

				const createChangeEntry: FileChangeEntry = {
					changeType: "created",
					filePath: step.file,
					summary: createSummary,
					addedLines: createAddedLines,
					removedLines: [],
					timestamp: Date.now(),
					diffContent: createFormattedDiff,
					originalContent: "",
					newContent: contentToProcess,
				};

				this.changeLogger.logChange(createChangeEntry);

				this.postChatUpdate({
					type: "appendRealtimeModelMessage",
					value: {
						text: `Successfully created file \`${path.basename(
							targetFileUri.fsPath
						)}\`.`,
						isError: false,
					},
					diffContent: createFormattedDiff,
				});

				progress.report({
					message: `Successfully created file ${path.basename(
						targetFileUri.fsPath
					)}.`,
				});
				return { success: true, diffContent: createFormattedDiff };
			} else {
				return this._reportErrorAndReturnResult(
					error,
					`Error accessing or creating file ${targetFileUri.fsPath}.`,
					step.file,
					PlanStepAction.CreateFile,
					workspaceRootUri
				);
			}
		}
	}

	private async _handleModifyFileAction(
		step: PlanStep,
		token: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		workspaceRootUri: vscode.Uri,
		modelName: string
	): Promise<PlanStepExecutionResult> {
		if (token.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}
		if (!step.file || !step.modificationPrompt) {
			const errMsg =
				"Missing file path or modification prompt for ModifyFile action.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				step.file,
				PlanStepAction.ModifyFile,
				workspaceRootUri
			);
		}
		const targetFileUri = vscode.Uri.joinPath(workspaceRootUri, step.file);
		let document: vscode.TextDocument;
		let editor: vscode.TextEditor;
		let originalContent: string;

		try {
			document = await vscode.workspace.openTextDocument(targetFileUri);
			editor = await vscode.window.showTextDocument(document);
			originalContent = editor.document.getText();
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				progress.report({
					message: `File ${path.basename(
						targetFileUri.fsPath
					)} not found. Attempting to generate initial content and create it...`,
				});

				const createStep: PlanStep = {
					action: PlanStepAction.CreateFile,
					file: step.file,
					generate_prompt: step.modificationPrompt,
					description: `Creating missing file ${path.basename(
						targetFileUri.fsPath
					)} from modification prompt.`,
				};

				return await this._handleCreateFileAction(
					createStep,
					token,
					progress,
					workspaceRootUri,
					modelName
				);
			} else {
				return this._reportErrorAndReturnResult(
					error,
					`Failed to access or open document ${targetFileUri.fsPath}.`,
					step.file,
					PlanStepAction.ModifyFile,
					workspaceRootUri
				);
			}
		}

		progress.report({
			message: `Analyzing and modifying ${path.basename(
				targetFileUri.fsPath
			)} with AI...`,
		});

		let cleanedAIContent: string;
		try {
			const aiModifiedContent = await _performModification(
				originalContent,
				step.modificationPrompt,
				editor.document.languageId,
				editor.document.uri.fsPath,
				modelName,
				this.aiRequestService,
				this.enhancedCodeGenerator,
				token,
				this.postMessageToWebview,
				false
			);
			cleanedAIContent = aiModifiedContent;
		} catch (aiError: any) {
			return this._reportErrorAndReturnResult(
				aiError,
				`Failed to modify file ${path.basename(targetFileUri.fsPath)}.`,
				step.file,
				PlanStepAction.ModifyFile,
				workspaceRootUri
			);
		}

		try {
			await applyAITextEdits(editor, originalContent, cleanedAIContent, token);
		} catch (editError: any) {
			return this._reportErrorAndReturnResult(
				editError,
				`Failed to apply AI text edits to ${path.basename(
					targetFileUri.fsPath
				)}.`,
				step.file,
				PlanStepAction.ModifyFile,
				workspaceRootUri
			);
		}

		const { summary, addedLines, removedLines, formattedDiff } =
			await generateFileChangeSummary(
				originalContent,
				cleanedAIContent,
				step.file
			);

		const newChangeEntry: FileChangeEntry = {
			changeType: "modified",
			filePath: step.file,
			summary: summary,
			addedLines: addedLines,
			removedLines: removedLines,
			timestamp: Date.now(),
			diffContent: formattedDiff,
			originalContent: originalContent,
			newContent: cleanedAIContent,
		};
		this.changeLogger.logChange(newChangeEntry);

		this.postChatUpdate({
			type: "appendRealtimeModelMessage",
			value: {
				text: `Successfully applied modifications to \`${path.basename(
					targetFileUri.fsPath
				)}\`.`,
				isError: false,
			},
			diffContent: formattedDiff,
		});

		progress.report({
			message: `Successfully applied modifications to ${path.basename(
				targetFileUri.fsPath
			)}.`,
		});
		return { success: true, diffContent: formattedDiff };
	}

	private async _handleRunCommandAction(
		step: PlanStep,
		workspaceRootUri: vscode.Uri
	): Promise<PlanStepExecutionResult> {
		if (!step.command) {
			const errMsg = "Missing command for RunCommand action.";
			return this._reportErrorAndReturnResult(
				new Error(errMsg),
				errMsg,
				undefined,
				PlanStepAction.RunCommand,
				workspaceRootUri
			);
		}

		const terminalName = "Minovative Mind Task";
		let terminal = vscode.window.terminals.find((t) => t.name === terminalName);
		if (!terminal) {
			terminal = vscode.window.createTerminal(terminalName);
		}
		terminal.show();

		const fullCommand = `${step.command} ${
			step.args ? step.args.join(" ") : ""
		}`;
		terminal.sendText(fullCommand);

		this.postChatUpdate({
			type: "appendRealtimeModelMessage",
			value: {
				text: `Running command: \`${fullCommand}\``,
				isError: false,
			},
		});

		return { success: true };
	}

	public async executePlanStep(
		step: PlanStep,
		token: vscode.CancellationToken,
		progress: vscode.Progress<{ message?: string; increment?: number }>
	): Promise<PlanStepExecutionResult> {
		progress.report({ message: step.description });

		if (token.isCancellationRequested) {
			return {
				success: false,
				errorType: "cancellation",
				errorMessage: "Operation cancelled by user.",
			};
		}

		const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceRootUri) {
			const errMsg =
				"No workspace folder open. Cannot perform file operations.";
			this.postChatUpdate({
				type: "appendRealtimeModelMessage",
				value: { text: errMsg, isError: true },
			});
			return {
				success: false,
				errorType: "non-transient",
				errorMessage: errMsg,
			};
		}

		const modelName: string = vscode.workspace
			.getConfiguration("minovativeMind")
			.get("modelName", DEFAULT_FLASH_MODEL);

		try {
			switch (step.action) {
				case PlanStepAction.ModifyFile:
					return await this._handleModifyFileAction(
						step,
						token,
						progress,
						workspaceRootUri,
						modelName
					);

				case PlanStepAction.TypeContent:
					return await this._handleTypeContentAction(
						step,
						token,
						progress,
						workspaceRootUri
					);

				case PlanStepAction.CreateFile:
					return await this._handleCreateFileAction(
						step,
						token,
						progress,
						workspaceRootUri,
						modelName
					);

				case PlanStepAction.DeleteFile:
					return await this._handleDeleteFileAction(
						step,
						token,
						progress,
						workspaceRootUri
					);

				case PlanStepAction.RunCommand:
					return await this._handleRunCommandAction(step, workspaceRootUri);

				case PlanStepAction.ViewFile: {
					if (!step.file) {
						const errMsg = "Missing file path for ViewFile action.";
						return this._reportErrorAndReturnResult(
							new Error(errMsg),
							errMsg,
							step.file,
							PlanStepAction.ViewFile,
							workspaceRootUri
						);
					}
					const fileUri = vscode.Uri.joinPath(workspaceRootUri, step.file);
					try {
						await vscode.window.showTextDocument(fileUri, { preview: true });
						progress.report({
							message: `Viewing file: ${path.basename(fileUri.fsPath)}`,
						});
						this.postChatUpdate({
							type: "appendRealtimeModelMessage",
							value: {
								text: `Opened file \`${path.basename(fileUri.fsPath)}\`.`,
								isError: false,
							},
						});
						return { success: true };
					} catch (error: any) {
						return this._reportErrorAndReturnResult(
							error,
							`Failed to open file ${path.basename(
								fileUri.fsPath
							)} for viewing.`,
							step.file,
							PlanStepAction.ViewFile,
							workspaceRootUri
						);
					}
				}

				case PlanStepAction.ExecuteCommand: {
					if (!step.command) {
						const errMsg = "Missing command for ExecuteCommand action.";
						return this._reportErrorAndReturnResult(
							new Error(errMsg),
							errMsg,
							undefined,
							PlanStepAction.ExecuteCommand,
							workspaceRootUri
						);
					}
					try {
						progress.report({
							message: `Executing command: ${step.command} ${
								step.args ? step.args.join(" ") : ""
							}`,
						});
						await vscode.commands.executeCommand(
							step.command,
							...(step.args || [])
						);
						this.postChatUpdate({
							type: "appendRealtimeModelMessage",
							value: {
								text: `Successfully executed command \`${step.command}\`.`,
								isError: false,
							},
						});
						return { success: true };
					} catch (error: any) {
						return this._reportErrorAndReturnResult(
							error,
							`Failed to execute command ${step.command}.`,
							undefined,
							PlanStepAction.ExecuteCommand,
							workspaceRootUri
						);
					}
				}

				case PlanStepAction.ShowMessage: {
					if (!step.message) {
						const errMsg = "Missing message for ShowMessage action.";
						return this._reportErrorAndReturnResult(
							new Error(errMsg),
							errMsg,
							undefined,
							PlanStepAction.ShowMessage,
							workspaceRootUri
						);
					}
					this.postChatUpdate({
						type: "appendRealtimeModelMessage",
						value: { text: step.message, isError: false },
					});
					return { success: true };
				}

				default: {
					const errMsg = `Plan step action '${step.action}' is not yet implemented.`;
					return this._reportErrorAndReturnResult(
						new Error(errMsg),
						errMsg,
						undefined,
						step.action as PlanStepAction,
						workspaceRootUri
					);
				}
			}
		} catch (globalError: any) {
			if (globalError.message === ERROR_OPERATION_CANCELLED) {
				throw globalError;
			}
			return this._reportErrorAndReturnResult(
				globalError,
				`An unexpected error occurred during plan step execution.`,
				step.file,
				step.action,
				workspaceRootUri
			);
		}
	}
}
