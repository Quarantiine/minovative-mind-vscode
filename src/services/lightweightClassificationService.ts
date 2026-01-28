import * as vscode from "vscode";
import { AIRequestService } from "./aiRequestService";
import { DEFAULT_FLASH_LITE_MODEL } from "../sidebar/common/sidebarConstants";

export class LightweightClassificationService {
	constructor(private aiRequestService: AIRequestService) {}

	/**
	 * Checks if the given text is likely an error message using a lightweight AI model.
	 */
	public async checkIsError(
		text: string,
		token?: vscode.CancellationToken,
	): Promise<boolean> {
		if (!text || text.trim().length === 0) {
			return true;
		}

		// Fast heuristic for obvious cases to save an API call
		const lowerText = text.toLowerCase();
		if (
			lowerText.startsWith("error:") ||
			lowerText.includes("i cannot fulfill this request")
		) {
			return true;
		}

		const prompt = `
Analyze the following text and determine if it is an error message, a refusal to generate code, or a failure notification.
Respond with ONLY "YES" if it is an error/refusal, or "NO" if it is valid content (even if it's just a comment or code snippet).

Text:
"""
${text.substring(0, 1000)}
"""

Response (YES/NO):`;

		try {
			const result = await this.aiRequestService.generateWithRetry(
				[{ text: prompt }],
				DEFAULT_FLASH_LITE_MODEL,
				undefined,
				"lightweight error check",
				undefined,
				undefined,
				token,
			);

			return result.trim().toUpperCase().startsWith("YES");
		} catch (error) {
			console.error("Error in lightweight checkIsError:", error);
			// Fallback to safe assumption (not an error) to avoid blocking valid content on AI failure,
			// or could fallback to regex if we want to be conservative.
			// For now, let's return false so we don't block potentially valid code.
			return false;
		}
	}

	/**
	 * Checks if the user's prompt implies a request to rewrite the file entirely.
	 */
	public async checkRewriteIntent(
		promptText: string,
		token?: vscode.CancellationToken,
	): Promise<boolean> {
		if (!promptText || promptText.trim().length === 0) {
			return false;
		}

		const prompt = `
Analyze the following user prompt and determine if the user intends to completely rewrite, replace, or overhaul an existing file/codebase, as opposed to just editing or modifying a part of it.
Respond with ONLY "YES" if it is a rewrite/replace intent, or "NO" if it is an edit/modification intent.

User Prompt:
"""
${promptText.substring(0, 1000)}
"""

Response (YES/NO):`;

		try {
			const result = await this.aiRequestService.generateWithRetry(
				[{ text: prompt }],
				DEFAULT_FLASH_LITE_MODEL,
				undefined,
				"lightweight rewrite intent check",
				undefined,
				undefined,
				token,
			);

			return result.trim().toUpperCase().startsWith("YES");
		} catch (error) {
			console.error("Error in lightweight checkRewriteIntent:", error);
			return false;
		}
	}

	/**
	 * Generates a concise natural language summary of the given file content using a lightweight AI model.
	 */
	public async summarizeFile(
		filePath: string,
		content: string,
		token?: vscode.CancellationToken,
	): Promise<string> {
		if (!content || content.trim().length === 0) {
			return "Empty file.";
		}

		const prompt = `
Provide a concise, high-level summary of the following file's purpose and main functionality.
Focus on WHAT the code does and HOW it fits into a larger system.

File: ${filePath}
Content:
"""
${content.substring(0, 5000)}
"""

Summary:`;

		try {
			const result = await this.aiRequestService.generateWithRetry(
				[{ text: prompt }],
				DEFAULT_FLASH_LITE_MODEL,
				undefined,
				"lightweight file summary",
				undefined,
				undefined,
				token,
			);

			return result.trim();
		} catch (error) {
			console.error("Error in lightweight summarizeFile:", error);
			return "Summary generation failed.";
		}
	}
}
