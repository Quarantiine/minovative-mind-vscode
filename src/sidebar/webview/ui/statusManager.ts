import { RequiredDomElements } from "../types/webviewTypes";
import { appState } from "../state/appState";
import { reenableAllMessageActionButtons } from "./chatMessageRenderer";
import { stopTypingAnimation } from "./typingAnimation";

export function updateApiKeyStatus(
	elements: RequiredDomElements,
	text: string
): void {
	const sanitizedText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	elements.apiKeyStatusDiv.textContent = sanitizedText;
	const lowerText = text.toLowerCase();
	if (lowerText.startsWith("error:")) {
		elements.apiKeyStatusDiv.style.color = "var(--vscode-errorForeground)";
	} else if (
		lowerText.startsWith("info:") ||
		lowerText.includes("success") ||
		lowerText.includes("key added") ||
		lowerText.includes("key deleted") ||
		lowerText.includes("using key") ||
		lowerText.includes("switched to key") ||
		lowerText.startsWith("adding") ||
		lowerText.startsWith("switching") ||
		lowerText.startsWith("waiting") ||
		lowerText.endsWith("cancelled.")
	) {
		elements.apiKeyStatusDiv.style.color =
			"var(--vscode-editorInfo-foreground)";
	} else {
		elements.apiKeyStatusDiv.style.color =
			"var(--vscode-descriptionForeground)";
	}
}

export function updateStatus(
	elements: RequiredDomElements,
	text: string,
	isError: boolean = false,
	showLoadingDots: boolean = false
): void {
	const sanitizedText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	let displayHtml = sanitizedText;

	if (showLoadingDots) {
		displayHtml += `<span class="loading-text"><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>`;
	}

	elements.statusArea.innerHTML = displayHtml;
	elements.statusArea.style.color = isError
		? "var(--vscode-errorForeground)"
		: "var(--vscode-descriptionForeground)";

	if (!isError && !showLoadingDots) {
		setTimeout(() => {
			// Only clear if the current content is still the one set by this timeout
			if (elements.statusArea.innerHTML === displayHtml) {
				elements.statusArea.textContent = "";
			}
		}, 10000); // 10 seconds for non-error messages (when no loading dots)
	} else if (isError) {
		setTimeout(() => {
			// Only clear if the current content is still the one set by this timeout
			if (elements.statusArea.innerHTML === displayHtml) {
				elements.statusArea.textContent = "";
			}
		}, 15000); // 15 seconds for error messages
	}
}

export function updateEmptyChatPlaceholderVisibility(
	elements: RequiredDomElements
): void {
	console.log("[DEBUG] updateEmptyChatPlaceholderVisibility called.");

	const actualMessages = Array.from(elements.chatContainer.children).filter(
		(child) =>
			child.classList.contains("message") &&
			!child.classList.contains("loading-message")
	);

	if (actualMessages.length > 0) {
		elements.emptyChatPlaceholder.style.display = "none";
		elements.chatContainer.style.display = "flex";
	} else {
		elements.emptyChatPlaceholder.style.display = "flex";
		elements.chatContainer.style.display = "none";
	}
	console.log(
		`[DEBUG] actualMessages.length: ${actualMessages.length}, emptyChatPlaceholder.style.display: ${elements.emptyChatPlaceholder.style.display}`
	);
}

/**
 * Resets the UI state after cancellation to ensure all controls are properly re-enabled
 * and all pending states are cleared.
 * @param elements The DOM elements to reset
 * @param setLoadingState A callback function to update the global loading state.
 */
export function resetUIStateAfterCancellation(
	elements: RequiredDomElements,
	setLoadingState: (loading: boolean, elements: RequiredDomElements) => void
): void {
	console.log("Resetting UI state after cancellation");
	elements.statusArea.textContent = "";
	if (elements.apiKeyStatusDiv) {
		elements.apiKeyStatusDiv.textContent = "";
	}

	// Re-enable all input controls
	elements.chatInput.disabled = false;
	elements.sendButton.disabled = false;
	elements.modelSelect.disabled = false;

	// Re-enable chat history buttons
	elements.loadChatButton.disabled = false;

	// Re-enable API key controls
	elements.prevKeyButton.disabled = false;
	elements.nextKeyButton.disabled = false;
	elements.deleteKeyButton.disabled = false;
	elements.addKeyInput.disabled = false;
	elements.addKeyButton.disabled = false;

	// Hide all confirmation and review UIs
	if (elements.planConfirmationContainer) {
		elements.planConfirmationContainer.style.display = "none";
	}
	if (elements.planParseErrorContainer) {
		elements.planParseErrorContainer.style.display = "none";
		if (elements.planParseErrorDisplay) {
			elements.planParseErrorDisplay.textContent = "";
		}
		if (elements.failedJsonDisplay) {
			elements.failedJsonDisplay.textContent = "";
		}
	}
	if (elements.commitReviewContainer) {
		elements.commitReviewContainer.style.display = "none";
	}

	// Clear any active streaming related state and reset flags
	stopTypingAnimation();
	// This ensures the "Model: Generating..." text doesn't linger in the chat.
	if (
		appState.currentAiMessageContentElement && // Check if there's a reference to the text content span
		appState.currentAiMessageContentElement.parentElement && // Check if the parent message element exists
		appState.currentAiMessageContentElement.parentElement.classList.contains(
			"ai-message"
		) // Ensure it's an actual AI message element
	) {
		const lingeringMessageElement =
			appState.currentAiMessageContentElement.parentElement;
		// Remove the entire AI message container from the DOM.
		lingeringMessageElement.remove();
	}
	appState.currentAiMessageContentElement = null;
	appState.currentAccumulatedText = "";
	appState.typingBuffer = "";
	appState.isCommitActionInProgress = false; // Reset commit flag
	appState.isPlanExecutionInProgress = false; // Reset plan execution flag
	appState.isAwaitingUserReview = false; // CRITICAL: Reset review state
	appState.pendingPlanData = null; // Clear any pending plan data
	appState.pendingCommitReviewData = null; // Clear any pending commit data

	// Re-enable all message action buttons
	reenableAllMessageActionButtons(elements);

	// Update empty chat placeholder visibility
	updateEmptyChatPlaceholderVisibility(elements);

	setLoadingState(false, elements);
	appState.isCancellationInProgress = false;
	console.log(
		"UI state reset complete. isCancellationInProgress reset to false."
	);
}
