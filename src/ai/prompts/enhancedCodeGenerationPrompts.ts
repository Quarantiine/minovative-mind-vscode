import * as vscode from "vscode";
import * as path from "path";
import { DEFAULT_SIZE } from "../../sidebar/common/sidebarConstants";
import {
	FileAnalysis,
	FileStructureAnalysis,
	EnhancedGenerationContext,
} from "../enhancedCodeGeneration";
import { SafeCommandExecutor } from "../../context/safeCommandExecutor";

/**
 * Analyzes a file path for framework and structure information.
 * This was originally `_analyzeFilePath` in `EnhancedCodeGenerator`.
 */
function _analyzeFilePath(filePath: string): FileAnalysis {
	const segments = filePath.split(path.sep); // Use path.sep for OS compatibility
	const fileName = path.basename(filePath);
	const extension = path.extname(filePath);

	let framework = "unknown";
	let projectStructure = "unknown";
	let expectedPatterns = "standard";

	// Detect framework based on path structure
	if (segments.includes("pages") || segments.includes("app")) {
		framework = "Next.js";
		projectStructure = "pages/app router";
	} else if (segments.includes("src") && segments.includes("components")) {
		framework = "React";
		projectStructure = "src-based";
	} else if (segments.includes("src") && segments.includes("services")) {
		framework = "Node.js/Express";
		projectStructure = "service-oriented";
	}

	// Detect patterns based on file location
	if (segments.includes("components")) {
		expectedPatterns = "React component patterns";
	} else if (segments.includes("utils") || segments.includes("helpers")) {
		expectedPatterns = "utility function patterns";
	} else if (segments.includes("services")) {
		expectedPatterns = "service layer patterns";
	}

	return {
		framework,
		projectStructure,
		expectedPatterns,
		fileName,
		extension,
	};
}

/**
 * Get language ID from file extension.
 * This was originally `_getLanguageId` in `EnhancedCodeGenerator`.
 */
function _getLanguageId(extension: string): string {
	const languageMap: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".py": "python",
		".java": "java",
		".cs": "csharp",
		".cpp": "cpp",
		".c": "c",
		".go": "go",
		".rs": "rust",
		".php": "php",
		".rb": "ruby",
		".swift": "swift",
		".kt": "kotlin",
	};

	return languageMap[extension] || "text";
}

/**
 * Create Helper for Formatting `FileStructureAnalysis`
 * This was originally `_formatFileStructureAnalysis` in `EnhancedCodeGenerator`.
 */
function _formatFileStructureAnalysis(
	analysis?: FileStructureAnalysis,
): string {
	if (!analysis) {
		return "";
	}

	let formatted = "**File Structure Analysis:**\n";
	if (analysis.imports.length > 0) {
		formatted += `- Imports: ${analysis.imports.length} lines\n`;
	}
	if (analysis.exports.length > 0) {
		formatted += `- Exports: ${analysis.exports.length} lines\n`;
	}
	if (analysis.functions.length > 0) {
		formatted += `- Functions: ${analysis.functions.length} functions\n`;
	}
	if (analysis.classes.length > 0) {
		formatted += `- Classes: ${analysis.classes.length} classes\n`;
	}
	if (analysis.variables.length > 0) {
		formatted += `- Variables: ${analysis.variables.length} variables\n`;
	}
	if (analysis.comments.length > 0) {
		formatted += `- Comments: ${analysis.comments.length} lines\n`;
	}
	formatted +=
		"Analyze this structure to understand the file's organization and apply changes consistently.";
	return formatted;
}

// --- Exported Prompt Generation Functions ---

/**
 * Creates the enhanced generation prompt used for initial content generation.
 * Originally extracted from `EnhancedCodeGenerator._createEnhancedGenerationPrompt`.
 */
/**
 * Generates the system instruction for enhanced generation.
 */
export function getEnhancedGenerationSystemInstruction(
	filePath: string,
	context: EnhancedGenerationContext & { formattedDiagnostics?: string },
): string {
	const fileAnalysis = _analyzeFilePath(filePath);
	const languageId = _getLanguageId(fileAnalysis.extension);
	const isRewrite = context.isRewriteOperation ?? false;

	const requirementsList: string[] = [];

	if (isRewrite) {
		requirementsList.push(
			"**Prioritize New Structure/Content**: You are tasked with generating the new code as specified in the instructions. Prioritize generating the new code structure and content precisely as specified, even if it requires significant deviations from typical patterns or implies a complete overhaul of an existing conceptual file. You have full autonomy to innovate and introduce new patterns/structures if they best fulfill the request.",
		);
	}

	requirementsList.push(
		"**Accuracy First**: Ensure all imports, types, and dependencies are *absolutely* correct and precisely specified. Verify module paths, type definitions, and API usage.",
	);
	requirementsList.push(
		"**Style Consistency**: Adhere * rigorously* to the project's existing coding patterns, conventions, and formatting. Maintain current indentation, naming, and structural choices.",
	);
	requirementsList.push(
		"**Error Prevention & Exhaustive Consideration**: Generate code that will compile and run *without any errors or warnings*. Proactively anticipate and guard against ALL potential pitfalls, edge cases, and secondary impacts. Consider null/undefined checks, input validations, and how this change affects related components or state.",
	);
	requirementsList.push(
		"**Best Practices**: Employ modern language features, established design patterns, and industry best practices to ensure high-quality, efficient, and robust code that is production-ready, maintainable, and clean.",
	);
	requirementsList.push(
		"**Production Readiness**: Stress robustness, maintainability, and adherence to best practices for the generated code.",
	);
	requirementsList.push(
		"**Security**: Implement secure coding practices meticulously, identifying and addressing potential vulnerabilities relevant to the language and context.",
	);
	requirementsList.push(
		"**Focus on Current Intent**: Prioritize the current modification instructions over historical context or existing coding patterns if they conflict. Your primary goal is to fulfill the *current* user request.",
	);
	const allowedCommands = SafeCommandExecutor.getAllowedCommands().join(", ");
	requirementsList.push(
		`**Command Execution Format (RunCommandStep)**: For any \`RunCommandStep\` action, the \`command\` property MUST be an object \`{ executable: string, args: string[], usesShell?: boolean }\`. The \`executable\` should be the command name (e.g., 'npm', 'git') and \`args\` an array of its arguments (e.g., ['install', '--save-dev', 'package']). 
        
        **ALLOWED COMMANDS**: You are strictly limited to the following commands for 'executable': [${allowedCommands}]. 
        **Command Tips**: Use \`sort\` and \`uniq\` to clean up output. Use \`realpath\` to resolve paths. Use \`find src -iname ...\` for case-insensitive searches scoped to source directories. Prefer \`git ls-files\` over \`ls -R\` for file listing. Commands are automatically filtered to exclude node_modules, dist, build artifacts, and binary files.
        
        If a command *absolutely requires* \`shell: true\` (e.g., it uses shell-specific features like pipes, redirects, or environment variable expansion inherently for its functionality, and cannot be expressed directly via \`executable\` and \`args\`), you MUST explicitly include \`usesShell: true\` in the object. This flag triggers critical fallback security checks in \`PlanExecutorService\` and should be used sparingly. Always prefer \`executable\` and \`args\` without \`usesShell: true\` for security reasons, unless explicitly necessary.`,
	);

	return `You are the expert software engineer for me, specializing in ${languageId} development. Your task is to generate production-ready, accurate code. ONLY focus on generating code. EXCLUDE all conversational or meta-commentary.

**File Analysis:**
- Path: ${filePath}
- Language: ${languageId}
- Framework: ${fileAnalysis.framework}
- Project Structure: ${fileAnalysis.projectStructure}
- Expected Patterns: ${fileAnalysis.expectedPatterns}

**Requirements:**
${requirementsList.map((req) => `- ${req}`).join("\n")}`;
}

/**
 * Generates the user message for enhanced generation.
 */
export function getEnhancedGenerationUserMessage(
	generatePrompt: string,
	context: EnhancedGenerationContext & { formattedDiagnostics?: string },
): string {
	return `**Instructions:**
${generatePrompt}

**Project Context:**
${context.projectContext}

**Relevant Snippets:**
${context.relevantSnippets}

${
	context.formattedDiagnostics
		? `**Relevant Diagnostics (Request Type: general):**\n${context.formattedDiagnostics}\n`
		: ""
}

${
	context.activeSymbolInfo
		? `**Active Symbol Info:**
- **Contextual Accuracy**: Use this info for correct integration, signatures, types, and naming for code interacting with these symbols.
${JSON.stringify(context.activeSymbolInfo, null, 2)}`
		: ""
}

${
	context.fileStructureAnalysis
		? _formatFileStructureAnalysis(context.fileStructureAnalysis) + "\n"
		: ""
}
${
	context.successfulChangeHistory
		? `
**Change History:**
Analyze past successful patterns and apply effective solution strategies.
${context.successfulChangeHistory}
`
		: ""
}`;
}

/**
 * Creates the enhanced modification prompt.
 * Originally extracted from `EnhancedCodeGenerator._createEnhancedModificationPrompt`.
 */
/**
 * Generates the system instruction for enhanced modification.
 */
export function getEnhancedModificationSystemInstruction(
	filePath: string,
	context: EnhancedGenerationContext & { formattedDiagnostics?: string },
): string {
	const languageId = _getLanguageId(path.extname(filePath));
	const fileAnalysis = context.fileStructureAnalysis;
	const isRewrite = context.isRewriteOperation ?? false;

	const requirementsList: string[] = [];

	requirementsList.push(
		"**SEARCH/REPLACE PROTOCOL**: You MUST use the `SEARC#H`, `===#===`, and `REPLAC#E` markers for all modifications. The '#' character is a critical safety feature to prevent collisions with existing code, including code that might discuss these markers.",
	);
	requirementsList.push(
		"**NO LEGACY MARKERS**: Do not use `SEARCH`, `REPLACE`, or `=======` for surgical edits. These are legacy formats and are incompatible with the extraction engine. However, they can be mentioned in text or documentation if relevant.",
	);
	requirementsList.push(
		"**Full File Rewrite**: Provide the FULL file content only if the entire file needs to be replaced. Otherwise, always use blocks.",
	);
	requirementsList.push(
		"```\n<<<<<<< SEARC#H\n[Exact content to be replaced]\n===#===\n[New content to replace with]\n>>>>>>> REPLAC#E\n```",
	);
	requirementsList.push(
		"**Multiple Changes**: Sequential blocks are encouraged for multiple changes.",
	);
	requirementsList.push(
		"**Context Match & Uniqueness**: The `SEARC#H` block must *exactly* match the existing code. Include enough surrounding context lines to ensure the match is **GLOBALLY UNIQUE** in the file. If a block matches multiple locations, the modification will fail.",
	);
	requirementsList.push(
		"**Deletions**: Leave the `REPLAC#E` section empty for deletions.",
	);
	requirementsList.push(
		"**Never Satisfied / Exhaustive Impact**: Do not settle for the most obvious change. Analyze the entire file and related snippets to ensure your modification accounts for ALL side effects, edge cases, and secondary components. Completeness is non-negotiable.",
	);

	if (isRewrite) {
		requirementsList.push(
			"**Rewrite Exception**: Even for rewrites, try to use large SEARC#H/REPLAC#E blocks if possible. However, if the entire file is changing significantly, you can use a single SEARC#H block containing the *entire* original content and a REPLAC#E block with the *entire* new content.",
		);
	}

	return `You are the expert software engineer for me. Your task is to modify the existing file according to the provided instructions. ONLY focus on generating code. EXCLUDE all conversational or meta-commentary.

Path: ${filePath}
Language: ${languageId}

${_formatFileStructureAnalysis(fileAnalysis)}

**CRITICAL OUTPUT CONSTRAINTS:**
- Use the **Search and Replace** block format exclusively.
- **Protocol**: \`SEARC#H\`, \`REPLAC#E\`, and \`===#===\`.
- **Meta-Discussion Tip**: If you are writing code that *mentions* these markers (e.g., in a changelog or variable name), do not get confused. The *functional* markers that the system extracts MUST always be on their own line at the start of the line.
- Wrap the entire output in a single markdown code block.

Example:
\`\`\`${languageId}
 <<<<<<< SEARC#H
    const x = 1;
    console.log(x);
 ===#===
    const x = 2;
    console.log("Value:", x);
 >>>>>>> REPLAC#E
\`\`\`

**Requirements:**
${requirementsList.map((req) => `- ${req}`).join("\n")}`;
}

/**
 * Generates the user message for enhanced modification.
 */
export function getEnhancedModificationUserMessage(
	filePath: string,
	modificationPrompt: string,
	currentContent: string,
	context: EnhancedGenerationContext & { formattedDiagnostics?: string },
): string {
	const languageId = _getLanguageId(path.extname(filePath));

	return `**Instructions:**
${modificationPrompt}

**Current Content:**
\`\`\`${languageId}
${currentContent}
\`\`\`

**Context:**
${context.projectContext}

**Relevant Snippets:**
${context.relevantSnippets}

${
	context.formattedDiagnostics
		? `**Relevant Diagnostics (Request Type: fix):**\n${context.formattedDiagnostics}\n`
		: ""
}

${
	context.activeSymbolInfo
		? `**Active Symbol Info:**
- **Contextual Accuracy**: Use this info for correct integration, signatures, types, and naming for code interacting with these symbols.
${JSON.stringify(context.activeSymbolInfo, null, 2)}`
		: ""
}

${
	context.successfulChangeHistory
		? `
**Change History:**
Analyze past effective patterns and solution strategies.
${context.successfulChangeHistory}
`
		: ""
}`;
}

/**
 * Creates the refinement prompt for unreasonable modifications.
 * Originally extracted from `EnhancedCodeGenerator._refineModification`.
 */
/**
 * Generates the system instruction for refinement.
 */
export function getRefineModificationSystemInstruction(
	filePath: string,
	context: EnhancedGenerationContext & { formattedDiagnostics?: string },
): string {
	const languageId = _getLanguageId(path.extname(filePath));

	return `You are an expert code reviewer and refactorer. Your task is to fix the issues in the provided code modification. ONLY provide the refined code. EXCLUDE all conversational or meta-commentary.

**Language:** ${languageId}

**Refinement Requirements:**
- **PRIORITY: ZERO ERRORS/WARNINGS**: Your primary objective is to resolve ALL reported issues in this single refinement attempt. The resulting code MUST compile and run without any errors or warnings.
- **Preserve Surrounding Code**: Leave all code lines and blocks untouched if they are not directly involved in resolving an identified diagnostic.
- **Maintain Indentation/Formatting**: Strictly adhere to the existing indentation, spacing, and formatting conventions of the original code.
- **Maintain Import Integrity**: Ensure all necessary imports are present and correct. Do not remove existing imports unless they are explicitly unused by the new, correct code. Add only strictly required new imports.
- **Strict Style Adherence:** Strictly adhere to the original file's existing code style, formatting (indentation, spacing, line breaks, bracket placement), and naming conventions.
- **Functionality and Correctness:** Ensure the modified code maintains all original functionality and is fully functional and error-free after correction.

**FINAL OUTPUT FORMAT: ABSOLUTELY CRITICAL**
When providing the refined and corrected code, you MUST return the *complete, full content of the entire file*. The output MUST be a **single, properly formatted markdown code block** (e.g., 
\`\`\`${languageId}
...full_file_content...
\`\`\`
). Do NOT provide only a partial code snippet, diff, specific function/class, or any conversational text outside the code block. The output must be the *whole, updated file* contained within this single code block.`;
}

/**
 * Generates the user message for refinement.
 */
export function getRefineModificationUserMessage(
	filePath: string,
	originalContent: string,
	modifiedContent: string,
	diffIssues: string[],
	context: EnhancedGenerationContext & { formattedDiagnostics?: string },
): string {
	const languageId = _getLanguageId(path.extname(filePath));
	let initialFeedback =
		"The modification seems to have issues that need to be addressed:";

	if (
		diffIssues.includes(
			"Modification seems too drastic - consider a more targeted approach",
		)
	) {
		initialFeedback +=
			"\n- **Drastic Change Detected**: The changes introduce a very high ratio of new/removed lines compared to the original content. This might indicate an unintended refactoring or deletion.";
	}
	if (diffIssues.includes("All imports were removed - this may be incorrect")) {
		initialFeedback +=
			"\n- **Import Integrity Compromised**: All imports appear to have been removed, which is highly likely to cause compilation errors.";
	}

	return `${initialFeedback}

**Issues to Resolve:**
${diffIssues.map((issue) => `- ${issue}`).join("\n")}

**Original Content:**
\`\`\`${languageId}
${originalContent}
\`\`\`

**Current Modification (with issues):**
\`\`\`${languageId}
${modifiedContent}
\`\`\`

**Context:**
${context.projectContext}

**Snippets:**
${context.relevantSnippets}

${
	context.formattedDiagnostics
		? `**Relevant Diagnostics (Request Type: fix):**\n${context.formattedDiagnostics}\n`
		: ""
}

${
	context.activeSymbolInfo
		? `**Active Symbol Info:**
- **Contextual Accuracy**: Use this info for correct integration, signatures, types, and naming for code interacting with these symbols.
${JSON.stringify(context.activeSymbolInfo, null, 2)}`
		: ""
}

${
	context.fileStructureAnalysis
		? _formatFileStructureAnalysis(context.fileStructureAnalysis) + "\n"
		: ""
}

${
	context.successfulChangeHistory
		? `
**Change History:**
Analyze past successful patterns and apply effective solution strategies.
${context.successfulChangeHistory}
`
		: ""
}`;
}

/**
 * Helper to format relevant files content into Markdown fenced code blocks for prompts.
 */
export async function _formatRelevantFilesForPrompt(
	relevantFilePaths: string[],
	workspaceRootUri: vscode.Uri,
	token: vscode.CancellationToken,
): Promise<string> {
	if (!relevantFilePaths || relevantFilePaths.length === 0) {
		return "";
	}

	const formattedSnippets: string[] = [];
	const maxFileSizeForSnippet = DEFAULT_SIZE;

	for (const relativePath of relevantFilePaths) {
		if (token.isCancellationRequested) {
			return formattedSnippets.join("\n");
		}

		const fileUri = vscode.Uri.joinPath(workspaceRootUri, relativePath);
		let fileContent: string | null = null;
		let languageId = path.extname(relativePath).substring(1);
		if (!languageId) {
			languageId = path.basename(relativePath).toLowerCase();
		}
		if (languageId === "makefile") {
			languageId = "makefile";
		} else if (languageId === "dockerfile") {
			languageId = "dockerfile";
		} else if (languageId === "jsonc") {
			languageId = "json";
		} else if (
			languageId === "eslintignore" ||
			languageId === "prettierignore" ||
			languageId === "gitignore"
		) {
			languageId = "ignore";
		} else if (languageId === "license") {
			languageId = "plaintext";
		}

		try {
			const fileStat = await vscode.workspace.fs.stat(fileUri);

			if (fileStat.type === vscode.FileType.Directory) {
				continue;
			}

			if (fileStat.size > maxFileSizeForSnippet) {
				console.warn(
					`[EnhancedCodeGenerator] Skipping relevant file '${relativePath}' (size: ${fileStat.size} bytes) due to size limit for prompt inclusion.`,
				);
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\nplaintext\n[File skipped: too large for context (${(
						fileStat.size / 1024
					).toFixed(2)}KB > ${(maxFileSizeForSnippet / 1024).toFixed(
						2,
					)}KB)]\n\n`,
				);
				continue;
			}

			const contentBuffer = await vscode.workspace.fs.readFile(fileUri);
			const content = Buffer.from(contentBuffer).toString("utf8");

			if (content.includes("\0")) {
				console.warn(
					`[EnhancedCodeGenerator] Skipping relevant file '${relativePath}' as it appears to be binary.`,
				);
				formattedSnippets.push(
					`--- Relevant File: ${relativePath} ---\nplaintext\n[File skipped: appears to be binary]\n\n`,
				);
				continue;
			}

			fileContent = content;
		} catch (error: any) {
			if (
				error instanceof vscode.FileSystemError &&
				(error.code === "FileNotFound" || error.code === "EntryNotFound")
			) {
				console.warn(
					`[EnhancedCodeGenerator] Relevant file not found: '${relativePath}'. Skipping.`,
				);
			} else if (error.message.includes("is not a file")) {
				console.warn(
					`[EnhancedCodeGenerator] Skipping directory '${relativePath}' as a relevant file.`,
				);
			} else {
				console.error(
					`[EnhancedCodeGenerator] Error reading relevant file '${relativePath}': ${error.message}. Skipping.`,
					error,
				);
			}
			formattedSnippets.push(
				`--- Relevant File: ${relativePath} ---\nplaintext\n[File skipped: could not be read or is inaccessible: ${error.message}]\n\n`,
			);
			continue;
		}

		if (fileContent !== null) {
			formattedSnippets.push(
				`--- Relevant File: ${relativePath} ---\n${languageId}\n${fileContent}\n\n`,
			);
		}
	}

	return formattedSnippets.join("\n");
}
