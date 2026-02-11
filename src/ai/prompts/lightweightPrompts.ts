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

	const prompt = `
You are an expert summarization agent using the Gemini Flash Lite model. Your goal is to condense the provided chat history into a concise summary.

CRITICAL INSTRUCTION: Filter the history strictly based on the CURRENT USER REQUEST provided below.
1. If the CURRENT USER REQUEST explicitly targets a specific topic (e.g., a specific file, function, or concept mentioned), ONLY include historical facts, context, or previous outputs relevant to THAT specific topic in the summary.
2. If the CURRENT USER REQUEST is general (e.g., "Continue what we were doing," "Summarize everything," or seems like a continuation that implies broad context), summarize the *entire* provided history cohesively.
3. The resulting summary must be brief, factual (no opinions), and structured clearly. Do not include any introductory phrases like "Based on the history...".

Chat History to analyze:
--- HISTORY START ---
${historyContent}
--- HISTORY END ---

CURRENT USER REQUEST:
${currentUserRequest}

BEGIN SUMMARY (Use the model 'Gemini Flash Lite' approach: highly focused and brief):
`;

	try {
		const result = await aiRequestService.generateWithRetry(
			[{ text: prompt }],
			DEFAULT_FLASH_LITE_MODEL, // Explicitly target Flash Lite for summarization
			undefined, // No history needed for this type of request
			"contextual history summarization",
			undefined, // No specific generation config needed
			undefined, // No streaming callbacks needed
			token,
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
	const prompt = `
You are an expert technical planner.

CONTEXT:
1. User Request:
"""
${userRequestContent}
"""

2. AI Response (Technical Explanation/Suggestion):
"""
${aiMessageContent}
"""

TASK:
Create a high-level, structured plan based on the AI's response, BUT strictly aligned with the User's Request.

CRITICAL INTENT CHECK:
- If the User's Request was about UPDATING DOCUMENTATION (e.g., "update docs", "document this"), the plan MUST focus on updating documentation files (.md, etc.). DO NOT propose modifying code files unless explicitly requested.
- If the User's Request was about REFACTORING or CODING, the plan should focus on code changes.
- Ensure the plan actually addresses what the user asked for, using the AI's response as the technical detail for *how* to do it.

GUIDELINES:
- Concise and actionable: Extract essential steps.
- High-level: Describe actions and brief rationale.
- Reference files/modules: Mention existing ones implied by context.
- Structure: Use numbered/bulleted lists.
- Complete: Include error handling/verifications.
- Production-ready: Highlight modularity/maintainability.

Format the output to begin EXACTLY with:
"/plan "
`;

	try {
		const result = await aiRequestService.generateWithRetry(
			[{ text: prompt }],
			DEFAULT_FLASH_LITE_MODEL, // Existing logic uses Flash Lite for plan generation
			undefined, // No history needed for this type of request
			"lightweight plan prompt",
			undefined, // No specific generation config needed
			undefined, // No streaming callbacks needed
			token,
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
