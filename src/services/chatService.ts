import * as vscode from "vscode";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import {
	ERROR_OPERATION_CANCELLED,
	initializeGenerativeAI,
} from "../ai/gemini";
import * as lightweightPrompts from "../ai/prompts/lightweightPrompts";
import { GenerationConfig } from "@google/generative-ai";
import { UrlContextService } from "./urlContextService";
import { HistoryEntry, HistoryEntryPart } from "../sidebar/common/sidebarTypes";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { ContextBuildOptions } from "../types/context";

export class ChatService {
	private urlContextService: UrlContextService;

	constructor(private provider: SidebarProvider) {
		this.urlContextService = new UrlContextService();
	}

	private async _analyzeRecentHistory(): Promise<{
		historicallyRelevantFiles: vscode.Uri[];
		focusReminder: string;
	}> {
		if (!this.provider.workspaceRootUri) {
			return { historicallyRelevantFiles: [], focusReminder: "" };
		}

		const workspaceRootUri = this.provider.workspaceRootUri;

		const recentHistory = this.provider.chatHistoryManager
			.getChatHistory()
			.slice(-10);
		const modelResponses = recentHistory.filter(
			(entry) => entry.role === "model",
		);

		// Collect unique file paths from the last 5 model responses
		const historicallyRelevantFilePaths = new Set<string>();
		modelResponses.slice(-5).forEach((response) => {
			response.relevantFiles?.forEach((filePath) => {
				historicallyRelevantFilePaths.add(filePath);
			});
		});

		const historicallyRelevantFiles: vscode.Uri[] = Array.from(
			historicallyRelevantFilePaths,
		).map((filePath) => vscode.Uri.joinPath(workspaceRootUri, filePath));

		let focusReminder = "";
		const lastModelResponse = modelResponses[modelResponses.length - 1];

		if (
			lastModelResponse?.relevantFiles &&
			lastModelResponse.relevantFiles.length > 0
		) {
			const fileList = lastModelResponse.relevantFiles
				.map((p) => `\`${p}\``)
				.join(", ");
			focusReminder = `--- Conversational Background ---\nNote: The previous exchange touched on these files: ${fileList}. Consider this context as you fulfill the *current* request, but do not feel restricted by it if the user is moving in a new direction.\n--- End Background ---`;
		}

		return { historicallyRelevantFiles, focusReminder };
	}

	public async handleRegularChat(
		userContentParts: HistoryEntryPart[],
		groundingEnabled: boolean = false,
	): Promise<void> {
		const apiKey = this.provider.apiKeyManager.getActiveApiKey();
		const modelName = DEFAULT_FLASH_LITE_MODEL;

		await this.provider.startUserOperation("chat");
		const operationId = this.provider.currentActiveChatOperationId;
		const token = this.provider.activeOperationCancellationTokenSource?.token;

		if (!operationId || !token) {
			console.error(
				"[ChatService] Operation ID or token not available after startUserOperation.",
			);
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error: "Internal error: Operation ID or token not available.",
				operationId: operationId as string,
			});
			this.provider.activeOperationCancellationTokenSource?.dispose();
			this.provider.activeOperationCancellationTokenSource = undefined;
			this.provider.currentActiveChatOperationId = null;
			return;
		}

		let success = true;
		let finalAiResponseText: string | null = null;

		const userMessageTextForContext = userContentParts
			.filter((part): part is { text: string } => "text" in part)
			.map((part) => part.text)
			.join("\n");

		try {
			if (!apiKey) {
				throw new Error(
					"Gemini API key is not set. Please set it in VS Code settings to use chat features.",
				);
			}

			if (!modelName) {
				throw new Error(
					"Gemini model is not selected. Please select one in VS Code settings to use chat features.",
				);
			}

			const initializationSuccess = initializeGenerativeAI(apiKey, modelName);

			if (!initializationSuccess) {
				throw new Error(
					`Failed to initialize Gemini AI with model '${modelName}'. Please check your API key and selected model.`,
				);
			}
			const { historicallyRelevantFiles, focusReminder } =
				await this._analyzeRecentHistory();

			const urlContexts =
				await this.urlContextService.processMessageForUrlContext(
					userMessageTextForContext,
					operationId,
				);
			const urlContextString =
				this.urlContextService.formatUrlContexts(urlContexts);

			// --- NEW: Contextual History Summarization ---
			let historySummaryContent: string | undefined = undefined;
			const historyForSummarization =
				this.provider.chatHistoryManager.getChatHistory();

			if (historyForSummarization.length > 0) {
				this.provider.postMessageToWebview({
					type: "statusUpdate",
					value: "Summarizing chat history",
					showLoadingDots: true,
				});
				try {
					historySummaryContent =
						await lightweightPrompts.generateContextualHistorySummary(
							historyForSummarization,
							userMessageTextForContext,
							this.provider.aiRequestService,
							token,
						);
					this.provider.postMessageToWebview({
						type: "statusUpdate",
						value: "Chat history summarized.",
					});
				} catch (summaryError: any) {
					console.warn(
						`[ChatService] Failed to generate history summary. Continuing with limited context. Error: ${summaryError.message}`,
					);
					historySummaryContent = `[IMPORTANT: Focused history summarization failed. Contextual relevance may be reduced. Error: ${summaryError.message}]`;
				}
			}
			// ---------------------------------------------

			if (urlContexts.length > 0) {
				console.log(
					`[ChatService] Processed ${urlContexts.length} URLs for context`,
				);
			}

			const projectContext =
				await this.provider.contextService.buildProjectContext(
					token,
					userMessageTextForContext,
					undefined,
					undefined,
					{ historicallyRelevantFiles } as ContextBuildOptions,
				);
			if (projectContext.contextString.startsWith("[Error")) {
				throw new Error(projectContext.contextString);
			}

			await this.provider.updatePersistedAiStreamingState({
				content: "",
				relevantFiles: projectContext.relevantFiles,
				isComplete: false,
				isError: false,
				operationId: operationId,
			});

			this.provider.postMessageToWebview({
				type: "aiResponseStart",
				value: {
					modelName,
					relevantFiles: projectContext.relevantFiles,
					operationId: operationId,
				},
			});

			let systemInstruction = `Project Context:\n${
				projectContext.contextString
			}${urlContextString ? `\n\n${urlContextString}` : ""}`;

			// Prepend History Summary if available
			if (historySummaryContent) {
				systemInstruction = `**HISTORICAL CONTEXT (Reference only - prioritize current user request)**:\n${historySummaryContent}\n\n${systemInstruction}`;
			}

			// Prepend Focus Reminder to system instruction instead of user turn
			if (focusReminder) {
				systemInstruction = `${focusReminder}\n\n${systemInstruction}`;
			}

			const fullUserTurnContents: HistoryEntryPart[] = [...userContentParts];

			let accumulatedResponse = "";

			let generationConfig: GenerationConfig | undefined = undefined;

			if (groundingEnabled) {
				generationConfig = {};
			}

			const historyToPass = historySummaryContent
				? []
				: this.provider.chatHistoryManager.getChatHistory();

			finalAiResponseText =
				await this.provider.aiRequestService.generateWithRetry(
					fullUserTurnContents,
					modelName,
					historyToPass,
					"chat",
					generationConfig,
					{
						onChunk: (chunk: string) => {
							accumulatedResponse += chunk;
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
					false,
					systemInstruction,
				);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (finalAiResponseText.toLowerCase().startsWith("error:")) {
				success = false;
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: finalAiResponseText }],
					"error-message",
				);
			} else {
				const aiResponseUrlContexts =
					await this.urlContextService.processMessageForUrlContext(
						accumulatedResponse,
						operationId,
					);
				if (aiResponseUrlContexts.length > 0) {
					console.log(
						`Found ${aiResponseUrlContexts.length} URLs in AI response`,
					);
				}

				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: accumulatedResponse }],
					undefined,
					projectContext.relevantFiles,
					projectContext.relevantFiles &&
						projectContext.relevantFiles.length <= 3,
				);
			}
		} catch (error: any) {
			const isCancellation = error?.message === ERROR_OPERATION_CANCELLED;

			if (isCancellation) {
				finalAiResponseText = ERROR_OPERATION_CANCELLED;
				success = true;
				if (this.provider.currentAiStreamingState) {
					await this.provider.updatePersistedAiStreamingState({
						...this.provider.currentAiStreamingState,
						isError: false,
						isComplete: true,
					});
				}
			} else {
				finalAiResponseText = formatUserFacingErrorMessage(
					error,
					"Failed to generate AI response.",
					"AI Response Generation Error: ",
					this.provider.workspaceRootUri,
				);
				success = false;
				if (this.provider.currentAiStreamingState) {
					await this.provider.updatePersistedAiStreamingState({
						...this.provider.currentAiStreamingState,
						isError: true,
					});
				}
				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: finalAiResponseText }],
					"error-message",
				);
			}
		} finally {
			const isThisOperationStillActiveGlobally =
				this.provider.currentActiveChatOperationId === operationId;

			if (isThisOperationStillActiveGlobally) {
				if (this.provider.currentAiStreamingState) {
					this.provider.currentAiStreamingState.isComplete = true;
				}

				const isCancellation =
					finalAiResponseText === ERROR_OPERATION_CANCELLED;

				if (isCancellation) {
					this.provider.endCancellationOperation();
				}

				this.provider.postMessageToWebview({
					type: "aiResponseEnd",
					success: success,
					error: isCancellation
						? "Chat generation cancelled."
						: success
							? null
							: finalAiResponseText,
					operationId: operationId as string,
				});

				this.provider.activeOperationCancellationTokenSource?.dispose();
				this.provider.activeOperationCancellationTokenSource = undefined;
				this.provider.currentActiveChatOperationId = null;

				this.provider.chatHistoryManager.restoreChatHistoryToWebview();
			} else {
				console.log(
					`[ChatService] Old chat operation (${operationId})'s finally block detected new operation, skipping global state modification.`,
				);
			}
		}
	}

	public async regenerateAiResponseFromHistory(
		userMessageIndex: number,
	): Promise<void> {
		const { chatHistoryManager, contextService, aiRequestService } =
			this.provider;
		const apiKey = this.provider.apiKeyManager.getActiveApiKey();
		const modelName = DEFAULT_FLASH_LITE_MODEL;

		await this.provider.startUserOperation("chat");
		const operationId = this.provider.currentActiveChatOperationId;
		const token = this.provider.activeOperationCancellationTokenSource?.token;

		if (!operationId || !token) {
			console.error(
				"[ChatService] Operation ID or token not available after startUserOperation.",
			);
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error: "Internal error: Operation ID or token not available.",
				operationId: operationId as string,
			});
			this.provider.activeOperationCancellationTokenSource?.dispose();
			this.provider.activeOperationCancellationTokenSource = undefined;
			this.provider.currentActiveChatOperationId = null;
			return;
		}

		let success = true;
		let finalAiResponseText: string | null = null;
		let currentHistory: readonly HistoryEntry[] = [];
		let relevantFiles: string[] | undefined;

		try {
			if (!apiKey) {
				throw new Error(
					"Gemini API key is not set. Please set it in VS Code settings to use chat features.",
				);
			}

			if (!modelName) {
				throw new Error(
					"Gemini model is not selected. Please select one in VS Code settings to use chat features.",
				);
			}

			const initializationSuccess = initializeGenerativeAI(apiKey, modelName);

			if (!initializationSuccess) {
				throw new Error(
					`Failed to initialize Gemini AI with model '${modelName}'. Please check your API key and selected model.`,
				);
			}
			currentHistory = chatHistoryManager.getChatHistory();

			let lastUserMessageIndex = -1;
			for (let i = currentHistory.length - 1; i >= 0; i--) {
				if (currentHistory[i].role === "user") {
					lastUserMessageIndex = i;
					break;
				}
			}

			if (lastUserMessageIndex === -1) {
				throw new Error(
					"Validation Error: No user message found in chat history after editing.",
				);
			}

			const editedUserMessageEntry = currentHistory[lastUserMessageIndex];

			if (
				!editedUserMessageEntry ||
				editedUserMessageEntry.role !== "user" ||
				!editedUserMessageEntry.parts ||
				editedUserMessageEntry.parts.length === 0
			) {
				throw new Error(
					"Validation Error: Edited user message not found or is not a user message with valid content.",
				);
			}

			const userContentPartsForRegen = editedUserMessageEntry.parts;
			const userMessageTextForContext = userContentPartsForRegen
				.filter((part): part is { text: string } => "text" in part)
				.map((part) => part.text)
				.join("\n");

			const projectContext = await contextService.buildProjectContext(
				token,
				userMessageTextForContext,
				undefined,
				undefined,
				{
					useAISelectionCache: false,
					forceAISelectionRecalculation: true,
				} as ContextBuildOptions,
			);

			if (projectContext.contextString.startsWith("[Error")) {
				throw new Error(projectContext.contextString);
			}
			relevantFiles = projectContext.relevantFiles;

			await this.provider.updatePersistedAiStreamingState({
				content: "",
				relevantFiles: relevantFiles,
				isComplete: false,
				isError: false,
				operationId: operationId,
			});

			this.provider.postMessageToWebview({
				type: "aiResponseStart",
				value: {
					modelName,
					relevantFiles: relevantFiles,
					operationId: operationId,
				},
			});

			const systemInstruction = `**PRIORITY: REGENERATE RESPONSE BASED ON CURRENT USER TURN**\nProject Context:\n${projectContext.contextString}`;

			const fullUserTurnContents: HistoryEntryPart[] = [
				...userContentPartsForRegen,
			];

			let accumulatedResponse = "";
			finalAiResponseText = await aiRequestService.generateWithRetry(
				fullUserTurnContents,
				modelName,
				currentHistory,
				"chat",
				undefined,
				{
					onChunk: (chunk: string) => {
						accumulatedResponse += chunk;
						if (this.provider.currentAiStreamingState) {
							this.provider.updatePersistedAiStreamingState({
								...this.provider.currentAiStreamingState,
								content: this.provider.currentAiStreamingState.content + chunk,
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
				false,
				systemInstruction, // Pass systemInstruction
			);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (finalAiResponseText.toLowerCase().startsWith("error:")) {
				success = false;
				chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: finalAiResponseText }],
					"error-message",
				);
			} else {
				chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: accumulatedResponse }],
					undefined,
					relevantFiles,
					relevantFiles && relevantFiles.length <= 3,
				);
			}
		} catch (error: any) {
			const isCancellation = error?.message === ERROR_OPERATION_CANCELLED;

			if (isCancellation) {
				finalAiResponseText = ERROR_OPERATION_CANCELLED;
				success = true;
				if (this.provider.currentAiStreamingState) {
					await this.provider.updatePersistedAiStreamingState({
						...this.provider.currentAiStreamingState,
						isError: false,
						isComplete: true,
					});
				}
				console.log("[ChatService] AI response regeneration cancelled.");
			} else {
				finalAiResponseText = formatUserFacingErrorMessage(
					error,
					"Failed to regenerate AI response.",
					"AI Response Regeneration Error: ",
					this.provider.workspaceRootUri,
				);
				success = false;
				if (this.provider.currentAiStreamingState) {
					await this.provider.updatePersistedAiStreamingState({
						...this.provider.currentAiStreamingState,
						isError: true,
					});
				}
				console.error("[ChatService] Error regenerating AI response:", error);
				chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: finalAiResponseText }],
					"error-message",
				);
			}
		} finally {
			const isThisOperationStillActiveGlobally =
				this.provider.currentActiveChatOperationId === operationId;

			if (isThisOperationStillActiveGlobally) {
				if (this.provider.currentAiStreamingState) {
					this.provider.currentAiStreamingState.isComplete = true;
				}

				const isCancellation =
					finalAiResponseText === ERROR_OPERATION_CANCELLED;

				if (isCancellation) {
					this.provider.endCancellationOperation();
				}

				this.provider.postMessageToWebview({
					type: "aiResponseEnd",
					success: success,
					error: isCancellation
						? "Chat generation cancelled."
						: success
							? null
							: finalAiResponseText,
					operationId: operationId as string,
				});

				this.provider.activeOperationCancellationTokenSource?.dispose();
				this.provider.activeOperationCancellationTokenSource = undefined;
				this.provider.currentActiveChatOperationId = null;

				this.provider.chatHistoryManager.restoreChatHistoryToWebview();
			} else {
				console.log(
					`[ChatService] Old regeneration operation (${operationId})'s finally block detected new operation, skipping global state modification.`,
				);
			}

			this.provider.isEditingMessageActive = false;
		}
	}
}
