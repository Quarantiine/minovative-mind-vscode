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
4. IMPORTANT: Clearly label this as historical context. The main AI agent will use this as supplementary background, and it should NOT override the user's current intent.
5. TOPIC SHIFT: If the CURRENT USER REQUEST represents a significant shift in topic (e.g. user asks for something unrelated to previous discussion), return a minimal or empty summary emphasizing that the previous context is no longer relevant.
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
	filePath?: string,
): Promise<{
	isValid: boolean;
	reason: string;
	type: "fragment" | "malformed_markers" | "valid";
}> {
	const systemInstruction = `
You are an expert code integrity validator using the Gemini Flash Lite model.
Your task is to determine if the provided AI-GENERATED OUTPUT is a **complete and valid** result or an **unintended fragment/broken output**.

CRITICAL - CONTEXT SNIPPETS:
- The "ORIGINAL CONTENT CONTEXT" provided is intentionally a TRUNCATED SNIPPET (top/bottom) of the original file.
- **NEVER** conclude the AI-GENERATED OUTPUT is a fragment just because it is shorter than the full original file or because the context snippet itself is incomplete.
- Judge completeness based ONLY on the internal structure of the AI-GENERATED OUTPUT.
- If the output is a JSON file, check if it is a syntactically complete JSON object (properly closed with }). Do not worry if it doesn't contain all the data from the context snippet - the context snippet is just a preview.

CRITICAL - SEARCH/REPLACE BLOCKS:
- If the output correctly uses the SEARC#H/REPLAC#E marker format (<<<<<<< SEARC#H, ===#===, >>>>>>> REPLAC#E), it is **BY DEFINITION** a valid partial update.
- **NEVER** flag an output as a fragment if it contains valid SEARC#H/REPLAC#E blocks, even if it only modifies a small part of the file.

CRITICAL BOOLEAN MAPPING:
- If you determine the output is VALID, you MUST set "isValid" to true.
- If you determine the output is a FRAGMENT or MALFORMED, you MUST set "isValid" to false.
`;

	const userPrompt = `
${filePath ? `TARGET FILE: ${filePath}\n` : ""}
AI-GENERATED OUTPUT TO VALIDATE:
"""
${rawOutput}
"""

ORIGINAL CONTENT CONTEXT:
Size: ${originalContent.length} characters
Start of file:
${originalContent.substring(0, 500)}
...
End of file:
${originalContent.length > 500 ? originalContent.substring(originalContent.length - 500) : ""}
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

/**
 * Transforms a technical diff into a concise, professional narrative summary using the Flash Lite model.
 * @param filePath Path of the file being changed.
 * @param technicalSummary A low-level technical summary of changes (e.g. "added function X, modified Y").
 * @param diffContent The actual diff content.
 * @param intentPrompt The original user instruction/intent for this change.
 * @param aiRequestService Service for making AI calls.
 * @param token Cancellation token.
 * @returns A polished narrative summary or the original technical summary as fallback.
 */
export async function generateNarrativeDiffSummary(
	filePath: string,
	technicalSummary: string,
	diffContent: string,
	intentPrompt: string,
	aiRequestService: AIRequestService,
	token?: vscode.CancellationToken,
): Promise<string> {
	const filename = filePath.split(/[/\\]/).pop() || filePath;

	const systemInstruction = `
You are an expert technical writer using the Gemini Flash Lite model.
Your task is to transform a technical diff and its raw summary into a single, professional narrative sentence.

FORMAT:
The [filename] update [does something] by [doing something else]...

RULES:
1. Be concise and professional.
2. Focus on the 'why' and the 'how' based on the user's intent and the diff.
3. Use the provided filename: "${filename}".
4. Output ONLY the narrative summary sentence. No preamble or conversational filler.
`;

	const userPrompt = `
FILE: ${filePath}
USER INTENT: ${intentPrompt}
TECHNICAL SUMMARY: ${technicalSummary}

DIFF CONTENT:
${diffContent}

NARRATIVE SUMMARY:
`;

	try {
		const result = await aiRequestService.generateWithRetry(
			[{ text: userPrompt }],
			DEFAULT_FLASH_LITE_MODEL,
			undefined,
			"narrative diff summarization",
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
			return technicalSummary;
		}

		return result.trim();
	} catch (error: any) {
		console.error("Error generating narrative diff summary:", error);
		if (error.message === ERROR_OPERATION_CANCELLED) {
			throw error;
		}
		// Fallback to technical summary on error
		return technicalSummary;
	}
}
