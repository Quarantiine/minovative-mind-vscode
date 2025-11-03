// src/sidebar/webview/eventHandlers/messageBusHandler.ts
import {
	appendMessage,
	finalizeStreamingMessage,
	buildPlanTimeline,
	renderPlanTimeline,
} from "../ui/chatMessageRenderer";
import {
	updateApiKeyStatus,
	updateStatus,
	updateEmptyChatPlaceholderVisibility,
} from "../ui/statusManager";
import { appState } from "../state/appState";
import {
	AiStreamingState,
	PersistedPlanData,
	PlanExecutionFinishedMessage,
	ChatMessage,
	ModelInfo,
	AiResponseStartMessage,
	AiResponseChunkMessage,
	AiResponseEndMessage,
	FormattedTokenStatistics,
	ExtensionToWebviewMessages,
	PlanTimelineInitializeMessage, // ADDED
	PlanTimelineProgressMessage, // ADDED
} from "../../common/sidebarTypes";
import {
	stopTypingAnimation,
	startTypingAnimation,
} from "../ui/typingAnimation";
import {
	createPlanConfirmationUI,
	showPlanConfirmationUI,
	showPlanParseErrorUI,
	showCommitReviewUI,
	hideAllConfirmationAndReviewUIs,
	showClearChatConfirmationUI,
} from "../ui/confirmationAndReviewUIs";
import { md } from "../utils/markdownRenderer";
import { postMessageToExtension } from "../utils/vscodeApi";
import { RequiredDomElements } from "../types/webviewTypes";
import { resetUIStateAfterCancellation } from "../ui/statusManager";
import {
	handleCodeFileStreamStart,
	handleCodeFileStreamChunk,
	handleCodeFileStreamEnd,
	resetCodeStreams,
} from "./codeStreamHandler";
import { showSuggestions } from "../ui/commandSuggestions";

export function initializeMessageBusHandler(
	elements: RequiredDomElements,
	setLoadingState: (loading: boolean, elements: RequiredDomElements) => void
): void {
	window.addEventListener("message", (event: MessageEvent) => {
		const message = event.data;
		console.log(
			"[Webview] Message received from extension:",
			message.type,
			message
		);

		switch (message.type) {
			case "aiResponse": {
				appendMessage(
					elements,
					"Model",
					message.value,
					`ai-message ${message.isError ? "error-message" : ""}`.trim(),
					true,
					undefined,
					message.relevantFiles,
					undefined, // messageIndexForHistory
					undefined, // isRelevantFilesExpandedForHistory
					false // isPlanExplanationForRender
				);

				// REMOVED: This block was prematurely showing the plan confirmation UI.
				// The plan confirmation UI should only be shown after aiResponseEnd for streaming plans.
				if (message.isLoading === false) {
					setLoadingState(false, elements);
				}
				break;
			}

			case "receiveWorkspaceFiles": // Changed case name
				console.log("[MessageBusHandler] Received receiveWorkspaceFiles."); // Updated log message
				if (Array.isArray(message.value)) {
					// Modified conditional logic
					appState.allWorkspaceFiles = message.value as string[]; // Updated data assignment and type cast
					appState.isRequestingWorkspaceFiles = false;
					showSuggestions(
						appState.allWorkspaceFiles,
						"file",
						elements,
						setLoadingState
					);
				} else {
					console.error(
						"[MessageBusHandler] Received unexpected payload for receiveWorkspaceFiles:",
						message.value
					);
					appState.allWorkspaceFiles = []; // Clear files on unexpected format
					appState.isRequestingWorkspaceFiles = false; // Reset request status
					showSuggestions([], "file", elements, setLoadingState);
				}
				break;

			case "codeFileStreamStart": {
				handleCodeFileStreamStart(elements, message as any);
				break;
			}
			case "codeFileStreamChunk": {
				handleCodeFileStreamChunk(elements, message as any);
				break;
			}
			case "codeFileStreamEnd": {
				handleCodeFileStreamEnd(elements, message as any);
				break;
			}

			case "restoreStreamingProgress": {
				finalizeStreamingMessage(elements);
				const streamingState = message.value as AiStreamingState;
				const { content, relevantFiles, isComplete, isError, operationId } =
					streamingState;

				appState.currentActiveOperationId = operationId;

				console.log(
					"[Webview] Received restoreStreamingProgress. Content length:",
					content.length,
					"Is Complete:",
					isComplete,
					"Operation ID:",
					operationId
				);

				// Append the base AI message element. This sets up the DOM structure
				// and assigns `appState.currentAiMessageContentElement` to the correct span.
				// We pass an empty string for initial text, as content will be injected/animated.
				appendMessage(
					elements,
					"Model",
					"", // Initial empty text, content will be populated next
					`ai-message ${isError ? "error-message" : ""}`.trim(),
					true, // Treat as a history-backed message for consistent styling and buttons
					undefined, // No diffContent for streaming progress
					relevantFiles,
					undefined, // messageIndexForHistory
					undefined, // isRelevantFilesExpandedForHistory
					false // isPlanExplanationForRender
				);

				// Get a reference to the message element that was just created.
				const restoredMessageElement = elements.chatContainer
					?.lastElementChild as HTMLDivElement | null;
				if (restoredMessageElement) {
					// Find the specific content span within the newly created message element.
					appState.currentAiMessageContentElement =
						restoredMessageElement.querySelector(
							".message-text-content"
						) as HTMLSpanElement | null;

					// Get references to copy/delete buttons
					const copyButton = restoredMessageElement.querySelector(
						".copy-button"
					) as HTMLButtonElement | null;
					const deleteButton = restoredMessageElement.querySelector(
						".delete-button"
					) as HTMLButtonElement | null;
					const editButton = restoredMessageElement.querySelector(
						".edit-button"
					) as HTMLButtonElement | null;

					if (appState.currentAiMessageContentElement) {
						// Populate the accumulated text from the restored state
						appState.currentAccumulatedText = content;

						// Render content and manage loading state based on `isComplete`
						if (isComplete) {
							// If the stream is complete, just render the final content.
							appState.currentAiMessageContentElement.innerHTML = md.render(
								appState.currentAccumulatedText
							);
							// Store the original markdown text for copy functionality
							appState.currentAiMessageContentElement.dataset.originalMarkdown =
								appState.currentAccumulatedText;
							stopTypingAnimation(); // Ensure animation is stopped
							// Re-enable action buttons and the UI
							if (!appState.isCancellationInProgress) {
								setLoadingState(false, elements);
							} else {
								console.log(
									"[Guard] UI remains disabled due to ongoing cancellation (restoreStreamingProgress completed)."
								);
							}
							if (copyButton) {
								copyButton.disabled = false;
							}
							if (deleteButton) {
								deleteButton.disabled = false;
							}
							if (editButton) {
								editButton.disabled = false;
							}
						} else {
							// If the stream is NOT complete, render accumulated content PLUS the loading dots.
							appState.currentAiMessageContentElement.innerHTML =
								md.render(appState.currentAccumulatedText) +
								'<span class="loading-text">Generating<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>';
							startTypingAnimation(elements); // Re-activate the typing animation for the dots
							// Disable action buttons and indicate a loading state
							setLoadingState(true, elements);
							if (copyButton) {
								copyButton.disabled = true;
							} // Disable buttons while generating
							if (deleteButton) {
								deleteButton.disabled = true;
							}
							if (editButton) {
								editButton.disabled = true;
							}
						}

						// Ensure the chat container scrolls to the bottom to show the restored message
						if (elements.chatContainer) {
							elements.chatContainer.scrollTop =
								elements.chatContainer.scrollHeight;
						}
					} else {
						console.warn(
							"[Webview] Failed to find .message-text-content in restored AI message. Fallback to direct append."
						);
						// Fallback if the content element isn't found after appendMessage.
						// Append the full content, ensuring it's treated as a history message.
						appendMessage(
							elements,
							"Model",
							content,
							`ai-message ${isError ? "error-message" : ""}`.trim(),
							true,
							undefined,
							relevantFiles,
							undefined, // messageIndexForHistory
							undefined, // isRelevantFilesExpandedForHistory
							false // isPlanExplanationForRender
						);
						// If isComplete was false, call setLoadingState(false, elements) as animation setup failed.
						if (!isComplete) {
							setLoadingState(false, elements);
						}
					}
				} else {
					console.warn(
						"[Webview] Failed to find or create AI message element for restoreStreamingProgress. Fallback to direct append."
					);
					// Fallback if the message element itself couldn't be created.
					appendMessage(
						elements,
						"Model",
						content,
						`ai-message ${isError ? "error-message" : ""}`.trim(),
						true,
						undefined,
						relevantFiles,
						undefined, // messageIndexForHistory
						undefined, // isRelevantFilesExpandedForHistory
						false // isPlanExplanationForRender
					);
					// If isComplete was false, call setLoadingState(false, elements) as animation setup failed.
					if (!isComplete) {
						setLoadingState(false, elements);
					}
				}
				break;
			}

			case "showGenericLoadingMessage": {
				elements.statusArea.textContent = "";
				elements.apiKeyStatusDiv.textContent = "";
				console.log(
					"[Webview] Received showGenericLoadingMessage. Displaying generic loading."
				);
				// Remove any existing loading message to ensure a clean state
				const existingLoadingMsg =
					elements.chatContainer.querySelector(".loading-message");
				if (existingLoadingMsg) {
					existingLoadingMsg.remove();
				}

				// Ensure UI controls are disabled while loading
				setLoadingState(true, elements);
				break;
			}

			case "aiResponseStart": {
				elements.statusArea.textContent = "";
				elements.apiKeyStatusDiv.textContent = "";
				const startMessage = message as AiResponseStartMessage; // Cast message
				setLoadingState(true, elements);
				finalizeStreamingMessage(elements); // Modified: Replace resetStreamingAnimationState()
				console.log(
					"Received aiResponseStart. Starting stream via appendMessage."
				);
				appState.isCancellationInProgress = false; // Add this line
				appState.currentActiveOperationId = startMessage.value.operationId; // Assign operationId
				appendMessage(
					elements,
					"Model",
					"",
					"ai-message",
					true,
					undefined,
					startMessage.value.relevantFiles,
					undefined, // messageIndexForHistory
					undefined, // isRelevantFilesExpandedForHistory
					false // isPlanExplanationForRender
				);
				break;
			}
			case "aiResponseChunk": {
				const chunkMessage = message as AiResponseChunkMessage; // Cast message
				if (chunkMessage.operationId !== appState.currentActiveOperationId) {
					console.debug(
						"Ignoring AI chunk from old operation:",
						chunkMessage.operationId
					);
					return;
				}
				if (chunkMessage.value !== undefined) {
					appState.typingBuffer += chunkMessage.value;
					if (appState.typingTimer === null) {
						startTypingAnimation(elements);
					}
				}
				break;
			}
			case "aiResponseEnd": {
				const endMessage = message as AiResponseEndMessage; // Cast message
				if (endMessage.operationId !== appState.currentActiveOperationId) {
					console.debug(
						"Ignoring AI response end from old operation:",
						endMessage.operationId
					);
					return;
				}

				finalizeStreamingMessage(elements);
				console.log("Received aiResponseEnd. Stream finished.");

				const isCancellation =
					typeof endMessage.error === "string" &&
					endMessage.error.includes("cancelled");

				if (appState.currentAiMessageContentElement) {
					appState.currentAccumulatedText += appState.typingBuffer;
					let finalContentHtml: string;

					if (!endMessage.success && isCancellation) {
						finalContentHtml = "";
						appState.currentAiMessageContentElement.dataset.originalMarkdown =
							"";
						appState.currentAccumulatedText = "";
					} else if (!endMessage.success && endMessage.error) {
						const errorMessageContent =
							typeof endMessage.error === "string"
								? endMessage.error
								: "Unknown error occurred during AI response streaming.";
						const errorText = `Error: ${errorMessageContent}`;
						finalContentHtml = md.render(errorText);
						appState.currentAiMessageContentElement.dataset.originalMarkdown =
							errorText;
					} else {
						finalContentHtml = md.render(appState.currentAccumulatedText);
						appState.currentAiMessageContentElement.dataset.originalMarkdown =
							appState.currentAccumulatedText;
					}
					// Ensure rendering happens BEFORE plan confirmation logic
					appState.currentAiMessageContentElement.innerHTML = finalContentHtml;

					const messageElement =
						appState.currentAiMessageContentElement.parentElement;
					if (messageElement) {
						// Re-enable copy, delete, and edit buttons on the message
						messageElement
							.querySelector(".copy-button")
							?.removeAttribute("disabled");
						messageElement
							.querySelector(".delete-button")
							?.removeAttribute("disabled");
						messageElement
							.querySelector(".edit-button")
							?.removeAttribute("disabled");

						// CRITICAL CHANGE: Handle generate-plan-button visibility
						const generatePlanButton = messageElement.querySelector(
							".generate-plan-button"
						) as HTMLButtonElement | null;

						if (
							endMessage.success &&
							endMessage.isPlanResponse &&
							endMessage.planData
						) {
							if (generatePlanButton) {
								generatePlanButton.style.display = "none";
							}
						} else {
							// Otherwise, ensure it's visible (for regular AI responses)
							if (generatePlanButton) {
								generatePlanButton.style.display = ""; // Reset to default display
							}
						}
					}
				} else {
					console.warn(
						"aiResponseEnd received but currentAiMessageContentElement is null. Fallback to appending new message."
					);
					// Fallback: If for some reason the element wasn't tracked, append a new message.
					// This should generally only happen if a previous streaming message was somehow malformed or lost.
					if (!endMessage.success && isCancellation) {
					} else if (!endMessage.success && endMessage.error) {
						const errorMessageContent =
							typeof endMessage.error === "string"
								? endMessage.error
								: "Unknown error occurred during AI operation.";
						appendMessage(
							elements,
							"Model",
							md.render(`Error: ${errorMessageContent}`),
							"ai-message error-message",
							true,
							undefined, // diffContent
							undefined, // relevantFiles
							undefined, // messageIndexForHistory
							undefined, // isRelevantFilesExpandedForHistory
							false // isPlanExplanationForRender (fallback, so it's not a plan)
						);
					} else {
						// If successful but currentAiMessageContentElement was null, append the accumulated text.
						appendMessage(
							elements,
							"Model",
							md.render(appState.currentAccumulatedText),
							"ai-message",
							true,
							undefined, // diffContent
							undefined, // relevantFiles
							undefined, // messageIndexForHistory
							undefined, // isRelevantFilesExpandedForHistory
							false // isPlanExplanationForRender (fallback, so it's not a plan)
						);
					}
				}

				// Add logic to select all elements with the class '.user-message-edited-pending-ai'
				// from 'elements.chatContainer' and remove this class from each of them.
				const editedMessages = elements.chatContainer.querySelectorAll(
					".user-message-edited-pending-ai"
				);
				editedMessages.forEach((msg) => {
					msg.classList.remove("user-message-edited-pending-ai");
				});

				// Common cleanup for isCommitActionInProgress regardless of outcome
				appState.isCommitActionInProgress = false;

				// Handle status bar updates for errors/cancellations
				if (!endMessage.success) {
					const statusMessage = isCancellation
						? ""
						: typeof endMessage.error === "string"
						? `AI Operation Failed: ${endMessage.error}`
						: "AI operation failed or was cancelled.";
					updateStatus(elements, statusMessage, true);
				} else if (endMessage.statusMessageOverride) {
					// Handle custom success messages like "No changes staged"
					updateStatus(elements, endMessage.statusMessageOverride, false);
				}

				// This block is the SOLE place where showPlanConfirmationUI is called for newly generated plans.
				// It must contain calls to createPlanConfirmationUI, set appState.pendingPlanData, call showPlanConfirmationUI,
				// and hide the cancel button.
				if (
					endMessage.success &&
					endMessage.isPlanResponse &&
					endMessage.planData
				) {
					console.log("aiResponseEnd indicates confirmable plan.");
					createPlanConfirmationUI(
						elements,
						postMessageToExtension,
						updateStatus,
						setLoadingState
					);
					appState.pendingPlanData = endMessage.planData as {
						type: string;
						originalRequest?: string;
						originalInstruction?: string;
						relevantFiles?: string[];
					};
					showPlanConfirmationUI(
						elements,
						appState.pendingPlanData,
						postMessageToExtension,
						updateStatus,
						setLoadingState
					);
					if (elements.cancelGenerationButton) {
						elements.cancelGenerationButton.style.display = "none";
					}

					// Automatically open the sidebar when a plan is completed
					postMessageToExtension({
						type: "openSidebar",
					});
				}
				// 2. Add a new else if for commit review.
				else if (
					endMessage.success &&
					endMessage.isCommitReviewPending &&
					endMessage.commitReviewData
				) {
					appState.pendingCommitReviewData = endMessage.commitReviewData;
					showCommitReviewUI(
						elements,
						endMessage.commitReviewData.commitMessage,
						endMessage.commitReviewData.stagedFiles,
						postMessageToExtension,
						updateStatus,
						setLoadingState
					);
					if (elements.cancelGenerationButton) {
						elements.cancelGenerationButton.style.display = "none";
					}
				}
				// 4. Ensure the final else if handles standard UI re-enablement.
				else if (endMessage.success) {
					// Ensure setLoadingState(false, elements) is NOT called if appState.isCancellationInProgress is true.
					if (!appState.isCancellationInProgress) {
						setLoadingState(false, elements);
					} else {
						console.log(
							"[Guard] UI remains disabled due to ongoing cancellation."
						);
					}
				}
				// Ensure error paths do not prematurely re-enable UI if cancellation is in progress
				else if (!endMessage.success) {
					// If it's an error and not a cancellation, or an error path where UI should still be loading due to cancellation
					if (!isCancellation) {
						// If it's a real error, not a cancellation
						if (!appState.isCancellationInProgress) {
							// If not cancellation, re-enable UI
							setLoadingState(false, elements);
						} else {
							// If cancellation is in progress, UI remains disabled
							console.log(
								"[Guard] UI remains disabled due to ongoing cancellation (aiResponseEnd error path)."
							);
						}
					} else {
						// It is a cancellation
						if (!appState.isCancellationInProgress) {
							setLoadingState(false, elements); // Should ideally be handled by resetUIStateAfterCancellation or similar
						} else {
							console.log(
								"[Guard] UI remains disabled as cancellation is acknowledged (aiResponseEnd cancellation path)."
							);
						}
					}
				}
				appState.currentActiveOperationId = null; // Set currentActiveOperationId to null after processing
				break;
			}

			case "planTimelineInitialize": {
				const initializeMessage = message as PlanTimelineInitializeMessage;
				console.log(
					"[Webview] Received planTimelineInitialize message. Steps:",
					initializeMessage.stepDescriptions.length
				);

				// 3. Handle planTimelineInitialize
				appState.currentPlanSteps = initializeMessage.stepDescriptions;
				appState.currentPlanStepIndex = -1; // Reset step index
				appState.isPlanExecutionInProgress = true;
				setLoadingState(true, elements);

				buildPlanTimeline(elements);
				renderPlanTimeline(elements, -1, "Initializing...");

				break;
			}

			case "planTimelineProgress": {
				const progressMessage = message as PlanTimelineProgressMessage;
				console.log(
					"[Webview] Received planTimelineProgress message. Index:",
					progressMessage.stepIndex
				);

				// 4. Handle planTimelineProgress
				appState.currentPlanStepIndex = progressMessage.stepIndex;
				renderPlanTimeline(
					elements,
					progressMessage.stepIndex,
					progressMessage.detail ?? "",
					progressMessage.diffContent,
					progressMessage.status === "failed"
				);

				setLoadingState(true, elements);
				break;
			}

			case "requestClearChatConfirmation": {
				console.log("[Webview] Received requestClearChatConfirmation.");
				showClearChatConfirmationUI(
					elements,
					postMessageToExtension,
					updateStatus,
					setLoadingState
				);
				break;
			}

			case "updateTokenStatistics": {
				console.log(
					"[Webview] Received token statistics update:",
					message.value
				);
				const stats = message.value as FormattedTokenStatistics;
				console.log(
					`[Webview] updateTokenStatistics: Received stats object:`,
					stats
				);

				// Update token usage display
				const totalInputElement = document.getElementById("total-input-tokens");
				const totalOutputElement = document.getElementById(
					"total-output-tokens"
				);
				const totalTokensElement = document.getElementById("total-tokens");
				const requestCountElement = document.getElementById("request-count");
				const avgInputElement = document.getElementById("avg-input-tokens");
				const avgOutputElement = document.getElementById("avg-output-tokens");

				if (totalInputElement) {
					totalInputElement.textContent = stats.totalInput;
				}
				if (totalOutputElement) {
					totalOutputElement.textContent = stats.totalOutput;
				}
				if (totalTokensElement) {
					totalTokensElement.textContent = stats.total;
				}
				if (requestCountElement) {
					requestCountElement.textContent = stats.requestCount;
				}
				if (avgInputElement) {
					avgInputElement.textContent = stats.averageInput;
				}
				if (avgOutputElement) {
					avgOutputElement.textContent = stats.averageOutput;
				}

				// Model Usage Breakdown
				if (elements.modelUsagePercentagesList) {
					elements.modelUsagePercentagesList.innerHTML = ""; // Clear existing content

					const heading = document.createElement("h4");
					heading.textContent = "Model Usage Breakdown";
					elements.modelUsagePercentagesList.appendChild(heading);

					let modelUsageMap: Map<string, number>;

					if (Array.isArray(stats.modelUsagePercentages)) {
						modelUsageMap = new Map(
							stats.modelUsagePercentages as [string, number][]
						);
					} else {
						console.warn(
							"[Webview] updateTokenStatistics: Received modelUsagePercentages not as an array of entries. Initializing empty Map. Received:",
							stats.modelUsagePercentages
						);
						modelUsageMap = new Map();
					}

					console.log(
						`[Webview] updateTokenStatistics: modelUsageMap.size = ${
							modelUsageMap.size
						}, modelUsageMap contents = ${JSON.stringify(
							Array.from(modelUsageMap.entries())
						)}`
					);

					if (modelUsageMap.size > 0) {
						modelUsageMap.forEach((percentage, modelName) => {
							const div = document.createElement("div");
							div.textContent = `${modelName}: ${percentage.toFixed(2)}%`;
							elements.modelUsagePercentagesList.appendChild(div);
						});
					} else {
						// Fallback message if the map is empty
						const noDataParagraph = document.createElement("p");
						noDataParagraph.textContent = "No model usage data available yet.";
						elements.modelUsagePercentagesList.appendChild(noDataParagraph);
					}
				}
				appState.lastFormattedTokenStats = stats; // Assign the stats object to appState.lastFormattedTokenStats
				break;
			}

			case "updateCurrentTokenEstimates": {
				console.log(
					"[Webview] Received current token estimates update:",
					message.value
				);
				const estimates = message.value;

				// Update token usage display with current streaming estimates
				const totalInputElement = document.getElementById("total-input-tokens");
				const totalOutputElement = document.getElementById(
					"total-output-tokens"
				);
				const totalTokensElement = document.getElementById("total-tokens");

				if (totalInputElement) {
					totalInputElement.textContent = estimates.inputTokens;
				}
				if (totalOutputElement) {
					totalOutputElement.textContent = estimates.outputTokens;
				}
				if (totalTokensElement) {
					totalTokensElement.textContent = estimates.totalTokens;
				}
				break;
			}

			case "structuredPlanParseFailed": {
				const { error, failedJson } = message.value;
				console.log("Received structuredPlanParseFailed.");
				showPlanParseErrorUI(
					elements,
					error,
					failedJson,
					postMessageToExtension,
					updateStatus, // Corrected order as per showPlanParseErrorUI signature
					setLoadingState // Corrected order as per showPlanParseErrorUI signature
				);
				if (!appState.isCancellationInProgress) {
					setLoadingState(false, elements);
				} else {
					console.log(
						"[Guard] UI remains disabled due to ongoing cancellation (structuredPlanParseFailed)."
					);
				}
				break;
			}

			case "commitReview": {
				console.log("Received commitReview message:", message.value);
				if (
					!message.value ||
					typeof message.value.commitMessage !== "string" ||
					!Array.isArray(message.value.stagedFiles)
				) {
					console.error("Invalid 'commitReview' message value:", message.value);
					if (!appState.isCancellationInProgress) {
						setLoadingState(false, elements);
					} else {
						console.log(
							"[Guard] UI remains disabled due to ongoing cancellation (commitReview invalid value)."
						);
					}
					return;
				}
				const { commitMessage, stagedFiles } = message.value;
				appState.pendingCommitReviewData = { commitMessage, stagedFiles }; // Update appState here
				showCommitReviewUI(
					elements,
					commitMessage,
					stagedFiles,
					postMessageToExtension,
					updateStatus,
					setLoadingState
				);
				break;
			}

			case "restorePendingCommitReview": {
				if (message.value) {
					console.log(
						"Received restorePendingCommitReview message:",
						message.value
					);
					if (
						typeof message.value.commitMessage !== "string" ||
						!Array.isArray(message.value.stagedFiles)
					) {
						console.error(
							"Invalid 'restorePendingCommitReview' message value:",
							message.value
						);
						if (!appState.isCancellationInProgress) {
							setLoadingState(false, elements);
						} else {
							console.log(
								"[Guard] UI remains disabled due to ongoing cancellation (restorePendingCommitReview invalid value)."
							);
						}
						return;
					}
					const { commitMessage, stagedFiles } = message.value;

					appState.pendingCommitReviewData = { commitMessage, stagedFiles };

					showCommitReviewUI(
						elements,
						commitMessage,
						stagedFiles,
						postMessageToExtension,
						updateStatus,
						setLoadingState
					);
					appState.isAwaitingUserReview = true; // Added as per instructions.

					if (!appState.isCancellationInProgress) {
						setLoadingState(false, elements);
					} else {
						console.log(
							"[Guard] UI remains disabled due to ongoing cancellation (restorePendingCommitReview)."
						);
					}

					if (elements.cancelGenerationButton) {
						elements.cancelGenerationButton.style.display = "none";
					}
				} else {
					console.warn(
						"restorePendingCommitReview received without message.value. No action taken."
					);
					if (!appState.isCancellationInProgress) {
						setLoadingState(false, elements);
					} else {
						console.log(
							"[Guard] UI remains disabled due to ongoing cancellation (restorePendingCommitReview fallback)."
						);
					}
				}
				break;
			}

			case "restorePendingPlanConfirmation":
				if (message.value) {
					console.log("Received restorePendingPlanConfirmation.");
					// Update the type cast to include textualPlanExplanation for comprehensive restoration
					const restoredPlanData = message.value as PersistedPlanData; // Use the more complete type from sidebarTypes
					appState.pendingPlanData = restoredPlanData; // Assign to appState

					// Append the restored textual plan explanation to the chat UI
					appendMessage(
						elements,
						"Model",
						restoredPlanData.textualPlanExplanation, // Use the restored text
						"ai-message",
						true, // Treat as history-backed
						undefined,
						restoredPlanData.relevantFiles,
						undefined, // messageIndexForHistory
						undefined, // isRelevantFilesExpandedForHistory
						true // isPlanExplanationForRender
					);

					createPlanConfirmationUI(
						elements,
						postMessageToExtension,
						updateStatus,
						setLoadingState
					);

					if (elements.planConfirmationContainer) {
						elements.planConfirmationContainer.style.display = "flex";
						appState.isAwaitingUserReview = true; // Added as per instructions.
						updateStatus(
							elements,
							"Pending plan confirmation restored. Review and confirm to proceed."
						);

						if (elements.cancelGenerationButton) {
							elements.cancelGenerationButton.style.display = "none";
						}
						if (!appState.isCancellationInProgress) {
							setLoadingState(false, elements);
						} else {
							console.log(
								"[Guard] UI remains disabled due to ongoing cancellation (restorePendingPlanConfirmation)."
							);
						}
					} else {
						console.error(
							"Error: Plan confirmation container not found during restore. Cannot display pending plan."
						);
						updateStatus(
							elements,
							"Error: Failed to restore pending plan UI. Inputs re-enabled.",
							true
						);
						appState.pendingPlanData = null;
						if (!appState.isCancellationInProgress) {
							setLoadingState(false, elements);
						} else {
							console.log(
								"[Guard] UI remains disabled due to ongoing cancellation (restorePendingPlanConfirmation fallback)."
							);
						}
					}
				} else {
					console.warn(
						"restorePendingPlanConfirmation received without message.value. No action taken."
					);
					if (!appState.isCancellationInProgress) {
						setLoadingState(false, elements);
					} else {
						console.log(
							"[Guard] UI remains disabled due to ongoing cancellation (restorePendingPlanConfirmation no value)."
						);
					}
				}
				break;

			case "appendRealtimeModelMessage":
				if (message.value && typeof message.value.text === "string") {
					// 6. Modify the `case "appendRealtimeModelMessage":` block to remove the check for `message.isPlanStepUpdate`
					appendMessage(
						elements,
						"Model",
						message.value.text,
						`ai-message ${message.value.isError ? "error-message" : ""}`.trim(),
						true,
						message.diffContent,
						message.relevantFiles,
						undefined, // messageIndexForHistory
						undefined, // isRelevantFilesExpandedForHistory
						false, // isPlanExplanationForRender
						false // isPlanStepUpdate (Hardcoded false, as timeline handles progress)
					);
					setLoadingState(appState.isLoading, elements);
				} else {
					console.warn(
						"Received 'appendRealtimeModelMessage' with invalid value:",
						message.value
					);
				}
				break;

			case "apiKeyStatus": {
				if (typeof message.value === "string") {
					updateApiKeyStatus(elements, message.value);
					setLoadingState(appState.isLoading, elements);
				}
				break;
			}
			case "statusUpdate": {
				if (typeof message.value === "string") {
					updateStatus(
						elements,
						message.value,
						message.isError ?? false,
						message.showLoadingDots ?? false
					);
					if (
						appState.isCancellationInProgress &&
						message.value.toLowerCase().includes("cancelled")
					) {
						appState.isCancellationInProgress = false;
						console.log(
							"[Webview] Cancellation flow confirmed and completed by statusUpdate. isCancellationInProgress reset."
						);
					}
				}
				break;
			}
			case "updateKeyList": {
				if (message.value && Array.isArray(message.value.keys)) {
					const updateData = message.value as {
						keys: any[];
						activeIndex: number;
						totalKeys: number;
					};

					appState.totalKeys = updateData.totalKeys;
					appState.activeIndex = updateData.activeIndex; // Update the active index in the app state
					appState.isApiKeySet = updateData.activeIndex !== -1;

					if (
						updateData.activeIndex !== -1 &&
						updateData.keys[updateData.activeIndex]
					) {
						elements.currentKeyDisplay!.textContent =
							updateData.keys[updateData.activeIndex].maskedKey;
					} else {
						elements.currentKeyDisplay!.textContent = "No Active Key";
						updateApiKeyStatus(elements, "Please add an API key.");
					}
					setLoadingState(appState.isLoading, elements);
				} else {
					console.error("Invalid 'updateKeyList' message received:", message);
				}
				break;
			}
			case "updateModelList": {
				if (
					message.value &&
					Array.isArray(message.value.availableModels) &&
					typeof message.value.selectedModel === "string"
				) {
					const { availableModels, selectedModel } = message.value as {
						availableModels: ModelInfo[];
						selectedModel: string;
					};
					elements.modelSelect!.innerHTML = "";
					availableModels.forEach((model: ModelInfo) => {
						const option = document.createElement("option");
						option.value = model.name;
						option.textContent = `${model.name} - ${model.description}`;
						if (model.name === selectedModel) {
							option.selected = true;
						}
						elements.modelSelect!.appendChild(option);
					});
					elements.modelSelect!.value = selectedModel;
					console.log(
						"Model list updated in webview. Selected:",
						selectedModel
					);
					setLoadingState(appState.isLoading, elements);
				} else {
					console.error("Invalid 'updateModelList' message received:", message);
				}
				break;
			}
			case "updateLoadingState": {
				setLoadingState(message.value as boolean, elements);
				break;
			}
			case "reenableInput": {
				console.log("Received reenableInput message. Resetting UI state.");
				resetUIStateAfterCancellation(elements, setLoadingState);
				appState.currentActiveOperationId = null;
				appState.isRequestingWorkspaceFiles = false;
				appState.hasRevertibleChanges = false;
				resetCodeStreams();
				// Reset plan state
				appState.currentPlanSteps = [];
				appState.currentPlanStepIndex = -1;
				appState.isPlanExecutionInProgress = false;
				break;
			}
			// 5. Remove case "planExecutionStarted":
			// case "planExecutionStarted": {
			// 	appState.isPlanExecutionInProgress = true;
			// 	setLoadingState(appState.isLoading, elements);
			// 	break;
			// }

			case "planExecutionEnded": {
				// 7. Modify the `case "planExecutionEnded":` block
				appState.isPlanExecutionInProgress = false;
				appState.currentPlanSteps = [];
				appState.currentPlanStepIndex = -1;
				setLoadingState(appState.isLoading, elements);
				break;
			}
			case "planExecutionFinished": {
				console.log(
					"[Webview] Received planExecutionFinished message.",
					message
				);
				const planFinishedMessage = message as PlanExecutionFinishedMessage;
				appState.hasRevertibleChanges =
					planFinishedMessage.hasRevertibleChanges;
				if (!appState.isCancellationInProgress) {
					setLoadingState(false, elements); // Refresh UI to update revert button visibility
				} else {
					console.log(
						"[Guard] UI remains disabled due to ongoing cancellation (planExecutionFinished)."
					);
				}
				break;
			}
			case "revertCompleted": {
				console.log("[Webview] Received revertCompleted message.");
				appState.hasRevertibleChanges = false; // Hide the revert button
				postMessageToExtension({
					type: "statusUpdate",
					value: "Revert completed.",
					isError: false,
				});
				break;
			}
			case "chatCleared": {
				if (elements.chatContainer) {
					elements.chatContainer.innerHTML = "";
				}
				if (!appState.isCancellationInProgress) {
					setLoadingState(false, elements);
				} else {
					console.log(
						"[Guard] UI remains disabled due to ongoing cancellation (chatCleared)."
					);
				}
				finalizeStreamingMessage(elements);
				hideAllConfirmationAndReviewUIs(elements);
				appState.pendingPlanData = null; // Ensure this is reset too
				appState.pendingCommitReviewData = null; // Ensure this is reset too
				appState.isPlanExecutionInProgress = false; // Reset plan execution state
				appState.currentPlanSteps = []; // Reset plan steps
				appState.currentPlanStepIndex = -1; // Reset step index
				updateEmptyChatPlaceholderVisibility(elements);
				resetCodeStreams();
				break;
			}
			case "restoreHistory": {
				if (elements.chatContainer && Array.isArray(message.value)) {
					// Clear existing messages to ensure a complete re-render.
					elements.chatContainer.innerHTML = "";
					appState.nextMessageIndex = message.value.length; // Synchronize the next message index
					// Re-populate the chat display with each historical entry.
					message.value.forEach((msg: ChatMessage, index: number) => {
						if (
							msg &&
							typeof msg.sender === "string" &&
							typeof msg.text === "string"
						) {
							appendMessage(
								elements,
								msg.sender,
								msg.text,
								msg.className || "",
								true,
								msg.diffContent,
								msg.relevantFiles,
								index,
								msg.isRelevantFilesExpanded,
								msg.isPlanExplanation, // isPlanExplanationForRender
								msg.isPlanStepUpdate, // Pass the new flag here
								msg.imageParts // Pass the 12th parameter
							);
						}
					});

					// Select all elements within elements.chatContainer that have the class .user-message-edited-pending-ai.
					const editedMessages = elements.chatContainer.querySelectorAll(
						".user-message-edited-pending-ai"
					);
					editedMessages.forEach((msg) => {
						msg.classList.remove("user-message-edited-pending-ai");
					});

					setLoadingState(appState.isLoading, elements);

					// Scroll to the bottom to show the most recent messages, maintaining UX.
					elements.chatContainer.scrollTop =
						elements.chatContainer.scrollHeight;
				} else {
					updateStatus(
						elements,
						"Error: Failed to restore chat history due to invalid format.",
						true
					);
				}
				break;
			}
			case "authStateUpdate": {
				const { isSignedIn } = message.value;
				console.log(
					`[messageBusHandler] authStateUpdate received. isSignedIn: ${isSignedIn}`
				);

				break;
			}
			case "updateRelevantFilesDisplay": {
				const { messageIndex, isExpanded } = message.value;
				if (elements.chatContainer) {
					const messageElement = elements.chatContainer.querySelector(
						`.message[data-message-index=\"${messageIndex}\"]`
					) as HTMLDivElement | null;
					if (messageElement) {
						const contextFilesDiv = messageElement.querySelector(
							".ai-context-files"
						) as HTMLDivElement | null;
						if (contextFilesDiv) {
							contextFilesDiv.classList.toggle("collapsed", !isExpanded);
							contextFilesDiv.classList.toggle("expanded", isExpanded);
						} else {
							console.warn(
								`[updateRelevantFilesDisplay] .ai-context-files div not found for message index ${messageIndex}.`
							);
						}
					} else {
						console.warn(
							`[updateRelevantFilesDisplay] Message element with data-message-index=\"${messageIndex}\" not found.`
						);
					}
				}
				break;
			}
			case "PrefillChatInput": {
				console.log(
					"[Webview] Received PrefillChatInput. Prefilling chat input."
				);
				const { text } = message.payload;
				const chatInput = elements.chatInput;
				if (chatInput) {
					chatInput.value = text; // Set the chat input field's value
					chatInput.focus(); // Set focus to the input field for user interaction
					// Update the status bar message to inform the user
					updateStatus(
						elements,
						"Context loaded into chat input. Review and send."
					);
					// Ensure the UI controls are enabled (e.g., send button)
					setLoadingState(false, elements);
				}
				break;
			}
			case "resetCodeStreamingArea": {
				console.log(
					"[Webview] Received resetCodeStreamingArea message. Resetting code streams."
				);
				resetCodeStreams();
				break;
			}
			case "operationCancelledConfirmation": {
				console.log(
					"[Webview] Received operationCancelledConfirmation. Resetting UI state."
				);
				finalizeStreamingMessage(elements);
				resetUIStateAfterCancellation(elements, setLoadingState);
				appState.currentActiveOperationId = null;
				appState.isRequestingWorkspaceFiles = false;
				appState.hasRevertibleChanges = false;
				resetCodeStreams();
				// Reset plan state
				appState.currentPlanSteps = [];
				appState.currentPlanStepIndex = -1;
				appState.isPlanExecutionInProgress = false;
				break;
			}
			default:
				console.warn(
					"[Webview] Received unknown message type from extension:",
					message.type
				);
		}
	});
}
