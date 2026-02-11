import * as sidebarTypes from "../../sidebar/common/sidebarTypes";
import { HistoryEntryPart } from "../../sidebar/common/sidebarTypes";
import { SafeCommandExecutor } from "../../context/safeCommandExecutor";

export function createInitialPlanningExplanationPrompt(
	projectContext: string,
	userRequest?: string,
	editorContext?: sidebarTypes.PlanGenerationContext["editorContext"],
	diagnosticsString?: string,
	chatHistory?: sidebarTypes.HistoryEntry[],
	urlContextString?: string,
): string {
	let specificContextContent = "";
	let planExplanationInstructions = "";

	const createFileJsonRules = `
JSON Plan Rules for \`create_file\` steps:
- Must include \`path\`.
- **MANDATORY STREAMING RULE**: You MUST use \`generate_prompt\` for ALL code files (e.g., .ts, .tsx, .js, .jsx, .py, .java, .css, etc.). This is NON-NEGOTIABLE. Using \`generate_prompt\` enables the live streaming visualization which users require.
- Use \`content\` ONLY for non-code configuration files (e.g., .gitignore, .env.example, package.json with static content).
- Never use \`content\` for any file containing actual code logic, regardless of file size.
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
									(p): p is HistoryEntryPart & { text: string } => "text" in p,
								)
								.map((p) => p.text)
								.join("\n")}`,
					)
					.join("\n---\n")}`
			: "";

	return `You are an expert software engineer. Your task is to explain a detailed, high-level, step-by-step plan to fulfill the request, focusing solely on problem-solving or feature implementation. No code or JSON output, only human-readable text.

Instructions for Plan Explanation:
*   Goal: Provide a clear, comprehensive, high-level, and human-readable plan using Markdown.
*   Context & Analysis: ${planExplanationInstructions.trim()}
${createFileJsonRules.trim()}
${newDependencyInstructionsForExplanation.trim()}
Refer to the "Broader Project Context" which includes detailed symbol information.

Command Usage Guidelines:
- **Stability**: Use \`ls | sort\` or \`find . | sort\` for consistent file ordering to prevent hallucinations.
- **Robust Searching**: Use \`find . -iname "*pattern*"\` for case-insensitive file searching. \`find\` is case-sensitive by default, so \`*Service.ts\` will miss \`planService.ts\` if using \`*service.ts\`.
- **Noise Reduction**: Use \`grep ... | uniq\` to remove duplicate matches and save context window.
- **Canonical Paths**: Use \`realpath <path>\` to resolve relative paths (e.g., \`../\`) before performing file modifications, ensuring accuracy.
- **Git Context**: If the request involves recent work or history, use \`git log\`, \`git status\`, or \`git diff\` (recent changes in this workspace) to gather context before planning.
- **Targeted Reading**: When reading files, prefer small, targeted ranges (300-500 lines) over reading entire large files. Use symbols to find specific logic.
- **Dependencies**: Prefer \`npm install <pkg>\` (no shell) over shell scripts for reliability.
${
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
	urlContextString?: string,
): string {
	const chatHistoryForPrompt =
		chatHistory && chatHistory.length > 0
			? `Chat History:\n${chatHistory
					.map(
						(entry) =>
							`Role: ${entry.role}\nContent:\n${entry.parts
								.filter(
									(p): p is HistoryEntryPart & { text: string } => "text" in p,
								)
								.map((p) => p.text)
								.join("\n")}`,
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
- \`create_file\`: You MUST use \`generate_prompt\` for ALL code files (.ts, .tsx, .js, .jsx, .py, .java, .css, etc.) regardless of size.
- **MANDATORY STREAMING RULE**: Using \`generate_prompt\` for code files is NON-NEGOTIABLE. It enables real-time streaming which the user requires. Use \`content\` ONLY for non-code config files (.gitignore, .env.example).
- \`modify_file\`: Always provide a non-empty \`modification_prompt\`.
- **Context Agent (\`use_context_agent\`):**:
    - Set \`use_context_agent\` to \`true\` ONLY if you need to dynamically search the codebase for information NOT already present in the prompt context (e.g., finding the definition of a symbol that isn't imported, checking usage patterns across the workspace).
    - Default to \`false\` for straightforward creations or modifications where the context is sufficient.
    - \`true\` triggers an agentic search (adds latency). Use sparingly.
- All \`path\` fields must be relative to workspace root, no \`..\` or leading \`/\`.
- Each step (create/modify) should be a single step.
- A single \`modification_prompt\` should cohesively describe multiple changes for one file, one step if they're part of one logical task.
- Avoid over-fragmentation.
- For \`create_file\` with code files, \`generate_prompt\` is MANDATORY, not optional. Never use \`content\` for code.
- All generated code/instructions must be production-ready (complete, functional, no placeholders/TODOs). The best code you can give.
- **Allowed Command List**: For 'run_command' steps, you are strictly limited to the following commands: [${SafeCommandExecutor.getAllowedCommands().join(", ")}]. Ensure any command you use is in this list.
- **Git for Context**: You are encouraged to use \`git log\`, \`git status\`, and \`git diff\` (recent changes in this workspace) to understand the current state and history of the project when needed for context.
- **Robustness**: Use \`find . -iname ...\` for searches to avoid case-sensitivity issues (e.g., \`find src -name "*service.ts"\` will fail to find \`planService.ts\` on many systems).
- **PATH ACCURACY**: You MUST use the EXACT relative paths provided in the diagnostics or project context. Do not truncate paths or assume files are in the root if they are in subdirectories.

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

/**
 * Creates a prompt for the AI to analyze the context of a failed execution or a needed fix
 * and propose a high-level textual correction strategy.
 */
export function createCorrectionPlanningPrompt(
	contextString: string,
	editorContext:
		| sidebarTypes.PlanGenerationContext["editorContext"]
		| undefined,
	chatHistory: sidebarTypes.HistoryEntry[],
	summaryOfLastChanges: string,
): string {
	const chatHistoryForPrompt =
		chatHistory && chatHistory.length > 0
			? `Chat History (for context):\n${chatHistory
					.map(
						(entry) =>
							`Role: ${entry.role}\nContent:\n${entry.parts
								.filter(
									(p): p is HistoryEntryPart & { text: string } => "text" in p,
								)
								.map((p) => p.text)
								.join("\n")}`,
					)
					.join("\n---\n")}`
			: "";

	let editorInfo = "";
	if (editorContext) {
		editorInfo = `
Target File: ${editorContext.filePath}
Language: ${editorContext.languageId}
Instruction: ${editorContext.instruction}
Selected Code:
\`\`\`${editorContext.languageId}
${editorContext.selectedText}
\`\`\`
Diagnostics: ${editorContext.diagnosticsString || "None"}
`;
	}

	return `You are an expert software engineer. A previous attempt to fulfill a request has resulted in errors or incomplete implementation. Your task is to analyze the provided context (focused on recently changed files) and the summary of previous changes/errors to propose a fix strategy.

STRATEGY PRIORITIZATION RULES:
1. **CRITICAL**: Your primary goal is to fix all reported ERRORS in the "FILES WITH ERRORS" list.
2. **SKIP CLEAN FILES**: Do NOT suggest modifications for files listed as "CLEAN FILES" or "HAS NO DIAGNOSTICS" unless a change there is MATHEMATICALLY NECESSARY to fix a diagnostic in an error file (e.g., updating an import, changing a function signature used by the error file).
3. **DIAGNOSTIC FOCUS**: Carefully read the "Self-Correction Diagnostic Summary" and "Relevant Diagnostics" for each file. Your plan must address EVERY reported error.

Instructions:
1. Review the "Summary of Recent Changes/Errors" and the "Self-Correction Diagnostic Summary".
2. Identify which files have ERRORS and which are CLEAN. 
3. Analyze the "Current Project Context" (focusing on files with reported errors) and any "Target File" info.
4. Propose a clear, high-level, step-by-step textual strategy (using Markdown) to fix the reported ERRORS and complete the task.
5. Focus solely on problem-solving. No code or JSON output yet.

Summary of Recent Changes/Errors:
${summaryOfLastChanges}

${editorInfo}
${chatHistoryForPrompt ? `\n${chatHistoryForPrompt}\n` : ""}

Current Project Context:
${contextString}

--- Correction Strategy (Text with Markdown) ---
`;
}

/**
 * Creates a prompt for calling the `generateExecutionPlan` tool to execute a correction strategy.
 */
export function createCorrectionExecutionPrompt(
	projectContext: string,
	editorContext:
		| sidebarTypes.PlanGenerationContext["editorContext"]
		| undefined,
	chatHistory: sidebarTypes.HistoryEntry[],
	textualPlanExplanation: string,
	summaryOfLastChanges: string,
	urlContextString?: string,
): string {
	const chatHistoryForPrompt =
		chatHistory && chatHistory.length > 0
			? `Chat History:\n${chatHistory
					.map(
						(entry) =>
							`Role: ${entry.role}\nContent:\n${entry.parts
								.filter(
									(p): p is HistoryEntryPart & { text: string } => "text" in p,
								)
								.map((p) => p.text)
								.join("\n")}`,
					)
					.join("\n---\n")}`
			: "";

	let mainUserRequestDescription =
		"Correction and completion of previous task.";
	if (editorContext) {
		mainUserRequestDescription = `Request: Fix/Correct code (Instruction: "${editorContext.instruction}").
File: ${editorContext.filePath}
Language: ${editorContext.languageId}
Selected Code:
\`\`\`${editorContext.languageId}
${editorContext.selectedText}
\`\`\`
Diagnostics: ${editorContext.diagnosticsString || "None"}`;
	}

	return `You are an expert software engineer AI. Generate a structured execution plan to fix specific issues identified in the textual strategy while considering the recent changes by calling the \`generateExecutionPlan\` function.

Goal: Implement the "Correction Strategy" while carefully considering the "Summary of Recent Changes/Errors" to avoid repeating mistakes.

Instructions for Function Call:
- You MUST call the \`generateExecutionPlan\` tool.
- \`plan\`: Use the "Correction Strategy" provided below.
- \`user_request\`: ${mainUserRequestDescription}
- \`project_context\`: Entire broader project context.
- \`chat_history\`: Entire recent chat history.
- \`recent_changes\`: Use the "Summary of Recent Changes/Errors" below.
- \`url_context_string\`: Any provided URL context.

Crucial Rules for \`generateExecutionPlan\` Tool:
- **Holistic File Analysis**: Before generating any plan steps, FIRST analyze all required modifications for EACH file targeted.
- **Enforce One \`ModifyFileStep\` Per File**: Consolidate all changes for a single file into exactly ONE step.
- \`create_file\`: You MUST use \`generate_prompt\` for ALL code files.
- **MANDATORY STREAMING RULE**: Using \`generate_prompt\` for code files is NON-NEGOTIABLE.
- All generated code/instructions must be production-ready (complete, functional, no placeholders/TODOs).
- **Allowed Command List**: For 'run_command' steps, you are strictly limited to the following commands: [${SafeCommandExecutor.getAllowedCommands().join(
		", ",
	)}].
- **PATH ACCURACY**: You MUST use the EXACT relative paths provided in the diagnostics or project context. Do not truncate paths or assume files are in the root if they are in subdirectories.

Summary of Recent Changes/Errors:
${summaryOfLastChanges}

Correction Strategy:
${textualPlanExplanation}

Broader Project Context:
${projectContext}

${chatHistoryForPrompt ? `\n${chatHistoryForPrompt}` : ""}
${urlContextString ? `\nURL Context:\n${urlContextString}` : ""}
`;
}
