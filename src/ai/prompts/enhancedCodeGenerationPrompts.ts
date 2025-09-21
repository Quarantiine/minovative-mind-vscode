// src/ai/prompts/enhancedCodeGenerationPrompts.ts
import * as path from "path";
import {
	FileAnalysis,
	FileStructureAnalysis,
	EnhancedGenerationContext,
} from "../enhancedCodeGeneration";

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
	analysis?: FileStructureAnalysis
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
export function createEnhancedGenerationPrompt(
	filePath: string,
	generatePrompt: string,
	context: EnhancedGenerationContext
): string {
	const fileAnalysis = _analyzeFilePath(filePath);
	const languageId = _getLanguageId(fileAnalysis.extension); // Derive languageId from fileAnalysis
	const isRewrite = context.isRewriteOperation ?? false;

	const requirementsList: string[] = [];

	if (isRewrite) {
		requirementsList.push(
			"**Prioritize New Structure/Content**: You are tasked with generating the new code as specified in the instructions. Prioritize generating the new code structure and content precisely as specified, even if it requires significant deviations from typical patterns or implies a complete overhaul of an existing conceptual file. You have full autonomy to innovate and introduce new patterns/structures if they best fulfill the request."
		);
	}

	requirementsList.push(
		"**Accuracy First**: Ensure all imports, types, and dependencies are *absolutely* correct and precisely specified. Verify module paths, type definitions, and API usage."
	);
	requirementsList.push(
		"**Style Consistency**: Adhere * rigorously* to the project's existing coding patterns, conventions, and formatting. Maintain current indentation, naming, and structural choices."
	);
	requirementsList.push(
		"**Error Prevention**: Generate code that will compile and run *without any errors or warnings*. Proactively anticipate and guard against common pitfalls beyond just the immediate task, such as null/undefined checks, any types in typescript, input validations, edge cases, or off-by-one errors."
	);
	requirementsList.push(
		"**Best Practices**: Employ modern language features, established design patterns, and industry best practices to ensure high-quality, efficient, and robust code that is production-ready, maintainable, and clean."
	);
	requirementsList.push(
		"**Production Readiness**: Stress robustness, maintainability, and adherence to best practices for the generated code."
	);
	requirementsList.push(
		"**Security**: Implement secure coding practices meticulously, identifying and addressing potential vulnerabilities relevant to the language and context."
	);
	requirementsList.push(
		"**Command Execution Format (RunCommandStep)**: For any `RunCommandStep` action, the `command` property MUST be an object `{ executable: string, args: string[], usesShell?: boolean }`. The `executable` should be the command name (e.g., 'npm', 'git') and `args` an array of its arguments (e.g., ['install', '--save-dev', 'package']). If a command *absolutely requires* `shell: true` (e.g., it uses shell-specific features like pipes, redirects, or environment variable expansion inherently for its functionality, and cannot be expressed directly via `executable` and `args`), you MUST explicitly include `usesShell: true` in the object. This flag triggers critical fallback security checks in `PlanExecutorService`. Always prefer `executable` and `args` without `usesShell: true` for security reasons, unless explicitly necessary."
	);

	// This prompt strictly targets technical problem-solving.
	// It explicitly states "ONLY focus on generating code." and is now strengthened with an explicit exclusion.
	// Emphasis on quality attributes like accuracy, error prevention, and best practices is clearly stated in the requirements list.
	return `You are the expert software engineer for me, specializing in ${languageId} development. Your task is to generate production-ready, accurate code. ONLY focus on generating code. EXCLUDE all conversational or meta-commentary.

**File Analysis:**
- Path: ${filePath}
- Language: ${languageId}
- Framework: ${fileAnalysis.framework}
- Project Structure: ${fileAnalysis.projectStructure}
- Expected Patterns: ${fileAnalysis.expectedPatterns}

**Instructions:**
${generatePrompt}

**Project Context:**
${context.projectContext}

**Relevant Snippets:**
${context.relevantSnippets}

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
export function createEnhancedModificationPrompt(
	filePath: string,
	modificationPrompt: string,
	currentContent: string,
	context: EnhancedGenerationContext
): string {
	const languageId = _getLanguageId(path.extname(filePath));
	const fileAnalysis = context.fileStructureAnalysis; // From context, not _analyzeFilePath
	const isRewrite = context.isRewriteOperation ?? false;

	const requirementsList: string[] = [];

	if (isRewrite) {
		requirementsList.push(
			"**Prioritize New Structure/Content**: You are tasked with a significant rewrite or overhaul of the existing file. Prioritize generating the new code structure and content precisely as specified in the instructions, even if it requires significant deviations from the existing structure or content. Treat the 'Current Content' as a reference to be completely overhauled, not strictly adhered to for incremental changes. You have full autonomy to innovate and introduce new patterns/structures if they best fulfill the request."
		);
		requirementsList.push(
			"**Drastic Changes Allowed**: This request implies a major overhaul. You are explicitly permitted to make substantial changes to the existing structure, organization, and content. Extensive refactoring or re-implementation is permissible if it supports the requested overhaul."
		);
		requirementsList.push(
			"**Advanced Dependency Management (Rewrite)**: When performing a rewrite, manage imports intelligently: add only strictly necessary new imports, remove all unused imports, and reorder imports for optimal clarity and consistency with project conventions. The goal is a clean, correct, and well-organized import block for the new structure, reflecting best practices."
		);
		requirementsList.push(
			"**Consistent Style (New Code)**: Maintain internal code style (indentation, naming, formatting) for consistency within the *newly generated* sections, following modern best practices for the language."
		);
		requirementsList.push(
			"**Production-Ready Output (Rewrite)**: The generated code, even if a complete overhaul, must be production-ready, robust, highly maintainable, and free of *any* compilation errors, warnings, or runtime issues. Ensure architectural soundness, scalability, and efficiency in the new design, adhering to modern best practices."
		);
	} else {
		requirementsList.push(
			"**Precise & Minimal Modification**: For non-rewrite operations, make precise, surgical, and targeted changes that directly address the instructions. Avoid any unnecessary refactoring, cosmetic-only alterations, or modifications to surrounding code not directly impacted by the task. The goal is seamless, minimal disruption, and zero unintended side effects, maintaining the existing file's stability."
		);
		requirementsList.push(
			"**Advanced Dependency Management**: Add only strictly necessary new imports. Actively identify and remove *all* unused imports from the entire file. Preserve the existing import order unless a logical reordering is *absolutely essential* for significantly improving clarity, resolving conflicts, or adhering to project-wide standards for a new block of code."
		);
		requirementsList.push(
			"**Consistent Style (Existing Code)**: Strictly follow the existing code style, formatting, and conventions of the current file."
		);
		requirementsList.push(
			"**Production-Ready Output (Incremental)**: All modifications must result in code that is production-ready, robust, highly maintainable, and free of *any* compilation errors, warnings, or runtime issues. Ensure changes integrate seamlessly, maintaining the stability and correctness of the existing codebase."
		);
	}

	// Universal critical requirements (always strictly enforced, regardless of rewrite intent)
	requirementsList.push(
		"**FINAL OUTPUT FORMAT: IMPORTANT**: When modifying a file, you MUST generate and return the *complete, full content of the entire file* after applying the modifications. The output MUST be a **single, properly formatted markdown code block** (e.g., \n```typescript\n...full_file_content...\n```\n). Do NOT provide only a partial code snippet, diff, specific function/class, or any conversational text outside the code block. The output must be the *whole, updated file* contained within this single code block."
	);
	requirementsList.push(
		"**Accuracy First**: Ensure all imports, types, and dependencies are *absolutely* correct and precisely specified. Verify module paths, type definitions, and API usage."
	);
	requirementsList.push(
		"**Error Prevention & Robustness**: Generate code that will compile and run *without any errors or warnings*. Proactively anticipate and guard against common pitfalls, such as null/undefined checks, `any` types in TypeScript (unless explicitly justified), input validations, edge cases, and off-by-one errors. Prioritize robust error handling."
	);
	requirementsList.push(
		"**Best Practices**: Employ modern language features, established design patterns, and industry best practices to ensure high-quality, efficient, and robust code that is maintainable and clean."
	);
	requirementsList.push(
		"**Security**: Implement secure coding practices meticulously, identifying and addressing potential vulnerabilities relevant to the language and context."
	);
	requirementsList.push(
		"**Command Execution Format (RunCommandStep)**: For any `RunCommandStep` action, the `command` property MUST be an object `{ executable: string, args: string[], usesShell?: boolean }`. The `executable` should be the command name (e.g., 'npm', 'git') and `args` an array of its arguments (e.g., ['install', '--save-dev', 'package']). If a command *absolutely requires* `shell: true` (e.g., it uses shell-specific features like pipes, redirects, or environment variable expansion inherently for its functionality, and cannot be expressed directly via `executable` and `args`), you MUST explicitly include `usesShell: true` in the object. This flag triggers critical fallback security checks in `PlanExecutorService`. Always prefer `executable` and `args` without `usesShell: true` for security reasons, unless explicitly necessary."
	);

	// This prompt strictly targets technical problem-solving for file modifications.
	// It explicitly states "ONLY focus on generating code." and is now strengthened with an explicit exclusion.
	// Emphasis on quality attributes is clearly defined in the requirements list, adapting for rewrite vs. incremental changes.
	return `You are the expert software engineer for me,. Your task is to modify the existing file according to the provided instructions. ONLY focus on generating code. EXCLUDE all conversational or meta-commentary.

Path: ${filePath}
Language: ${languageId}

${_formatFileStructureAnalysis(fileAnalysis)}

**Instructions:**
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
export function createRefineModificationPrompt(
	filePath: string,
	originalContent: string,
	modifiedContent: string,
	diffIssues: string[], // Assumed to be already generated by _analyzeDiff
	context: EnhancedGenerationContext
): string {
	const languageId = _getLanguageId(path.extname(filePath));
	let initialFeedback =
		"The modification seems to have issues that need to be addressed:";

	// These checks should ideally be performed *before* calling this prompt function,
	// and the results (e.g., specific messages) passed in `diffIssues`.
	// The original _refineModification method's internal `_analyzeDiff` call
	// should be externalized to the calling `EnhancedCodeGenerator` logic.
	if (
		diffIssues.includes(
			"Modification seems too drastic - consider a more targeted approach"
		)
	) {
		initialFeedback +=
			"\n- **Drastic Change Detected**: The changes introduce a very high ratio of new/removed lines compared to the original content. This might indicate an unintended refactoring or deletion.";
	}
	if (diffIssues.includes("All imports were removed - this may be incorrect")) {
		initialFeedback +=
			"\n- **Import Integrity Compromised**: All imports appear to have been removed, which is highly likely to cause compilation errors.";
	}

	// This prompt strictly targets technical problem-solving by refining existing code.
	// It now explicitly states to "ONLY provide the refined code" and to "EXCLUDE all conversational or meta-commentary."
	// Emphasis on quality attributes like zero errors, preserving surrounding code, maintaining formatting,
	// import integrity, strict style adherence, and functionality/correctness is clearly present in the instructions.
	return `ONLY provide the refined code. EXCLUDE all conversational or meta-commentary. ${initialFeedback}\n\n**Issues with the modification:**\n${diffIssues
		.map((issue) => `- ${issue}`)
		.join(
			"\n"
		)}\n\n**Original Content:**\n\`\`\`${languageId}\n${originalContent}\n\`\`\`\n\n**Current Modification:**\n\`\`\`${languageId}\n${modifiedContent}\n\`\`\`\n\n**Refinement Instructions:**
- **PRIORITY: ZERO ERRORS/WARNINGS**: Your primary objective is to resolve ALL reported issues in this single refinement attempt. The resulting code MUST compile and run without any errors or warnings.
- **Preserve Surrounding Code**: Leave all code lines and blocks untouched if they are not directly involved in resolving an identified diagnostic.
- **Maintain Indentation/Formatting**: Strictly adhere to the existing indentation, spacing, and formatting conventions of the original code.
- **Maintain Import Integrity**: Ensure all necessary imports are present and correct. Do not remove existing imports unless they are explicitly unused by the new, correct code. Add only strictly required new imports.
- **Strict Style Adherence:** Strictly adhere to the original file's existing code style, formatting (indentation, spacing, line breaks, bracket placement), and naming conventions.
- **Functionality and Correctness:** Ensure the modified code maintains all original functionality and is fully functional and error-free after correction.

**Context:**
${context.projectContext}

**Snippets:**
${context.relevantSnippets}

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
