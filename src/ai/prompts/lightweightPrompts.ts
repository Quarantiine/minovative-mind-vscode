import { AIRequestService } from "../../services/aiRequestService";
import { DEFAULT_FLASH_LITE_MODEL } from "../../sidebar/common/sidebarConstants";
import { ERROR_OPERATION_CANCELLED } from "../gemini";
import * as vscode from "vscode";
import { HistoryEntry } from "../../sidebar/common/sidebarTypes";

// Helper to format history entries into a readable string for the prompt
function formatHistoryForPrompt(history: readonly HistoryEntry[]): string {
	return history
		.map((entry) => {
			const role =
				entry.role === "user"
					? "User"
					: entry.role === "model"
						? "Assistant"
						: entry.role;
			const content = entry.parts
				.map((p) => ("text" in p ? p.text : "[Image]"))
				.join(" ");
			const filesInfo = entry.relevantFiles?.length
				? ` (Relevant Files: ${entry.relevantFiles.join(", ")})`
				: "";
			return `${role}: ${content}${filesInfo}`;
		})
		.join("\n");
}

/**
 * Generates a summary of the chat history, strictly filtered based on the current user request, using the Flash Lite model.
 * @param history The full conversation history.
 * @param currentUserRequest The text of the user's latest request, used for focusing the summary.
 * @param aiRequestService Service for making AI calls.
 * @param token Cancellation token.
 * @returns A concise, focused summary string.
 */
export async function generateContextualHistorySummary(
	history: readonly HistoryEntry[],
	currentUserRequest: string,
	aiRequestService: AIRequestService,
	token?: vscode.CancellationToken,
): Promise<string> {
	const historyContent = formatHistoryForPrompt(history);

	const systemInstruction = `
You are an expert summarization agent using the Gemini Flash Lite model. Your goal is to condense the provided chat history into a concise summary.

CRITICAL INSTRUCTION: Filter the history strictly based on the CURRENT USER REQUEST provided.
1. If the CURRENT USER REQUEST explicitly targets a specific topic, ONLY include relevant historical facts, context, or previous outputs in the summary.
2. If the CURRENT USER REQUEST is general, summarize the *entire* provided history cohesively.
3. The resulting summary must be brief, factual (no opinions), and structured clearly. Do not include introductory phrases.
`;

	const userPrompt = `
Chat History to analyze:
--- HISTORY START ---
${historyContent}
--- HISTORY END ---

CURRENT USER REQUEST:
${currentUserRequest}

BEGIN SUMMARY (highly focused and brief):
`;

	try {
		const result = await aiRequestService.generateWithRetry(
			[{ text: userPrompt }],
			DEFAULT_FLASH_LITE_MODEL,
			undefined,
			"contextual history summarization",
			undefined,
			undefined,
			token,
			false,
			systemInstruction,
		);

		if (token?.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		if (!result || result.toLowerCase().startsWith("error:")) {
			throw new Error(
				result ||
					"Empty or erroneous response from lightweight AI for history summarization.",
			);
		}
		return result.trim();
	} catch (error: any) {
		console.error("Error generating contextual history summary:", error);
		if (error.message === ERROR_OPERATION_CANCELLED) {
			throw error;
		}
		throw new Error(
			`Failed to generate contextual history summary: ${error.message}`,
		);
	}
}

export async function generateLightweightPlanPrompt(
	aiMessageContent: string,
	userRequestContent: string,
	modelName: string,
	aiRequestService: AIRequestService,
	token?: vscode.CancellationToken,
): Promise<string> {
	const systemInstruction = `
You are an expert technical planner.

TASK:
Create a high-level, structured plan based on the AI's response, BUT strictly aligned with the User's Request.

CRITICAL INTENT CHECK:
- If the User's Request was about UPDATING DOCUMENTATION, the plan MUST focus on documentation.
- If it's about REFACTORING or CODING, the plan should focus on code changes.
- Ensure the plan actually addresses what the user asked for.

GUIDELINES:
- Concise, actionable, high-level.
- Structure: Use numbered/bulleted lists.
- Format the output to begin EXACTLY with: "/plan Plan: "
`;

	const userPrompt = `
1. USER REQUEST:
"""
${userRequestContent}
"""

2. AI RESPONSE (TECHNICAL DETAIL):
"""
${aiMessageContent}
"""
`;

	try {
		const result = await aiRequestService.generateWithRetry(
			[{ text: userPrompt }],
			DEFAULT_FLASH_LITE_MODEL,
			undefined,
			"lightweight plan prompt",
			undefined,
			undefined,
			token,
			false,
			systemInstruction,
		);

		if (token?.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		if (!result || result.toLowerCase().startsWith("error:")) {
			throw new Error(
				result ||
					"Empty or erroneous response from lightweight AI for plan prompt.",
			);
		}
		return result.trim(); // Trim any leading/trailing whitespace
	} catch (error: any) {
		console.error("Error generating lightweight plan prompt:", error);
		if (error.message === ERROR_OPERATION_CANCELLED) {
			throw error; // Re-throw cancellation error directly
		}
		throw new Error(`Failed to generate /plan prompt: ${error.message}`);
	}
}

/**
 * Validates the integrity of the AI-generated output using the Flash Lite model via Function Calling.
 * It detects if the output is an unintended code fragment or contains malformed Search/Replace markers.
 */
export async function validateOutputIntegrity(
	rawOutput: string,
	originalContent: string,
	aiRequestService: AIRequestService,
	token?: vscode.CancellationToken,
): Promise<{
	isValid: boolean;
	reason: string;
	type: "fragment" | "malformed_markers" | "valid";
}> {
	const systemInstruction = `
You are an expert code integrity validator using the Gemini Flash Lite model.
Your task is to determine if the provided AI-generated code modification is a **complete and valid** result or an **unintended fragment/broken output**.

RULES:
- A result is a FRAGMENT if it contains only a small part of the file without Search/Replace markers, OR if it contains "..." or "// ... rest of code" placeholders that suggest omission.
- A result is MALFORMED if it attempts to use Search/Replace markers (<<<<<<< SEARCH, =======, >>>>>>> REPLACE) but they are broken, missing parts, or incorrectly ordered.
- A result is VALID if it correctly uses Search/Replace blocks OR if it provides the full, complete file content (as long as it doesn't look like a fragment).
`;

	const userPrompt = `
AI-GENERATED OUTPUT TO VALIDATE:
"""
${rawOutput}
"""

ORIGINAL CONTENT CONTEXT:
Size: ${originalContent.length} characters
Snippet:
${originalContent.substring(0, 500)}
`;

	try {
		const apiKey = aiRequestService.getActiveApiKey();
		if (!apiKey) {
			throw new Error("No API Key available for integrity validation.");
		}

		// Use function calling for structured output
		const {
			OUTPUT_INTEGRITY_VALIDATION_TOOL,
		} = require("../../services/aiRequestService");

		const result = await aiRequestService.generateFunctionCall(
			apiKey,
			DEFAULT_FLASH_LITE_MODEL,
			[{ role: "user", parts: [{ text: userPrompt }] }],
			[OUTPUT_INTEGRITY_VALIDATION_TOOL],
			"ANY" as any, // FunctionCallingMode.ANY
			systemInstruction,
			undefined, // cachedContent
			token,
		);

		if (token?.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		if (!result || !result.functionCall) {
			return {
				isValid: true,
				reason: "Model did not use function call, defaulting to valid.",
				type: "valid",
			};
		}

		const args = result.functionCall.args as any;
		return {
			isValid: typeof args.isValid === "boolean" ? args.isValid : true,
			reason: args.reason || "No reason provided",
			type: args.type || "valid",
		};
	} catch (error: any) {
		console.error("Error validating output integrity:", error);
		if (error.message === ERROR_OPERATION_CANCELLED) {
			throw error;
		}
		return {
			isValid: true,
			reason: `Validation failed: ${error.message}. Defaulting to valid for safety.`,
			type: "valid",
		};
	}
}
