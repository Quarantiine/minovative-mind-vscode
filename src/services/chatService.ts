import * as vscode from "vscode";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import {
	ERROR_OPERATION_CANCELLED,
	initializeGenerativeAI,
} from "../ai/gemini";
import { GenerationConfig, Tool } from "@google/generative-ai";
import { UrlContextService } from "./urlContextService";
import { HistoryEntry, HistoryEntryPart } from "../sidebar/common/sidebarTypes";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";

const AI_CHAT_PROMPT =
	"Lets discuss and do not code yet. You should only focus on high level thinking in this project, using the project context given to you. Only respone helpfully with production-ready explainations, no placeholders, no TODOs for the user. Make sure to mention what files are being changed or created if any.";

export class ChatService {
	private urlContextService: UrlContextService;

	constructor(private provider: SidebarProvider) {
		this.urlContextService = new UrlContextService();
	}

	public async handleRegularChat(
		userContentParts: HistoryEntryPart[],
		groundingEnabled: boolean = false
	): Promise<void> {
		const { settingsManager } = this.provider;
		const apiKey = this.provider.apiKeyManager.getActiveApiKey();
		const modelName = DEFAULT_FLASH_LITE_MODEL;

		await this.provider.startUserOperation("chat");
		const operationId = this.provider.currentActiveChatOperationId;
		const token = this.provider.activeOperationCancellationTokenSource?.token;

		if (!operationId || !token) {
			console.error(
				"[ChatService] Operation ID or token not available after startUserOperation."
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

		if (!apiKey) {
			vscode.window.showErrorMessage(
				"Gemini API key is not set. Please set it in VS Code settings to use chat features."
			);
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error: "Gemini API key is not set.",
				operationId: operationId as string,
			});
			return;
		}

		if (!modelName) {
			vscode.window.showErrorMessage(
				"Gemini model is not selected. Please select one in VS Code settings to use chat features."
			);
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error: "Gemini model is not selected.",
				operationId: operationId as string,
			});
			return;
		}

		const initializationSuccess = initializeGenerativeAI(apiKey, modelName);

		if (!initializationSuccess) {
			vscode.window.showErrorMessage(
				`Failed to initialize Gemini AI with model '${modelName}'. Please check your API key and selected model.`
			);
			this.provider.postMessageToWebview({
				type: "aiResponseEnd",
				success: false,
				error: `Failed to initialize Gemini AI with model '${modelName}'.`,
				operationId: operationId as string,
			});
			throw new Error(
				formatUserFacingErrorMessage(
					new Error(
						`Failed to initialize Gemini AI with model '${modelName}'.`
					),
					"Failed to initialize AI service.",
					"AI Initialization Error: ",
					this.provider.workspaceRootUri
				)
			);
		}

		const userMessageTextForContext = userContentParts
			.filter((part): part is { text: string } => "text" in part)
			.map((part) => part.text)
			.join("\n");

		try {
			const urlContexts =
				await this.urlContextService.processMessageForUrlContext(
					userMessageTextForContext,
					operationId
				);
			const urlContextString =
				this.urlContextService.formatUrlContexts(urlContexts);

			if (urlContexts.length > 0) {
				console.log(
					`[ChatService] Processed ${urlContexts.length} URLs for context`
				);
			}

			const projectContext =
				await this.provider.contextService.buildProjectContext(
					token,
					userMessageTextForContext
				);
			if (projectContext.contextString.startsWith("[Error")) {
				throw new Error(projectContext.contextString);
			}

			this.provider.currentAiStreamingState = {
				content: "",
				relevantFiles: projectContext.relevantFiles,
				isComplete: false,
				isError: false,
				operationId: operationId,
			};

			this.provider.postMessageToWebview({
				type: "aiResponseStart",
				value: {
					modelName,
					relevantFiles: projectContext.relevantFiles,
					operationId: operationId,
				},
			});

			const initialSystemPrompt: HistoryEntryPart[] = [
				{
					text: `${AI_CHAT_PROMPT} \n\nProject Context:\n${
						projectContext.contextString
					}${urlContextString ? `\n\n${urlContextString}` : ""}`,
				},
			];
			const fullUserTurnContents: HistoryEntryPart[] = [
				...initialSystemPrompt,
				...userContentParts,
			];

			let accumulatedResponse = "";

			let generationConfig: GenerationConfig | undefined = undefined;

			if (groundingEnabled) {
				generationConfig = {};
			}

			finalAiResponseText =
				await this.provider.aiRequestService.generateWithRetry(
					fullUserTurnContents,
					modelName,
					this.provider.chatHistoryManager.getChatHistory(),
					"chat",
					generationConfig,
					{
						onChunk: (chunk: string) => {
							accumulatedResponse += chunk;
							if (this.provider.currentAiStreamingState) {
								this.provider.currentAiStreamingState.content += chunk;
							}
							this.provider.postMessageToWebview({
								type: "aiResponseChunk",
								value: chunk,
								operationId: operationId as string,
							});
						},
					},
					token,
					false
				);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (finalAiResponseText.toLowerCase().startsWith("error:")) {
				success = false;
			} else {
				const aiResponseUrlContexts =
					await this.urlContextService.processMessageForUrlContext(
						accumulatedResponse,
						operationId
					);
				if (aiResponseUrlContexts.length > 0) {
					console.log(
						`Found ${aiResponseUrlContexts.length} URLs in AI response`
					);
				}

				this.provider.chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: accumulatedResponse }],
					undefined,
					projectContext.relevantFiles,
					projectContext.relevantFiles &&
						projectContext.relevantFiles.length <= 3
				);
			}
		} catch (error: any) {
			finalAiResponseText = formatUserFacingErrorMessage(
				error,
				"Failed to generate AI response.",
				"AI Response Generation Error: ",
				this.provider.workspaceRootUri
			);
			success = false;
			if (this.provider.currentAiStreamingState) {
				this.provider.currentAiStreamingState.isError = true;
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
					`[ChatService] Old chat operation (${operationId})'s finally block detected new operation, skipping global state modification.`
				);
			}
		}
	}

	public async regenerateAiResponseFromHistory(
		userMessageIndex: number
	): Promise<void> {
		const {
			settingsManager,
			chatHistoryManager,
			contextService,
			aiRequestService,
		} = this.provider;
		const modelName = DEFAULT_FLASH_LITE_MODEL;

		await this.provider.startUserOperation("chat");
		const operationId = this.provider.currentActiveChatOperationId;
		const token = this.provider.activeOperationCancellationTokenSource?.token;

		if (!operationId || !token) {
			console.error(
				"[ChatService] Operation ID or token not available after startUserOperation."
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
					"Validation Error: No user message found in chat history after editing."
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
					"Validation Error: Edited user message not found or is not a user message with valid content."
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
				{ useAISelectionCache: false, forceAISelectionRecalculation: true }
			);

			if (projectContext.contextString.startsWith("[Error")) {
				throw new Error(projectContext.contextString);
			}
			relevantFiles = projectContext.relevantFiles;

			this.provider.currentAiStreamingState = {
				content: "",
				relevantFiles: relevantFiles,
				isComplete: false,
				isError: false,
				operationId: operationId,
			};

			this.provider.postMessageToWebview({
				type: "aiResponseStart",
				value: {
					modelName,
					relevantFiles: relevantFiles,
					operationId: operationId,
				},
			});

			const initialSystemPrompt: HistoryEntryPart[] = [
				{
					text: `${AI_CHAT_PROMPT} \n\nProject Context:\n${projectContext.contextString}`,
				},
			];
			const fullUserTurnContents: HistoryEntryPart[] = [
				...initialSystemPrompt,
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
							this.provider.currentAiStreamingState.content += chunk;
						}
						this.provider.postMessageToWebview({
							type: "aiResponseChunk",
							value: chunk,
							operationId: operationId as string,
						});
					},
				},
				token,
				false
			);

			if (token.isCancellationRequested) {
				throw new Error(ERROR_OPERATION_CANCELLED);
			}
			if (finalAiResponseText.toLowerCase().startsWith("error:")) {
				success = false;
			} else {
				chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: accumulatedResponse }],
					undefined,
					relevantFiles,
					relevantFiles && relevantFiles.length <= 3
				);
			}
		} catch (error: any) {
			finalAiResponseText = formatUserFacingErrorMessage(
				error,
				"Failed to regenerate AI response.",
				"AI Response Regeneration Error: ",
				this.provider.workspaceRootUri
			);
			success = false;
			if (this.provider.currentAiStreamingState) {
				this.provider.currentAiStreamingState.isError = true;
			}
			if (error.message === ERROR_OPERATION_CANCELLED) {
				console.log("[ChatService] AI response regeneration cancelled.");
			} else {
				console.error("[ChatService] Error regenerating AI response:", error);
				chatHistoryManager.addHistoryEntry(
					"model",
					[{ text: finalAiResponseText }],
					"error-message"
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
					`[ChatService] Old regeneration operation (${operationId})'s finally block detected new operation, skipping global state modification.`
				);
			}

			this.provider.isEditingMessageActive = false;
		}
	}
}
