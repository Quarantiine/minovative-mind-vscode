import { library, icon } from "@fortawesome/fontawesome-svg-core";
import {
	faPaperPlane,
	faFloppyDisk,
	faFolderOpen,
	faTrashCan,
	faChevronLeft,
	faChevronRight,
	faPlus,
	faCheck,
	faTimes,
	faRedo,
	faStop,
	faCopy,
	faExclamationTriangle,
	faPenToSquare, // Import faPenToSquare as per instructions
	faChartLine, // Import faChartLine for token usage icon
	faLightbulb,
	faImage,
	faProjectDiagram, // Import faProjectDiagram for heuristic context toggle button
} from "@fortawesome/free-solid-svg-icons";

// Add the imported icons to the Font Awesome library for use in the webview.
// This ensures that their SVG data is available when `icon()` is called.
library.add(
	faPaperPlane,
	faFloppyDisk,
	faFolderOpen,
	faTrashCan,
	faChevronLeft,
	faChevronRight,
	faPlus,
	faCheck,
	faTimes,
	faRedo,
	faStop,
	faCopy,
	faExclamationTriangle,
	faPenToSquare, // Add faPenToSquare to the library as per instructions
	faChartLine, // Add faChartLine to the library for token usage icon
	faLightbulb,
	faImage,
	faProjectDiagram // Add faProjectDiagram to the library for heuristic context toggle button
);

/**
 * Sets a Font Awesome icon for a given HTML button element.
 * This function retrieves the SVG markup for the specified icon and inserts it into the button.
 * Includes a try-catch block for robustness against potential Font Awesome rendering issues.
 *
 * @param button The HTMLButtonElement to set the icon for. If null, the function does nothing.
 * @param iconDefinition The Font Awesome icon definition object (e.g., `faPaperPlane`).
 * @returns void
 */
export function setIconForButton(
	button: HTMLButtonElement | null,
	iconDefinition: any
): void {
	if (button) {
		try {
			// Generate the SVG HTML for the icon, applying a common class for styling.
			const iconHTML = icon(iconDefinition, {
				classes: ["fa-icon"],
			}).html[0];

			if (iconHTML) {
				// Set the button's inner HTML to the generated SVG icon.
				button.innerHTML = iconHTML;
			} else {
				// Fallback: If Font Awesome fails to generate HTML, display a placeholder and log an error.
				button.innerHTML = "?"; // Placeholder for visibility
				console.error(
					"Failed to generate Font Awesome icon HTML for:",
					iconDefinition.iconName
				);
			}
		} catch (e) {
			// Error handling for any exceptions during icon setting (e.g., invalid iconDefinition).
			console.error(
				`Error setting Font Awesome icon '${
					iconDefinition?.iconName || "unknown"
				}'`,
				e
			);
			button.innerHTML = "!"; // Visual indicator of an error
		}
	}
}

// Export specific Font Awesome icon definitions that are directly referenced
// in other modules (e.g., when dynamically creating elements or for direct comparison).
export {
	faExclamationTriangle,
	faCopy,
	faTrashCan,
	faCheck,
	faTimes,
	faRedo,
	faStop,
	faPenToSquare, // Export faPenToSquare as per instructions
	faChartLine, // Export faChartLine for token usage icon
	faLightbulb,
	faProjectDiagram, // Export faProjectDiagram for heuristic context toggle button
};
