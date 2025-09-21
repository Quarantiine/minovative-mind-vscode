import { postMessageToExtension } from "./utils/vscodeApi";
import { initializeDomElements } from "./state/domElements";
import { appState } from "./state/appState";
import { initializeButtonEventListeners } from "./eventHandlers/buttonEventHandlers";
import { initializeInputEventListeners } from "./eventHandlers/inputEventHandlers";
import { initializeMessageBusHandler } from "./eventHandlers/messageBusHandler";
import {
	updateEmptyChatPlaceholderVisibility,
	updateStatus,
} from "./ui/statusManager";
import {
	createPlanConfirmationUI,
	createClearChatConfirmationUI,
} from "./ui/confirmationAndReviewUIs";
import {
	reenableAllMessageActionButtons,
	setGlobalSetLoadingState,
	disableAllMessageActionButtons,
} from "./ui/chatMessageRenderer";
import { RequiredDomElements } from "./types/webviewTypes";
import { setIconForButton } from "./utils/iconHelpers";
import { faChartLine } from "./utils/iconHelpers";
import { hideSuggestions } from "./ui/commandSuggestions";

/**
 * Updates token usage display with current statistics
 */
function updateTokenUsageDisplay(elements: RequiredDomElements): void {
	// Request token statistics from extension
	postMessageToExtension({ type: "getTokenStatistics" });
}

/**
 * Toggles token usage display visibility
 */
function toggleTokenUsageDisplay(elements: RequiredDomElements): void {
	appState.isTokenUsageVisible = !appState.isTokenUsageVisible;
	elements.tokenUsageContainer.style.display = appState.isTokenUsageVisible
		? "block"
		: "none";

	if (appState.isTokenUsageVisible) {
		updateTokenUsageDisplay(elements);
	}
}

/**
 * Updates the loading state of the webview UI, controlling the visibility and
 * disabled status of various elements based on the current application state.
 *
 * @param loading - A boolean indicating whether the webview is in a loading state.
 * @param elements - An object containing references to all required DOM elements.
 */
function setLoadingState(
	loading: boolean,
	elements: RequiredDomElements
): void {
	console.log(
		`[setLoadingState] Call: loading=${loading}, current isLoading=${appState.isLoading}, current isApiKeySet=${appState.isApiKeySet}, current isCommandSuggestionsVisible=${appState.isCommandSuggestionsVisible}`
	);
	appState.isLoading = loading;
	const loadingMsg = elements.chatContainer.querySelector(".loading-message");
	if (loadingMsg) {
		loadingMsg.remove();
	}

	// Determine visibility of complex UI containers
	const planConfirmationVisible =
		elements.planConfirmationContainer?.style.display !== "none" || false;
	const planParseErrorVisible =
		elements.planParseErrorContainer.style.display !== "none";
	const commitReviewVisible =
		elements.commitReviewContainer.style.display !== "none";
	// Introduce new variable for clear chat confirmation visibility
	const chatClearConfirmationVisible =
		elements.chatClearConfirmationContainer?.style.display !== "none" || false;

	// Introduce new constants for granular control
	const canInteractWithMainChatControls =
		!loading &&
		appState.isApiKeySet &&
		!appState.isAwaitingUserReview && // Refactored
		!appState.isCancellationInProgress &&
		!appState.isPlanExecutionInProgress;

	const canSendCurrentInput =
		canInteractWithMainChatControls && !appState.isCommandSuggestionsVisible;

	// Determine enablement for chat history management buttons
	const canInteractWithChatHistoryButtons =
		!loading &&
		!appState.isAwaitingUserReview && // Refactored
		!appState.isCommandSuggestionsVisible &&
		!appState.isCancellationInProgress &&
		!appState.isPlanExecutionInProgress;

	// Define enablement for image upload controls
	const canInteractWithImageControls =
		!loading &&
		!appState.isAwaitingUserReview &&
		!appState.isCancellationInProgress &&
		!appState.isPlanExecutionInProgress;

	console.log(
		`[setLoadingState] Final computed canInteractWithMainChatControls=${canInteractWithMainChatControls}, canSendCurrentInput=${canSendCurrentInput}, canInteractWithChatHistoryButtons=${canInteractWithChatHistoryButtons}`
	);

	// Apply disabled states to main chat interface elements
	elements.chatInput.disabled = !canInteractWithMainChatControls;
	elements.modelSelect.disabled = !canInteractWithMainChatControls;
	elements.sendButton.disabled = !canSendCurrentInput;
	elements.openFileListButton.disabled = !canInteractWithMainChatControls; // Instruction 1: Enable/disable openFileListButton

	// Apply disabled states to API key management controls
	const enableApiKeyControls =
		!appState.isLoading &&
		!appState.isAwaitingUserReview && // Refactored
		!appState.isCommandSuggestionsVisible &&
		appState.totalKeys > 0 &&
		!appState.isCancellationInProgress &&
		!appState.isPlanExecutionInProgress;
	elements.prevKeyButton.disabled =
		!enableApiKeyControls || appState.totalKeys <= 1;
	elements.nextKeyButton.disabled =
		!enableApiKeyControls || appState.totalKeys <= 1;
	elements.deleteKeyButton.disabled =
		!enableApiKeyControls || !appState.isApiKeySet;

	const enableAddKeyInputControls =
		!loading &&
		!appState.isAwaitingUserReview && // Refactored
		!appState.isCommandSuggestionsVisible &&
		!appState.isCancellationInProgress &&
		!appState.isPlanExecutionInProgress;
	elements.addKeyInput.disabled = !enableAddKeyInputControls;
	elements.addKeyButton.disabled = !enableAddKeyInputControls;

	// Determine if there are actual messages in the chat (excluding loading messages)
	const hasMessages =
		elements.chatContainer.childElementCount > 0 &&
		!elements.chatContainer.querySelector(".loading-message");

	// Apply disabled states to chat history buttons
	elements.loadChatButton.disabled = !canInteractWithChatHistoryButtons;
	elements.saveChatButton.disabled =
		!canInteractWithChatHistoryButtons || !hasMessages;
	elements.clearChatButton.disabled =
		!canInteractWithChatHistoryButtons || !hasMessages;

	// Apply disabled state for confirm commit button
	elements.confirmCommitButton.disabled =
		loading ||
		!commitReviewVisible ||
		elements.commitMessageTextarea.value.trim() === "";

	// Apply disabled states for image upload controls
	const attachImageButton = elements.attachImageButton; // Alias for clarity as per instruction 1
	elements.imageUploadInput.disabled = !canInteractWithImageControls;
	// elements.imageUploadInput.style.display line removed as per instruction. (It should remain 'none' as per index.html)
	attachImageButton.disabled = !canInteractWithImageControls;
	// Re-add uploadImageButton.style.display with 'inline-flex' as per instruction for attachImageButton.
	attachImageButton.style.display = canInteractWithImageControls
		? "inline-flex"
		: "none";
	// Updated logic for clearImagesButton.disabled
	elements.clearImagesButton.disabled =
		!canInteractWithImageControls || appState.selectedImages.length === 0;
	// The clearImagesButton.style.display line was not part of the removal instruction,
	// nor was it part of the 'set its style.display' instruction (which targeted uploadImageButton).
	// Therefore, keep its existing display logic.
	elements.clearImagesButton.style.display =
		appState.selectedImages.length > 0 && canInteractWithImageControls
			? "inline-flex"
			: "none";
	// New additions for clearImagesButton pointerEvents and opacity as per instruction
	elements.clearImagesButton.style.pointerEvents = canInteractWithImageControls
		? ""
		: "none";
	elements.clearImagesButton.style.opacity = canInteractWithImageControls
		? "1"
		: "0.5";

	// For image previews container, disable pointer events and reduce opacity for a disabled look
	elements.imagePreviewsContainer.style.pointerEvents =
		canInteractWithImageControls ? "" : "none";
	elements.imagePreviewsContainer.style.opacity = canInteractWithImageControls
		? "1"
		: "0.5";
	// Updated logic for imagePreviewsContainer.style.display
	elements.imagePreviewsContainer.style.display =
		appState.selectedImages.length > 0 && canInteractWithImageControls
			? "flex"
			: "none";

	console.log(
		`[setLoadingState] Status: loading=${loading}, planConfVis=${planConfirmationVisible}, planParseErrVis=${planParseErrorVisible}, commitRevVis=${commitReviewVisible}`
	);
	console.log(
		`[setLoadingState] Chat: childCount=${elements.chatContainer.childElementCount}, hasMessages=${hasMessages}`
	);
	console.log(
		`[setLoadingState] Buttons: saveDisabled=${elements.saveChatButton.disabled}, clearDisabled=${elements.clearChatButton.disabled}`
	);

	// Disable message action buttons if loading
	if (loading) {
		disableAllMessageActionButtons(elements);
	}

	// Control visibility of the cancel generation button
	if (
		(loading || appState.isPlanExecutionInProgress) &&
		!appState.isCancellationInProgress &&
		!appState.isAwaitingUserReview
	) {
		elements.cancelGenerationButton.style.display = "inline-flex";
	} else {
		elements.cancelGenerationButton.style.display = "none";
	}

	// Control visibility of the revert changes button
	if (!loading && appState.hasRevertibleChanges) {
		elements.revertChangesButton.style.display = "inline-flex";
	} else {
		elements.revertChangesButton.style.display = "none";
	}

	// Hide confirmation/error/review UIs if a new loading operation starts
	if (loading && planConfirmationVisible && !appState.isAwaitingUserReview) {
		if (elements.planConfirmationContainer) {
			elements.planConfirmationContainer.style.display = "none";
		}
		appState.pendingPlanData = null; // Clear pending plan data if a new request starts
		updateStatus(
			elements,
			"New request initiated, pending plan confirmation cancelled.",
			false
		);
	}

	if (loading && planParseErrorVisible && !appState.isAwaitingUserReview) {
		elements.planParseErrorContainer.style.display = "none";
		if (elements.planParseErrorDisplay) {
			elements.planParseErrorDisplay.textContent = "";
		}
		if (elements.failedJsonDisplay) {
			elements.failedJsonDisplay.textContent = "";
		}
		updateStatus(
			elements,
			"New request initiated, parse error UI hidden.",
			false
		);
	}
	if (loading && commitReviewVisible && !appState.isAwaitingUserReview) {
		elements.commitReviewContainer.style.display = "none";
		updateStatus(
			elements,
			"New request initiated, commit review UI hidden.",
			false
		);
	}
	// Add conditional block to hide clear chat confirmation UI
	if (
		loading &&
		chatClearConfirmationVisible &&
		!appState.isAwaitingUserReview
	) {
		if (elements.chatClearConfirmationContainer) {
			elements.chatClearConfirmationContainer.style.display = "none";
		}
		updateStatus(
			elements,
			"New request initiated, clear chat confirmation UI hidden.",
			false
		);
	}

	// Update empty chat placeholder visibility only when not loading
	if (!loading) {
		updateEmptyChatPlaceholderVisibility(elements);
		// Re-enable all message action buttons when loading becomes false
		reenableAllMessageActionButtons(elements);
	}
}

/**
 * Initializes the webview by acquiring DOM elements, setting initial UI states,
 * and attaching all necessary event listeners.
 */
function initializeWebview(): void {
	const elements = initializeDomElements();
	if (!elements) {
		console.error(
			"Critical DOM elements not found. Exiting webview initialization."
		);
		// Error message to the user is handled within initializeDomElements.
		return;
	}

	// Post webviewReady message to the extension
	postMessageToExtension({ type: "webviewReady" });
	console.log("Webview sent ready message.");

	// Set initial focus to the chat input
	elements.chatInput.focus();

	// Set initial disabled states and display styles for various UI elements
	elements.chatInput.disabled = true;
	elements.sendButton.disabled = true;
	elements.modelSelect.disabled = true;

	elements.clearChatButton.disabled = true;
	elements.saveChatButton.disabled = true;
	elements.loadChatButton.disabled = false;
	elements.openFileListButton.disabled = true;

	elements.prevKeyButton.disabled = true;
	elements.nextKeyButton.disabled = true;
	elements.deleteKeyButton.disabled = true;

	elements.cancelGenerationButton.style.display = "none";
	elements.planParseErrorContainer.style.display = "none";
	elements.commitReviewContainer.style.display = "none";
	elements.confirmCommitButton.disabled = true;
	elements.commandSuggestionsContainer.style.display = "none";
	elements.revertChangesButton.style.display = "none"; // Set initial display for revertChangesButton

	// Initialize all event listeners for buttons, inputs, and the message bus
	initializeInputEventListeners(elements, setLoadingState);
	// Instruction 3: ensure initializeButtonEventListeners is called after initializeDomElements.
	// This is already the case as initializeDomElements returns `elements`, which is then passed
	// to initializeButtonEventListeners. The order here is correct.
	initializeButtonEventListeners(elements, setLoadingState);
	initializeMessageBusHandler(elements, setLoadingState);

	// Add token usage toggle event listener
	elements.tokenUsageToggle.addEventListener("click", () => {
		toggleTokenUsageDisplay(elements);
	});

	// Set icon for token usage button
	setIconForButton(elements.tokenUsageToggle, faChartLine);

	// Perform initial UI setup for dynamically created components or visibility
	createPlanConfirmationUI(
		elements,
		postMessageToExtension,
		updateStatus,
		setLoadingState
	);
	// Add call to createClearChatConfirmationUI
	createClearChatConfirmationUI(elements, postMessageToExtension);
	updateEmptyChatPlaceholderVisibility(elements);

	// Apply the initial loading state (which is typically false on startup)
	// This will correctly enable/disable buttons based on initial appState values
	// (e.g., isApiKeySet is likely false initially).
	setLoadingState(false, elements);

	// Set up global reference to setLoadingState for use in chatMessageRenderer
	setGlobalSetLoadingState(setLoadingState);

	// Add global keydown event listener for Escape key
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (appState.isCommandSuggestionsVisible) {
				event.preventDefault(); // Prevent default browser behavior (e.g., closing context menus)
				hideSuggestions(elements, setLoadingState);
			}
		}
	});
}

// Ensure the webview is initialized once the DOM is fully loaded.
document.addEventListener("DOMContentLoaded", initializeWebview);
