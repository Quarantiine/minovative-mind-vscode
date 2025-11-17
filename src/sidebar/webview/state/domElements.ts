// Path: src/sidebar/webview/state/domElements.ts
import { RequiredDomElements } from "../types/webviewTypes";

/**
 * Initializes and retrieves references to all required DOM elements from the HTML document.
 * This function consolidates all `document.getElementById` calls and performs critical
 * startup validation.
 *
 * If any essential DOM element is not found, it indicates a critical error in the webview
 * HTML structure. In such cases, it logs an error to the console and updates the entire
 * document body to display a user-friendly error message, preventing further script
 * execution and potential runtime errors.
 *
 * @returns An object containing references to all required DOM elements if successful,
 *          or `null` if any required element is missing.
 */
export function initializeDomElements(): RequiredDomElements | null {
	const chatContainer = document.getElementById(
		"chat-container"
	) as HTMLDivElement;
	const chatInput = document.getElementById(
		"chat-input"
	) as HTMLTextAreaElement;
	const sendButton = document.getElementById(
		"send-button"
	) as HTMLButtonElement;
	const statusArea = document.getElementById("status-area") as HTMLDivElement;
	const modelSelect = document.getElementById(
		"model-select"
	) as HTMLSelectElement;
	const currentKeyDisplay = document.getElementById(
		"current-key-display"
	) as HTMLSpanElement;
	const prevKeyButton = document.getElementById(
		"prev-key-button"
	) as HTMLButtonElement;
	const nextKeyButton = document.getElementById(
		"next-key-button"
	) as HTMLButtonElement;
	const deleteKeyButton = document.getElementById(
		"delete-key-button"
	) as HTMLButtonElement;
	const addKeyInput = document.getElementById(
		"add-key-input"
	) as HTMLInputElement;
	const addKeyButton = document.getElementById(
		"add-key-button"
	) as HTMLButtonElement;
	const apiKeyStatusDiv = document.getElementById(
		"api-key-status"
	) as HTMLDivElement;
	const clearChatButton = document.getElementById(
		"clear-chat-button"
	) as HTMLButtonElement;
	const saveChatButton = document.getElementById(
		"save-chat-button"
	) as HTMLButtonElement;
	const loadChatButton = document.getElementById(
		"load-chat-button"
	) as HTMLButtonElement;
	const cancelGenerationButton = document.getElementById(
		"cancel-generation-button"
	) as HTMLButtonElement;
	const planParseErrorContainer = document.getElementById(
		"plan-parse-error-container"
	) as HTMLDivElement;
	const planParseErrorDisplay = document.getElementById(
		"plan-parse-error-display"
	) as HTMLParagraphElement;
	const failedJsonDisplay = document.getElementById(
		"failed-json-display"
	) as HTMLElement; // Can be any HTML element
	const retryGenerationButton = document.getElementById(
		"retry-generation-button"
	) as HTMLButtonElement;
	const cancelParseErrorButton = document.getElementById(
		"cancel-parse-error-button"
	) as HTMLButtonElement;
	const commitReviewContainer = document.getElementById(
		"commit-review-container"
	) as HTMLDivElement;
	const commitMessageTextarea = document.getElementById(
		"commit-message-textarea"
	) as HTMLTextAreaElement;
	const stagedFilesList = document.getElementById(
		"staged-files-list"
	) as HTMLUListElement;
	const confirmCommitButton = document.getElementById(
		"confirm-commit-button"
	) as HTMLButtonElement;
	const cancelCommitButton = document.getElementById(
		"cancel-commit-button"
	) as HTMLButtonElement;
	const emptyChatPlaceholder = document.getElementById(
		"empty-chat-placeholder"
	) as HTMLDivElement;
	const revertChangesButton = document.getElementById(
		"revert-changes-button"
	) as HTMLButtonElement;

	const chatInputControlsWrapper = document.getElementById(
		"chat-input-controls-wrapper"
	) as HTMLDivElement;
	const commandSuggestionsContainer = document.getElementById(
		"command-suggestions-container"
	) as HTMLDivElement;
	const openFileListButton = document.getElementById(
		"openFileListButton"
	) as HTMLButtonElement;
	const heuristicContextToggle = document.getElementById(
		"heuristic-context-toggle"
	) as HTMLButtonElement;
	// const groundingToggle = document.getElementById(
	// 	"grounding-toggle"
	// ) as HTMLInputElement;

	// Token usage elements
	const tokenUsageContainer = document.getElementById(
		"token-usage-container"
	) as HTMLDivElement;
	const tokenUsageDisplay = document.getElementById(
		"token-usage-display"
	) as HTMLDivElement;
	const tokenUsageToggle = document.getElementById(
		"token-usage-toggle"
	) as HTMLButtonElement;

	const modelUsagePercentagesList = document.createElement("div");
	modelUsagePercentagesList.id = "model-percentages-list";
	modelUsagePercentagesList.classList.add("token-stats-section");
	tokenUsageContainer.appendChild(modelUsagePercentagesList);

	// Create new copy stats button
	const copyStatsButton = document.createElement("button");
	copyStatsButton.id = "copy-stats-button";
	copyStatsButton.title = "Copy All Statistics";
	copyStatsButton.classList.add("action-button"); // Add a class for styling consistency
	tokenUsageContainer.appendChild(copyStatsButton);

	// Image upload elements
	const imageUploadInput = document.getElementById(
		"image-upload-input"
	) as HTMLInputElement;
	const attachImageButton = document.getElementById(
		"attach-image-button"
	) as HTMLButtonElement;
	const imagePreviewsContainer = document.getElementById(
		"image-previews-container"
	) as HTMLDivElement;
	const clearImagesButton = document.getElementById(
		"clear-images-button"
	) as HTMLButtonElement;

	// The current implementation of main.ts does not retrieve planConfirmationContainer,
	// confirmPlanButton, or cancelPlanButton via getElementById at startup.
	// Instead, they are dynamically created within createPlanConfirmationUI()
	// if they are null. Therefore, they are not part of the initial fatal validation here.

	const editingIndicator = document.getElementById(
		"editing-indicator"
	) as HTMLElement | null;

	const editMessageHelpText = document.getElementById(
		"edit-message-help-text"
	) as HTMLElement | null;

	const requiredElements = {
		chatContainer,
		chatInput,
		sendButton,
		statusArea,
		modelSelect,
		currentKeyDisplay,
		prevKeyButton,
		nextKeyButton,
		deleteKeyButton,
		addKeyInput,
		addKeyButton,
		apiKeyStatusDiv,
		clearChatButton,
		saveChatButton,
		loadChatButton,
		cancelGenerationButton,
		planParseErrorContainer,
		planParseErrorDisplay,
		failedJsonDisplay,
		retryGenerationButton,
		cancelParseErrorButton,
		commitReviewContainer,
		commitMessageTextarea,
		stagedFilesList,
		confirmCommitButton,
		cancelCommitButton,
		emptyChatPlaceholder,
		revertChangesButton,

		chatInputControlsWrapper,
		commandSuggestionsContainer,
		openFileListButton,
		heuristicContextToggle,

		// Token usage elements
		tokenUsageContainer,
		tokenUsageDisplay,
		tokenUsageToggle,
		modelUsagePercentagesList,
		copyStatsButton, // Add the new copy stats button here

		// Image upload elements
		imageUploadInput,
		attachImageButton,
		imagePreviewsContainer,
		clearImagesButton,

		// Add the new elements here:
		editingIndicator,
		editMessageHelpText,
	};

	const missingElements: string[] = [];
	for (const [key, value] of Object.entries(requiredElements)) {
		if (value === null) {
			missingElements.push(key);
		}
	}

	if (missingElements.length > 0) {
		const errorMessage = `Critical Error: Required DOM elements not found. Webview UI cannot be initialized. Missing: ${missingElements.join(
			", "
		)}. Please check the extension's 'index.html' file and the webview JavaScript.`;
		console.error(errorMessage);

		const body = document.querySelector("body");
		if (body) {
			body.innerHTML = `
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    text-align: center;
                    color: var(--vscode-errorForeground);
                    background-color: var(--vscode-sideBar-background);
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    box-sizing: border-box;
                ">
                    <h1 style="color: var(--vscode-errorForeground); margin-bottom: 10px;">UI Initialization Error</h1>
                    <p style="font-weight: bold; margin-bottom: 20px;">
                        The Minovative Mind webview UI could not load completely.
                    </p>
                    <p>
                        This usually indicates an issue with the extension's installation or a corrupted file.
                    </p>
                    <ul style="text-align: left; margin-top: 15px; margin-bottom: 25px; padding-left: 25px;">
                        <li>Reload the VS Code window (Command Palette: Developer: Reload Window).</li>
                        <li>Disable and re-enable the Minovative Mind extension.</li>
                        <li>Uninstall and reinstall the Minovative Mind extension.</li>
                    </ul>
                    <p style="font-size: 0.8em; color: var(--vscode-descriptionForeground);">
                        For developers: Check the console (Developer: Open Webview Developer Tools) for more details.
                    </p>
                    <pre style="
                        background-color: var(--vscode-textCodeBlock-background);
                        color: var(--vscode-errorForeground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                        padding: 10px;
                        border-radius: 4px;
                        max-width: 80%;
                        overflow-x: auto;
                        text-align: left;
                        font-size: 0.85em;
                        margin-top: 20px;
                    ">${errorMessage}</pre>
                </div>
            `;
		}
		return null;
	}

	// If all elements are found, cast and return the object
	return requiredElements as RequiredDomElements;
}
