import {
	faCheck,
	faTimes,
	faRedo,
	faStop,
	faCopy,
	faTrashCan,
	faPaperPlane,
	faFloppyDisk,
	faFolderOpen,
	faChevronLeft,
	faChevronRight,
	faPlus,
	faUndo,
	faImage, // Added faImage import
	faFolder,
	faFileExport, // Import faFolder
} from "@fortawesome/free-solid-svg-icons";
import { setIconForButton } from "../utils/iconHelpers";
import { postMessageToExtension } from "../utils/vscodeApi";
import { updateStatus, updateApiKeyStatus } from "../ui/statusManager";
import { appState } from "../state/appState";
import { sendMessage } from "../messageSender";
import { hidePlanParseErrorUI } from "../ui/confirmationAndReviewUIs";
import { stopTypingAnimation } from "../ui/typingAnimation";
import { RequiredDomElements } from "../types/webviewTypes";
import { clearImagePreviews } from "../utils/imageUtils";
import { showSuggestions } from "../ui/commandSuggestions"; // Import showSuggestions

/**
 * Initializes all button and interactive element event listeners in the webview.
 * @param elements An object containing all required DOM elements.
 * @param setLoadingState A callback function to update the global loading state.
 */
export function initializeButtonEventListeners(
	elements: RequiredDomElements,
	setLoadingState: (loading: boolean, elements: RequiredDomElements) => void
): void {
	const {
		sendButton,
		modelSelect,
		addKeyButton,
		addKeyInput,
		prevKeyButton,
		nextKeyButton,
		deleteKeyButton,
		clearChatButton,
		saveChatButton,
		loadChatButton,
		retryGenerationButton,
		cancelParseErrorButton,
		confirmCommitButton,
		cancelCommitButton,

		cancelGenerationButton,
		chatContainer,
		revertChangesButton,
		attachImageButton, // Modified destructuring: rename uploadImageButton to attachImageButton
		clearImagesButton,
		openFileListButton, // Destructure openFileListButton
		copyStatsButton, // Destructure copyStatsButton
	} = elements;

	// Initial icon setup for buttons
	setIconForButton(sendButton, faPaperPlane);
	setIconForButton(saveChatButton, faFloppyDisk);
	setIconForButton(loadChatButton, faFolderOpen);
	setIconForButton(clearChatButton, faTrashCan);
	setIconForButton(prevKeyButton, faChevronLeft);
	setIconForButton(nextKeyButton, faChevronRight);
	setIconForButton(deleteKeyButton, faTrashCan);
	setIconForButton(addKeyButton, faPlus);
	setIconForButton(retryGenerationButton, faRedo);
	setIconForButton(cancelParseErrorButton, faTimes);
	setIconForButton(cancelGenerationButton, faStop);
	setIconForButton(confirmCommitButton, faCheck);
	setIconForButton(cancelCommitButton, faTimes);
	setIconForButton(revertChangesButton, faUndo);
	setIconForButton(attachImageButton, faImage);
	setIconForButton(clearImagesButton, faTimes);
	setIconForButton(openFileListButton, faFolder);
	setIconForButton(copyStatsButton, faCopy); // Set icon for copyStatsButton

	// Send Button
	sendButton.addEventListener("click", () => {
		console.log("Send button clicked.");
		// sendMessage now takes elements and setLoadingState as parameters for consistency
		sendMessage(elements, setLoadingState);
	});

	// Model Select
	modelSelect.addEventListener("change", () => {
		const selectedModel = modelSelect.value;
		postMessageToExtension({ type: "selectModel", value: selectedModel });
		updateStatus(elements, `Requesting switch to model: ${selectedModel}...`); // Pass elements
	});

	// Add API Key Button
	addKeyButton.addEventListener("click", () => {
		const apiKey = addKeyInput.value.trim();
		if (apiKey) {
			postMessageToExtension({ type: "addApiKey", value: apiKey });
			addKeyInput.value = "";
			updateApiKeyStatus(elements, "Adding key..."); // Pass elements
		} else {
			updateApiKeyStatus(elements, "Error: Please enter an API key to add."); // Pass elements
		}
	});

	// Add Key Input (Enter key)
	addKeyInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addKeyButton.click();
		}
	});

	// Previous Key Button
	prevKeyButton.addEventListener("click", () => {
		if (appState.totalKeys > 1) {
			const newIndex =
				(appState.activeIndex - 1 + appState.totalKeys) % appState.totalKeys;
			postMessageToExtension({ type: "setApiActiveKey", value: newIndex });
			updateApiKeyStatus(elements, "Switching key...");
		}
	});

	// Next Key Button
	nextKeyButton.addEventListener("click", () => {
		if (appState.totalKeys > 1) {
			const newIndex = (appState.activeIndex + 1) % appState.totalKeys;
			postMessageToExtension({ type: "setApiActiveKey", value: newIndex });
			updateApiKeyStatus(elements, "Switching key...");
		}
	});

	// Delete Key Button
	deleteKeyButton.addEventListener("click", () => {
		postMessageToExtension({ type: "requestDeleteConfirmation" });
		updateApiKeyStatus(elements, "Waiting for delete confirmation..."); // Pass elements
	});

	// Clear Chat Button
	clearChatButton.addEventListener("click", () => {
		console.log("Clear Chat button clicked.");
		postMessageToExtension({ type: "requestClearChatConfirmation" });
	});

	// Save Chat Button
	saveChatButton.addEventListener("click", () => {
		console.log("Save Chat button clicked.");
		postMessageToExtension({ type: "saveChatRequest" });
		updateStatus(elements, "Requesting chat save..."); // Pass elements
	});

	// Load Chat Button
	loadChatButton.addEventListener("click", () => {
		console.log("Load Chat button clicked.");
		postMessageToExtension({ type: "loadChatRequest" });
		updateStatus(elements, "Requesting chat load..."); // Pass elements
	});

	// Open File List Button
	openFileListButton.addEventListener("click", () => {
		console.log("Open File List button clicked.");
		if (
			appState.allWorkspaceFiles.length === 0 &&
			!appState.isRequestingWorkspaceFiles
		) {
			appState.isRequestingWorkspaceFiles = true;
			postMessageToExtension({ type: "requestWorkspaceFiles" });
			showSuggestions([], "loading", elements, setLoadingState);
		} else {
			showSuggestions(
				appState.allWorkspaceFiles,
				"file",
				elements,
				setLoadingState
			);
		}
	});

	// Copy Token Statistics Button
	copyStatsButton.addEventListener("click", async () => {
		console.log("Copy Stats button clicked.");

		if (!appState.lastFormattedTokenStats) {
			updateStatus(
				elements,
				"No token statistics available to copy yet.",
				true
			);
			return;
		}

		const stats = appState.lastFormattedTokenStats;
		let statsString = `# Token Usage Statistics\n\n`;

		// Overall Totals
		statsString += `Overall Totals:\n`;
		statsString += `- Total Input Tokens: ${stats.totalInput}\n`;
		statsString += `- Total Output Tokens: ${stats.totalOutput}\n`;
		statsString += `- Total Tokens: ${stats.total}\n`;
		statsString += `- Total Requests: ${stats.requestCount}\n`;
		statsString += `- Average Input Tokens/Request: ${stats.averageInput}\n`;
		statsString += `- Average Output Tokens/Request: ${stats.averageOutput}\n`;

		// Model Usage Percentages
		if (stats.modelUsagePercentages && stats.modelUsagePercentages.length > 0) {
			statsString += `\nModel Usage Percentages:\n`;
			for (const [modelName, percentage] of stats.modelUsagePercentages) {
				statsString += `- ${modelName} (with Thinking Mode): ${percentage.toFixed(
					2
				)}%\n`;
			}
		} else {
			statsString += `\nNo specific model usage data available.\n`;
		}

		try {
			await navigator.clipboard.writeText(statsString);
			console.log("Token statistics copied to clipboard.");
			updateStatus(elements, "Token statistics copied to clipboard!");

			const originalTitle = copyStatsButton.title;
			setIconForButton(copyStatsButton, faCheck);
			copyStatsButton.title = "Copied!";

			setTimeout(() => {
				setIconForButton(copyStatsButton, faCopy);
				copyStatsButton.title = originalTitle;
			}, 1500);
		} catch (err) {
			console.error("Failed to copy token statistics: ", err);
			let errorMessage = "Failed to copy token statistics.";
			if (err instanceof Error && err.message) {
				errorMessage += ` Details: ${err.message}`;
			}
			updateStatus(elements, errorMessage, true);
		}
	});

	// Revert Changes Button
	revertChangesButton.addEventListener("click", () => {
		console.log("Revert Changes button clicked.");
		postMessageToExtension({ type: "revertRequest" });
		setLoadingState(true, elements);
		updateStatus(elements, "Requesting revert of last changes...");
	});

	// Retry Generation Button (for plan parse error)
	retryGenerationButton.addEventListener("click", () => {
		console.log("Retry Generation button clicked.");
		// The hidePlanParseErrorUI function already handles setting display: none and clearing content
		hidePlanParseErrorUI(elements);
		postMessageToExtension({ type: "retryStructuredPlanGeneration" });
		setLoadingState(true, elements);
		updateStatus(elements, "Retrying structured plan generation..."); // Pass elements
	});

	// Cancel Parse Error Button
	cancelParseErrorButton.addEventListener("click", () => {
		console.log("Cancel Parse Error button clicked.");
		// Prevent duplicate cancellation requests
		if (appState.isCancellationInProgress) {
			console.warn(
				"Cancellation already in progress, ignoring duplicate request"
			);
			return;
		}

		// The hidePlanParseErrorUI function already handles setting display: none and clearing content
		hidePlanParseErrorUI(elements);
		appState.isCancellationInProgress = true; // Set cancellation flag
		setLoadingState(true, elements); // Add this line
		postMessageToExtension({ type: "universalCancel" }); // Use universal cancel for immediate cancellation
		updateStatus(elements, "Cancelling operations...", false); // Pass elements
		stopTypingAnimation(); // Ensure typing animation stops
		// Clear any current streaming message content if it was interrupted
		if (appState.currentAiMessageContentElement) {
			appState.currentAccumulatedText += appState.typingBuffer;
			appState.currentAiMessageContentElement.textContent =
				appState.currentAccumulatedText;
			appState.currentAiMessageContentElement = null;
			appState.typingBuffer = "";
			appState.currentAccumulatedText = "";
		}
	});

	// Cancel Generation Button
	cancelGenerationButton.addEventListener("click", () => {
		console.log("Cancel Generation button clicked.");
		// Prevent duplicate cancellation requests
		if (appState.isCancellationInProgress) {
			console.warn(
				"Cancellation already in progress, ignoring duplicate request"
			);
			return;
		}

		appState.isCancellationInProgress = true; // Set cancellation flag
		setLoadingState(true, elements); // Add this line

		if (appState.currentAiMessageContentElement) {
			stopTypingAnimation();
		}

		postMessageToExtension({ type: "universalCancel" });
		updateStatus(elements, "Cancelling operations...", false);
	});

	// Attach Image Button
	attachImageButton.addEventListener("click", () => {
		console.log(
			"Attach Image button clicked, programmatically clicking hidden input."
		);
		elements.imageUploadInput.click();
	});

	// Clear Images Button
	clearImagesButton.addEventListener("click", () => {
		console.log("Clear Images button clicked.");
		clearImagePreviews(elements.imagePreviewsContainer);
		appState.selectedImages = [];
		elements.imageUploadInput.value = "";
		setLoadingState(appState.isLoading, elements); // Added this line
		elements.clearImagesButton.style.display = "none"; // Hide the button
	});

	// Chat Container (for message actions: copy, delete, open file)
	chatContainer.addEventListener("click", async (event) => {
		const target = event.target as HTMLElement;
		const copyButton = target.closest(
			".copy-button"
		) as HTMLButtonElement | null;
		const deleteButton = target.closest(
			".delete-button"
		) as HTMLButtonElement | null;
		const fileItem = target.closest(
			".context-file-item[data-filepath]"
		) as HTMLLIElement | null;
		const generatePlanButton = target.closest(
			".generate-plan-button"
		) as HTMLButtonElement | null;

		// Check for code copy button
		const codeCopyButton = target.closest(
			".code-copy-button"
		) as HTMLButtonElement | null;

		// Check for copy context button
		const copyContextButton = target.closest(
			".copy-context-button"
		) as HTMLButtonElement | null;

		if (generatePlanButton && !generatePlanButton.disabled) {
			const messageIndexStr = generatePlanButton.dataset.messageIndex;
			if (messageIndexStr) {
				const parsedIndex = parseInt(messageIndexStr, 10);
				if (!isNaN(parsedIndex)) {
					// Temporarily disable chat input and update placeholder
					elements.chatInput.disabled = true;
					elements.sendButton.disabled = true; // Also disable send button
					setLoadingState(true, elements); // Add this line

					postMessageToExtension({
						type: "generatePlanPromptFromAIMessage",
						payload: { messageIndex: parsedIndex },
					});
					updateStatus(elements, "Generating /plan prompt...");
				} else {
					console.error("Invalid data-message-index:", messageIndexStr);
					updateStatus(
						elements,
						"Error: Invalid message index for plan generation.",
						true
					);
				}
			} else {
				console.error("data-message-index not found on generate-plan-button.");
				updateStatus(
					elements,
					"Error: Missing message index for plan generation.",
					true
				);
			}
			return; // Crucially return to prevent falling through to other button handlers
		}

		if (fileItem) {
			event.preventDefault();
			const filePath = fileItem.dataset.filepath;
			if (filePath) {
				postMessageToExtension({ type: "openFile", value: filePath });
				updateStatus(elements, `Opening file: ${filePath}`); // Pass elements
			}
			return;
		}

		// Handle .copy-context-button clicks
		if (copyContextButton && !copyContextButton.disabled) {
			event.preventDefault();
			copyContextButton.disabled = true; // Disable button immediately

			const messageElement = copyContextButton.closest(
				".message"
			) as HTMLElement;
			if (!messageElement) {
				console.error(
					"Copy context button clicked, but parent message element not found."
				);
				updateStatus(
					elements,
					"Error: Could not find message context to copy.",
					true
				);
				copyContextButton.disabled = false;
				return;
			}

			const messageIndexStr = messageElement.dataset.messageIndex;
			const parsedIndex = messageIndexStr ? parseInt(messageIndexStr, 10) : NaN;

			if (isNaN(parsedIndex)) {
				console.error(
					"Invalid data-message-index for copy context button:",
					messageIndexStr
				);
				updateStatus(
					elements,
					"Error: Invalid message index for copying context.",
					true
				);
				copyContextButton.disabled = false;
				return;
			}

			const originalIconHTML = copyContextButton.innerHTML;
			const originalTitle = copyContextButton.title;

			try {
				updateStatus(elements, "Copying message context...");

				postMessageToExtension({
					type: "copyContextMessage",
					payload: { messageIndex: parsedIndex },
				});

				// UI Feedback: Change icon to faCheck
				setIconForButton(copyContextButton, faCheck);
				copyContextButton.title = "Copied!";

				setTimeout(() => {
					// Revert to faFolder icon
					setIconForButton(copyContextButton, faFileExport);
					copyContextButton.title = originalTitle; // Restore original title
					copyContextButton.disabled = false; // Re-enable button
				}, 1500);

				console.log("Copied message context request sent.");
			} catch (err) {
				console.error("Failed to copy message context: ", err);
				let errorMessage = "Failed to copy message context.";
				if (err instanceof Error && err.message) {
					errorMessage += ` Details: ${err.message}`;
				}
				updateStatus(elements, errorMessage, true);
				copyContextButton.disabled = false;
			}
			return; // Crucially return to prevent further event propagation.
		}

		// Handle .code-copy-button clicks before the general .copy-button
		if (codeCopyButton && !codeCopyButton.disabled) {
			event.preventDefault(); // Prevent default button action
			codeCopyButton.disabled = true; // Disable button immediately

			const faCheckSvg = `<svg class="fa-icon" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="check" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L192 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"></path></svg>`;

			const originalInnerHTML = codeCopyButton.innerHTML;
			const originalTitle = codeCopyButton.title;

			try {
				const preElement = codeCopyButton.closest("pre.hljs");
				if (preElement) {
					const codeElement = preElement.querySelector("code");
					if (codeElement) {
						const codeToCopy = codeElement.textContent || "";
						await navigator.clipboard.writeText(codeToCopy);
						console.log("Code copied to clipboard.");

						// Visual feedback
						codeCopyButton.classList.add("copied");
						codeCopyButton.innerHTML = `${faCheckSvg}Copied!`;
						codeCopyButton.title = "Copied!";

						setTimeout(() => {
							codeCopyButton.innerHTML = originalInnerHTML;
							codeCopyButton.title = originalTitle;
							codeCopyButton.classList.remove("copied");
							codeCopyButton.disabled = false;
						}, 1000);
					} else {
						console.warn(
							"Could not find code element within pre.hljs for copy button."
						);
						updateStatus(elements, "Error: Could not find code to copy.", true);
						codeCopyButton.disabled = false; // Add: Re-enable button on error
					}
				} else {
					console.warn(
						"Could not find parent pre.hljs element for code copy button."
					);
					updateStatus(
						elements,
						"Error: Could not find code block for copy.",
						true
					);
					codeCopyButton.disabled = false; // Add: Re-enable button on error
				}
			} catch (err) {
				console.error("Failed to copy code: ", err);
				let errorMessage = "Failed to copy code.";
				if (err instanceof Error && err.message) {
					errorMessage += ` Details: ${err.message}`;
				}
				updateStatus(elements, errorMessage, true);
				codeCopyButton.disabled = false; // Add: Re-enable button on error
			}
			return; // Crucially return to prevent further event propagation.
		}

		if (copyButton && !copyButton.disabled) {
			const messageElement = copyButton.closest(".message");
			if (messageElement) {
				const textElement = messageElement.querySelector(
					".message-text-content"
				) as HTMLSpanElement | null;

				if (textElement) {
					// Use the original markdown text if available, otherwise fall back to HTML extraction
					let textToCopy = textElement.dataset.originalMarkdown;

					if (!textToCopy) {
						// Fallback to the old HTML extraction method if original markdown is not available
						const textToCopyHTML = textElement.innerHTML;

						// Create a temporary div to parse HTML and extract text, handling newlines
						const tempDiv = document.createElement("div");
						tempDiv.innerHTML = textToCopyHTML;

						// Add newlines before block-level elements for better copy-paste
						Array.from(
							tempDiv.querySelectorAll(
								"p, pre, ul, ol, li, div, br, h1, h2, h3, h4, h5, h6, blockquote, table, tr"
							)
						).forEach((el) => {
							if (el.tagName === "BR") {
								el.replaceWith("\n");
							} else if (el.tagName === "LI") {
								// Ensure new line before each list item, except the first one
								if (el.previousElementSibling) {
									el.prepend("\n");
								}
							} else {
								// Append newline to other block elements
								el.append("\n");
							}
						});

						textToCopy = tempDiv.textContent || tempDiv.innerText || "";
						// Clean up excessive newlines and trim
						textToCopy = textToCopy.replace(/\n{3,}/g, "\n\n"); // Reduce 3+ newlines to 2
						textToCopy = textToCopy.replace(/^\n+/, ""); // Remove leading newlines
						textToCopy = textToCopy.replace(/\n+$/, ""); // Remove trailing newlines
						textToCopy = textToCopy.trim(); // Final trim

						textToCopy = textToCopy.replace(/\n\s*\n/g, "\n\n"); // Clean up blank lines
					}

					// *** Append diff content if available ***
					const diffContainer = messageElement.querySelector(".diff-container");
					if (diffContainer) {
						const diffCodePre = diffContainer.querySelector("pre.diff-code");
						if (diffCodePre) {
							const diffTextContent = diffCodePre.textContent || "";
							if (diffTextContent.trim() !== "") {
								// Append the diff content, separated by a clear header
								textToCopy += `\n\n\`\`\`diff\n${diffTextContent.trim()}\n\`\`\``;
							}
						}
					}

					try {
						await navigator.clipboard.writeText(textToCopy);
						console.log("Text copied to clipboard.");

						const originalIconHTML = copyButton.innerHTML;
						setIconForButton(copyButton, faCheck);
						copyButton.title = "Copied!";

						setTimeout(() => {
							copyButton.innerHTML = originalIconHTML;
							copyButton.title = "Copy Markdown";
						}, 1500);
					} catch (err) {
						console.error("Failed to copy text: ", err);
						let errorMessage = "Failed to copy text.";
						if (err instanceof Error && err.message) {
							errorMessage += ` Details: ${err.message}`;
						}
						updateStatus(elements, errorMessage, true); // Pass elements
					}
				} else {
					console.warn("Could not find text span for copy button.");
					updateStatus(elements, "Error: Could not find text to copy.", true); // Pass elements
				}
			} else {
				console.warn(
					"Copy button clicked, but parent message element not found."
				);
			}
		} else if (deleteButton && !deleteButton.disabled) {
			const messageElementToDelete = deleteButton.closest(
				".message[data-is-history='true']"
			);
			if (messageElementToDelete) {
				// Find all history messages to determine the index
				const allHistoryMessages = Array.from(
					chatContainer.querySelectorAll(".message[data-is-history='true']")
				);
				const messageIndex = allHistoryMessages.indexOf(messageElementToDelete);

				if (messageIndex !== -1) {
					postMessageToExtension({
						type: "deleteSpecificMessage",
						messageIndex: messageIndex,
					});
					updateStatus(elements, "Requesting message deletion..."); // Pass elements
				} else {
					console.warn(
						"Could not find index of history message to delete (after data-is-history filter)."
					);
				}
			} else {
				console.warn(
					"Delete button clicked, but target is not a history-backed message."
				);
			}
		}
	});
}
