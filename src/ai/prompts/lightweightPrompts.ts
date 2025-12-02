import { AIRequestService } from "../../services/aiRequestService";
import { DEFAULT_FLASH_LITE_MODEL } from "../../sidebar/common/sidebarConstants";
import { ERROR_OPERATION_CANCELLED } from "../gemini";
import * as vscode from "vscode";

export async function generateLightweightPlanPrompt(
	aiMessageContent: string,
	modelName: string,
	aiRequestService: AIRequestService,
	token?: vscode.CancellationToken
): Promise<string> {
	const prompt = `

Analyze the AI's previous response to create a high-level plan for code implementation. Focus on a structured, step-by-step outline of key changes, integrations, and considerations, without code. Use this as a blueprint for production-ready code.

Guidelines:
- Concise and actionable: Extract essential steps, dependencies, and logic.
- High-level: Describe actions, brief rationale if key, and interactions; no details or code.
- Reference files/modules: Mention existing ones if implied for context.
- Structure: Use numbered/bulleted lists; group tasks (e.g., setup, logic, testing).
- Complete: Include error handling, edges, performance, prerequisites if relevant.
- Production-ready: Highlight modularity, scalability, security, maintainability.

Begin the plan exactly with this:
"/plan with high-level thinking, no coding yet, in the best way, generate a plan about this below (use related files if needed to implement plan):"

AI Response: ${aiMessageContent}
`;

	try {
		const result = await aiRequestService.generateWithRetry(
			[{ text: prompt }],
			DEFAULT_FLASH_LITE_MODEL,
			undefined, // No history needed for this type of request
			"lightweight plan prompt",
			undefined, // No specific generation config needed
			undefined, // No streaming callbacks needed
			token
		);

		if (token?.isCancellationRequested) {
			throw new Error(ERROR_OPERATION_CANCELLED);
		}

		if (!result || result.toLowerCase().startsWith("error:")) {
			throw new Error(
				result ||
					"Empty or erroneous response from lightweight AI for plan prompt."
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
