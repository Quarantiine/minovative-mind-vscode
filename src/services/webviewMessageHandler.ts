import * as vscode from "vscode";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as path from "path";
import {
	ImageInlineData,
	HistoryEntryPart,
} from "../sidebar/common/sidebarTypes";

import { allMessageSchemas } from "./messageSchemas";
import { formatUserFacingErrorMessage } from "../utils/errorFormatter";
import { ERROR_OPERATION_CANCELLED } from "../ai/gemini";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";
import { generateLightweightPlanPrompt } from "../ai/prompts/lightweightPrompts";
import { scanWorkspace } from "../context/workspaceScanner";
import { createAsciiTree } from "../utils/treeFormatter";

export const PRE_PROMPT_MESSAGE =
	"You are an expert software engineer. Your task is to provide production-ready code that is robust, maintainable, secure, clean, efficient, and follows industry best practices. No placeholders, no todo comments, no basic code. Focus on implementing the following feature/enhancement from the message instructions below.";

export async function handleWebviewMessage(
	data: any,
	provider: SidebarProvider
): Promise<void> {
	console.log(`[MessageHandler] Message received: ${data.type}`);

	// --- Zod Validation Block ---
	const parseResult = allMessageSchemas.safeParse(data);

	if (!parseResult.success) {
		console.error(
			`[MessageHandler] Zod validation failed for incoming message:`,
			parseResult.error.flatten()
		);
		provider.postMessageToWebview({
			type: "statusUpdate",
			value:
				"Invalid message format received from webview. Please check the data sent.",
			isError: true,
		});
		return; // Stop processing invalid message
	}

	const validatedData = parseResult.data; // Use validated data from now on

	// Prevent new operations if one is ongoing
	// `allowedDuringBackground` includes messages that can run concurrently,
	// are follow-up actions, or are designed to interrupt/redirect existing operations.
	const allowedDuringBackground = [
		"webviewReady",
		"requestDeleteConfirmation",
		"saveChatRequest",
		"loadChatRequest",
		"selectModel",
		"requestAuthState",
		"deleteSpecificMessage",
		"confirmCommit", // Follow-up to commit generation
		"cancelCommit", // Follow-up to commit generation
		"openExternalLink",
		"confirmPlanExecution", // Allowed as a follow-up action to a pending plan
		"retryStructuredPlanGeneration", // Allowed as a follow-up action to a failed/declined plan
		"openFile", // Allowed as a direct user interaction
		"toggleRelevantFilesDisplay", // Allowed as a UI interaction
		"openSettingsPanel",
		"universalCancel", // Universal cancellation message, must be allowed during background operations
		"editChatMessage", // Allowed to interrupt/redirect existing operations
		"getTokenStatistics", // Allow token statistics requests during background operations
		"getCurrentTokenEstimates", // Allow current token estimates during background operations
		"openSidebar", // Allow opening sidebar during background operations
		"generatePlanPromptFromAIMessage", // Allow this new message type during background operations
		"revertRequest",
		"requestClearChatConfirmation", // Allowed for user confirmation flow
		"confirmClearChatAndRevert", // Allowed as a direct user interaction during clear chat flow
		"cancelClearChat", // Allowed as a direct user interaction during clear chat flow
		"requestWorkspaceFiles", // Allow workspace file requests during background operations
		"operationCancelledConfirmation", // Allowed to update UI state after cancellation
		"copyContextMessage", // Allowed during background operations
		"setApiActiveKey", // Allow API key switching
	];

	if (
		provider.isOperationInProgress() &&
		!allowedDuringBackground.includes(validatedData.type)
	) {
		console.warn(
			`Message type "${validatedData.type}" blocked because an operation is in progress.`
		);
		provider.postMessageToWebview({
			type: "statusUpdate",
			value:
				"An operation is already in progress. Please wait for it to complete or cancel it before starting a new one.",
			isError: true,
		});
		return;
	}

	// Capture the current state of a user operation before processing the message.
	const initialActiveChatOperationId = provider.currentActiveChatOperationId;
	const initialIsGeneratingUserRequest = provider.isGeneratingUserRequest;

	try {
		switch (validatedData.type) {
			case "universalCancel":
				console.log(
					"[MessageHandler] Received universal cancellation request."
				);
				await provider.triggerUniversalCancellation();
				break;

			case "operationCancelledConfirmation":
				console.log(
					"[WebviewMessageHandler] Received operationCancelledConfirmation from extension."
				);
				// When the extension confirms cancellation, the webview updates its UI state.
				provider.postMessageToWebview({
					type: "updateLoadingState",
					value: false,
				});
				provider.postMessageToWebview({ type: "reenableInput" });
				break;

			case "webviewReady":
				console.log("[MessageHandler] Webview ready. Initializing UI state.");
				await provider.handleWebviewReady();
				break;

			case "planRequest": {
				const userRequest = validatedData.value;
				await provider.startUserOperation("plan"); // Start the operation and set generating state
				provider.chatHistoryManager.addHistoryEntry(
					"user",
					`/plan ${userRequest}`
				);
				// The planService will handle the rest, including UI updates
				await provider.planService.handleInitialPlanRequest(userRequest);
				break;
			}

			case "confirmPlanExecution": {
				await provider.startUserOperation("planExecution"); // Start the operation and set generating state
				if (provider.pendingPlanGenerationContext) {
					const contextForExecution = {
						...provider.pendingPlanGenerationContext,
					};
					provider.pendingPlanGenerationContext = null;
					await provider.planService.generateStructuredPlanAndExecute(
						contextForExecution
					);
				} else {
					const errorMessage =
						"No plan is currently awaiting confirmation. Please generate a new plan.";
					console.error(`[MessageHandler] ${errorMessage}`);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					await provider.endUserOperation("failed", errorMessage); // Signal failure and re-enable inputs
				}
				break;
			}

			case "retryStructuredPlanGeneration": {
				await provider.startUserOperation("retryPlan"); // Start the operation and set generating state
				if (provider.lastPlanGenerationContext) {
					const contextForRetry = { ...provider.lastPlanGenerationContext };
					provider.chatHistoryManager.addHistoryEntry(
						"model",
						"User requested retry of structured plan generation."
					);
					await provider.planService.generateStructuredPlanAndExecute(
						contextForRetry
					);
				} else {
					const errorMessage =
						"No previously generated plan is available for retry. Please initiate a new plan request.";
					console.error(`[MessageHandler] ${errorMessage}`);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					await provider.endUserOperation("failed", errorMessage); // Signal failure and re-enable inputs
				}
				break;
			}

			case "revertRequest":
				console.log("[MessageHandler] Received revertRequest.");
				await provider.revertLastPlanChanges();
				break;

			case "chatMessage": {
				await provider.startUserOperation("chat"); // Start the operation and set generating state
				const userMessageText = validatedData.value;
				const incomingImageParts = validatedData.imageParts; // Array of ImageInlineData | undefined

				// Handle /commit command first (existing logic)
				if (userMessageText.trim().toLowerCase() === "/commit") {
					// The token is already available via provider.activeOperationCancellationTokenSource
					await provider.startUserOperation("commit");
					await provider.commitService.handleCommitCommand(
						provider.activeOperationCancellationTokenSource!.token
					);
					break; // Exit case after handling /commit
				}

				// Construct userHistoryParts array
				const userHistoryParts: HistoryEntryPart[] = [];

				// Add the user's text message if not empty, or a default message if only images
				if (userMessageText.trim() !== "") {
					userHistoryParts.push({ text: userMessageText });
				} else if (incomingImageParts && incomingImageParts.length > 0) {
					// Prepend text if only images are provided, for context
					userHistoryParts.push({ text: "Here are some images for context." });
				}

				// If incomingImageParts exist, iterate and push them as inlineData parts
				if (incomingImageParts && incomingImageParts.length > 0) {
					for (const imgWrapper of incomingImageParts) {
						if (imgWrapper && imgWrapper.inlineData) {
							// Ensure 'imgWrapper.inlineData' is correctly typed as ImageInlineData
							const imageDataPart: ImageInlineData = {
								mimeType: imgWrapper.inlineData.mimeType,
								data: imgWrapper.inlineData.data,
							};
							// Push the structured HistoryEntryPart containing the typed inlineData
							userHistoryParts.push({ inlineData: imageDataPart });
						} else {
							console.warn(
								"[MessageHandler] Skipping invalid or malformed image part: ",
								imgWrapper
							);
							continue;
						}
					}
				}

				// Handle cases where no text or images are provided
				if (userHistoryParts.length === 0) {
					const errorMessage = "Please provide a message or images to send.";
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					await provider.endUserOperation("failed", errorMessage);
					break;
				}

				provider.chatHistoryManager.addHistoryEntry("user", userHistoryParts);

				await provider.chatService.handleRegularChat(userHistoryParts);
				break;
			}

			case "commitRequest": {
				await provider.startUserOperation("commit"); // Start the operation and set generating state
				await provider.commitService.handleCommitCommand(
					provider.activeOperationCancellationTokenSource!.token
				);
				break;
			}

			case "confirmCommit":
				const editedCommitMessage = validatedData.value;
				// No explicit provider.endUserOperation() here; CommitService will handle it
				await provider.commitService.confirmCommit(editedCommitMessage);
				break;

			case "cancelCommit":
				// No explicit provider.endUserOperation() here; CommitService will handle it
				provider.commitService.cancelCommit();
				break;

			case "getTokenStatistics":
				const stats = provider.tokenTrackingService.getFormattedStatistics();
				provider.postMessageToWebview({
					type: "updateTokenStatistics",
					value: stats,
				});
				break;

			case "getCurrentTokenEstimates":
				const { inputText, outputText } = validatedData.value;
				const currentEstimates =
					provider.tokenTrackingService.getCurrentStreamingEstimates(
						inputText || "",
						outputText || ""
					);
				provider.postMessageToWebview({
					type: "updateCurrentTokenEstimates",
					value: currentEstimates,
				});
				break;

			case "openSidebar":
				try {
					await vscode.commands.executeCommand(
						"minovative-mind.activitybar.focus"
					);
					console.log(
						"[MessageHandler] Sidebar opened automatically after plan completion."
					);
				} catch (error: any) {
					console.error("[MessageHandler] Failed to open sidebar:", error);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: formatUserFacingErrorMessage(
							error,
							"Failed to open sidebar.",
							"Error: "
						),
						isError: true,
					});
				}
				break;

			case "addApiKey":
				await provider.apiKeyManager.addApiKey(validatedData.value.trim());
				break;

			case "setApiActiveKey":
				await provider.apiKeyManager.setActiveKey(validatedData.value);
				break;

			case "requestDeleteConfirmation":
				const result = await vscode.window.showWarningMessage(
					"Are you sure you want to delete the active API key?",
					{ modal: true },
					"Yes",
					"No"
				);
				if (result === "Yes") {
					const activeIndex = provider.apiKeyManager.getActiveApiKeyIndex();
					if (activeIndex !== -1) {
						await provider.apiKeyManager.deleteApiKey(activeIndex);
					} else {
						provider.postMessageToWebview({
							type: "statusUpdate",
							value: "Error: No active API key to delete.",
							isError: true,
						});
					}
				} else {
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: "API key deletion cancelled.",
					});
					provider.postMessageToWebview({ type: "reenableInput" });
				}
				break;

			case "requestClearChatConfirmation":
				console.log("[MessageHandler] Received requestClearChatConfirmation.");
				provider.postMessageToWebview({
					type: "requestClearChatConfirmation",
				});
				break;

			case "confirmClearChatAndRevert":
				console.log("[MessageHandler] Received confirmClearChatAndRevert.");
				try {
					await provider.chatHistoryManager.clearChat();
					provider.changeLogger.clearAllCompletedPlanChanges();
					await provider.updatePersistedCompletedPlanChangeSets(null);

					provider.postMessageToWebview({ type: "chatCleared" });
					provider.postMessageToWebview({
						type: "planExecutionFinished",
						hasRevertibleChanges: false,
					});
					provider.postMessageToWebview({ type: "reenableInput" });

					console.log(
						"[MessageHandler] Chat history cleared and all past changes reverted successfully."
					);
				} catch (error: any) {
					console.error(
						"[MessageHandler] Error clearing chat or reverting changes:",
						error
					);
					const errorMessage = formatUserFacingErrorMessage(
						error,
						"Failed to clear chat and revert changes."
					);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					provider.postMessageToWebview({ type: "reenableInput" });
					vscode.window.showErrorMessage(errorMessage);
				}
				break;

			case "cancelClearChat":
				console.log("[MessageHandler] Received cancelClearChat.");
				provider.postMessageToWebview({
					type: "statusUpdate",
					value: "Chat clear operation cancelled.",
				});
				provider.postMessageToWebview({ type: "reenableInput" });
				break;

			case "saveChatRequest":
				await provider.chatHistoryManager.saveChat();
				break;

			case "loadChatRequest":
				await provider.chatHistoryManager.loadChat();
				break;

			case "deleteSpecificMessage":
				provider.chatHistoryManager.deleteHistoryEntry(
					validatedData.messageIndex
				);
				break;

			case "toggleRelevantFilesDisplay": {
				provider.chatHistoryManager.updateMessageRelevantFilesExpandedState(
					validatedData.messageIndex,
					validatedData.isExpanded
				);
				break;
			}

			case "selectModel":
				await provider.settingsManager.handleModelSelection(
					validatedData.value
				);
				break;

			case "openExternalLink": {
				const url = validatedData.url;
				if (url) {
					await vscode.env.openExternal(vscode.Uri.parse(url, true));
				}
				break;
			}

			case "openSettingsPanel": {
				const panelId = validatedData.panelId;
				if (panelId) {
					try {
						await vscode.commands.executeCommand(
							"minovative-mind.openSettingsPanel"
						);
						provider.postMessageToWebview({
							type: "statusUpdate",
							value:
								"Please open the Minovative Mind settings panel to sign in.",
						});
					} catch (error: any) {
						console.error(
							`[MessageHandler] Error opening settings panel ${panelId}:`,
							error
						);
						provider.postMessageToWebview({
							type: "statusUpdate",
							value: formatUserFacingErrorMessage(
								error,
								"Failed to open settings panel.",
								"Error: "
							),
							isError: true,
						});
					}
				} else {
					provider.postMessageToWebview({
						type: "statusUpdate",
						value:
							"Cannot open settings panel: No valid panel identifier was provided.",
						isError: true,
					});
				}
				break;
			}

			case "openFile": {
				const relativeFilePathFromWebview = validatedData.value;

				if (relativeFilePathFromWebview.trim() === "") {
					const errorMessage = formatUserFacingErrorMessage(
						new Error(
							`The provided file path is invalid or malformed: "${relativeFilePathFromWebview}".`
						),
						"Security alert: The provided file path is invalid or malformed. Operation blocked.",
						"Security alert: ",
						vscode.workspace.workspaceFolders?.[0]?.uri
					);
					console.warn(`[MessageHandler] ${errorMessage}`);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					return;
				}

				let isPathWithinWorkspace = false;
				let absoluteFileUri: vscode.Uri | undefined;
				let workspaceRoot: string | undefined;

				if (
					vscode.workspace.workspaceFolders &&
					vscode.workspace.workspaceFolders.length > 0
				) {
					const rootFolder = vscode.workspace.workspaceFolders[0];
					workspaceRoot = path.normalize(rootFolder.uri.fsPath);

					try {
						absoluteFileUri = vscode.Uri.joinPath(
							rootFolder.uri,
							relativeFilePathFromWebview
						);
					} catch (uriError: any) {
						const errorMessage = formatUserFacingErrorMessage(
							uriError,
							"Error: The file path could not be resolved. Please ensure the path is valid and accessible.",
							"Error: ",
							vscode.workspace.workspaceFolders?.[0]?.uri
						);
						console.error(`[MessageHandler] ${errorMessage}`, uriError);
						provider.postMessageToWebview({
							type: "statusUpdate",
							value: errorMessage,
							isError: true,
						});
						return;
					}

					const absoluteNormalizedFilePath = path.normalize(
						absoluteFileUri.fsPath
					);

					if (
						absoluteNormalizedFilePath === workspaceRoot ||
						absoluteNormalizedFilePath.startsWith(workspaceRoot + path.sep)
					) {
						isPathWithinWorkspace = true;
					}
				} else {
					const errorMessage = formatUserFacingErrorMessage(
						new Error("No VS Code workspace folder is currently open."),
						"Security alert: Cannot open file. No VS Code workspace is currently open. Please open a project folder to proceed.",
						"Security alert: "
					);
					console.warn(`[MessageHandler] ${errorMessage}`);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					return;
				}

				if (!isPathWithinWorkspace || !absoluteFileUri) {
					const errorMessage = formatUserFacingErrorMessage(
						new Error(
							`Attempted to open a file located outside the current VS Code workspace: "${relativeFilePathFromWebview}".`
						),
						"Security alert: Attempted to open a file located outside the current VS Code workspace. This operation is blocked for security reasons.",
						"Security alert: ",
						vscode.workspace.workspaceFolders?.[0]?.uri
					);
					console.warn(`[MessageHandler] ${errorMessage}`);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					return;
				}

				try {
					await vscode.commands.executeCommand("vscode.open", absoluteFileUri);
					// provider.postMessageToWebview({
					// 	type: "statusUpdate",
					// 	value: `File opened successfully: ${path.basename(
					// 		absoluteFileUri.fsPath
					// 	)}`,
					// });
				} catch (openError: any) {
					const formattedError = formatUserFacingErrorMessage(
						openError,
						"Error opening file: Failed to open the specified file.",
						"Error opening file: ",
						vscode.workspace.workspaceFolders?.[0]?.uri
					);
					console.error(
						`[MessageHandler] Error opening file ${absoluteFileUri.fsPath} in VS Code:`,
						openError
					);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: formattedError,
						isError: true,
					});
				}
				break;
			}

			case "editChatMessage": {
				const { messageIndex, newContent } = validatedData;
				console.log(
					`[MessageHandler] Received editChatMessage for index ${messageIndex}: "${newContent.substring(
						0,
						50
					)}..."`
				);

				provider.isEditingMessageActive = true; // Set flag at the start of the edit operation
				await provider.triggerUniversalCancellation(); // Cancel any ongoing operations

				try {
					await provider.startUserOperation("edit"); // Start new operation and set `isGeneratingUserRequest`
					provider.postMessageToWebview({
						type: "updateLoadingState",
						value: true,
					});

					provider.postMessageToWebview({
						type: "statusUpdate",
						value: "Message edited. Processing new request...",
					});

					provider.chatHistoryManager.editMessageAndTruncate(
						messageIndex,
						newContent
					);
					provider.chatHistoryManager.restoreChatHistoryToWebview(); // Restore history to reflect the edit

					const lowerCaseNewContent = newContent.trim().toLowerCase();

					if (lowerCaseNewContent.startsWith("/plan ")) {
						const planRequest = newContent.trim().substring("/plan ".length);
						if (!planRequest) {
							const errorMessage =
								"Please provide a description for the plan after /plan.";
							console.error(`[MessageHandler] ${errorMessage}`);
							provider.postMessageToWebview({
								type: "statusUpdate",
								value: errorMessage,
								isError: true,
							});
							// End operation with failure for invalid command, outer finally will clean up isEditingMessageActive
							await provider.endUserOperation("failed", errorMessage);
							return; // Exit here as operation is handled
						}
						await provider.planService.handleInitialPlanRequest(planRequest);
					} else if (lowerCaseNewContent === "/commit") {
						// Use the token from the currently active operation, created by startUserOperation
						await provider.startUserOperation("commit");
						await provider.commitService.handleCommitCommand(
							provider.activeOperationCancellationTokenSource!.token
						);
					} else {
						// If it's not a recognized command, proceed with regular chat message regeneration
						await provider.chatService.regenerateAiResponseFromHistory(
							messageIndex
						);
					}
				} catch (error: any) {
					const isCancellation = error.message === ERROR_OPERATION_CANCELLED;
					if (isCancellation) {
						console.log(
							"[MessageHandler] editChatMessage: Operation cancelled during processing."
						);
						// endUserOperation("cancelled") will be called by triggerUniversalCancellation if triggered by user
						// or here if it's an internal cancellation.
						await provider.endUserOperation("cancelled");
					} else {
						const formattedError = formatUserFacingErrorMessage(
							error,
							"Failed to process edited message.",
							"Error processing edit: "
						);
						console.error(
							`[MessageHandler] Error processing editChatMessage:`,
							error
						);
						provider.postMessageToWebview({
							type: "statusUpdate",
							value: formattedError,
							isError: true,
						});
						await provider.endUserOperation("failed", formattedError);
					}
				} finally {
					// Ensure isEditingMessageActive is reset after the edit flow is complete (success, failure, or cancellation)
					// The SidebarProvider's endUserOperation will handle this for the main `isGeneratingUserRequest` state.
					// This line is redundant if `endUserOperation` handles it, but kept here for explicit clarity in this file.
					provider.isEditingMessageActive = false;
				}
				break;
			}

			case "generatePlanPromptFromAIMessage": {
				const messageIndex = validatedData.payload.messageIndex;

				const historyEntry =
					provider.chatHistoryManager.getChatHistory()[messageIndex];

				if (!historyEntry || historyEntry.role !== "model") {
					const errorMessage =
						"Error: Could not generate plan prompt. Invalid AI message context.";
					console.error(
						`[MessageHandler] Invalid history entry for index ${messageIndex} or not an AI message.`
					);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					await provider.endUserOperation("failed", errorMessage);
					break;
				}

				const aiMessageContent = historyEntry.parts
					.map((part) => ("text" in part && part.text ? part.text : ""))
					.filter((text) => text.length > 0)
					.join("\n");

				if (!aiMessageContent || aiMessageContent.trim() === "") {
					const errorMessage =
						"Error: AI message content is empty, cannot generate plan prompt.";
					console.error(
						`[MessageHandler] AI message content is empty for index ${messageIndex}.`
					);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					await provider.endUserOperation("failed", errorMessage);
					break;
				}

				await provider.startUserOperation("planPrompt"); // Start the operation and set generating state
				const token = provider.activeOperationCancellationTokenSource!.token; // Get the token for the new operation

				try {
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: "Generating plan prompt from AI message...",
					});

					const generatedPlanText = await generateLightweightPlanPrompt(
						aiMessageContent,
						DEFAULT_FLASH_LITE_MODEL,
						provider.aiRequestService,
						token
					);

					if (token.isCancellationRequested) {
						console.log(
							"[MessageHandler] generatePlanPromptFromAIMessage: Operation cancelled after generation but before pre-fill."
						);
						await provider.endUserOperation("cancelled");
						return; // Crucially, exit the handler early.
					}

					provider.postMessageToWebview({
						type: "PrefillChatInput",
						payload: { text: generatedPlanText },
					});
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: "Plan prompt generated and pre-filled into chat input.",
					});
					await provider.endUserOperation("success"); // endUserOperation will handle updateLoadingState(false)
				} catch (error: any) {
					const isCancellation = error.message === ERROR_OPERATION_CANCELLED;
					if (isCancellation) {
						console.log(
							"[MessageHandler] generatePlanPromptFromAIMessage: Operation cancelled during generation."
						);
						await provider.endUserOperation("cancelled");
					} else {
						const formattedError = formatUserFacingErrorMessage(
							error,
							"Failed to generate plan prompt.",
							"Error generating plan prompt: "
						);
						console.error(
							`[MessageHandler] Error generating lightweight plan prompt:`,
							error
						);
						provider.postMessageToWebview({
							type: "statusUpdate",
							value: formattedError,
							isError: true,
						});
						await provider.endUserOperation("failed", formattedError);
					}
				} finally {
					// The token source is disposed in provider.endUserOperation or triggerUniversalCancellation
					// No need for redundant disposal here.
				}
				break;
			}

			case "copyContextMessage": {
				console.log("[MessageHandler] Received copyContextMessage request.");
				if (!provider.workspaceRootUri) {
					const errorMessage = "No workspace is open to copy context from.";
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
					break;
				}

				try {
					const messageIndex = validatedData.payload.messageIndex;

					const chatHistory = provider.chatHistoryManager.getChatHistory();
					if (messageIndex < 0 || messageIndex >= chatHistory.length) {
						throw new Error("Invalid message index provided.");
					}
					const historyEntry = chatHistory[messageIndex];
					if (
						!["user", "model"].includes(historyEntry.role) ||
						!historyEntry.parts.length
					) {
						throw new Error(
							"Selected message is not a user or AI message or has no content."
						);
					}

					let messageContentText = "";
					// Extract text content from HistoryEntryPart array
					historyEntry.parts.forEach((part) => {
						if ("text" in part && part.text) {
							messageContentText += part.text + "\n";
						}
					});
					messageContentText = messageContentText.trim();

					if (!messageContentText) {
						throw new Error("Message content is empty.");
					}

					provider.postMessageToWebview({
						type: "statusUpdate",
						value: "Building project context for the message...",
						showLoadingDots: true,
					});

					const contextResult =
						await provider.contextService.buildProjectContext(
							provider.activeOperationCancellationTokenSource?.token,
							messageContentText,
							undefined, // editorContext
							undefined, // initialDiagnosticsString
							{
								useScanCache: true,
								useDependencyCache: true,
								useAISelectionCache: true,
								forceAISelectionRecalculation: false,
							},
							false, // includePersona
							false // includeVerboseHeaders
						);

					const relevantFiles = contextResult.relevantFiles;

					const fileTreeContent = createAsciiTree(
						relevantFiles,
						"Project Root"
					);

					let allFileContents = "";
					for (const relativePath of relevantFiles) {
						const uri = vscode.Uri.joinPath(
							provider.workspaceRootUri,
							relativePath
						);
						try {
							const contentBytes = await vscode.workspace.fs.readFile(uri);
							const fileContent = Buffer.from(contentBytes).toString("utf-8");
							allFileContents += `--- File: ${relativePath} ---\n${fileContent}\n\n`;
						} catch (fileReadError: any) {
							console.warn(
								`[MessageHandler] Could not read file ${relativePath}: ${fileReadError.message}`
							);
							allFileContents += `--- File: ${relativePath} ---\n[Error reading file: ${fileReadError.message}]\n\n`;
						}
					}

					const header =
						historyEntry.role === "user" ? "User message" : "Instructions";
					const finalCombinedContent = `${PRE_PROMPT_MESSAGE}\n\n${header}: ${messageContentText}\n\nFile Tree:\n${fileTreeContent}\n\nFile Content:\n${allFileContents}`;

					await vscode.env.clipboard.writeText(finalCombinedContent);

					provider.postMessageToWebview({
						type: "statusUpdate",
						value: "Message context copied to clipboard successfully!",
						isError: false,
					});
					console.log("[MessageHandler] Message context copied to clipboard.");
				} catch (error: any) {
					const errorMessage = formatUserFacingErrorMessage(
						error,
						"Failed to copy message context to clipboard.",
						"Error copying context: "
					);
					console.error(`[MessageHandler] ${errorMessage}`, error);
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: errorMessage,
						isError: true,
					});
				}
				break;
			}

			case "requestWorkspaceFiles":
				console.log(
					"[WebviewMessageHandler] Webview requested workspace files."
				);
				try {
					const allScannedFilesUris = await scanWorkspace({ useCache: true });
					const allScannedFilesRelativePaths = allScannedFilesUris.map((uri) =>
						vscode.workspace.asRelativePath(uri)
					);
					provider.postMessageToWebview({
						type: "receiveWorkspaceFiles",
						value: allScannedFilesRelativePaths,
					});
					console.log(
						`[WebviewMessageHandler] Sent ${allScannedFilesRelativePaths.length} workspace file paths to webview.`
					);
				} catch (error: any) {
					console.error(
						"[WebviewMessageHandler] Error scanning workspace files for webview:",
						error
					);
					provider.postMessageToWebview({
						type: "receiveWorkspaceFiles",
						value: [],
					});
					provider.postMessageToWebview({
						type: "statusUpdate",
						value: formatUserFacingErrorMessage(
							error,
							"An unknown error occurred while scanning workspace files.",
							"Error scanning workspace files: "
						),
						isError: true,
					});
				}
				break;

			case "aiResponseEnd": {
				if (
					validatedData.success &&
					validatedData.isPlanResponse &&
					validatedData.requiresConfirmation
				) {
					await provider.endUserOperation("review");
				} else if (validatedData.success) {
					await provider.endUserOperation("success");
				} else {
					await provider.endUserOperation("failed");
				}
				break;
			}

			case "structuredPlanParseFailed": {
				const { error, failedJson } = validatedData.value;
				console.error("Received structuredPlanParseFailed.", error, failedJson);
				const errorMessage = formatUserFacingErrorMessage(
					error,
					"Failed to parse AI-generated plan structure.",
					"Error: "
				);
				provider.postMessageToWebview({
					type: "statusUpdate",
					value: errorMessage,
					isError: true,
				});
				await provider.endUserOperation("failed", errorMessage);
				break;
			}

			case "commitReview": {
				console.log("Received commitReview message:", validatedData.value);
				await provider.endUserOperation("review");
				break;
			}

			default:
				console.warn(
					`Unknown message type received: ${
						(validatedData as { type: unknown }).type
					}`
				);
		}
	} catch (error: any) {
		const errorMessage = formatUserFacingErrorMessage(
			error,
			"An unexpected error occurred while processing your request."
		);
		console.error(
			`[MessageHandler] Unhandled error in handleWebviewMessage:`,
			error
		);

		// If a user operation was initially generating and its ID hasn't changed,
		// attempt to end the operation with a "failed" status.
		if (
			initialIsGeneratingUserRequest &&
			provider.currentActiveChatOperationId === initialActiveChatOperationId
		) {
			await provider.endUserOperation("failed", errorMessage);
		} else {
			// If not an active user operation, or the operation ID changed (meaning a new one started/cancelled),
			// just post a status update to the webview.
			provider.postMessageToWebview({
				type: "statusUpdate",
				value: errorMessage,
				isError: true,
			});
			provider.postMessageToWebview({ type: "reenableInput" });
		}
	}
}
