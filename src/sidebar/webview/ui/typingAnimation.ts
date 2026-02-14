import { md, sanitizeAiResponse } from "../utils/markdownRenderer";
import { appState } from "../state/appState";
import { RequiredDomElements } from "../types/webviewTypes";
import { scrollToBottomIfAtBottom } from "../utils/scrollUtils";

/**
 * Stops the typing animation by clearing the interval timer.
 */
export function stopTypingAnimation(): void {
	if (appState.typingTimer !== null) {
		clearInterval(appState.typingTimer);
		appState.typingTimer = null;
		console.log("[Webview][TypingAnimation] Typing animation stopped.");
	}
}

/**
 * Types the next set of characters from the typing buffer into the AI message content element.
 * Manages scrolling and stops the animation when the buffer is empty and no more content is loading.
 * @param elements - An object containing references to all required DOM elements.
 */
export function typeNextCharacters(elements: RequiredDomElements): void {
	if (!appState.currentAiMessageContentElement) {
		stopTypingAnimation();
		console.warn(
			"[Webview][TypingAnimation] No currentAiMessageContentElement found, stopping typing animation.",
		);
		return;
	}

	// Stop if buffer is empty AND not actively loading (e.g., no new chunk is expected soon)
	// This condition ensures the animation keeps showing loading dots if more content is coming,
	// but stops definitively when the stream ends.
	if (appState.typingBuffer.length === 0 && !appState.isLoading) {
		stopTypingAnimation();
		return;
	}

	const charsToType = Math.min(
		appState.CHARS_PER_INTERVAL,
		appState.typingBuffer.length,
	);
	if (charsToType > 0) {
		appState.currentAccumulatedText += appState.typingBuffer.substring(
			0,
			charsToType,
		);
		appState.typingBuffer = appState.typingBuffer.substring(charsToType);

		// Sanitize the text before rendering to ensure no tool calls leak during the typing animation
		const sanitizedText = sanitizeAiResponse(appState.currentAccumulatedText);

		// Render the accumulated text as Markdown
		appState.currentAiMessageContentElement.innerHTML =
			md.render(sanitizedText);
		// Store the original markdown text for copy functionality
		appState.currentAiMessageContentElement.dataset.originalMarkdown =
			appState.currentAccumulatedText;

		// Scroll to the bottom of the chat container
		// elements.chatContainer is guaranteed to be an HTMLDivElement by RequiredDomElements
		scrollToBottomIfAtBottom(elements.chatContainer);
	}
}

/**
 * Starts the typing animation if it's not already running.
 * The animation continuously calls `typeNextCharacters` at a defined interval.
 * @param elements - An object containing references to all required DOM elements.
 */
export function startTypingAnimation(elements: RequiredDomElements): void {
	// Only start a new timer if one isn't already active
	if (appState.typingTimer === null) {
		// Ensure TYPING_SPEED_MS is a positive number to prevent issues with setInterval(..., 0)
		// If it's 0 or negative, default to a reasonable interval like 5ms.
		const intervalMs =
			appState.TYPING_SPEED_MS > 0 ? appState.TYPING_SPEED_MS : 5;

		// Use an arrow function to capture elements in the closure for the interval callback
		appState.typingTimer = setInterval(
			() => typeNextCharacters(elements),
			intervalMs,
		);
		console.log(
			`[Webview][TypingAnimation] Typing animation started with interval ${intervalMs}ms.`,
		);
	}
}
