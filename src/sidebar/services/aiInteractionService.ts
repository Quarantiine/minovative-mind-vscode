import { EnhancedCodeGenerator } from "../../ai/enhancedCodeGeneration";
import * as sidebarTypes from "../common/sidebarTypes";
import * as vscode from "vscode";
import * as path from "path";
import { TEMPERATURE } from "../common/sidebarConstants";
import { AIRequestService } from "../../services/aiRequestService";
import * as crypto from "crypto";

export async function _performModification(
	originalFileContent: string,
	modificationPrompt: string,
	languageId: string,
	filePath: string,
	modelName: string,
	aiRequestService: AIRequestService,
	enhancedCodeGenerator: EnhancedCodeGenerator,
	token: vscode.CancellationToken,
	postMessageToWebview: (
		message: sidebarTypes.ExtensionToWebviewMessages,
	) => void,
	isMergeOperation: boolean = false, // isMergeOperation parameter
): Promise<string> {
	const streamId = crypto.randomUUID(); // Added as per instruction 1

	let specializedMergeInstruction = "";
	if (isMergeOperation) {
		// This is the core enhancement: detailed merge instructions for the AI
		specializedMergeInstruction = `
            You are currently resolving Git merge conflicts. Your absolute primary goal is to produce a single, coherent, and syntactically correct file with **ALL** merge conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`, \`|||||||\`) completely removed. Note that these Git markers are DIFFERENT from the SEARC#H/REPLAC#E markers used for file modifications.

            When analyzing conflict blocks:
            -   **Prioritize Semantic Coherence:** Understand the purpose of the code and how the changes from both sides (HEAD and incoming) might interact.
            -   **Intelligently Integrate:** For simple, non-overlapping changes, combine them.
            -   **Handle Overlaps Carefully:** For directly conflicting lines, decide based on which change appears to be more complete, critical, or aligns better with the overall project logic. The \`Modification Instruction\` below will guide your high-level strategy.
            -   **Syntax and Structure:** Ensure the final code is syntactically valid for ${languageId} and maintains consistent indentation and coding style.
            -   **No Partial Conflicts:** Do not leave any partial markers or unresolved sections. The file must be fully merged.
            `;
	}

	const prompt = `You are an expert AI software developer tasked with modifying the provided file content based on the given instructions. ONLY focus on generating code.

    --- Specialized Merge Instruction ---
    ${specializedMergeInstruction}
    --- End Specialized Merge Instruction ---

    **CRITICAL REQUIREMENTS:**
    *   **Preserve Existing Structure & Style**: Maintain the current file organization, structural patterns, and architectural design. Strictly follow existing code style, formatting (indentation, spacing, line breaks), and conventions. Preserve comments and import order unless new imports are strictly necessary.
    *   **Error Prevention & Production Readiness**: Ensure the modified code compiles and runs *without any errors or warnings*. Proactively address potential runtime issues, logical flaws, and edge cases (e.g., null/undefined checks, off-by-one errors, input validations). Stress robustness, maintainability, and adherence to best practices for production readiness.

    Your output MUST contain **ONLY** the complete, production-ready file content. **ABSOLUTELY NO MARKDOWN CODE BLOCK FENCES (\`\`\`typescript), NO CONVERSATIONAL TEXT, NO EXPLANATIONS, NO APOLOGIES, NO COMMENTS (UNLESS PART OF THE CODE LOGIC), NO YAML, NO JSON, NO XML, NO EXTRA ELEMENTS WHATSOEVER.** Your response **MUST START DIRECTLY ON THE FIRST LINE** with the pure, modified file content and nothing else.

    File Path: ${filePath}
    Language: ${languageId}

    --- Original File Content ---
    \`\`\`${languageId}
    ${originalFileContent}
    \`\`\`
    --- End Original File Content ---

    --- Modification Instruction ---
    ${modificationPrompt}
    --- End Modification Instruction ---

    Your complete, raw modified file content:`;

	const generationConfig = {
		temperature: TEMPERATURE,
	};

	let modifiedContent = "";
	try {
		// Send codeFileStreamStart message immediately before content generation
		postMessageToWebview({
			type: "codeFileStreamStart",
			value: {
				streamId: streamId,
				filePath: `/${path.basename(filePath)}`,
				languageId: languageId,
			}, // Modified as per instruction 2
		});

		const generationContext = {
			projectContext: "",
			relevantSnippets: "",
			editorContext: undefined,
			activeSymbolInfo: undefined,
		};
		const genResult = await enhancedCodeGenerator.generateFileContent(
			filePath,
			modificationPrompt,
			generationContext,
			modelName,
			token,
			generationConfig,
		);
		modifiedContent = genResult.content;

		// Send `codeFileStreamEnd` on success
		postMessageToWebview({
			type: "codeFileStreamEnd",
			value: {
				streamId: streamId,
				filePath: `/${path.basename(filePath)}`,
				success: true,
			}, // Modified as per instruction 4
		});
	} catch (error) {
		console.error("Error during AI file", error); // Log any caught errors
		// Send `codeFileStreamEnd` on error
		postMessageToWebview({
			type: "codeFileStreamEnd",
			value: {
				streamId: streamId, // Modified as per instruction 4 (use the declared streamId)
				filePath: `/${path.basename(filePath)}`,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error; // Re-throw them to ensure proper upstream handling by planExecutionService
	}

	return modifiedContent;
}
