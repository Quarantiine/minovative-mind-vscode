import * as vscode from "vscode";

/**
 * Options used to customize how the project context is built.
 */
export interface ContextBuildOptions {
	/**
	 * Disables the AI's internal file selection cache.
	 * Default is true, except during regeneration.
	 */
	useAISelectionCache?: boolean;

	/**
	 * Forces recalculation of AI file selection, ignoring cache entirely.
	 * Default is false.
	 */
	forceAISelectionRecalculation?: boolean;

	/**
	 * Explicit list of files from recent chat history that must be prioritized
	 * for content inclusion in the generated project context.
	 */
	historicallyRelevantFiles?: vscode.Uri[];
}
