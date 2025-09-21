import * as sidebarTypes from "../../sidebar/common/sidebarTypes";
import { HistoryEntryPart } from "../../sidebar/common/sidebarTypes";

export function createInitialPlanningExplanationPrompt(
	projectContext: string,
	userRequest?: string,
	editorContext?: sidebarTypes.PlanGenerationContext["editorContext"],
	diagnosticsString?: string,
	chatHistory?: sidebarTypes.HistoryEntry[],
	urlContextString?: string
): string {
	let specificContextContent = "";
	let planExplanationInstructions = "";

	const createFileJsonRules = `
JSON Plan Rules for \`create_file\` steps:
- Must include \`path\`.
- Provide *exactly one* of \`content\` (literal file content) or \`generate_prompt\` (prompt for content generation). Never both, never neither.
`;

	const newDependencyInstructionsForExplanation = `
Dependency Management:
- Do not edit manifest files (e.g., package.json, requirements.txt) directly for new dependencies.
- Use \`RunCommand\` for installation: \`npm install <pkg>\` (runtime), \`npm install <pkg> --save-dev\` (dev) for Node.js; \`pip install <pkg>\` for Python.
- Infer package manager from project context.
- Include \`RunCommand\` for \`npm install\` or \`pip install -r requirements.txt\` if manifest files are created/modified by other means.
`;

	if (editorContext) {
		const filePath = editorContext.filePath;
		const languageId = editorContext.languageId;
		const selectedText = editorContext.selectedText;
		const fullText = editorContext.fullText;
		const diagnostics = diagnosticsString
			? `\nRelevant Diagnostics in Selection:\n${diagnosticsString}`
			: "";

		if (editorContext.instruction.toLowerCase() === "/fix") {
			specificContextContent = `File Path: ${filePath}
Language: ${languageId}
Instruction Type: I triggered '/fix' on the selected code to fix bugs based on provided diagnostics.
Selected Code:
\`\`\`${languageId}
${selectedText}
\`\`\`
Full Content of Affected File:
\`\`\`${languageId}
${fullText}
\`\`\`${diagnostics}`;
			planExplanationInstructions = `Based on the '/fix' command and file context, explain a detailed plan. The plan must address 'Relevant Diagnostics'. Consult "Broader Project Context" (symbol info) for broader impact, affected areas, compatibility, and side effects.`;
		} else if (editorContext.instruction.toLowerCase() === "/merge") {
			specificContextContent = `File Path: ${filePath}
Language: ${languageId}
Instruction Type: I triggered '/merge' to resolve Git merge conflicts in this file.
Full Content of Affected File (with conflicts):
\`\`\`${languageId}
${fullText}
\`\`\``;
			planExplanationInstructions = `Based on the '/merge' command, explain a plan to resolve all Git merge conflicts ('<<<<<<<', '=======', '>>>>>>>') and produce a clean merged file. The plan must include a single 'modify_file' step for conflict resolution.`;
		} else {
			// Custom instruction
			specificContextContent = `File Path: ${filePath}
Language: ${languageId}
Instruction Type: My custom instruction: "${editorContext.instruction}".
Selected Code:
\`\`\`${languageId}
${selectedText}
\`\`\`
Full Content of Affected File:
\`\`\`${languageId}
${fullText}
\`\`\`${diagnostics}`;
			planExplanationInstructions = `Based on my custom instruction ("${editorContext.instruction}") and file context, explain a detailed plan. Interpret the request in the context of selected code, chat history, and diagnostics.`;
		}
	} else if (userRequest) {
		specificContextContent = `My Request from Chat: ${userRequest}`;
		planExplanationInstructions = `Based on my request ("${userRequest}") and chat history, explain a detailed plan to fulfill it.`;
	}

	const chatHistoryForPrompt =
		chatHistory && chatHistory.length > 0
			? `Chat History (for context):\n${chatHistory
					.map(
						(entry) =>
							`Role: ${entry.role}\nContent:\n${entry.parts
								.filter(
									(p): p is HistoryEntryPart & { text: string } => "text" in p
								)
								.map((p) => p.text)
								.join("\n")}`
					)
					.join("\n---\n")}`
			: "";

	return `You are an expert software engineer. Your task is to explain a detailed, high-level, step-by-step plan to fulfill the request, focusing solely on problem-solving or feature implementation. No code or JSON output, only human-readable text.

Instructions for Plan Explanation:
*   Goal: Provide a clear, comprehensive, high-level, and human-readable plan using Markdown.
*   Context & Analysis: ${planExplanationInstructions.trim()}
${createFileJsonRules.trim()}
${newDependencyInstructionsForExplanation.trim()}
Refer to the "Broader Project Context" which includes detailed symbol information. ${
		editorContext && diagnosticsString
			? "For '/fix' requests, specifically detail how your plan addresses all 'Relevant Diagnostics'."
			: ""
	}
*   Completeness & Clarity: Cover all necessary steps. Describe each step briefly (e.g., "Create 'utils.ts'", "Modify 'main.ts' to import utility", "Install 'axios' via npm").
*   Production Readiness: Generate production-ready code. Prioritize robustness, maintainability, security, cleanliness, efficiency, and industry best practices.

${
	specificContextContent
		? `Specific Context:\n${specificContextContent.trim()}\n`
		: ""
}
${chatHistoryForPrompt ? `\n${chatHistoryForPrompt}\n` : ""}
${urlContextString ? `URL Context: ${urlContextString}\n` : ""}

Broader Project Context (Reference Only):
${projectContext}

--- Plan Explanation (Text with Markdown) ---
`;
}

/**
 * Creates a prompt specifically designed for instructing an AI to call the `generateExecutionPlan` function.
 * This prompt bundles all relevant context for the AI to formulate the arguments for the function call.
 * The AI will be expected to output a function call rather than a free-form JSON plan.
 */
export function createPlanningPromptForFunctionCall(
	userRequest: string | undefined,
	projectContext: string,
	editorContext:
		| sidebarTypes.PlanGenerationContext["editorContext"]
		| undefined,
	chatHistory: sidebarTypes.HistoryEntry[] | undefined,
	textualPlanExplanation: string,
	recentChanges: string | undefined,
	urlContextString?: string
): string {
	const chatHistoryForPrompt =
		chatHistory && chatHistory.length > 0
			? `Chat History:\n${chatHistory
					.map(
						(entry) =>
							`Role: ${entry.role}\nContent:\n${entry.parts
								.filter(
									(p): p is HistoryEntryPart & { text: string } => "text" in p
								)
								.map((p) => p.text)
								.join("\n")}`
					)
					.join("\n---\n")}`
			: "";

	const recentChangesForPrompt =
		recentChanges && recentChanges.length > 0
			? `Recent Project Changes:\n${recentChanges}`
			: "";

	let mainUserRequestDescription =
		userRequest ||
		"No specific user request provided, rely on textual plan explanation.";

	if (editorContext) {
		const filePath = editorContext.filePath;
		const languageId = editorContext.languageId;
		const selectedText = editorContext.selectedText;
		const fullText = editorContext.fullText;
		const diagnostics = editorContext.diagnosticsString
			? `\nRelevant Diagnostics: ${editorContext.diagnosticsString}`
			: "";

		if (editorContext.instruction.toLowerCase() === "/fix") {
			mainUserRequestDescription = `Request: Fix code (triggered '/fix').
File: ${filePath}
Language: ${languageId}
Selected Code:
\`\`\`${languageId}
${selectedText}
\`\`\`
Full Content:
\`\`\`${languageId}
${fullText}
\`\`\`${diagnostics}`;
		} else if (editorContext.instruction.toLowerCase() === "/merge") {
			mainUserRequestDescription = `Request: Resolve Git merge conflicts (triggered '/merge').
File: ${filePath}
Language: ${languageId}
Full Content (with conflicts):
\`\`\`${languageId}
${fullText}
\`\`\``;
		} else {
			mainUserRequestDescription = `Request: Custom instruction ("${editorContext.instruction}").
File: ${filePath}
Language: ${languageId}
Selected Code:
\`\`\`${languageId}
${selectedText}
\`\`\`
Full Content:
\`\`\`${languageId}
${fullText}
\`\`\`${diagnostics}`;
		}
	}

	return `You are an expert software engineer AI. Generate a structured execution plan by calling the \`generateExecutionPlan\` function.

Instructions for Function Call:
- You MUST call the \`generateExecutionPlan\` tool.
- \`plan\`: Use the entire detailed textual plan explanation below.
- \`user_request\`: Original user's request or editor instruction.
- \`project_context\`: Entire broader project context.
- \`chat_history\`: Entire recent chat history.
- \`recent_changes\`: Entire recent project changes.
- \`url_context_string\`: Any provided URL context.

Crucial Rules for \`generateExecutionPlan\` Tool:
- **Holistic File Analysis**: Before generating any plan steps, FIRST analyze all required modifications for EACH file targeted by the user's request.
- **Single Comprehensive \`modification_prompt\`**: For each file path requiring changes, construct EXACTLY ONE detailed \`modification_prompt\` that comprehensively describes ALL intended additions, deletions, refactorings, or other edits for that specific file.
- **Enforce One \`ModifyFileStep\` Per File**: Generate PRECISELY ONE \`ModifyFileStep\` for any given file path within the \`ExecutionPlan\`. All changes for a file MUST be included in that single step's \`modification_prompt\`.
- **Prevent Redundant Steps**: AVOID generating multiple, fragmented \`ModifyFileStep\` entries for the same file path within a single \`ExecutionPlan\`.
- \`create_file\`: Provide *either* \`content\` *or* \`generate_prompt\`; never both or neither.
- \`modify_file\`: Always provide a non-empty \`modification_prompt\`.
- All \`path\` fields must be relative to workspace root, no \`..\` or leading \`/\`.
- Each step (create/modify) should be a single step.
- A single \`modification_prompt\` should cohesively describe multiple changes for one file, one step if they're part of one logical task.
- Avoid over-fragmentation.
- For \`create_file\`, prefer \`content\` for known file content; use \`generate_prompt\` only if dynamic generation is truly needed.
- All generated code/instructions must be production-ready (complete, functional, no placeholders/TODOs). The best code you can give.

Goal: Ensure all relevant information is passed accurately and comprehensively to the \`generateExecutionPlan\` function. 

Absolutely Critical: The entire plan MUST NOT contain multiple 'modify_file' steps that target the exact same 'path'. All modifications for a single file must be consolidated into a single 'modify_file' step for that specific file. For a 'modify_file' step, its 'modification_prompt' must cohesively describe *all* changes intended for that single file. This is to ensure only one 'modify_file' step is generated per file throughout the plan.

User Request/Instruction:
${mainUserRequestDescription.trim()}

Detailed Textual Plan Explanation:
${textualPlanExplanation}

Broader Project Context:
${projectContext}

${chatHistoryForPrompt ? `\n${chatHistoryForPrompt}` : ""}
${recentChangesForPrompt ? `\n${recentChangesForPrompt}` : ""}
${urlContextString ? `\nURL Context:\n${urlContextString}` : ""}
`;
}
