// src/sidebar/webview/eventHandlers/codeStreamHandler.ts

// Imports needed for the extracted logic
import { RequiredDomElements } from "../types/webviewTypes";
import {
	CodeFileStreamStartMessage,
	CodeFileStreamChunkMessage,
	CodeFileStreamEndMessage,
} from "../../common/sidebarTypes";
import hljs from "highlight.js";

// --- Extracted State ---
export let activeCodeStreams = new Map<
	string,
	{ container: HTMLDivElement; codeElement: HTMLElement }
>();

export let codeStreamingArea: HTMLElement | null = null;

// --- Extracted Core Logic ---
export const resetCodeStreams = (): void => {
	activeCodeStreams.clear();

	if (codeStreamingArea) {
		codeStreamingArea.innerHTML = "";
		codeStreamingArea.style.display = "none";
	}
};

// --- Handler Functions ---

export function handleCodeFileStreamStart(
	elements: RequiredDomElements,
	message: CodeFileStreamStartMessage,
): void {
	const { streamId, filePath, languageId, status } = message.value;
	console.log(
		`[CodeStreamHandler] Code stream start/update: ${filePath} (Stream ID: ${streamId}, Status: ${status})`,
	);

	if (!codeStreamingArea) {
		codeStreamingArea = document.getElementById("code-streaming-area");
		if (!codeStreamingArea) {
			console.error("[CodeStreamHandler] Code streaming area not found.");
			return;
		}
	}

	let streamInfo = activeCodeStreams.get(streamId);

	if (streamInfo) {
		// Update existing stream's status
		const statusIndicator = streamInfo.container.querySelector(
			".loading-dots",
		) as HTMLElement | null;
		if (statusIndicator) {
			const displayStatus = status || "Generating";
			statusIndicator.innerHTML = `${displayStatus}<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>`;
		}
		return;
	}

	// Create container for this file's stream
	const container = document.createElement("div");
	container.classList.add("code-file-stream-container");
	container.dataset.streamId = streamId;

	// Pre and Code elements for content
	const pre = document.createElement("pre");
	const codeElement = document.createElement("code");
	codeElement.classList.add(`language-${languageId}`);
	codeElement.classList.add("hljs"); // For highlight.js
	pre.appendChild(codeElement);
	container.appendChild(pre);

	// Footer for file path and loading dots
	const footer = document.createElement("div");
	footer.classList.add("code-file-stream-footer");
	const displayStatus = status || "Generating";
	footer.innerHTML = `
        <span class="file-path">${filePath}</span>
        <span class="status-indicator">
            <span class="loading-dots">${displayStatus}<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>
        </span>
    `;
	container.appendChild(footer);

	codeStreamingArea.appendChild(container);
	activeCodeStreams.set(streamId, { container, codeElement });

	codeStreamingArea.style.display = "flex"; // Show the overall streaming area
	codeStreamingArea.scrollTop = codeStreamingArea.scrollHeight; // Scroll to bottom
}

export function handleCodeFileStreamChunk(
	elements: RequiredDomElements, // Kept for consistency, though not directly used here
	message: CodeFileStreamChunkMessage,
): void {
	const { streamId, chunk } = message.value;
	// console.log(`[CodeStreamHandler] Code stream chunk for ${streamId}: ${chunk.length} chars`);

	const streamInfo = activeCodeStreams.get(streamId);
	if (streamInfo) {
		streamInfo.codeElement.textContent += chunk;
		if (codeStreamingArea) {
			codeStreamingArea.scrollTop = codeStreamingArea.scrollHeight; // Scroll to bottom
		}
	} else {
		console.warn(
			`[CodeStreamHandler] Received chunk for unknown stream ID: ${streamId}`,
		);
	}
}

export function handleCodeFileStreamEnd(
	elements: RequiredDomElements, // Kept for consistency
	message: CodeFileStreamEndMessage,
): void {
	const { streamId, success, error } = message.value;
	console.log(
		`[CodeStreamHandler] Code stream end for ${streamId}. Success: ${success}, Error: ${error}`,
	);

	const streamInfo = activeCodeStreams.get(streamId);
	if (streamInfo) {
		const footer = streamInfo.container.querySelector(
			".code-file-stream-footer",
		);
		const statusIndicator = footer?.querySelector(
			".status-indicator",
		) as HTMLElement | null;
		const loadingDots = footer?.querySelector(
			".loading-dots",
		) as HTMLElement | null;

		// Remove loading dots
		if (loadingDots) {
			loadingDots.remove();
		}

		// Add success/error icon
		if (statusIndicator) {
			const icon = document.createElement("span");
			icon.classList.add("status-icon");
			if (success) {
				icon.textContent = "✔"; // Green check
				icon.style.color = "var(--vscode-editorGutter-addedBackground)";
				icon.title = "Generation complete";
			} else {
				icon.textContent = "❌"; // Red cross
				icon.style.color = "var(--vscode-errorForeground)";
				icon.title = `Generation failed: ${error || "Unknown error"}`;
				if (error) {
					const errorDetails = document.createElement("span");
					errorDetails.classList.add("error-details");
					errorDetails.textContent = ` ${error}`;
					statusIndicator.appendChild(errorDetails);
				}
			}
			statusIndicator.prepend(icon);
		}

		// Ensure final highlighting is applied
		if (typeof hljs !== "undefined" && hljs) {
			// Safely check for hljs availability
			hljs.highlightElement(streamInfo.codeElement);
		}

		activeCodeStreams.delete(streamId);

		if (codeStreamingArea) {
			codeStreamingArea.scrollTop = codeStreamingArea.scrollHeight; // Scroll to bottom
		}
	} else {
		console.warn(
			`[CodeStreamHandler] Received end message for unknown stream ID: ${streamId}`,
		);
	}
}
